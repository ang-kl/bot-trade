// cpp-exec/src/vpo_types.hpp
//
// Virtual Pending Order Engine — core state types (owner directive
// 2026-07-22, "Zero Native Pending Orders"): every pending order this
// engine manages exists ONLY in this process's memory as one of these
// structs. No broker-side limit/stop order is ever placed for an entry —
// cTrader's ~100-modify/min API limit makes trailing a dynamic VWAP/POC
// level via cancel/replace unworkable, so the level lives here instead and
// fires a plain market order the instant price touches it.
//
// If this process disconnects or restarts while a strategy is ARMED, the
// entry is missed — accepted by design (owner: "do not write a broker-side
// hybrid fallback"). There is no safety net for that window.
#pragma once

#include <atomic>
#include <string>

namespace vpo {

enum class VposState { IDLE, ARMED, FIRED };

enum class Side { Buy, Sell };

// One virtual pending order. `state` and `triggerPrice` are the hot-path
// fields: the background recompute thread writes triggerPrice (and can
// transition IDLE<->ARMED), the tick-execution thread only ever reads
// triggerPrice and attempts the ARMED->FIRED CAS — never the reverse
// direction, so there is no read/write race on the transition itself (see
// vpo_dispatcher.hpp for why CAS, not a plain store, is what prevents a
// double-fire). side/volume/relativeStopLoss/relativeTakeProfit are set by
// the SAME background-thread recompute call that arms the order, atomically,
// so the hot thread never observes a torn/partial order shape: it always
// either sees IDLE (ignore) or ARMED with a fully-formed order (all fields
// current for this arm cycle).
struct VirtualPendingOrder {
  std::atomic<VposState> state{VposState::IDLE};
  std::atomic<double> triggerPrice{0.0};
  std::atomic<Side> side{Side::Buy};
  // Order shape fired on touch — relative distances (cTrader's own
  // relativeStopLoss/relativeTakeProfit units), NOT sizing. Sizing (volume)
  // is deliberately NOT computed here: this engine has no Kelly/margin gate
  // of its own (that logic lives in agent/services/risk.js) and inventing a
  // parallel sizing formula in C++ would be a second, unaudited source of
  // truth for how much capital a trade risks — a volumeResolver hook
  // (vpo_dispatcher.hpp) must supply this before an order can ever fire.
  std::atomic<double> relativeStopLoss{0.0};
  std::atomic<double> relativeTakeProfit{0.0};

  // Set once at construction, never mutated afterward — plain fields are
  // fine (no torn reads possible on an immutable value).
  const std::string symbol;
  const std::string timeframe; // the MICRO timeframe this order fires on
  const long long symbolId = 0;

  VirtualPendingOrder(std::string sym, std::string tf, long long symId)
      : symbol(std::move(sym)), timeframe(std::move(tf)), symbolId(symId) {}
};

} // namespace vpo
