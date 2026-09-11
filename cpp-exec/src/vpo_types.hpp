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
  // SETUP GENERATION (11-09-2026 audit, investigation F2 "immutable setup
  // generations"): a seqlock over the four fields above. storeBracket()
  // bumps it to odd before writing and to even after, so a reader that sees
  // an odd value, or a different value after its reads, knows it read a
  // torn or superseded setup and refuses to fire on it. The state CAS alone
  // cannot give this: a recompute already past the FIRED check stores its
  // new bracket before its own arm CAS fails.
  std::atomic<uint64_t> generation{0};

  // Set once at construction, never mutated afterward — plain fields are
  // fine (no torn reads possible on an immutable value).
  const std::string symbol;
  const std::string timeframe; // the MICRO timeframe this order fires on
  const long long symbolId = 0;
  // Symbol price precision (decimal digits) — needed to scale
  // relativeStopLoss/relativeTakeProfit into cTrader's wire units at fire
  // time (see vpo_dispatcher.cpp's relativePoints(), mirroring agent/lib/
  // lot-sizing.js's relativePoints()). Defaults to 5 (most FX majors) for
  // callers that don't have the real per-symbol value yet.
  const int digits = 5;

  VirtualPendingOrder(std::string sym, std::string tf, long long symId, int dig = 5)
      : symbol(std::move(sym)), timeframe(std::move(tf)), symbolId(symId), digits(dig) {}
};

// The ONE writer of a setup's shape (recompute thread only): the bracket is
// written inside an odd/even generation window so tryFire can tell a
// coherent setup from a torn or superseded one.
inline void storeBracket(VirtualPendingOrder& o, double trigger, Side side, double slDistance, double tpDistance) {
  o.generation.fetch_add(1, std::memory_order_acq_rel);   // odd: write in progress
  o.triggerPrice.store(trigger, std::memory_order_relaxed);
  o.side.store(side, std::memory_order_relaxed);
  o.relativeStopLoss.store(slDistance, std::memory_order_relaxed);
  o.relativeTakeProfit.store(tpDistance, std::memory_order_relaxed);
  o.generation.fetch_add(1, std::memory_order_acq_rel);   // even: complete
}

// ARM / IDLE TRANSITIONS NEVER OVERWRITE FIRED (10-09-2026). Reproduced: the
// recompute thread stored ARMED unconditionally, so a strategy whose fire was
// still unresolved (FIRED, waiting on the fire thread) was re-armed and the
// next tick won a SECOND ARMED->FIRED CAS on the same setup. The plain store
// was the hole: a load-then-store can also interleave with the tick thread's
// CAS. These helpers make every recompute-side transition a CAS that refuses
// to touch FIRED; only the fire thread's resetAfterFire() leaves FIRED.
inline bool armUnlessFired(VirtualPendingOrder& o) {
  VposState cur = o.state.load(std::memory_order_acquire);
  while (cur != VposState::FIRED) {
    if (o.state.compare_exchange_weak(cur, VposState::ARMED, std::memory_order_acq_rel,
                                      std::memory_order_acquire)) return true;
  }
  return false;
}
inline bool idleUnlessFired(VirtualPendingOrder& o) {
  VposState cur = o.state.load(std::memory_order_acquire);
  while (cur != VposState::FIRED) {
    if (o.state.compare_exchange_weak(cur, VposState::IDLE, std::memory_order_acq_rel,
                                      std::memory_order_acquire)) return true;
  }
  return false;
}

} // namespace vpo
