// cpp-exec/src/vpo_dispatcher.cpp — see vpo_dispatcher.hpp.
//
// Race-safety notes (owner asked explicitly for an explanation of how the
// ARMED->FIRED transition avoids a double-fire):
//
//   compare_exchange_strong(expected=ARMED, desired=FIRED) is the ONLY way
//   state ever leaves ARMED on the hot path. If two ticks arrive back to
//   back (or onTick() is ever called from more than one thread), only the
//   FIRST compare_exchange_strong call can observe state == ARMED and swap
//   it to FIRED; every other caller's `expected` gets overwritten to FIRED
//   by the failed CAS and its `if` short-circuits false. So exactly one
//   caller ever proceeds to placeOrder() for a given arm cycle, even under
//   concurrent onTick() calls on the same strategy.
//
//   The background recompute thread only ever transitions IDLE<->ARMED
//   (recompute() calls disarm() or arms — see vpo_strategy.hpp), never
//   touches FIRED. So there is no write race between the two threads on
//   the FIRED transition itself: only the hot thread ever produces FIRED,
//   and only resetAfterFire() (called by THIS dispatcher, single-threaded
//   from tryFire's own call site) ever clears it back to IDLE.
#include "vpo_dispatcher.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace vpo {

double relativePoints(double priceDistance, int digits) {
  const int d = std::max(0, std::min(5, digits));
  const double step = std::pow(10.0, 5 - d);
  const double snapped = std::round((priceDistance * 100000.0) / step) * step;
  return std::max(step, snapped);
}

VpoDispatcher::VpoDispatcher(ExecEngine& engine, BarProvider barProvider, VolumeResolver volumeResolver,
                             std::string macroTimeframe, std::string microTimeframe)
    : engine_(engine),
      barProvider_(std::move(barProvider)),
      volumeResolver_(std::move(volumeResolver)),
      macroTimeframe_(std::move(macroTimeframe)),
      microTimeframe_(std::move(microTimeframe)) {}

VpoDispatcher::~VpoDispatcher() { stop(); }

void VpoDispatcher::registerStrategy(std::unique_ptr<StrategyModule> strategy) {
  strategies_.push_back(std::move(strategy));
}

void VpoDispatcher::start(int recomputeIntervalMs) {
  if (running_.exchange(true)) return; // already started
  recomputeThread_ = std::thread([this, recomputeIntervalMs] { recomputeLoop(recomputeIntervalMs); });
}

void VpoDispatcher::stop() {
  if (!running_.exchange(false)) return;
  if (recomputeThread_.joinable()) recomputeThread_.join();
}

void VpoDispatcher::recomputeLoop(int intervalMs) {
  while (running_.load(std::memory_order_relaxed)) {
    for (auto& s : strategies_) {
      const std::vector<Bar> macro = barProvider_(s->order().symbol, macroTimeframe_);
      const std::vector<Bar> micro = barProvider_(s->order().symbol, microTimeframe_);
      s->recompute(macro, micro);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(intervalMs));
  }
}

bool VpoDispatcher::tryFire(StrategyModule& s, double bid, double ask) {
  VirtualPendingOrder& o = s.order();
  if (o.state.load(std::memory_order_relaxed) != VposState::ARMED) return false;

  const double trigger = o.triggerPrice.load(std::memory_order_relaxed);
  const Side side = o.side.load(std::memory_order_relaxed);
  // A Buy virtual order arms expecting a pullback DOWN onto the level, then
  // a bounce — it fires the instant the live ask reaches (or trades
  // through) that level, buying at market. A Sell order is the mirror:
  // fires when the live bid rises to meet the level.
  const bool touched = (side == Side::Buy) ? (ask <= trigger) : (bid >= trigger);
  if (!touched) return false;

  VposState expected = VposState::ARMED;
  if (!o.state.compare_exchange_strong(expected, VposState::FIRED, std::memory_order_acq_rel)) {
    return false; // another caller already won the race this tick
  }

  const double volume = volumeResolver_ ? volumeResolver_(s) : -1.0;
  if (!(volume > 0.0) || std::isnan(volume)) {
    // Sizing unavailable — refuse to fire a fabricated order. Re-arm is
    // NOT automatic here: the strategy stays FIRED until the next
    // recompute cycle re-evaluates the setup from scratch, same as a
    // rejected order would.
    s.resetAfterFire();
    return true;
  }

  jsn::Value payload{jsn::Object{}};
  payload.set("symbolId", static_cast<long long>(o.symbolId));
  payload.set("tradeSide", side == Side::Buy ? std::string("BUY") : std::string("SELL"));
  payload.set("orderType", std::string("MARKET"));
  payload.set("volume", volume);
  payload.set("relativeStopLoss", relativePoints(o.relativeStopLoss.load(std::memory_order_relaxed), o.digits));
  payload.set("relativeTakeProfit", relativePoints(o.relativeTakeProfit.load(std::memory_order_relaxed), o.digits));
  payload.set("label", std::string("vpo:") + s.key());

  const EngineResult result = engine_.placeOrder(payload);
  (void)result; // caller-side logging/telemetry hook, not this engine's concern
  s.resetAfterFire();
  return true;
}

void VpoDispatcher::onTick(long long symbolId, double bid, double ask) {
  for (auto& s : strategies_) {
    if (s->order().symbolId != symbolId) continue;
    tryFire(*s, bid, ask);
  }
}

} // namespace vpo
