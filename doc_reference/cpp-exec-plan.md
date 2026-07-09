# ADR: C++ Execution Sidecar (cpp-exec)

Status: Accepted (plan approved by owner)
Date: 2026-07-09

## What we decided

- Move **trade execution** and **trade monitoring** into a small C++ service ("cpp-exec").
- Node keeps everything else: **UI**, API, market scan, risk checks, Telegram.
- Node never talks to cTrader for order actions once the flag flips — it asks cpp-exec to do it.

## Why (the honest part)

- The strategy acts on **12h / 1d** candles. Order latency is measured in
  milliseconds; our decisions are measured in hours.
- So C++ does NOT buy us meaningful speed for this strategy.
- What it DOES buy:
  - **Isolation** — a crash or memory leak in the Node app cannot orphan
    an open position; the exec side keeps watching stops/targets.
  - **Robustness** — one small, single-purpose binary with a tight
    surface is easier to keep alive than a large Node process.
  - Owner preference for a hardened execution core.
- Recorded here so future readers know this trade-off was understood,
  not overlooked.

## Architecture

- **cpp-exec** sidecar, second Railway service.
  - Speaks JSON-over-WSS to cTrader Open API (port **5036**), same frame
    shape as `agent/lib/ctrader-ws.js`: `{payloadType, payload}`.
  - Exposes an HTTP control API on port **8091**.
  - Auth: `Authorization: Bearer <EXEC_SECRET>` on every control call.
- **Node delegator**: `agent/lib/exec-engine.js`.
  - Single module every order/SL-TP/close call must go through.
  - `EXEC_ENGINE=cpp` routes to the sidecar; `EXEC_ENGINE=js`
    (the default) keeps today's in-process path.

## Rollout phases

1. **Scaffold** — build cpp-exec, connect, authenticate, heartbeat.
2. **Parity testing** — on the demo account, send the same orders
   through both paths; diff fills, SL/TP amends, closes, reconcile.
3. **Flip** — set `EXEC_ENGINE=cpp` in production.
4. **Rollback ready** — keep the JS path in the code; flipping the env
   var back is the rollback. No redeploy of cpp-exec needed.

## Risks and mitigations

- **Double execution** if both paths ever fire for the same signal.
  - Mitigation: exec-engine.js is the single chokepoint; exactly one
    engine is active per the flag. No other module may open a socket
    to cTrader for order actions.
- **Cost** — a second Railway service bills separately.
- **TLS / WebSocket edge cases** — C++ WSS stacks handle reconnects,
  ping/pong, and partial frames differently from Node's `ws`.
  - Mitigation: parity phase runs long enough to see disconnect and
    reconnect cycles on demo before the flip.

## Out of scope

- No strategy, scan, or risk logic moves to C++.
- No protobuf migration; we stay on the JSON protocol Node already uses.
