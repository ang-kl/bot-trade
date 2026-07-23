# Multi-Account Migration Plan

**Status: PROPOSAL — awaiting owner `!!` sign-off. No application code changes in this document's scope.**

- Author: senior trading-systems architect session, 2026-07-24 SGT
- Baseline commit: `63d996ff6997a1d4b9c533667cf49b61810c5ad3` (main, PR #294 squash)
- Ranking criteria honoured, in order: reliability > robustness > alertness > awareness > speed.
- Every architectural claim about the current system cites `file:line` in this repo at the baseline commit.
- Anything not provable from the repo or official cTrader docs is marked **UNVERIFIED** and listed under OPEN DECISIONS.

---

## Phase 0 — Codebase Survey

### Corrections to the operator's stated context

1. **There is no Python service.** The two Railway services are the **Node agent** (`agent/`, `node:20` Dockerfile, port 3001) and the **C++ exec sidecar** (`cpp-exec/`, Debian Dockerfile, port 8091). The only `.py` file in the tree is a vendored artifact inside `node_modules/flatted/python/` and is never executed; there is no `requirements.txt`, Pipfile, or Python Dockerfile anywhere. References to Python appear only as ecosystem name-drops in research notes (`doc_reference/microstructure-frequent-trading-notes.md:96-97`). Everywhere this plan says "Python service" duties, read "Node agent".
2. **The web UI already lists multiple accounts** (`src/components/AccountSwitcher.jsx:19,52`) — but selection is a destructive single-slot swap, not a registry (S1.3 below).
3. **Partial multi-account seams already exist on the write side** (`ctrader_account_roles_json`, `getAutopilotAccounts` at `agent/loop.js:129-139`, per-account dispatch loop at `loop.js:651-665`, `monitored_positions.account_id` at `agent/db.js:180`). The read side — risk, guards, lessons, decisions — is 100% account-global. The migration is therefore mostly a *read-side scoping* project, not a green-field build.

### S1 — Where the single account is wired in

| Concern | Fact | Citation |
|---|---|---|
| Canonical account id | `agent_state` key `ctrader_account_id`; env `CTRADER_ACCOUNT_ID` seeds it once at boot only if unset | `agent/index.js:111-112`; fallback read `agent/lib/ctrader-env.js:26` |
| Runtime reads | All via `getState(db,'ctrader_account_id')` — loop, actions, state routes, pending-orders, reconciler | `agent/loop.js:136,145,320,690,959,1925,1986`; `agent/routes/actions.js:2334,2711,2736,2817,3113`; `agent/routes/state.js:91-92,576,858`; `agent/services/pending-orders.js:110`; `agent/services/reconciler.js:202,233` |
| Credential assembly | `getCtraderCreds(db, accountOverride)` returns `{host, clientId, clientSecret, accessToken, accountId, ready}`; **`accountOverride` param is the existing multi-account seam** | `agent/lib/ctrader-creds.js:18-35` (override consumed at :22) |
| OAuth token storage | ONE global token set in `agent_state`: `ctrader_access_token`, `ctrader_refresh_token`, `ctrader_token_refreshed_at`; env-seeded once | `agent/index.js:101-108` |
| Token refresher | Exactly one: `maybeRefreshCtraderToken` (24h throttle), called only from the main loop | `agent/lib/ctrader-auth.js:20-47,54-69`; call site `agent/loop.js:923-924` |
| One token spans all accounts | `wsGetAccountsByToken` returns every `ctidTraderAccount` the token can operate; the account list route enriches each with balances | `agent/lib/ctrader-ws.js:477`; `agent/routes/actions.js:2270-2303` |
| Account switch today | **Destructive swap-in-place**: `/actions/ctrader-select-account` rewrites `ctrader_account_id`, `ctrader_is_live`, `symbol_id_map`, `account_balance_usd`, `account_leverage`, and collapses `ctrader_account_roles_json` to one element | `agent/routes/actions.js:2744-2781` |
| C++ account identity | Reads `CTRADER_ACCOUNT_ID` env as optional pre-seed; runtime creds arrive via `POST /connect` push from Node; per-order payloads may carry their own `ctidTraderAccountId` | `cpp-exec/src/main.cpp:118-129`; `cpp-exec/src/engine.cpp:177,209,278` |
| Single sidecar broker session | `ensureSidecarSession` caches one `host\|accountId\|accessToken` key (`lastPushedKey`) — two accounts would thrash the sidecar's one session | `agent/lib/exec-engine.js:43-55` |

### S2 — Process model

One Node process, one C++ process. Long-running work in Node:

| Loop | Cadence | Owns | Citation |
|---|---|---|---|
| Main scan loop | 5 min default (1-60 via `loop_interval_min`), self-re-arming `setTimeout`; single-flight mutex `loopRunning`; circuit breaker at 10 consecutive errors | scan → analyze → dispatch → autotrade → reconcile → pending orders → housekeeping | start `agent/index.js:374-376`; `agent/loop.js:30,34-38,72-77,890,897,2044-2050,2077,2084-2086` |
| Telegram inbound poll | Once per loop cycle (`getUpdates` `timeout:0` — **not** a fast poll; command latency ≤ loop interval) | owner commands | `agent/loop.js:883-888`; `agent/services/telegram-control.js:166-175` |
| Fast position monitor | 30 s tick | per-position checks; **hosts the heartbeat watchdog** (`checkHeartbeats` every 2nd tick, `probeCppExec` every 4th) | `agent/services/fast-monitor.js:218-274` |
| Guardian ticker | maintenance interval + tick-driven | THE one persistent Node spot stream (`wsStreamSpots`) over open-position symbols | `agent/services/guardian.js:105-130` |
| VPO feeder | 60 s | pushes bars + sizing to sidecar `POST /vpo-config` | `agent/services/vpo-feeder.js:118-131` |
| Pending-order manager | per loop cycle | broker pending-order lifecycle | `agent/loop.js:1407` |

Connection ownership: every Node broker RPC is an **ephemeral per-call WebSocket** (`agent/lib/ctrader-ws.js:112-114` `wsRun`); no pool, no persistent trade connection. The only persistent Node socket is the guardian spot stream (`ctrader-ws.js:651`). With `EXEC_ENGINE=cpp`, execution routes to the sidecar over HTTP (`agent/lib/exec-engine.js:9-27,128-192`). Telegram outbound is `agent/services/telegram.js` (`sendMessage:143`), inbound is the loop-cycle poll above.

### S3 — State/memory surfaces that would collide across accounts

**SQLite tables (all created in `agent/db.js`) — account scoping status:**

| Table | Line | `account_id`? |
|---|---|---|
| `trades` | db.js:11 | NO |
| `scans` / `analyses` / `signals` / `regimes` | db.js:50/67/86/98 | NO |
| `symbol_hours` | db.js:115 | NO (broker-global, acceptable) |
| `controller_heartbeats` | db.js:124 | NO |
| `token_usage` | db.js:136 | NO |
| `monitored_positions` | db.js:150 | **YES** (db.js:180; stamped at `loop.js:417`, swept on switch `actions.js:2738`) |
| `performance_snapshots` | db.js:195 | NO |
| `agent_state` | db.js:211 | NO (flat global key/value — the biggest collision surface) |
| `action_log` | db.js:216 | NO |
| `pending_orders` / `broker_orders` | db.js:224/247 | NO |
| `trade_postmortems` | db.js:269 | NO |
| `risk_events` | db.js:287 | NO |
| `pending_signals` | db.js:304 | NO |
| `cup_handle_diagnostics` | db.js:324 | NO |

**In-memory globals violating per-account isolation (M2 inventory):**

- `agent/lib/exec-engine.js:43` — `lastPushedKey` (single sidecar session; **the** hard blocker)
- `agent/lib/ctrader-ws.js:497` — `symbolsListCache` keyed by host only
- `agent/services/fast-monitor.js:93-96` — `spikeUntil`/`volCache` keyed by symbol (collide across accounts); `lastCheckAt`/`lastPriceAt` keyed by broker position id (functionally safe)
- `agent/services/session-open-guard.js:62` — `acted` Set keyed by symbol
- `agent/loop.js:75-77` — `loopCount`/`consecutiveErrors`/`loopRunning` (process-wide)
- Already account-safe: `agent/lib/lot-sizing.js:16` `metaCache` keyed `${accountId}|${symbolId}`; `agent/services/fib-strategy.js:88` `barCache` (bars are account-independent)

**Filesystem state (M3 inventory):** one SQLite DB at `DB_PATH` (`agent/index.js:61-74`, `agent/db.js:384`); backtest reports dir `dirname(DB_PATH)/backtest-results` (`agent/lib/backtest-report.js:142-157`); autopilot report HTML (`agent/lib/autopilot-report.js:93-103`); telegram chart HTML (`agent/services/telegram-control.js:86-95`); C++ order telemetry at `TELEMETRY_PATH` single append-only log (`cpp-exec/src/main.cpp:106-110`). None account-scoped.

### S4 — Division of labour: C++ vs Node, and their link

**C++ sidecar** (`cpp-exec/src/main.cpp`): one engine thread (connect + auth + heartbeat + reconcile ~30 s; `main.cpp:132-133`, reconnect loop `engine.cpp:288`), HTTP server gated by `EXEC_SECRET` Bearer (`main.cpp:219`), optional VPO virtual-pending-order engine with 8 real strategy keys (`main.cpp:144-217`), and SpotFeed — a second, dedicated market-data WS feeding the VPO dispatcher (`main.cpp:247-286`; `spot_feed.cpp:83-172`). Routes: `/health /positions /connect /vpo-config /order /amend /close /cancel /config /backtest` (`main.cpp:221-364`). It holds **no credentials of its own** — Node pushes them via `POST /connect` (`exec-engine.js:44-55`); env `CTRADER_*` values are optional pre-seed only.

**Node agent**: everything else — strategy scanning, risk gate, reconciliation bookkeeping, Telegram, UI API, token refresh, sizing (pushed to C++ for VPO; `vpo-feeder.js:89-102`).

**Communication**: Node → C++ HTTP with `EXEC_URL` (default `http://127.0.0.1:8091`) + `EXEC_SECRET` Bearer (`exec-engine.js:20-27`). C++ → Node: none (Node polls `GET /health` / `GET /positions`). Reconcile has a JS/WS fallback path when the sidecar has no data yet (`exec-engine.js:181-188`).

**Broker connection budget today**: C++ = 1 (engine) + 1 (SpotFeed, only when VPO enabled); Node = 1 persistent guardian stream + ephemeral RPC sockets.

### S5 — Deploy pipeline

- Railway GitHub-integration deploys **on push to `main`**, per-service Root Directory (`agent/`, `cpp-exec/`), Dockerfile builders, `restartPolicyType ON_FAILURE` (`agent/railway.json`, `cpp-exec/railway.json`; agent has `healthcheckPath /health`).
- CI gates on PR/push (`.github/workflows/ci.yml`, `.github/workflows/cpp-exec.yml`) — test-only, they do not deploy.
- **`git tag` output is empty** — the `pre-multiacct-baseline` tag required by G1 does not exist yet.
- **Railway rollback has never been exercised** — only documented (`cpp-exec/README.md:44-49`: unset `EXEC_ENGINE` → agent falls back to the JS path). G5's rollback drill is therefore genuinely novel, not a formality.

---

## Phase 1 — Account Registry Design

### R1. Schema

New table `accounts` in the existing agent DB, created via the established `db.js` migration pattern (`CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE`, the same convention as `monitored_positions.account_id` at `db.js:531`):

```sql
CREATE TABLE IF NOT EXISTS accounts (
  account_id      TEXT PRIMARY KEY,      -- ctidTraderAccountId, e.g. '1251247'
  broker_label    TEXT NOT NULL,         -- 'Pepperstone'
  is_live         INTEGER NOT NULL,      -- 1 live / 0 demo (drives host selection, ctrader-creds.js:23-28)
  base_currency   TEXT NOT NULL,         -- 'SGD' | 'USD'
  leverage        INTEGER NOT NULL,      -- 25..200
  enabled         INTEGER NOT NULL DEFAULT 0,
  mode            TEXT NOT NULL DEFAULT 'manage_only',  -- 'active' | 'manage_only' | 'paused' (R3 semantics)
  risk_profile    TEXT,                  -- key into per-account risk overrides (params.risk)
  symbol_universe TEXT,                  -- key into a universes table/state key; NULL = global default
  params          TEXT NOT NULL DEFAULT '{}',  -- free-form JSON per-account strategy overrides
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Seed rows (from the operator's cTrader account screen, 2026-07-24): Live 1252961 (USD 1:30, disabled), Live 1251442 (USD 1:100, disabled), **Live 1251247 (SGD 1:200 — the protected current live account, owner-confirmed)**, Demo 5306502 (USD 1:25), Demo 5268549 (USD 1:200), Demo 5203012 (USD 1:200), Demo 5067353 (SGD 1:200). All hedged-mode.

### R2. Credential model — VERIFIED single-token

One cTID OAuth token covers all its accounts. Proof in-repo: `wsGetAccountsByToken` (`ctrader-ws.js:477`) enumerates every account for the one stored token, and per-account WS auth (`ProtoOAAccountAuthReq`) reuses the same token with a different `ctidTraderAccountId` (`ctrader-ws.js:200,554,665`). The operator's screenshot (7 accounts under one login) confirms it empirically.

Ownership: **the Node main loop remains the only token refresher** (`maybeRefreshCtraderToken`, `loop.js:923-924`) — unchanged. All other components (account workers, C++ sidecar) are token *readers*: workers read `agent_state`, the sidecar receives the token via the existing `/connect` push. One writer, N readers; no change to refresh cadence.

### R3. Registry operations via Telegram

Extends the existing command poll (`telegram-control.js:181-257`), which already handles 10 commands and audit-logs each to `action_log` (`:245-247`):

- `/accounts` — list: id, label, live/demo, enabled, mode, last heartbeat age, equity (from last reconcile).
- `/enable <id>` — `mode='active'`, `enabled=1`.
- `/disable <id>` — **no new entries; existing positions still managed** (guards, SL/TP amendments, weekend sweeps keep running). This is the default "off" gesture.
- `/flatten <id>` — close all positions for that account (per-account variant of the existing `/actions/close-all`, `actions.js:1057-1080`), then `mode='manage_only'`, `enabled=0`. Distinct command, never the default.
- `/pause <id>` / `/pauseall` — like disable but explicitly temporary; sets `mode='paused'`.
- `/status <id>` — per-account deep status (extends `fmtStatus`, `telegram-control.js:141-160`).

Live-account mutations require inline-keyboard confirmation (T3); demo mutations do not.

### R4. Hot reload

Registry rows are read fresh from SQLite at the top of each worker cycle — the same pattern every existing config uses (`loadRiskConfig` re-reads `risk_config_json` per evaluation, `risk.js:88-96`). No cache invalidation machinery needed. Worst-case propagation: one fast-monitor tick (30 s) for guard-relevant flags read there; one main-loop cycle (5 min default) for scan/entry behaviour; **immediately** for Telegram-initiated changes (the command handler applies the row change and the next reads see it). SIGHUP/pub-sub rejected: adds failure modes without beating a 30 s worst case that already satisfies "reliability first".

---

## Phase 2 — Concurrency and Process Model

### C1. Worker model — CHOSEN: (c) hybrid

**One Node agent process containing per-account logical workers (async task-groups), plus the C++ sidecar holding the shared broker connectivity: one trade session multiplexing all account-auths, one SpotFeed market-data connection.**

- (a) process-per-account — REJECTED: N× Railway memory footprints, N token-refresh loops fighting the single-writer rule (R2), N×2 WS connections against broker connection budgets, and Railway service sprawl (a new service per enabled account is operationally hostile to a one-check-in-per-day operator).
- (b) one process / per-account async groups with per-account broker connections — REJECTED: connection count and symbol subscriptions scale ×N, blowing the 150-300 symbol budget (C2) for no isolation gain over (c).
- (c) hybrid — ACCEPTED: cTrader Open API supports authorizing multiple `ctidTraderAccountId`s on one session (`ProtoOAAccountAuthReq` per account over one connection — the repo already reuses one token across accounts per R2; numeric cap **UNVERIFIED**, see L1). Market data is account-independent, so one SpotFeed serves all workers. Per-account state and decisions stay in per-worker objects (Phase 3).

Railway fit: the Node process today runs ~6 timers and one 5-minute loop; per-account workers add O(N) async tasks, not processes. The C++ sidecar already demonstrates the two-connection shape (engine + SpotFeed, `main.cpp:132,272-285`).

### C2. Shared market data, subscribed once

The existing SpotFeed → VpoDispatcher fan-out (`spot_feed.cpp` `onTick` → `vpo_dispatcher.cpp:114-119`, symbolId-filtered per strategy) is the template. Generalized: SpotFeed subscribes the union of all enabled accounts' symbol universes **once**; ticks fan out in-process to (i) C++ VPO strategies (existing path, unchanged) and (ii) a compact tick relay the Node side polls/streams for its guards (the guardian's own `wsStreamSpots` stream, `guardian.js:105`, retires in favour of this single source — one fewer broker connection).

Backpressure: per-account bounded queues, **drop-oldest with a WARN counter** — for guard logic, the newest price is strictly more valuable than a stale backlog; a growing backlog signals a stalled consumer, which is C3's job to catch, not a reason to buffer unboundedly.

### C3. Supervision

Extends the existing heartbeat layer rather than inventing one: `CONTROLLERS` registry + `beat()`/`checkHeartbeats()` (`agent/services/heartbeat.js:34-127`) already alert once per stall and once per recovery via `notifyOwner`, hosted on the fast-monitor 30 s ticker (`fast-monitor.js:261-267`) precisely so a dead main loop is still detected (`heartbeat.js:5-8`). Changes:

- Each account worker beats `account_worker:<account_id>` into `controller_heartbeats` and mirrors `last_heartbeat_at` onto its registry row (the `/accounts` display field).
- Default stall threshold: `expected interval × factor 3` (matches existing convention, `heartbeat.js:35-48`) — for a 30 s worker tick, alarm at 90 s. Configurable per the registry `params`.
- On stall: (i) watchdog cancels and respawns the worker task, (ii) CRITICAL Telegram alert, (iii) `action_log` incident row (`method='WORKER_RESTART'`, house convention per `reconciler.js:206`).

### C4. Crash isolation

In-process async workers cannot give OS-level isolation, so the boundary is: **each worker's cycle body runs inside a top-level try/catch that no other worker awaits on** (the existing loop already survives per-phase failures this way — e.g. `loop.js:1113-1121`'s try/catch per sweep). A worker that throws logs, beats `ok:false` (existing `beat` failure-streak path, `heartbeat.js:63-79`), and is respawned by C3. A worker that *hangs* is caught by the heartbeat watchdog — which lives on the independent fast-monitor ticker, not in any worker. Shared-process risks that remain (OOM, event-loop seizure) are covered by Railway's `ON_FAILURE` restart + the C++ sidecar surviving independently — and are the accepted cost of rejecting (a); the mitigation is the G6 watch window plus the sidecar's independence (orders in flight complete or reconcile).

### C5. Speed budget

Target: **tick-to-decision ≤ 100 ms for the C++ hot path** (VPO arm/fire already achieves this shape: tick → `onTick` → CAS fire, `vpo_dispatcher.cpp:71-112`), and **≤ 1 worker cycle (30 s) for Node guard decisions** — consistent with the stated ranking: a missed disconnection matters more than 50 ms. Division stands as-is: C++ owns the hot path (tick evaluation, virtual pending orders, order guard), Node owns orchestration, risk gating, Telegram, persistence. No latency-driven rearchitecture is proposed.

---

## Phase 3 — Memory and State Isolation

### M1. Mandatory `account_id` + scoped data access

Additive migration (nullable column + backfill, per the `db.js:531` convention) adding `account_id TEXT` to: `trades`, `scans`*, `analyses`*, `signals`, `pending_orders`, `broker_orders`, `risk_events`, `trade_postmortems`, `pending_signals`, `cup_handle_diagnostics`, `performance_snapshots`. (*scan/analysis rows are account-independent market observations; they gain the column for provenance but may hold NULL = "global scan".) Backfill: existing rows stamp the current `ctrader_account_id` (they are that account's history by construction).

Enforcement layer: a `repo.js` data-access module whose query helpers **require** an `accountId` argument and refuse unscoped access to scoped tables; strategy/guard code loses direct `db.prepare` access to those tables by lint rule (`no-restricted-syntax` on `db.prepare` outside `agent/db.js`/`agent/repo.js` — mechanical to enforce in the existing eslint gate). `agent_state` keys that are per-account move to key prefix `acct:<id>:<key>` with a compatibility read-through for the migration window.

### M2. In-memory state

Per-account `AccountWorker` objects own all mutable state; the S3 globals inventory is the work list: `lastPushedKey` (`exec-engine.js:43`) becomes a per-account session map (or retires — the sidecar multiplexes auths per C1); `symbolsListCache` (`ctrader-ws.js:497`) is host-keyed and may stay (symbol lists are per-host, not per-account) but gains the account-aware key for safety; `fast-monitor` symbol-keyed maps and `session-open-guard.acted` gain account-composite keys. `lot-sizing.metaCache` is already correct (`lot-sizing.js:16`).

### M3. Filesystem namespacing

`/data/accounts/<account_id>/` for: decision JSONL (3A), per-account report artifacts. The single SQLite DB stays shared (scoped by M1's column — splitting DB files per account is rejected: cross-account portfolio guards in 5A need one queryable store). C++ `TELEMETRY_PATH` gains an `account_id` field per record rather than per-account files (single writer, simpler rotation).

### M4. Telegram provenance

Every outbound message prefixed `[L-1251247]` / `[D-5306502]` (live/demo letter + id; formatter wraps the existing `sendMessage`, `telegram.js:143`). Inbound commands take an explicit `<id>` argument; a `/use <id>` sticky selection is supported for convenience and **echoed back in every reply** until changed. Ambiguous commands without id and without selection are rejected with the account list, never guessed.

### M5. Contamination test

A node:test suite that runs two in-memory accounts (initDB(':memory:')) through overlapping trade lifecycles (open A, open B, close A, amend B…) and asserts at the **query level**: every repo.js read issued during account A's worker cycle carries `account_id='A'` (instrumented repo layer records the scope of every query), zero rows from B's account ever surface in A's reads, and the final ledgers match independent single-account runs. Runs in the existing `node --test agent/**/*.test.js` gate.

---

## Phase 3A — Decision Provenance Logging (fixed requirement)

Implemented as specified; the cheap path reuses three existing surfaces instead of building new ones.

### D1. The decision record

One JSONL record per decision event (entry, close, modify, pending place/cancel, **and every deliberate skip**):

```json
{"v":1,"account_id":"1251247","at":"2026-07-24T05:00:00.000Z","controller":"rsi2_reversion","controller_ver":"<git sha or LABEL_VERSION>","inputs":{"rsi2":7.3,"sma100":1.0921,"atr":0.0012,"close":1.0954},"decision":"entry","reason":"rsi2_oversold_above_trend","corr_id":"d-1251247-8f3a","order_ref":null}
```

Foundations already in the repo: `risk_events` stores `veto_reason`/`checks_json`/`proposal_json` per evaluation (`db.js:287-296`; writer `risk.js:676-689`) with structured reason strings (`daily_loss_limit_hit`, `duplicate_symbol …`, `bad_rr`, …, `risk.js:344-651`); trade labels already carry `LABEL_VERSION` (`loop.js:309-317`). The gaps this phase closes, verified in Phase 0: **no account_id on risk_events, no controller version stamp, and scan-phase skips (style/stage/matrix/timeframe gates, `loop.js:542-630`) are stdout-only.**

### D2. Skip-decisions first-class

Every gate that today does `log('…skipping…')` (`loop.js:542,560,577,594,617-630`) emits a decision record with `decision:"skip"` and its gate as `reason`. The Cup & Handle silence-diagnostics table (`cup_handle_diagnostics`, `db.js:324-336` — best-progressed candidate + `blocked_at` gate) is the in-repo proof this reconstruct-why-it-didn't-fire pattern works; 3A generalizes it to every controller.

### D3. Durable sink — recommendation (OPEN DECISION)

`/data/accounts/<id>/decisions/YYYY-MM-DD.jsonl` (append-only, daily rotation) **plus** a thin `decision_log` SQLite index table (corr_id, account_id, at, controller, decision, reason, order_ref) for joins. Independent of Telegram by construction; survives worker death (file append + WAL-mode SQLite). Retention recommendation: JSONL 180 days, index table 90 days (matching the existing `risk_events` 90-day prune, `loop.js:2064`). External sinks rejected for now: new infra, new failure modes.

### D4. Performance by design

Async buffered writer (in-memory queue, batched `fs.appendFile` flush every 1 s or 100 records, flush-on-shutdown); decision events are **never sampled** — only tick-level telemetry may sample. The C++ hot path does not write JSONL: it already emits order telemetry to `TELEMETRY_PATH` (`main.cpp:106-110`) and its decisions (VPO arm/disarm/fire) are surfaced to Node via `/health`/`/positions` counters — the cheap route is a small ring buffer in the sidecar drained by the existing Node poll (`probeCppExec` cadence, `heartbeat.js:169`), persisted by the same Node writer. Decision volume (per 5-min cycle per account, plus VPO recompute events) is orders of magnitude below any I/O ceiling.

### D5. Join path to Trade Lessons

`decision record → corr_id → order/trade (trades.account_id) → trade_postmortems (gains account_id per M1) → lessons-tuner decay keys`. The decay layer (`lessons-tuner.js:79-96`) currently keys on symbol/strategy/timeframe **without account** — under M1 the postmortem reads become account-scoped, so **demo lessons can never tune the live account** (and an explicit "promote demo lesson to live" action is the only crossing, journaled).

---

## Phase 4 — Telegram Awareness Layer

### T1. Severity taxonomy

- **CRITICAL** (immediate, bypass batching): worker dead/restarted, broker connection lost > 60 s, order rejection, margin threshold breach, guard hard-breach (K2), heartbeat stall.
- **WARN** (immediate during G6 watch, otherwise batched at 15 min): heartbeat late, reconnect succeeded, symbol subscription dropped/resubscribed, guard soft-breach.
- **INFO** (batched, 2 h cadence + daily digest): trade open/close digest, routine sweeps.

Implementation: a `notify(severity, accountId, text)` wrapper around the existing `sendMessage`/`notifyOwner` (`telegram.js:143`; `telegram-control.js:273-278`), with the batch queue flushed by the fast-monitor ticker. The existing scattered mute logic (`alertVetoOnce` 6 h mutes, `loop.js:55-70`) folds into this layer.

### T2. Daily digest

One message per enabled account + one portfolio roll-up at a fixed SGT hour: positions, realised/unrealised PnL, incidents (from `action_log`), worker uptime (from `controller_heartbeats`). Builds on the existing per-day journal document sender (`sendDocument`, `telegram.js:160-171`).

### T3. Command safety

Telegram Bot API inline keyboards (**not currently used anywhere** — `telegram-control.js` sends plain text only; this is new but small): any command that can close positions or disable/enable a LIVE account sends an inline-keyboard `Confirm [L-1251247] flatten? ✅/❌` step; demo accounts execute immediately. Confirmations time out (60 s) to no-op.

### T4. Outbound rate limiting

Per-severity token bucket + collapse rule: if ≥3 CRITICALs share a cause-class within 30 s (e.g. broker outage hitting every account), send ONE aggregated CRITICAL ("connection lost on 5 accounts: L-1251247, D-…") and suppress duplicates for the collapse window, with a summary when the storm clears. (Telegram's own API limits: ~30 msg/s bot-wide, 1 msg/s per chat — **UNVERIFIED** from official docs, listed in L1/OPEN DECISIONS.)

---

## Phase 5 — Limits, Reliability, Robustness

### L1. cTrader Open API constraints

| Constraint | Value | Status |
|---|---|---|
| Non-historical requests | **50 req/s per connection** | VERIFIED — help.ctrader.com Open API FAQ |
| Historical requests (trendbars etc.) | **5 req/s per connection** | VERIFIED — help.ctrader.com Open API FAQ |
| Keep-alive | ProtoHeartbeatEvent at least **every 10 s**; proxy emits heartbeats after ~30 s idle | VERIFIED — help.ctrader.com (Open API FAQ / connection docs) |
| Multiple accounts per connection | Supported (one `ProtoOAAccountAuthReq` per account on one session; one token spans the cTID — proven in-repo, `ctrader-ws.js:477`) | Mechanism VERIFIED; **numeric cap UNVERIFIED** |
| Max symbol spot subscriptions per connection | — | **UNVERIFIED** — not in public docs; must be answered by Spotware support ticket + empirical staging probe before the 150-300 universe is finalized |
| Access-token lifetime / refresh window | — | **UNVERIFIED** (repo refreshes every 24 h as a defensive habit, `ctrader-auth.js:14`) |
| Reconnection throttling / ban policy | — | **UNVERIFIED** |

Budget math at 50 req/s: the current design's request rate (5-min scan cycles, 30 s guards, batched trendbars at 5/s historical) is far below ceiling even at N=7 accounts; the binding constraint is the **unverified symbol-subscription cap**, which is why C2 subscribes the union once.

### L2. Reconnection strategy

Exponential backoff with full jitter (base 1 s, cap 60 s), then on success: re-auth all account-auths, resubscribe the full symbol union, and **mandatory reconciliation before any new decision**: fetch broker truth (`reconcile`, `exec-engine.js:170-192`), diff against local `monitored_positions`, alert WARN on any mismatch and adopt broker truth — never trust local state across a gap. The C++ engine's existing reconnect loop (`engine.cpp:288`) and Node's reconcile-desync auditing (`reconciler.js` `RECONCILE_DESYNC` rows, `:206`) are the seams; the change is making post-reconnect reconcile a *blocking precondition* for the affected account workers.

### L3. Idempotency

**Confirmed gap.** Order submission today carries no client order id: `wsPlaceOrder` sends a raw `NEW_ORDER_REQ` (`ctrader-ws.js:228-243`); `clientMsgId` is per-socket request/response correlation only (`:128,138`); dedupe is post-hoc (risk-gate `duplicate_symbol` veto, `risk.js:398-411`, and reconciler relinking). This matches the historical 4× duplicate USDIDR incident this repo already paid for. Fix: every submission generates a `clientOrderId` (= 3A `corr_id`), persisted to `pending_orders` **before** the wire call; retries re-send the same id; the reconciler treats a broker position/order bearing an already-consumed id as the same logical order, never a new one. (Whether cTrader echoes a client order id end-to-end on `ProtoOANewOrderReq` — **UNVERIFIED**; if the field is not honoured, the same guarantee is implemented by the persist-before-send ledger + label matching, which the reconciler already does for positions.)

### L4. Degradation ladder (symbol budget exceeded)

Shedding order, automatic, each step journaled + WARN: (1) demo accounts' non-position symbols, lowest-priority tier first; (2) demo accounts' scan universe entirely (open-position symbols always retained); (3) live account's lowest-priority tier; (4) **never shed**: symbols with open positions or working orders on any enabled account, and the live account's core tier. Symbol tiers are a registry `params` field per account.

---

## Phase 5A — Global Capital Protection (fixed requirement)

### K1. Global guards and proposed defaults (all OPEN DECISIONS for sign-off)

Stored as `global_guards` (single JSON in `agent_state`, single writer = registry/Telegram layer). Per-account `params.risk` may **tighten only**: effective cap = `min(global, account)`, effective floor = `max(global, account)`, enforced in one `effectiveGuards(accountId)` function that every gate calls — never by convention. (Precedent: the risk gate already merges `risk_config_json` over defaults in one place, `risk.js:88-96`; this generalizes that merge with the asymmetry rule.)

| Guard | Proposed default |
|---|---|
| Per-account max daily drawdown | 3% of day-start equity, AND absolute cap: 50 SGD for L-1251247 (its equity is 34.30 SGD — the % alone is meaningless at this size), 1,500 USD-equiv for demos |
| Portfolio max daily drawdown | 5% of aggregate day-start equity |
| Equity floor per account | 75% of trailing 30-day high-water mark → auto-pause to no-new-entries |
| Max risk per trade | 5% (current `perTradeRiskPct` default, `risk.js:25`) as the global ceiling |
| Max concurrent open exposure | 5 positions/account (current `maxOpenPositions` default, `risk.js:63`), 12 portfolio-wide |
| Max correlated exposure, same symbol across accounts | 2 accounts may hold the same symbol+direction simultaneously |

### K2. Tiered breach behaviour (recommendation, OPEN DECISION)

- **Soft breach** (≥80% of any cap): WARN + no new entries for the affected scope (account or portfolio).
- **Hard breach** (≥100%): per-G6 kill-switch semantics — flatten-capable `/killswitch <id>` fires (account scope) or `/pauseall`+flatten prompt (portfolio scope) + CRITICAL. The flatten machinery exists (`/actions/close-all`, `actions.js:1057-1080`; equity-stop close-loop, `loop.js:1841-1882`) and gains account scoping in M1.

**Survey-driven hardening (required for 5A to be real):** the current `halt` flag is enforced **only** in the C++ order_guard; the JS exec path checks brackets but not halt (`exec-engine.js:111-134`). The guard layer must be enforced in `exec-engine.placeOrder` itself — the one chokepoint both modes share — so no execution path can bypass a breach state.

### K3. Storage and change control

Guards live beside the registry, hot-reloadable per R4. Any change affecting a LIVE account: inline-keyboard confirm (T3) + journal entry with before/after values (`action_log` house pattern + `/journal/`). Demo changes: immediate, still journaled.

### K4. Fail-safe posture

`effectiveGuards()` returns a poisoned sentinel if `global_guards` is unreadable, unparseable, or older than a freshness threshold (recommend 24 h heartbeat-touch); every gate treats the sentinel as **no-new-entries + WARN**. Never "trade with last known" and never "trade unlimited". (Precedent for freshness-fail-safe: the C++ VpoConfigStore treats >5-min-stale bars as absent, `vpo_config_store` per `doc_reference/cpp-virtual-pending-order-engine.md`.)

### K5. Broker-truth evaluation

Guards evaluate against the most recent successful reconcile (broker equity/positions — the same source the Account Health layer already prefers, per the "broker-truth balance" work in PR #290), with L2's blocking reconcile after any gap. A reconcile older than 2× its cadence (~60 s sidecar / per-cycle Node) triggers the K4 posture for entry decisions.

---

## Phase 6 — Migration, Testing, Rollback

Sequenced so live account 1251247 is the last thing touched.

- **G1. Baseline tag.** `git tag pre-multiacct-baseline` at `63d996ff…` (repo currently has **zero tags** — S5). Record in `/journal/`: tag, sha, and the Railway deployment IDs for both services. *The deployment IDs are not obtainable from this sandbox (no Railway access) — the journal entry carries a placeholder the operator fills from the Railway dashboard before M1 begins.* `[LIVE-IMPACT: none]`
- **G2. Compatibility shim (M0).** Registry with exactly one enabled account (the current one) drives the existing single-account code paths via the `getCtraderCreds` override seam (`ctrader-creds.js:22`) and `getAutopilotAccounts` fallback (`loop.js:135-138`). Regression: replay recorded scan cycles and diff decision logs byte-for-byte against pre-shim output; the full existing gate (CI + 825+ agent tests) must stay green. No release proceeds until this passes. `[LIVE-IMPACT: none — behaviour-identical by test]`
- **G3. Staging soak on demo.** Second Railway environment (separate service instances + separate env-var set per P3) running ONLY demo accounts 5306502, 5268549, 5203012, 5067353. **Soak: 5 trading days including one full weekend closure** (weekend sweeps are account-critical paths — `weekend-bank.js` / `weekend-loss-flag.js` must prove account-scoped behaviour). Success criteria: zero contamination-test failures, zero unexplained worker restarts, continuous heartbeats, Telegram taxonomy behaving, decision logs complete (spot-audit joins per D5). `[LIVE-IMPACT: none — live account absent from staging registry]`
- **G4. Cutover. RECOMMENDED: option (a) zero-downtime.** Production deploy of the multi-account build with 1251247 present-but-disabled in the registry; verify demo workers healthy in production; then `/enable 1251247` via Telegram (inline-confirm). The account is flat or near-flat (34.30 SGD equity) so exposure during the window is minimal; existing positions, if any, are adopted by the manage-only path before enable. Option (b) planned pause (`/pauseall` → swap → resume, max window 30 min) is the fallback if (a)'s shim verification cannot be trusted. `[LIVE-IMPACT: deployment restart interrupts the agent for seconds-to-minutes; mitigation: the C++ sidecar deploys first and independently; the agent restart window has no working pending orders (checked pre-deploy via /pending); broker-side SL/TP remain live at the broker throughout — protection does not depend on our process being up]`
- **G5. Rollback drill BEFORE cutover.** On staging: redeploy `pre-multiacct-baseline` via Railway rollback, confirm the old build boots and trades demo; journal the observed rollback duration. This has **never been exercised** (S5) — treat the first drill as discovery, not confirmation. `[LIVE-IMPACT: none — staging only]`
- **G6. Post-cutover watch.** 24 h: WARN promoted to immediate, `/killswitch <id>` (= flatten + disable, the per-account composition of `/actions/close-all` + `/disable`) verified on demo before cutover day. `[LIVE-IMPACT: monitoring only]`
- **G7. Automatic rollback trigger.** Any CRITICAL on 1251247 attributable to the new architecture within the watch window → auto `/pause 1251247` (no new entries) + operator CRITICAL with a one-tap rollback confirmation; on confirm (or 30 min unacknowledged + a second CRITICAL), roll back to `pre-multiacct-baseline` and post-mortem in `/journal/`. Fully automatic rollback without operator ack is deliberately NOT proposed (a false-positive rollback is itself a live-risk event); the auto-pause makes the account safe while awaiting the human. `[LIVE-IMPACT: pause only, entries stop, positions managed]`

---

## Phase 7 — Railway Service Topology

### P1. Target topology (recommendation, OPEN DECISION)

Keep exactly two services; add no infrastructure:

- **Node agent** — owns: registry (single writer), token refresh (single writer), all per-account workers, Telegram (in+out), risk/guards, decision-log persistence, SQLite DB on the `/data` volume (`DB_PATH`, `index.js:61-74`).
- **C++ sidecar** — owns: broker connectivity (multiplexed trade session + SpotFeed), order guard, VPO engine, order telemetry. Receives everything by push (`/connect`, `/vpo-config`, `/config`) — **it never reads the DB**, preserving today's clean seam (`exec-engine.js:44-55`).
- Shared state = the existing SQLite DB + HTTP push. Postgres/Redis rejected: new failure modes and operational surface against a reliability-first ranking, for coordination needs that one process + one push channel already satisfy.

### P2. One writer

Node agent is the sole registry/guards writer. The C++ service's view of "which accounts, which symbols" arrives exclusively via push from Node — already the established pattern (creds via `/connect`, VPO config via `/vpo-config`). No second writer exists by construction.

### P3. Environment separation

Staging gets: its own `AGENT_SECRET`/`EXEC_SECRET`, its own Telegram bot token (separate bot → separate chat, so staging noise never lands in the production channel), its own `DB_PATH` volume, and — critically — **a registry whose only rows are demo accounts**, plus a boot guard: if `ENVIRONMENT=staging` (new env var) and any registry row has `is_live=1 AND enabled=1`, refuse to start and alert. The OAuth token technically can operate live accounts (one token per cTID — R2), so the enforcement point is the registry boot guard + the absence of live rows, journaled as a known residual risk unless a second cTID is created for staging (**operator choice, OPEN DECISION**).

---

## OPEN DECISIONS (owner sign-off required)

| # | Decision | Recommendation | Why (one line) |
|---|---|---|---|
| 1 | C1 worker model | Hybrid (c): one Node process + per-account async workers + C++ multiplexed connectivity | Isolation where it matters (state), sharing where it's scarce (connections/symbols) |
| 2 | R3 disable semantics | `/disable` = no-new-entries+manage (default); `/flatten` = close-then-stop (separate command) | Selling into thin markets to satisfy an off-switch is the weekend-bank lesson in reverse |
| 3 | D3 decision-log sink + retention | `/data` JSONL per account (180 d) + SQLite `decision_log` index (90 d) | Durable, Telegram-independent, zero new infra; matches risk_events prune |
| 4 | K1 guard defaults | Table in Phase 5A | Anchored to current risk.js defaults where they exist |
| 5 | K2 breach tiering | Soft at 80% (WARN + no-new-entries), hard at 100% (killswitch + CRITICAL) | Early warning without hair-trigger flattening |
| 6 | G3 soak duration | 5 trading days incl. one weekend closure | Weekend sweeps are account-critical paths that must be seen live |
| 7 | G4 cutover option | (a) zero-downtime, live row starts disabled | The live account is near-flat; enable-after-verify beats a pause window |
| 8 | P1 registry store | SQLite `accounts` table in the existing agent DB | Single writer exists already; no new infra |
| 9 | Staging cTID | Same cTID with boot guard (cheap) vs second cTID (hard isolation) | Boot guard is code; second cTID is an operator account-management task — owner's call |
| 10 | L1 UNVERIFIED: symbol-subscription cap per connection | Ask Spotware support + empirical staging probe before finalizing the 150-300 universe | The binding constraint for C2; must not be guessed |
| 11 | L1 UNVERIFIED: numeric max accounts per connection | Same verification route | Bounds C1's multiplexing at N>7 |
| 12 | L1 UNVERIFIED: token lifetime; reconnection throttling; Telegram bot-API send limits | Same; keep 24 h defensive refresh meanwhile | Affects R2/L2/T4 tuning only, not architecture |
| 13 | L3: does cTrader honour a client order id end-to-end? | Verify against Open API messages doc + staging probe; fall back to persist-before-send ledger either way | Determines whether idempotency is wire-level or ledger-level |
| 14 | Live-account set | 1251247 only (owner already confirmed); 1252961/1251442 seeded disabled | Matches the funded, checked account |

---

## Milestone sequence and rough effort

| Milestone | Content | Effort (focused sessions) |
|---|---|---|
| **M0 — Shim** | G1 tag + journal; `accounts` table + seed; single-enabled-account compatibility mode; byte-for-byte regression harness | 1-2 |
| **M1 — Registry + scoping** | M1 column migrations + repo.js scoped DAO + lint rule; agent_state `acct:` prefixing; M3 filesystem namespacing; contamination test (M5) | 2-3 |
| **M2 — Workers + connectivity** | Per-account workers + supervision (C3/C4); sidecar multi-auth multiplexing + SpotFeed union subscription (C2); L2 reconnect/reconcile; L3 client order ids | 3-4 |
| **M3 — Telegram + guards** | T1-T4 (severity, digest, inline confirms, rate collapse); M4 provenance tags; R3 commands; 5A global guards incl. the JS-path halt fix; 3A decision logging (D1-D5) | 2-3 |
| **M4 — Staging soak** | P3 staging env; G3 5-day demo soak; G5 rollback drill; L1 empirical probes (subscription cap, account cap) | 1 + soak calendar time |
| **M5 — Cutover** | G4 option (a); G6 24 h watch; G7 trigger armed | 1 + watch window |

3A and 5A land in M3 — before any live exposure — and are exercised throughout the M4 soak.

---

*End of plan. No application code was modified. Awaiting `!!`.*
