// cpp-exec/src/vpo_strategies.cpp — see vpo_strategies.hpp for provenance
// and the arm/trigger-vs-signal distinction.
#include "vpo_strategies.hpp"

#include <algorithm>
#include <cmath>
#include <cctype>
#include <limits>
#include <string>

namespace vpo {

// ---------------------------------------------------------------------------
// P6 / audit F-L1-01…05. These ports had drifted from the JS strategies that
// were actually fitted and walk-forward tested, and when VPO_SYMBOLS is set
// they are ORIGINATING decisions — tryFire calls placeOrder directly, so the
// risk gate, news gate, duplicate-symbol veto and correlation caps never see
// them. A divergence here is not a cosmetic mismatch; it is an unfitted
// predicate trading real money.
//
// Every gate below cites the JS line it mirrors. Where an exact mirror is
// impossible — because this engine arms BEFORE the bar the JS reads exists —
// the comment says so rather than implying equivalence.
// ---------------------------------------------------------------------------
double StrategyModule::timeframeMinutes(const std::string& tf) {
  if (tf.empty()) return 0.0;
  size_t i = 0;
  while (i < tf.size() && (std::isdigit(static_cast<unsigned char>(tf[i])) || tf[i] == '.')) i++;
  if (i == 0) return 0.0;
  const std::string unit = tf.substr(i);
  double n = 0.0;
  try { n = std::stod(tf.substr(0, i)); } catch (...) { return 0.0; }
  if (!(n > 0.0)) return 0.0;
  if (unit == "m" || unit == "min" || unit == "mins") return n;
  if (unit == "h" || unit == "hr" || unit == "hrs") return n * 60.0;
  if (unit == "d" || unit == "day" || unit == "days") return n * 1440.0;
  if (unit == "w" || unit == "wk" || unit == "week" || unit == "weeks") return n * 10080.0;
  if (unit == "mo" || unit == "M" || unit == "month" || unit == "months") return n * 43200.0;
  return 0.0; // unreadable — the caller decides open or closed
}

namespace {
// The floor every JS strategy but rsi2 shares (MIN_RR = 1.5 in
// vwap-trend.js:34, vp-value.js:21, ema-pullback.js:28, donchian-breakout.js:24,
// fib-confluence.js:33, cup-handle.js:55). Six of the seven ports had no such
// check at all: a setup whose measured-move target sat inside its own stop
// distance armed and fired anyway.
constexpr double kMinRR = 1.5;

// Arms `o` only if the reward-to-risk of the proposed bracket clears `minRR`.
// Returns false (leaving the caller to disarm) otherwise. Centralised so the
// floor cannot be forgotten again by the next port.
bool armIfRewardClearsFloor(VirtualPendingOrder& o, double trigger, Side side,
                            double slDistance, double tpDistance, double minRR = kMinRR) {
  if (!(slDistance > 0.0) || !(tpDistance > 0.0)) return false;
  // The epsilon matters: rsi2 builds tp as exactly TP_RR × sl and passes
  // TP_RR as its own floor, so a bare `<` would reject it on rounding alone.
  if (tpDistance / slDistance < minRR - 1e-9) return false;
  o.triggerPrice.store(trigger, std::memory_order_relaxed);
  o.side.store(side, std::memory_order_relaxed);
  o.relativeStopLoss.store(slDistance, std::memory_order_relaxed);
  o.relativeTakeProfit.store(tpDistance, std::memory_order_relaxed);
  o.state.store(VposState::ARMED, std::memory_order_relaxed);
  return true;
}

constexpr double kDayMs = 86'400'000.0;
constexpr int kAtrPeriod = 14;
constexpr double kSlAtrBuffer = 0.5;     // vwap-trend.js SL_ATR_BUFFER
constexpr double kMaxPullbackAtr = 1.5;  // vwap-trend.js MAX_PULLBACK_ATR
constexpr int kSlopeLookback = 10;       // vwap-trend.js SLOPE_LOOKBACK
constexpr double kEdgeToleranceAtr = 0.5; // vp-value.js EDGE_TOLERANCE_ATR
constexpr int kMinBarsVwap = 30;
constexpr int kMinBarsVp = 40;
// The bar window vp_value evaluates on, independent of how deep the feeder
// pushes. Matches SIGNAL_BARS in agent/services/fib-strategy.js so the two
// engines score the same strategy on the same history.
constexpr int kVpWindowBars = 150;
} // namespace

void VwapTrendStrategy::recompute(const std::vector<Bar>& /*macroBars*/, const std::vector<Bar>& microBars) {
  if (static_cast<int>(microBars.size()) < kMinBarsVwap) { disarm(); return; }

  // Anchored VWAP off the micro (15m) bars — daily anchor, same choice
  // vwap-trend.js's anchorPeriodFor() makes for any timeframe under 1 day.
  const std::vector<double> vw = vwapAnchored(microBars, kDayMs);
  const int i = static_cast<int>(microBars.size()) - 1;
  if (i - kSlopeLookback < 0) { disarm(); return; }
  const double v = vw[i];
  const double vPrev = vw[i - kSlopeLookback];
  // vwapAnchored returns NaN when the window carried no volume. Disarm rather
  // than compare against it: every NaN comparison is false, so `risingTrend`
  // and `fallingTrend` would both be false and the strategy would idle by
  // accident rather than by decision. Matches vwap-trend.js:50, which returns
  // null on the same condition.
  if (std::isnan(v) || std::isnan(vPrev)) { disarm(); return; }
  const double a = atr(microBars, kAtrPeriod);
  if (!(a > 0.0)) { disarm(); return; }

  const Bar& bar = microBars[i];
  const bool risingTrend = bar.c > v && v > vPrev;
  const bool fallingTrend = bar.c < v && v < vPrev;

  // vwap-trend.js:69 puts the stop at the SIGNAL BAR'S OWN LOW minus the
  // buffer — `sl = bar.l - SL_ATR_BUFFER * a` — not at a bare buffer below
  // the entry. Risk is therefore (entry − bar.l) + 0.5·ATR, and since
  // position size is risk-derived, a stop that omits the (entry − bar.l)
  // term sizes every trade LARGER than the fitted strategy ever did.
  //
  // This engine arms before the touch bar exists, so its entry is the line
  // rather than a close. The faithful mapping is the same formula with the
  // trigger as the entry: any part of the most recent bar that has already
  // wicked past the line is structure the stop must clear. When nothing has,
  // this reduces to the old buffer — which is the correct answer in that
  // case, not a coincidence.
  if (risingTrend) {
    const double distToLine = bar.c - v;
    if (distToLine > kMaxPullbackAtr * a) { disarm(); return; } // too far from the line to be a live setup
    const double structure = std::min(bar.l, v);
    const double sl = (v - structure) + kSlAtrBuffer * a;
    if (!armIfRewardClearsFloor(order(), v, Side::Buy, sl, 2.0 * sl)) disarm();
    return;
  }
  if (fallingTrend) {
    const double distToLine = v - bar.c;
    if (distToLine > kMaxPullbackAtr * a) { disarm(); return; }
    const double structure = std::max(bar.h, v);
    const double sl = (structure - v) + kSlAtrBuffer * a;
    if (!armIfRewardClearsFloor(order(), v, Side::Sell, sl, 2.0 * sl)) disarm();
    return;
  }
  disarm();
}

void VpValueStrategy::recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& /*microBars*/) {
  if (static_cast<int>(macroBars.size()) < kMinBarsVp) { disarm(); return; }

  // The feeder now pushes a DEEPER macro window than it used to, because Cup &
  // Handle needs 210 bars (kChMinBars) and 150 were being sent — so that
  // strategy could never clear its own length guard. See vpo-feeder.js.
  //
  // vp_value must not silently inherit that extra depth. volumeProfile() reads
  // the WHOLE slice, so a wider window is a different value area, a different
  // POC, and therefore different arm prices and take-profit distances. That
  // would be a strategy change smuggled in behind a bug fix. Slice back to the
  // window this strategy has always seen (the Node scan's SIGNAL_BARS).
  const std::vector<Bar> window =
      macroBars.size() > static_cast<size_t>(kVpWindowBars)
          ? std::vector<Bar>(macroBars.end() - kVpWindowBars, macroBars.end())
          : macroBars;

  const double a = atr(window, kAtrPeriod);
  if (!(a > 0.0)) { disarm(); return; }

  const VolumeProfileResult vp = volumeProfile(window, 24);
  if (!vp.valid || !(vp.vahPrice > vp.valPrice)) { disarm(); return; } // degenerate/flat profile

  const Bar& bar = window.back();
  const double tol = kEdgeToleranceAtr * a;
  const double distToVal = std::fabs(bar.c - vp.valPrice);
  const double distToVah = std::fabs(bar.c - vp.vahPrice);

  // Two corrections here, both from vp-value.js:42-45.
  //
  // 1. The catch radius was 3× the fitted EDGE_TOLERANCE_ATR. "At the edge"
  //    means within 0.5·ATR in the JS; tripling it arms on price that is
  //    nowhere near the edge yet, so the profile that justified the trade
  //    can have moved by the time the touch happens. Back to 1×. This still
  //    arms before the touch — that is what the trigger is for.
  //
  // 2. The POC-SIDE condition was missing entirely. The thesis is a rotation
  //    from the edge back to the point of control, so a long requires price
  //    BELOW the POC (`bar.c > valPrice && bar.c < pocPrice`) and a short
  //    requires price ABOVE it. Without it the tier armed longs at the VAL
  //    while price sat above the POC — a "rotation" whose target was behind
  //    it, and whose take-profit distance was therefore measured backwards.
  const double catchRadius = tol;
  if (distToVal <= catchRadius && distToVal <= distToVah &&
      bar.c > vp.valPrice && bar.c < vp.pocPrice) {
    if (!armIfRewardClearsFloor(order(), vp.valPrice, Side::Buy, kSlAtrBuffer * a,
                                std::fabs(vp.pocPrice - vp.valPrice))) disarm();
    return;
  }
  if (distToVah <= catchRadius && bar.c < vp.vahPrice && bar.c > vp.pocPrice) {
    if (!armIfRewardClearsFloor(order(), vp.vahPrice, Side::Sell, kSlAtrBuffer * a,
                                std::fabs(vp.pocPrice - vp.vahPrice))) disarm();
    return;
  }
  disarm();
}

namespace {
// ema-pullback.js constants
constexpr int kEmaMinBars = 60;
constexpr int kEmaFast = 20;
constexpr int kEmaSlow = 50;
constexpr double kEmaMaxPullbackAtr = 2.0;   // ema-pullback.js MAX_PULLBACK_ATR
constexpr double kEmaSlAtrBuffer = 0.25;     // ema-pullback.js SL_ATR_BUFFER

// donchian-breakout.js constants
constexpr int kDonchianChannel = 20;         // donchian-breakout.js CHANNEL
constexpr int kDonchianMinBars = 40;
constexpr double kDonchianMinRangeAtr = 2.0; // donchian-breakout.js MIN_RANGE_ATR
constexpr double kDonchianMaxOvershootAtr = 1.0; // donchian-breakout.js MAX_OVERSHOOT_ATR
constexpr double kDonchianSlAtr = 1.5;       // donchian-breakout.js SL_ATR
constexpr double kDonchianVolX = 1.2;        // donchian-breakout.js VOL_X

// cup-handle.js constants (classic/bullish direction only — see
// vpo_strategies.hpp's CupHandleStrategy comment)
constexpr int kChMinBars = 210;
constexpr int kChCupMin = 15;
constexpr int kChCupMax = 120;
constexpr int kChHandleMin = 2;
constexpr int kChHandleMax = 15;
constexpr double kChDepthMin = 0.15;
constexpr double kChDepthMax = 0.33;
constexpr int kChRoundBottomBars = 3;
constexpr double kChHandleRetraceMax = 0.5;
constexpr double kChHandleLenMinRatio = 0.10;
constexpr double kChHandleLenMaxRatio = 0.30;
constexpr double kChSlAtr = 1.5;
constexpr double kChMinRR = 1.5;

int idxMinLow(const std::vector<Bar>& bars, int from, int to) {
  int best = from;
  for (int i = from; i <= to; i++) if (bars[i].l < bars[best].l) best = i;
  return best;
}
int idxMaxHigh(const std::vector<Bar>& bars, int from, int to) {
  int best = from;
  for (int i = from; i <= to; i++) if (bars[i].h > bars[best].h) best = i;
  return best;
}
double avgVolRange(const std::vector<Bar>& bars, int from, int to) {
  if (to < from) return 0.0;
  double s = 0.0;
  for (int i = from; i <= to; i++) s += bars[i].v;
  return s / (to - from + 1);
}

// fib-confluence.js constants
constexpr int kFibMinBars = 40;
constexpr int kFibMaxSwings = 4;     // fib-confluence.js MAX_SWINGS
constexpr double kFibBandAtr = 0.5;  // fib-confluence.js BAND_ATR
constexpr int kFibMinConfluence = 3; // fib-confluence.js MIN_CONFLUENCE
constexpr double kFibSlAtrBuffer = 0.5; // fib-confluence.js SL_ATR_BUFFER
constexpr int kFibFractalWidth = 2;
constexpr double kFibRatios[] = {0.382, 0.5, 0.618, 0.786};

struct SwingPt { int idx; double price; };
struct StrictSwings { std::vector<SwingPt> highs, lows; };

// STRICT pivot swing finder — mirrors fib-strategy.js's findSwings() bar-
// for-bar (a tying neighbour disqualifies the pivot). Deliberately separate
// from bt::findSwings (backtest.hpp), which uses non-strict >/< comparisons
// from an earlier vintage of the JS spec — this one matches current
// fib-strategy.js exactly, the source fib-confluence.js itself imports.
StrictSwings findStrictSwings(const std::vector<Bar>& bars, int fractalWidth) {
  StrictSwings out;
  const int n = static_cast<int>(bars.size());
  for (int i = fractalWidth; i < n - fractalWidth; i++) {
    bool isHigh = true, isLow = true;
    for (int j = i - fractalWidth; j <= i + fractalWidth; j++) {
      if (j == i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.highs.push_back({i, bars[i].h});
    if (isLow) out.lows.push_back({i, bars[i].l});
  }
  return out;
}

// rsi2-reversion.js constants
constexpr int kRsiTrendPeriod = 100;
constexpr int kRsiPeriod = 2;
constexpr double kRsiOversold = 10.0;
constexpr double kRsiSlAtr = 1.5;
constexpr double kRsiTpRR = 1.2;
// rsi2-reversion.js MIN_TF_MIN. Also its OWN reward floor: this strategy is
// explicitly exempt from the shared 1.5 (rsi2-reversion.js:25 — a high-win-
// rate mean-reverter keys its own lower STRATEGY_MIN_RR), so applying 1.5
// here would silently switch it off rather than align it.
constexpr double kRsiMinTfMinutes = 60.0;
constexpr int kRsiMinBars = kRsiTrendPeriod + kRsiPeriod + 2;
} // namespace

void EmaPullbackStrategy::recompute(const std::vector<Bar>& /*macroBars*/, const std::vector<Bar>& microBars) {
  if (static_cast<int>(microBars.size()) < kEmaMinBars) { disarm(); return; }
  const double ema20 = ema(microBars, kEmaFast);
  const double ema50 = ema(microBars, kEmaSlow);
  if (std::isnan(ema20) || std::isnan(ema50)) { disarm(); return; }
  const double a = atr(microBars, kAtrPeriod);
  if (!(a > 0.0)) { disarm(); return; }

  const Bar& bar = microBars.back();
  // Trend intact (EMA20 vs EMA50) and price still on the trend side of the
  // EMA20 line: arm at that line, waiting for the pullback touch. The JS
  // signal requires the touch to have ALREADY happened (bar.l <= ema20)
  // and closed back above — this engine arms BEFORE that instead (see
  // vpo_strategies.hpp file header, point 2's sibling case: this one still
  // waits for a touch, just of a line instead of a fixed level).
  // ema-pullback.js:83-85 — `sl = min(bar.l, ema50) - SL_ATR_BUFFER * a`.
  // Unlike vwap-trend, this stop's structure is a LINE (the slow EMA), which
  // exists before the touch does, so this is an exact port rather than a
  // mapping: the stop clears the slow EMA, and the previous 0.25·ATR-only
  // version sized every trade as if the trend line weren't there at all.
  if (ema20 > ema50 && bar.c > ema20 && bar.c > ema50) {
    const double distToLine = bar.c - ema20;
    if (distToLine > kEmaMaxPullbackAtr * a) { disarm(); return; } // too far above the line to be a live setup
    const double sl = (ema20 - std::min(bar.l, ema50)) + kEmaSlAtrBuffer * a;
    if (!armIfRewardClearsFloor(order(), ema20, Side::Buy, sl, 2.0 * sl)) disarm();
    return;
  }
  if (ema20 < ema50 && bar.c < ema20 && bar.c < ema50) {
    const double distToLine = ema20 - bar.c;
    if (distToLine > kEmaMaxPullbackAtr * a) { disarm(); return; }
    const double sl = (std::max(bar.h, ema50) - ema20) + kEmaSlAtrBuffer * a;
    if (!armIfRewardClearsFloor(order(), ema20, Side::Sell, sl, 2.0 * sl)) disarm();
    return;
  }
  disarm();
}

void DonchianBreakoutStrategy::recompute(const std::vector<Bar>& /*macroBars*/, const std::vector<Bar>& microBars) {
  if (static_cast<int>(microBars.size()) < kDonchianMinBars) { disarm(); return; }
  const int last = static_cast<int>(microBars.size()) - 1;

  // Prior-20 channel — the (potential, not-yet-touched) breakout bar itself
  // is excluded, same as donchian-breakout.js.
  double hi = -std::numeric_limits<double>::infinity();
  double lo = std::numeric_limits<double>::infinity();
  double volSum = 0.0;
  for (int i = last - kDonchianChannel; i < last; i++) {
    if (microBars[i].h > hi) hi = microBars[i].h;
    if (microBars[i].l < lo) lo = microBars[i].l;
    volSum += microBars[i].v;
  }
  const double range = hi - lo;
  const double a = atr(microBars, kAtrPeriod);
  if (!(a > 0.0) || range < kDonchianMinRangeAtr * a) { disarm(); return; } // micro-range noise

  // THE VOLUME GATE (donchian-breakout.js:57-60, `if (volX < VOL_X) return
  // null`). It was deleted here on the argument that it reads the breakout
  // bar's own volume, which does not exist before the touch. That argument
  // justifies not being able to mirror it EXACTLY; it does not justify
  // dropping a hard veto and trading the setup anyway. "Conviction needs
  // participation" is the whole premise of the strategy, and without any
  // volume condition this port fires breakouts on dead tape — precisely the
  // trades the fitted version refuses.
  //
  // So it is enforced against the LAST CLOSED BAR instead of the future
  // breakout bar: participation must already be building as price approaches
  // the band. This is a PROXY, deliberately named as one. It is stricter
  // than nothing and looser than the JS, and it can both miss a breakout
  // that only gets its volume on the break itself and admit one whose volume
  // fades before the touch. Making it exact needs the tick tape at fire
  // time, which is a larger change than closing this gap.
  const double avgVol = volSum / kDonchianChannel;
  const double volX = avgVol > 0.0 ? microBars[last].v / avgVol : 0.0;
  if (volX < kDonchianVolX) { disarm(); return; }

  const double close = microBars[last].c;
  const double catchRadius = 3.0 * kDonchianMaxOvershootAtr * a;
  const double distToHi = hi - close;
  const double distToLo = close - lo;
  if (close <= hi && distToHi <= catchRadius && distToHi <= distToLo) {
    // tp = the measured move (donchian-breakout.js:65); the RR floor is what
    // stops a 1.5·ATR stop being paired with a shallower range.
    if (!armIfRewardClearsFloor(order(), hi, Side::Buy, kDonchianSlAtr * a, range)) disarm();
    return;
  }
  if (close >= lo && distToLo <= catchRadius) {
    if (!armIfRewardClearsFloor(order(), lo, Side::Sell, kDonchianSlAtr * a, range)) disarm();
    return;
  }
  disarm();
}

namespace {
// Shared dir-parameterized cup+handle search — mirrors cup-handle.js's
// searchCupHandle(bars, tf, opts, dir) so the gating logic can never drift
// between the classic (dir=+1: rounded bottom, breaks UP) and inverted
// (dir=-1: rounded dome, breaks DOWN) directions. Sets the strategy's
// order atomics directly (order() is public; IDLE store == disarm()).
void recomputeCupHandle(StrategyModule& s, const std::vector<Bar>& macroBars, int dir) {
  auto& o = s.order();
  const auto idle = [&o] { o.state.store(VposState::IDLE, std::memory_order_relaxed); };

  if (static_cast<int>(macroBars.size()) < kChMinBars) { idle(); return; }
  const int last = static_cast<int>(macroBars.size()) - 1;
  const double close = macroBars[last].c;

  const double s20 = sma(macroBars, 20);
  const double s50 = sma(macroBars, 50);
  const double s200 = sma(macroBars, 200);
  const bool trendOk = !std::isnan(s20) && !std::isnan(s50) && !std::isnan(s200)
      && (dir == 1 ? (close > s20 && close > s50 && close > s200)
                   : (close < s20 && close < s50 && close < s200));
  if (!trendOk) { idle(); return; }

  for (int handleLen = kChHandleMin; handleLen <= kChHandleMax; handleLen++) {
    const int rr = last - handleLen;
    if (rr < kChCupMin + 10) break;

    // Right rim must be the local extreme vs. the handle bars after it — a
    // local HIGH for the classic pattern, a local LOW for the inverted one.
    double handleExtreme = dir == 1 ? -std::numeric_limits<double>::infinity()
                                    : std::numeric_limits<double>::infinity();
    for (int i = rr + 1; i < last; i++) {
      if (dir == 1) { if (macroBars[i].h > handleExtreme) handleExtreme = macroBars[i].h; }
      else { if (macroBars[i].l < handleExtreme) handleExtreme = macroBars[i].l; }
    }
    const bool rimHolds = dir == 1 ? macroBars[rr].h > handleExtreme
                                   : macroBars[rr].l < handleExtreme;
    if (!rimHolds) continue;

    // Cup: left rim first (roughly level with the right rim), then the
    // extreme (lowest low classic / highest high inverted) BETWEEN the rims.
    int lr = -1, ex = -1;
    double depthAbs = 0.0;
    for (int cand = rr - kChCupMin; cand >= std::max(rr - kChCupMax, 0); cand--) {
      const double candRim = dir == 1 ? macroBars[cand].h : macroBars[cand].l;
      const double rrRim = dir == 1 ? macroBars[rr].h : macroBars[rr].l;
      // leveling check, not a price mirror — the same relative band applies
      // to highs (classic) or lows (inverted), matching the JS exactly.
      if (candRim < rrRim * 0.95 || candRim > rrRim * 1.15) continue;
      const int exIdx = dir == 1 ? idxMinLow(macroBars, cand + 1, rr - 1)
                                 : idxMaxHigh(macroBars, cand + 1, rr - 1);
      const double rim = dir == 1 ? std::min(macroBars[cand].h, macroBars[rr].h)
                                  : std::max(macroBars[cand].l, macroBars[rr].l);
      const double exPrice = dir == 1 ? macroBars[exIdx].l : macroBars[exIdx].h;
      const double dAbs = dir == 1 ? rim - exPrice : exPrice - rim;
      const double d = dAbs / rim;
      if (d < kChDepthMin || d > kChDepthMax) continue;
      const double posInCup = static_cast<double>(exIdx - cand) / (rr - cand);
      if (posInCup < 0.2 || posInCup > 0.8) continue;
      lr = cand; ex = exIdx; depthAbs = dAbs;
      break;
    }
    if (lr < 0) continue;
    const int cupLen = rr - lr;
    const double extremePrice = dir == 1 ? macroBars[ex].l : macroBars[ex].h;
    const double rim = dir == 1 ? std::min(macroBars[lr].h, macroBars[rr].h)
                                : std::max(macroBars[lr].l, macroBars[rr].l);

    const double handleLenRatio = static_cast<double>(handleLen) / cupLen;
    if (handleLenRatio < kChHandleLenMinRatio || handleLenRatio > kChHandleLenMaxRatio) continue;

    // Rounded extreme: several bars near it, not one V-spike (dome-spike).
    const double nearExtreme = dir == 1 ? extremePrice + 0.15 * depthAbs
                                        : extremePrice - 0.15 * depthAbs;
    int roundBars = 0;
    for (int i = lr; i <= rr; i++) {
      const bool touches = dir == 1 ? macroBars[i].l <= nearExtreme
                                    : macroBars[i].h >= nearExtreme;
      if (touches) roundBars++;
    }
    if (roundBars < kChRoundBottomBars) continue;

    // Handle retrace: must not cross the cup's own midpoint. Handle volume
    // taper: quieter than the advance into the right rim — both fully
    // evaluable from already-observed bars, so both stay hard gates
    // (unlike the breakout-volume check, which needs the not-yet-existing
    // breakout bar's own volume and is dropped — see file header, point 1).
    double handleFar = dir == 1 ? std::numeric_limits<double>::infinity()
                                : -std::numeric_limits<double>::infinity();
    for (int i = rr + 1; i < last; i++) {
      if (dir == 1) { if (macroBars[i].l < handleFar) handleFar = macroBars[i].l; }
      else { if (macroBars[i].h > handleFar) handleFar = macroBars[i].h; }
    }
    const bool handleOk = dir == 1 ? handleFar >= rim - depthAbs * kChHandleRetraceMax
                                   : handleFar <= rim + depthAbs * kChHandleRetraceMax;
    if (!handleOk) continue;

    const int third = std::max(1, cupLen / 3);
    const double vOut = avgVolRange(macroBars, rr - third, rr);
    const double vHandle = avgVolRange(macroBars, rr + 1, last - 1);
    if (!(vOut > 0.0 && vHandle < vOut)) continue;

    const double a = atr(macroBars, kAtrPeriod);
    if (!(a > 0.0)) continue;
    const double sl = kChSlAtr * a;
    const double tp = depthAbs; // measured move, matching cup-handle.js tp1 - rim
    const double rrRatio = tp / sl;
    if (rrRatio < kChMinRR) continue; // cup-handle.js:55 — the one port that already had this

    // Breakout/breakdown level this engine arms at and waits for a touch,
    // rather than requiring (as cup-handle.js does) that the touch already
    // happened on the just-closed bar.
    const double prior2Extreme = dir == 1
        ? std::max(macroBars[last - 1].h, macroBars[last - 2].h)
        : std::min(macroBars[last - 1].l, macroBars[last - 2].l);
    const double breakoutLevel = dir == 1 ? std::max(prior2Extreme, handleExtreme)
                                          : std::min(prior2Extreme, handleExtreme);

    o.triggerPrice.store(breakoutLevel, std::memory_order_relaxed);
    o.side.store(dir == 1 ? Side::Buy : Side::Sell, std::memory_order_relaxed);
    o.relativeStopLoss.store(sl, std::memory_order_relaxed);
    o.relativeTakeProfit.store(tp, std::memory_order_relaxed);
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
    return;
  }
  idle();
}
} // namespace

void CupHandleStrategy::recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& /*microBars*/) {
  recomputeCupHandle(*this, macroBars, 1);
}

void InvCupHandleStrategy::recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& /*microBars*/) {
  recomputeCupHandle(*this, macroBars, -1);
}

void FibConfluenceStrategy::recompute(const std::vector<Bar>& /*macroBars*/, const std::vector<Bar>& microBars) {
  if (static_cast<int>(microBars.size()) < kFibMinBars) { disarm(); return; }
  const double a = atr(microBars, kAtrPeriod);
  if (!(a > 0.0)) { disarm(); return; }

  const StrictSwings sw = findStrictSwings(microBars, kFibFractalWidth);
  if (sw.highs.empty() || sw.lows.empty()) { disarm(); return; }

  const int nH = static_cast<int>(sw.highs.size());
  const int nL = static_cast<int>(sw.lows.size());
  const int fromH = std::max(0, nH - kFibMaxSwings);
  const int fromL = std::max(0, nL - kFibMaxSwings);

  struct Level { double price; bool isSupport; };
  std::vector<Level> levels;
  for (int hi = fromH; hi < nH; hi++) {
    for (int li = fromL; li < nL; li++) {
      const SwingPt& h = sw.highs[hi];
      const SwingPt& l = sw.lows[li];
      const double range = h.price - l.price;
      if (!(range > 0.0)) continue;
      if (h.idx > l.idx) {
        for (double r : kFibRatios) levels.push_back({h.price - r * range, true});
      } else if (l.idx > h.idx) {
        for (double r : kFibRatios) levels.push_back({l.price + r * range, false});
      }
    }
  }
  if (levels.empty()) { disarm(); return; }

  const double price = microBars.back().c;
  const double band = kFibBandAtr * a;
  std::vector<Level> near;
  for (const auto& lv : levels) if (std::fabs(lv.price - price) <= band) near.push_back(lv);
  if (static_cast<int>(near.size()) < kFibMinConfluence) { disarm(); return; }

  int supports = 0, resistances = 0;
  double zoneLoS = std::numeric_limits<double>::infinity(), zoneHiS = -std::numeric_limits<double>::infinity();
  double zoneLoR = std::numeric_limits<double>::infinity(), zoneHiR = -std::numeric_limits<double>::infinity();
  for (const auto& lv : near) {
    if (lv.isSupport) { supports++; zoneLoS = std::min(zoneLoS, lv.price); zoneHiS = std::max(zoneHiS, lv.price); }
    else { resistances++; zoneLoR = std::min(zoneLoR, lv.price); zoneHiR = std::max(zoneHiR, lv.price); }
  }

  // Bias from the dominant clustered side, ties going to long — matches
  // fib-confluence.js's tie-break exactly.
  bool isLong;
  double zoneLo, zoneHi;
  if (supports >= kFibMinConfluence && supports >= resistances) { isLong = true; zoneLo = zoneLoS; zoneHi = zoneHiS; }
  else if (resistances >= kFibMinConfluence && resistances > supports) { isLong = false; zoneLo = zoneLoR; zoneHi = zoneHiR; }
  else { disarm(); return; }

  const double sl = isLong ? zoneLo - kFibSlAtrBuffer * a : zoneHi + kFibSlAtrBuffer * a;
  const double risk = std::fabs(price - sl);
  if (!(risk > 0.0)) { disarm(); return; }

  // This JS signal already means "price is inside the zone right now" —
  // there's no future touch to wait for, so arm at the current close
  // itself (vpo_strategies.hpp file header, point 2).
  // tp is 2R by construction (fib-confluence.js:89) so the floor never binds
  // here; it goes through the same helper so no future edit can silently
  // change that without the floor noticing.
  if (!armIfRewardClearsFloor(order(), price, isLong ? Side::Buy : Side::Sell, risk, 2.0 * risk))
    disarm();
}

void Rsi2ReversionStrategy::recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& /*microBars*/) {
  // THE TIMEFRAME FLOOR (rsi2-reversion.js:47,62 — MIN_TF_MIN = 60). This is
  // the 2026-07-21 walk-forward result: the edge lives on 1h+ and this
  // strategy structurally loses on 5m–30m. It used to be "enforced" by a
  // comment in vpo_strategies.hpp asking whoever deploys the key not to set
  // VPO_MACRO_TF below an hour — which is not enforcement, it is a note.
  //
  // Fails OPEN on an unreadable label, matching the JS: `if (tf && tf.ms <
  // ...)` skips the check when parseTimeframe returns null. An empty macro
  // timeframe (a caller that never called setMacroTimeframe) reads as
  // unknown, so a unit test constructing a bare strategy behaves as before.
  const double tfMin = StrategyModule::timeframeMinutes(macroTimeframe());
  if (tfMin > 0.0 && tfMin < kRsiMinTfMinutes) { disarm(); return; }

  if (static_cast<int>(macroBars.size()) < kRsiMinBars) { disarm(); return; }
  const double r = rsi(macroBars, kRsiPeriod);
  const double trend = sma(macroBars, kRsiTrendPeriod);
  const double a = atr(macroBars, kAtrPeriod);
  if (std::isnan(r) || std::isnan(trend) || !(a > 0.0)) { disarm(); return; }

  const Bar& bar = macroBars.back();
  const bool longSetup = bar.c > trend && r < kRsiOversold;
  const bool shortSetup = bar.c < trend && r > (100.0 - kRsiOversold);
  if (!longSetup && !shortSetup) { disarm(); return; }

  // Same "already true, trade it now" shape as FibConfluenceStrategy — arms
  // at the current close immediately. Reward floor is TP_RR itself, not the
  // shared 1.5 — see kRsiMinTfMinutes' comment.
  const double slDist = kRsiSlAtr * a;
  if (!armIfRewardClearsFloor(order(), bar.c, longSetup ? Side::Buy : Side::Sell,
                              slDist, kRsiTpRR * slDist, kRsiTpRR))
    disarm();
}

} // namespace vpo
