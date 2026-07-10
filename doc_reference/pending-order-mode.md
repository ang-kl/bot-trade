# Pending Order Mode (resting LIMIT at fib 61.8%)

Plain-language reference. What it is, why it exists, how to turn it
on and off, and how to get out safely.

## Why we built it (the A/B evidence)

We backtested two entry styles at the fib 61.8% level:

- **Close-confirm** (old way): wait for a bar to CLOSE past the level.
  Result: very few trades. It starves the strategy of samples.
- **Touch-fill** (new way): a resting LIMIT order fills the moment
  price TOUCHES the level.
  Result: roughly **10x more trades**, enough data to trust the edge.

The edge is not universal. It only held on some instrument x
timeframe pairs.

**GO set** (armed candidates, owner-approved):

- EURUSD: 3d, 1d, 12h
- USDJPY: 3d
- GBPUSD: 12h, 1d
- NZDUSD: 4h
- MSFT.US: 12h, 4h

**DANGER set** (touch-fill loses badly — never arm these):

- NATGAS
- US30
- XAUUSD

## How it works (architecture)

One pass per agent loop, after the normal autoTrade phase:

1. **Scan** — `scanPendingSetups()` in `agent/services/fib-strategy.js`
   looks at CLOSED bars only, per symbol x timeframe in the matrix.
2. **Risk gate** — every candidate goes through the same risk checks
   as a market trade. No bypass.
3. **Place** — a LIMIT order at the 61.8% level goes out through
   `agent/lib/exec-engine.js` (JS WebSocket path, or the C++ sidecar
   via POST /order when EXEC_ENGINE=cpp).
4. **Record** — the order lands in the `pending_orders` table in
   SQLite (symbol, timeframe, order id, direction, level, SL, TP,
   volume, expiry, status).
5. **Sync each loop** — `managePendingOrders()` in
   `agent/services/pending-orders.js` reconciles our table against
   the broker: adopt fills, cancel invalidated setups, mark expired
   or gone orders.

## Safety story (why this is safe to have in the codebase)

- **Default OFF.** The whole feature is inert unless the agent-state
  key `pending_mode_enabled` is exactly `'true'`.
- **Per-instrument arming.** Even when ON, only symbol x timeframe
  pairs listed in `pending_matrix_json` are scanned. Everything else
  is ignored. The DANGER set is simply never put in the matrix.
- **Broker-side expiry (GTD).** Orders are placed good-till-date, so
  even if the agent dies, the broker deletes the order on its own.
- **Full audit trail.** Every place, cancel, fill-adopt, and expiry
  is written to `risk_events` and `action_log`.

## Controls (HTTP)

- `POST /actions/pending-mode` with `{ "on": true, "matrix":
  { "EURUSD": ["1d", "12h"] } }` — arm. Timeframes are canonicalised
  the same way as the autotrade matrix.
- `POST /actions/pending-mode` with `{ "on": false }` — disarm.
- `GET /state/config` — shows `pending_mode_enabled` and the parsed
  `pending_matrix`.
- `GET /state/pending-orders` — last 50 rows, newest first.

## Rollback / getting out

Turning the mode OFF stops NEW orders only.

`POST /actions/pending-mode { "on": false }` does **not** cancel
orders that are already resting at the broker. (Checked against the
actions route as built: there is no disarm-cancel step.)

To fully flatten after disarming, do ONE of:

1. **Cancel by hand** in cTrader (fastest, certain).
2. **Wait** for the broker-side GTD expiry to delete them.

If a resting order fills after disarm, it becomes a normal position
and the position manager handles it like any other trade.

## Files

- `agent/services/pending-orders.js` — per-loop manager (new)
- `agent/services/fib-strategy.js` — `scanPendingSetups()`
- `agent/lib/exec-engine.js` — `cancelOrder()`
- `agent/lib/ctrader-ws.js` — `wsCancelOrder()` (payload 2108)
- `cpp-exec/` — `POST /cancel` on the sidecar
- `agent/lib/db.js` — `pending_orders` table
