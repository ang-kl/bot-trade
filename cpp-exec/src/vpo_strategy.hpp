// cpp-exec/src/vpo_strategy.hpp
//
// StrategyModule: common base class for every virtual-pending-order
// strategy (owner directive 2026-07-22, "Multi-Strategy Dispatcher" —
// EMA, BRK, C&H, FIBC, RSI, VP, VWAP each inherit from one base and
// independently flag ARMED / update their own trigger price).
#pragma once

#include <string>
#include <vector>

#include "vpo_indicators.hpp"
#include "vpo_types.hpp"

namespace vpo {

class StrategyModule {
public:
  StrategyModule(std::string key, std::string symbol, std::string microTimeframe, long long symbolId)
      : key_(std::move(key)), order_(symbol, microTimeframe, symbolId) {}
  virtual ~StrategyModule() = default;

  // Registry key — matches the equivalent Node strategy's key in
  // agent/services/strategies.js (STRATEGY_REGISTRY) so the two stay
  // nameable against each other, even though only some are ported here.
  const std::string& key() const { return key_; }

  // Called ONLY from the background recompute thread (vpo_dispatcher.hpp),
  // never from the hot tick thread. Implementations read macro/micro bars,
  // decide ARM / hold / disarm, and — when arming — set triggerPrice, side,
  // relativeStopLoss, relativeTakeProfit on order() BEFORE flipping state to
  // ARMED, so a hot thread that observes ARMED always sees a fully-formed
  // order (see vpo_types.hpp).
  //
  // `macroBars` — the slower-recomputing aggregation (e.g. 4h, per the
  // owner's initial-scope directive); `microBars` — the faster one (e.g.
  // 15m). Strategies that don't need both may ignore one.
  virtual void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) = 0;

  VirtualPendingOrder& order() { return order_; }
  const VirtualPendingOrder& order() const { return order_; }

  // Called ONLY by the dispatcher, ONLY after a FIRED order's placeOrder
  // attempt completes (success or failure) — re-arms the strategy for the
  // next recompute cycle rather than leaving it stuck FIRED forever.
  void resetAfterFire() { disarm(); }

protected:
  // Disarm back to IDLE — used both by recompute() (setup invalidated) and
  // by resetAfterFire() above.
  void disarm() { order_.state.store(VposState::IDLE, std::memory_order_relaxed); }

private:
  std::string key_;
  VirtualPendingOrder order_;
};

} // namespace vpo
