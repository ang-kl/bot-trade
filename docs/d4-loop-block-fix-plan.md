# D4 — unblocking the 60-120s monitor-phase loop pass

Owner request (2026-07-27, urgent): production reported the Accounts page
timing out (`POST /actions/broker-positions`, 45s, no response) while 28
positions were open. `docs/outstanding-backlog-2026-07-26.md`'s P14 already
flagged this generally ("production reported `lastLoopMs: 127028`") and
gated any fix behind **D4: a written plan reviewed before any diff** — this
is that plan. **No code changes ship with this document.** It is
LIVE-IMPACT: the account being slowed down has 28 real open positions.

## 0. What actually happened tonight (evidence, not the backlog's guess)

Two live health checks during the incident:

```
lastLoopMs: 66295   openPositions: 28   circuitBreaker: null   errorsToday: 0
```

No crash, no circuit-breaker trip, no data loss — the UI's own error message
("agent is reachable but busy... nothing was changed") was accurate. The
server was simply unable to answer any HTTP request, including `/health`,
for the duration of one monitor-phase tick.

## 1. Root cause (grounded in code, file:line)

The backlog's stated mechanism — *"better-sqlite3 is synchronous, so the
process serves nothing"* — is **not what's actually happening**, and the
fix plan would be wrong if it targeted that. Verified:

- `agent/db.js:499-501` already sets `journal_mode = WAL` and
  `synchronous = NORMAL`. Under WAL, readers are never blocked by writers,
  and commits don't fsync per row. 28 positions × a handful of tiny
  `UPDATE`s each (`agent/loop.js:1992-1998, 2008, 2023, 2047, 2064, 2074,
  2097`) is on the order of **tens of milliseconds total** — not a
  plausible source of 60-120s.
- `evaluatePosition` (`agent/services/position-manager.js`) is pure/sync,
  no I/O.
- `heldPrices` — the per-position current price — is fetched **once
  before the loop**, batched at concurrency 4
  (`agent/services/held-prices.js:35-49`), exactly the pattern this fix
  will reuse. Not the bottleneck.
- `executeBrokerAction` (network: broker amend/close) only runs for
  positions where a deterministic rule actually fired — a handful per
  tick, not all 28.

**What actually dominates**: `agent/loop.js:2083` —
```js
for (const pos of activePositions) {
  ...
  const check = await runMonitorCheck(client, { ... })   // one LLM call
  ...
}
```
`runMonitorCheck` (`agent/services/monitor-svc.js:70-113`) makes one real
`client.messages.create(...)` HTTP round trip to Claude/GPT
**per position, awaited serially, with no batching**. At a realistic
1-4s per call (more under load/retries), **28 × ~2-4s ≈ 56-112s** — this
lines up almost exactly with the reported `lastLoopMs: 127028` and
tonight's `66295`.

The exact same anti-pattern exists a second time, independently, in the
weekend-watch phase (`agent/loop.js:1905-1907`) — gated to run only
~hourly on weekends, so it isn't the cause of tonight's incident, but it
is the same bug and needs the same fix.

Secondary effect worth naming honestly: no single primitive here is a hard
block (no `execSync`, no busy-wait — confirmed absent from
`ctrader-ws.js`/`exec-engine.js`/`monitor-svc.js`), so the event loop is
technically free between awaits. In practice, 28 near-simultaneous HTTPS
connections still contend for Node's default libuv threadpool (size 4,
shared with DNS/TLS handshakes) and add per-request logging/JSON overhead,
which is enough to starve a 5-45s-timeout HTTP client often enough that it
reads, correctly from the user's side, as "unresponsive."

## 2. Proposed fix

**Bounded-concurrency parallelization of the per-position monitor-check
LLM call**, mirroring the pattern `held-prices.js` already uses for price
quotes (chunk the position list, `Promise.all` per chunk, concurrency 4):

```js
// Illustrative shape, not a diff — implementation happens after this
// plan is approved.
const CONCURRENCY = 4
for (let i = 0; i < activePositions.length; i += CONCURRENCY) {
  const chunk = activePositions.slice(i, i + CONCURRENCY)
  await Promise.all(chunk.map(pos => monitorOnePosition(db, s, pos, ...)))
}
```

Everything currently inside the per-position loop body (metrics update,
stage-matrix gate, deterministic rule + `executeBrokerAction`, the
`runMonitorCheck` LLM fallback, its own `executeBrokerAction` on EXIT)
moves into one `monitorOnePosition` function, called at concurrency 4
instead of concurrency 1. Same fix shape applied to the weekend-watch loop
(`agent/loop.js:1890-1946`).

**Why concurrency 4, not unbounded `Promise.all` on all 28 at once:**
mirrors the existing, already-proven `held-prices.js` constant exactly (no
new tuning invented), and caps how many concurrent LLM + broker-API calls
this adds — relevant to both the LLM provider's own rate limits and
cTrader's documented 50 req/s connection budget, which other positions'
`executeBrokerAction` calls also share within the same tick.

**Expected effect**: a 28-position tick drops from ~60-120s to roughly
28/4 × ~2-4s ≈ **14-28s** — better, and short enough that ordinary
UI requests (30-45s client timeouts) mostly complete during a tick instead
of alongside it, though not instant. This is a mitigation, not a total
elimination — see §4 for why full elimination is a larger, separate
change I am not proposing tonight.

## 3. What this fix does NOT do (non-goals, on purpose)

- Does **not** change what the LLM is asked, how often a position is
  reviewed, or any risk/exit logic — purely a scheduling change (serial →
  bounded-concurrent). Same calls, same content, same decisions, just not
  queued one at a time.
- Does **not** touch the reconcile/equity-stop/housekeeping phases — the
  investigation confirmed these are either O(1) in network calls or gated
  to run far less than every tick; they are not contributors to the
  routine 60-120s pass and are out of scope.
- Does **not** attempt to move monitoring off the main event loop (a
  worker thread / child process). The evidence shows the mechanism is
  serial wall-clock stacking of network round trips, not a literal
  synchronous block — bounded concurrency addresses that mechanism
  directly. A separate-thread architecture would be a much larger change
  for a problem this fix already resolves to a large degree.

## 4. Open decisions (need your word before I write a diff)

| # | Question | My recommendation |
|---|---|---|
| D4a | Concurrency level | **4**, matching `held-prices.js`'s existing constant — no new number to justify from scratch |
| D4b | Include the weekend-watch loop in the same PR? | **Yes** — identical bug, identical fix, and leaving it would mean re-doing this review for the same root cause later |
| D4c | Verify `recordAnthropicUsage`/`daily_tokens_used` accounting under concurrency | **Must check before implementing**: if this is a JS-side read-then-write (not an atomic SQL `UPDATE ... SET x = x + ?`), running 4 positions' monitor checks concurrently could under-count the daily token budget (a lost-update race). I have not yet verified which it is — this is an implementation-time check, not a guess I'm willing to bake into the plan |
| D4d | Is 14-28s (post-fix estimate) an acceptable worst case, or do you want a staleness-based throttle too (e.g., skip the LLM call for a position checked within the last N minutes with no price move)? | Recommend **not** bundling this now — it's a monitoring-cadence *behavior* change, not a mechanical fix, and deserves its own decision. Ship the mechanical fix first, measure the real-world tick time with 28 (or more) positions, then decide if a throttle is still needed |

## 5. Test plan (once the above is confirmed)

- Unit test on the extracted `monitorOnePosition` function in isolation
  (mirrors how `evaluatePosition`/`executeBrokerAction` are already
  tested) — one position, mocked LLM/broker responses.
- A concurrency test: N mocked positions, assert they run in
  `ceil(N/4)` batches, not N serial calls (same shape as any
  `held-prices.js` batching test already in the suite).
- The D4c race-condition check from above, resolved as either "already
  atomic, no change needed" or "made atomic as part of this PR" —
  whichever it turns out to be, with a test proving concurrent calls don't
  lose an update.
- Full existing gate (`node --test`, `eslint`, `vitest`, `build`,
  `check:no-green`) — no behavior change to existing single-position
  logic, so the existing test suite should catch any regression in the
  extraction.
- Manual staging soak: arm on staging with several open positions,
  confirm `lastLoopMs` drops and `/health` stays responsive through a
  monitor-phase tick.

## 6. Rollout

Ship as its own PR once D4a-D4d are answered. Given this touches the live
position-monitoring path, per `CLAUDE.md` I'll hold it for your explicit
review even with a green gate, the same way D12 was handled — not
auto-merge, regardless of test results.

---

## 7. Follow-up (2026-07-28): naming the CPU burner

The D4 fix removed the *serial* stacking. It did not remove the block. Later
per-phase instrumentation showed the loop still stalls ~53s at a time, and
`services/event-loop-lag.js` settled the mechanism: during the worst stall the
process burns CPU at a ratio of **1.02 in `monitor`** and **1.01 in
`autopilot`**, while every broker-bound phase sits at **0.02-0.06**. So this is
our own JS holding the single thread, not Railway starving the container and
not network waiting.

That still does not say *which function*. Two previous answers to that question
came from reading the code — the deeper bar fetch, and the broker transport —
and measurement killed both. So the next step is sampled, not read.

`services/cpu-profile.js` takes a real V8 CPU profile over exactly one named
phase and reports self time per call frame, including native frames (synchronous
better-sqlite3 calls, TLS, GC) that no hand-placed timer can see.

**Operating it**

- Off by default. Set `CPU_PROFILE_PHASES` to a comma-separated list of phase
  keys — the same keys that appear in `/health`'s `loopPhaseMs` — e.g.
  `CPU_PROFILE_PHASES=monitor`. `*` arms every phase.
- `CPU_PROFILE_INTERVAL_US` tunes the sampling interval (default 5000µs).
- Read the result at `/health` → `loopCpuProfile`, keyed by phase:
  `totalMs`, `samples`, `idleMs`, `programMs`, `gcMs`, and `top[]` of
  `{ frame, selfMs, pct }` sorted by self time.
- Turn it back off once the burner is named. A diagnostic left running becomes
  part of the problem it was meant to explain.

**Reading it honestly**

- A high `idleMs`/`programMs` share means the phase *waited*, whatever the top
  JS frame says — check that before believing `top[0]`.
- `top[0]` is self time, not inclusive time. `runLoop` will never appear;
  that is the point.
- Arm it on **staging** first. The demo trio is the only account set this may
  run against.
