# C++ Roadmap — controllers & agents

Owner's directive (2026-07-17): *"Build the controller-heartbeat monitor to
reliability. C++ for the controllers and agents."* This document is the
standing plan for where C++ lives in this stack, what each phase buys, and
what would justify the next one. It exists so the decision is written down,
not re-argued.

## Where C++ already runs (Phase 0 — done)

- **Execution sidecar** (`cpp-exec/`): order placement, amendment, close,
  cancel, and position reconcile against cTrader over a persistent
  authenticated session. `EXEC_ENGINE=cpp` routes the keeper's order path
  through it.
- **Backtester** (`cpp-exec --backtest` and `POST /backtest`): the
  compute-bound hot path, where C++ genuinely pays.

## Phase 1 — reliability monitoring (this release)

The failures we have actually had (mislabelled market hours, a reconciler
that skipped our own fills, a precision bug in relative SL) were **logic
bugs, not latency or language problems**. The gap that could hurt us
silently is a controller that stops running — nobody notices until a
position goes unmanaged. Phase 1 closes that:

- `controller_heartbeats` table + `agent/services/heartbeat.js`: every
  background controller (main loop, fast monitor, burn-in, pending orders,
  trade guards, profit keeper, adaptive breaker, autopilot, hours refresh)
  stamps a beat per run, success or failure.
- The **watchdog runs on the 30-second fast-monitor ticker — independent of
  the main loop** — so a silently dead main loop is detected within minutes
  and alerted on Telegram (once per stall, once on recovery; failure streaks
  of 3+ alert once per streak).
- The **C++ engine is actively probed**: when `EXEC_ENGINE=cpp`, the
  sidecar's `GET /health` (reports socket connectivity, credentials, last
  reconcile) is polled every ~2 minutes and recorded as the `cpp_exec`
  heartbeat. That is the "agents" coverage — the C++ process is watched by
  the same monitor, with the same alerting.
- Desk → "Controllers — heartbeats" panel shows live status per controller.

**Honest limit:** if the whole Node process dies, nothing in-process can
alert. That layer is Railway's healthcheck + restart policy (the agent's
HTTP `/state/health` endpoint is the probe target). The heartbeat monitor
covers the worse case: a process that is *up but not doing its job*.

## Phase 2 — C++ liveness reporting both ways (small, when useful)

- Sidecar pushes its own heartbeat (`POST /heartbeat` to the keeper) so a
  half-dead sidecar (accepting TCP, engine thread wedged) is distinguishable
  from a network blip. `/health` already exposes `lastReconcileAt`, so the
  probe can flag a wedged engine thread today by staleness.

## Phase 3 — porting controllers to C++ (only with evidence)

The controllers are **network-bound**: each cycle is dominated by 20–200 ms
broker round-trips and LLM calls, not compute. Porting them to C++ moves
microseconds while the milliseconds stay. It becomes worth doing only if we
have measurements showing:

1. a control decision missed its window because of JS runtime latency
   (GC pause, event-loop starvation) — the heartbeat table now gives us the
   data to prove or refute this; or
2. cadence requirements tighten below ~5 s per position across hundreds of
   concurrent positions, where per-cycle overhead compounds.

If either shows up, the port order is: fast position monitor first (tightest
cadence), then the order-path controllers — each moving behind the existing
sidecar HTTP contract so the keeper stays the source of truth for state.

## Non-goals

- Rewriting scan/analyze in C++: they are deterministic and already fast;
  the bottleneck is broker data fetches.
- Nanosecond-class HFT infrastructure: we trade off a retail cTrader API
  whose own gateway latency is milliseconds; the venue does not offer the
  determinism that nanosecond engineering buys.
