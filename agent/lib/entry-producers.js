// ---------------------------------------------------------------------------
// agent/lib/entry-producers.js — the inventory of every path that can open
// NEW RISK, as code (phase P0 of docs/tick-momentum/plan.md, 11-09-2026).
//
// Plan §13: "Inventory all automatic producers … Every route must reject
// stale mode epochs at the final admission boundary even if an early producer
// check is missing." Blocker B11: "Every automatic producer and fallback
// reaches final admission."
//
// The list is pinned to the source by entry-producers.test.js: every file in
// agent/ that calls execPlaceOrder / exec.placeOrder / autoTrade must appear
// here, every route named here must exist, and the C++ direct path must still
// be the one the inventory says it is. A new producer that is not added here
// turns that test red — which is the review conversation worth having.
//
// `admission` is what stands between the producer and the broker TODAY:
//   exec-engine   — agent/lib/exec-engine.js (exec guard, bracket guarantee,
//                   withAccount, dedupe window) — the Node chokepoint that
//                   exec-chokepoint.test.js enforces
//   cpp-guard     — the sidecar's OrderGuard only (halt, volume cap, bracket);
//                   NO Node risk gate, NO reservation — this is blocker B01/B04
// Phase P2 replaces both with the reservation authority + one-use permit; the
// `family` and `basis` here are what the mode-epoch check keys on.
// ---------------------------------------------------------------------------

export const PRODUCER_FAMILIES = Object.freeze(['automatic', 'manual', 'manual_assisted', 'transport'])
export const ADMISSIONS = Object.freeze(['exec-engine', 'cpp-guard', 'none'])

export const ENTRY_PRODUCERS = Object.freeze([
  {
    id: 'scan_dispatch', family: 'automatic', basis: 'bar',
    file: 'agent/loop.js', via: 'autoTrade → execPlaceOrder',
    trigger: 'main loop: scan → analyse → risk gate → dispatch', admission: 'exec-engine',
    note: 'the ordinary scanner and synthesis path; every strategy in the registry',
  },
  {
    id: 'daily_momentum_account', family: 'automatic', basis: 'bar',
    file: 'agent/services/momentum-account.js', via: 'deps.autoTrade',
    trigger: 'once per day after the daily close, on the momentum account', admission: 'exec-engine',
  },
  {
    id: 'cross_sectional_book', family: 'automatic', basis: 'bar',
    file: 'agent/services/momentum-book.js', via: 'deps.autoTrade',
    trigger: 'every loop cycle from the shadow ranking rows (row-cursor accounts)', admission: 'exec-engine',
  },
  {
    id: 'pending_fib_orders', family: 'automatic', basis: 'bar',
    file: 'agent/services/pending-orders.js', via: 'exec.placeOrder',
    trigger: 'resting limits at Fibonacci levels, including restored ones', admission: 'exec-engine',
  },
  {
    id: 'closed_market_limits', family: 'automatic', basis: 'bar',
    file: 'agent/services/closed-market-limits.js', via: 'exec.placeOrder',
    trigger: 'closed-market and higher-timeframe limits placed for the next open', admission: 'exec-engine',
    note: 'plan B14: placement precedes the evidence gate on this branch',
  },
  {
    id: 'burn_in_probe', family: 'automatic', basis: 'bar',
    file: 'agent/services/burn-in.js', via: 'autoTrade',
    trigger: 'burn-in / probe orders at a fixed small size', admission: 'exec-engine',
  },
  {
    id: 'vpo_cpp_direct', family: 'automatic', basis: 'bar',
    file: 'cpp-exec/src/vpo_dispatcher.cpp', via: 'ExecEngine::placeOrder (C++, in-process)',
    fedBy: 'agent/services/vpo-feeder.js → POST /vpo-config',
    trigger: 'tick touch of a virtual pending level inside the sidecar', admission: 'cpp-guard',
    note: 'blocker B01/B04: sized from a cached minimum-stop volume; no Node risk gate or reservation',
  },
  {
    id: 'route_trade_now', family: 'manual_assisted',
    file: 'agent/routes/actions.js', route: 'POST /actions/trade-now', via: 'autoTrade',
    admission: 'exec-engine',
  },
  {
    id: 'route_validation_fill', family: 'manual_assisted',
    file: 'agent/routes/actions.js', route: 'POST /actions/validation-fill', via: 'autoTrade',
    admission: 'exec-engine',
  },
  {
    id: 'route_execute_trade', family: 'manual_assisted',
    file: 'agent/routes/actions.js', route: 'POST /actions/execute-trade', via: 'execPlaceOrder',
    admission: 'exec-engine',
  },
  {
    id: 'route_manual_order', family: 'manual',
    file: 'agent/routes/actions.js', route: 'POST /actions/manual-order', via: 'execPlaceOrder',
    admission: 'exec-engine',
  },
  {
    id: 'route_position_double', family: 'manual',
    file: 'agent/routes/actions.js', route: 'POST /actions/position-double', via: 'execPlaceOrder',
    admission: 'exec-engine', newRisk: true,
    note: 'plan §13: adds risk; must go through account-scoped admission, not a protection exemption',
  },
  {
    id: 'route_position_reverse', family: 'manual',
    file: 'agent/routes/actions.js', route: 'POST /actions/position-reverse', via: 'execPlaceOrder',
    admission: 'exec-engine', newRisk: true,
    note: 'plan §13: the opening leg is a new entry; a halt between the legs must block it',
  },
  {
    id: 'js_fallback_transport', family: 'transport',
    file: 'agent/lib/exec-fallback.js', via: 'wsPlaceOrder (raw write, allowed by exec-chokepoint.test.js)',
    trigger: 'sidecar down and exec-fallback can prove it did not act', admission: 'exec-engine',
    note: 'a transport under exec-engine, not a producer; listed so the boundary is complete',
  },
])

/** Producers the mode-epoch fence must cover: every automatic one. */
export function automaticProducers() {
  return ENTRY_PRODUCERS.filter(p => p.family === 'automatic')
}

/** Producers that bypass the Node chokepoint today — the P2 work list. */
export function producersOutsideExecEngine() {
  return ENTRY_PRODUCERS.filter(p => p.admission !== 'exec-engine')
}

export function producerInventoryView() {
  return {
    total: ENTRY_PRODUCERS.length,
    automatic: automaticProducers().length,
    outsideExecEngine: producersOutsideExecEngine().map(p => p.id),
    producers: ENTRY_PRODUCERS,
  }
}
