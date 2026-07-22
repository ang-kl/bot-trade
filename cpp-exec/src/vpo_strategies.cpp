// cpp-exec/src/vpo_strategies.cpp — see vpo_strategies.hpp for provenance
// and the arm/trigger-vs-signal distinction.
#include "vpo_strategies.hpp"

#include <cmath>

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

} // namespace vpo
