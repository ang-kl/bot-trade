// cpp-exec/src/vpo_strategies.cpp — see vpo_strategies.hpp for provenance
// and the arm/trigger-vs-signal distinction.
#include "vpo_strategies.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace vpo {

namespace {
constexpr double kDayMs = 86'400'000.0;
constexpr int kAtrPeriod = 14;
constexpr double kSlAtrBuffer = 0.5;     // vwap-trend.js SL_ATR_BUFFER
constexpr double kMaxPullbackAtr = 1.5;  // vwap-trend.js MAX_PULLBACK_ATR
constexpr int kSlopeLookback = 10;       // vwap-trend.js SLOPE_LOOKBACK
constexpr double kEdgeToleranceAtr = 0.5; // vp-value.js EDGE_TOLERANCE_ATR
constexpr int kMinBarsVwap = 30;
constexpr int kMinBarsVp = 40;
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
  const double a = atr(microBars, kAtrPeriod);
  if (!(a > 0.0)) { disarm(); return; }

  const Bar& bar = microBars[i];
  const bool risingTrend = bar.c > v && v > vPrev;
  const bool fallingTrend = bar.c < v && v < vPrev;

  if (risingTrend) {
    // Already pulled back through the line and holding above it — the JS
    // signal fires HERE (close confirms the bounce). This engine instead
    // arms BEFORE that: if price hasn't pulled back too far yet, wait for
    // the touch by setting the trigger at the current VWAP level.
    const double distToLine = bar.c - v;
    if (distToLine > kMaxPullbackAtr * a) { disarm(); return; } // too far from the line to be a live setup
    auto& o = order();
    o.triggerPrice.store(v, std::memory_order_relaxed);
    o.side.store(Side::Buy, std::memory_order_relaxed);
    o.relativeStopLoss.store(kSlAtrBuffer * a, std::memory_order_relaxed);
    o.relativeTakeProfit.store(2.0 * kSlAtrBuffer * a, std::memory_order_relaxed); // 2R, matching vwap-trend.js tp1
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
    return;
  }
  if (fallingTrend) {
    const double distToLine = v - bar.c;
    if (distToLine > kMaxPullbackAtr * a) { disarm(); return; }
    auto& o = order();
    o.triggerPrice.store(v, std::memory_order_relaxed);
    o.side.store(Side::Sell, std::memory_order_relaxed);
    o.relativeStopLoss.store(kSlAtrBuffer * a, std::memory_order_relaxed);
    o.relativeTakeProfit.store(2.0 * kSlAtrBuffer * a, std::memory_order_relaxed); // 2R, matching vwap-trend.js tp1
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
    return;
  }
  disarm();
}

void VpValueStrategy::recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& /*microBars*/) {
  if (static_cast<int>(macroBars.size()) < kMinBarsVp) { disarm(); return; }

  const double a = atr(macroBars, kAtrPeriod);
  if (!(a > 0.0)) { disarm(); return; }

  const VolumeProfileResult vp = volumeProfile(macroBars, 24);
  if (!vp.valid || !(vp.vahPrice > vp.valPrice)) { disarm(); return; } // degenerate/flat profile

  const Bar& bar = macroBars.back();
  const double tol = kEdgeToleranceAtr * a;
  const double distToVal = std::fabs(bar.c - vp.valPrice);
  const double distToVah = std::fabs(bar.c - vp.vahPrice);

  // Arm at whichever edge price is currently closer to (within a wider
  // catch radius than the JS's "already at the edge" check, since this
  // engine arms BEFORE the touch and waits for it).
  const double catchRadius = 3.0 * tol;
  if (distToVal <= catchRadius && distToVal <= distToVah && bar.c > vp.valPrice) {
    auto& o = order();
    o.triggerPrice.store(vp.valPrice, std::memory_order_relaxed);
    o.side.store(Side::Buy, std::memory_order_relaxed);
    o.relativeStopLoss.store(kSlAtrBuffer * a, std::memory_order_relaxed);
    o.relativeTakeProfit.store(std::fabs(vp.pocPrice - vp.valPrice), std::memory_order_relaxed);
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
    return;
  }
  if (distToVah <= catchRadius && bar.c < vp.vahPrice) {
    auto& o = order();
    o.triggerPrice.store(vp.vahPrice, std::memory_order_relaxed);
    o.side.store(Side::Sell, std::memory_order_relaxed);
    o.relativeStopLoss.store(kSlAtrBuffer * a, std::memory_order_relaxed);
    o.relativeTakeProfit.store(std::fabs(vp.pocPrice - vp.vahPrice), std::memory_order_relaxed);
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
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
  if (ema20 > ema50 && bar.c > ema20 && bar.c > ema50) {
    const double distToLine = bar.c - ema20;
    if (distToLine > kEmaMaxPullbackAtr * a) { disarm(); return; } // too far above the line to be a live setup
    auto& o = order();
    o.triggerPrice.store(ema20, std::memory_order_relaxed);
    o.side.store(Side::Buy, std::memory_order_relaxed);
    o.relativeStopLoss.store(kEmaSlAtrBuffer * a, std::memory_order_relaxed);
    o.relativeTakeProfit.store(2.0 * kEmaSlAtrBuffer * a, std::memory_order_relaxed); // 2R, matching ema-pullback.js's fixed rr=2
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
    return;
  }
  if (ema20 < ema50 && bar.c < ema20 && bar.c < ema50) {
    const double distToLine = ema20 - bar.c;
    if (distToLine > kEmaMaxPullbackAtr * a) { disarm(); return; }
    auto& o = order();
    o.triggerPrice.store(ema20, std::memory_order_relaxed);
    o.side.store(Side::Sell, std::memory_order_relaxed);
    o.relativeStopLoss.store(kEmaSlAtrBuffer * a, std::memory_order_relaxed);
    o.relativeTakeProfit.store(2.0 * kEmaSlAtrBuffer * a, std::memory_order_relaxed);
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
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
  for (int i = last - kDonchianChannel; i < last; i++) {
    if (microBars[i].h > hi) hi = microBars[i].h;
    if (microBars[i].l < lo) lo = microBars[i].l;
  }
  const double range = hi - lo;
  const double a = atr(microBars, kAtrPeriod);
  if (!(a > 0.0) || range < kDonchianMinRangeAtr * a) { disarm(); return; } // micro-range noise

  // Arm at whichever band edge price currently sits closest to, within a
  // wider catch radius than the JS's "already overshot" check — this
  // engine arms BEFORE the break and waits for the touch. The JS's
  // breakout-volume filter can't be pre-verified (it reads the not-yet-
  // existing breakout bar's own volume) so it's dropped here — see
  // vpo_strategies.hpp file header, point 1.
  const double close = microBars[last].c;
  const double catchRadius = 3.0 * kDonchianMaxOvershootAtr * a;
  const double distToHi = hi - close;
  const double distToLo = close - lo;
  if (close <= hi && distToHi <= catchRadius && distToHi <= distToLo) {
    auto& o = order();
    o.triggerPrice.store(hi, std::memory_order_relaxed);
    o.side.store(Side::Buy, std::memory_order_relaxed);
    o.relativeStopLoss.store(kDonchianSlAtr * a, std::memory_order_relaxed);
    o.relativeTakeProfit.store(range, std::memory_order_relaxed); // measured move, matching donchian-breakout.js tp1
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
    return;
  }
  if (close >= lo && distToLo <= catchRadius) {
    auto& o = order();
    o.triggerPrice.store(lo, std::memory_order_relaxed);
    o.side.store(Side::Sell, std::memory_order_relaxed);
    o.relativeStopLoss.store(kDonchianSlAtr * a, std::memory_order_relaxed);
    o.relativeTakeProfit.store(range, std::memory_order_relaxed);
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
    return;
  }
  disarm();
}

void CupHandleStrategy::recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& /*microBars*/) {
  if (static_cast<int>(macroBars.size()) < kChMinBars) { disarm(); return; }
  const int last = static_cast<int>(macroBars.size()) - 1;
  const double close = macroBars[last].c;

  const double s20 = sma(macroBars, 20);
  const double s50 = sma(macroBars, 50);
  const double s200 = sma(macroBars, 200);
  if (std::isnan(s20) || std::isnan(s50) || std::isnan(s200)
      || !(close > s20 && close > s50 && close > s200)) { disarm(); return; }

  for (int handleLen = kChHandleMin; handleLen <= kChHandleMax; handleLen++) {
    const int rr = last - handleLen;
    if (rr < kChCupMin + 10) break;

    // Right rim must be a local high vs. the handle bars after it.
    double handleExtreme = -std::numeric_limits<double>::infinity();
    for (int i = rr + 1; i < last; i++) if (macroBars[i].h > handleExtreme) handleExtreme = macroBars[i].h;
    if (!(macroBars[rr].h > handleExtreme)) continue;

    // Cup: left rim first (roughly level with the right rim), then the
    // lowest low between the rims, matching cup-handle.js's searchCupHandle
    // exactly (dir=1 branch only — see vpo_strategies.hpp comment).
    int lr = -1, ex = -1;
    double depthAbs = 0.0, depth = 0.0;
    for (int cand = rr - kChCupMin; cand >= std::max(rr - kChCupMax, 0); cand--) {
      const double candRim = macroBars[cand].h;
      const double rrRim = macroBars[rr].h;
      if (candRim < rrRim * 0.95 || candRim > rrRim * 1.15) continue;
      const int exIdx = idxMinLow(macroBars, cand + 1, rr - 1);
      const double rim = std::min(macroBars[cand].h, macroBars[rr].h);
      const double exPrice = macroBars[exIdx].l;
      const double dAbs = rim - exPrice;
      const double d = dAbs / rim;
      if (d < kChDepthMin || d > kChDepthMax) continue;
      const double posInCup = static_cast<double>(exIdx - cand) / (rr - cand);
      if (posInCup < 0.2 || posInCup > 0.8) continue;
      lr = cand; ex = exIdx; depthAbs = dAbs; depth = d;
      break;
    }
    if (lr < 0) continue;
    (void)depth; // kept for parity with the JS shape; not needed past this point
    const int cupLen = rr - lr;
    const double extremePrice = macroBars[ex].l;
    const double rim = std::min(macroBars[lr].h, macroBars[rr].h);

    const double handleLenRatio = static_cast<double>(handleLen) / cupLen;
    if (handleLenRatio < kChHandleLenMinRatio || handleLenRatio > kChHandleLenMaxRatio) continue;

    const double nearExtreme = extremePrice + 0.15 * depthAbs;
    int roundBars = 0;
    for (int i = lr; i <= rr; i++) if (macroBars[i].l <= nearExtreme) roundBars++;
    if (roundBars < kChRoundBottomBars) continue;

    // Handle retrace: must not drop below the cup's own midpoint. Handle
    // volume taper: quieter than the advance into the right rim — both
    // fully evaluable from already-observed bars, so both stay hard gates
    // (unlike the breakout-volume check, which needs the not-yet-existing
    // breakout bar's own volume and is dropped — see file header, point 1).
    double handleFar = std::numeric_limits<double>::infinity();
    for (int i = rr + 1; i < last; i++) if (macroBars[i].l < handleFar) handleFar = macroBars[i].l;
    if (!(handleFar >= rim - depthAbs * kChHandleRetraceMax)) continue;

    const int third = std::max(1, cupLen / 3);
    const double vOut = avgVolRange(macroBars, rr - third, rr);
    const double vHandle = avgVolRange(macroBars, rr + 1, last - 1);
    if (!(vOut > 0.0 && vHandle < vOut)) continue;

    const double a = atr(macroBars, kAtrPeriod);
    if (!(a > 0.0)) continue;
    const double sl = kChSlAtr * a;
    const double tp = depthAbs; // measured move, matching cup-handle.js tp1 - rim
    const double rrRatio = tp / sl;
    if (rrRatio < kChMinRR) continue;

    // Breakout level this engine arms at and waits for a touch, rather than
    // requiring (as cup-handle.js does) that the touch already happened on
    // the just-closed bar.
    const double prior2Extreme = std::max(macroBars[last - 1].h, macroBars[last - 2].h);
    const double breakoutLevel = std::max(prior2Extreme, handleExtreme);

    auto& o = order();
    o.triggerPrice.store(breakoutLevel, std::memory_order_relaxed);
    o.side.store(Side::Buy, std::memory_order_relaxed);
    o.relativeStopLoss.store(sl, std::memory_order_relaxed);
    o.relativeTakeProfit.store(tp, std::memory_order_relaxed);
    o.state.store(VposState::ARMED, std::memory_order_relaxed);
    return;
  }
  disarm();
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
  auto& o = order();
  o.triggerPrice.store(price, std::memory_order_relaxed);
  o.side.store(isLong ? Side::Buy : Side::Sell, std::memory_order_relaxed);
  o.relativeStopLoss.store(risk, std::memory_order_relaxed);
  o.relativeTakeProfit.store(2.0 * risk, std::memory_order_relaxed); // 2R, matching fib-confluence.js tp1
  o.state.store(VposState::ARMED, std::memory_order_relaxed);
}

void Rsi2ReversionStrategy::recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& /*microBars*/) {
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
  // at the current close immediately.
  const double slDist = kRsiSlAtr * a;
  auto& o = order();
  o.triggerPrice.store(bar.c, std::memory_order_relaxed);
  o.side.store(longSetup ? Side::Buy : Side::Sell, std::memory_order_relaxed);
  o.relativeStopLoss.store(slDist, std::memory_order_relaxed);
  o.relativeTakeProfit.store(kRsiTpRR * slDist, std::memory_order_relaxed); // ~1.2R, matching rsi2-reversion.js
  o.state.store(VposState::ARMED, std::memory_order_relaxed);
}

} // namespace vpo
