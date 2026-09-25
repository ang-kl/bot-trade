# V3 P1/P4 — startup and load measurement (M1, 25-09-2026)

Status: **instrument only.** This change records the startup window and the
steady-state latency of every boot. It grades nothing. The limits in §6 are
proposals until the owner confirms them (closure:205). Until then, no reading
below may be called Passed or Failed against them.

M3 adds the grading (`docs/v3-p1p4-harness-2026-09-25.md`): four goal rows
marked `proposed`, and a read-only harness that prints Passed / Failed /
Not Verifiable against the **proposed** limits. It labels every grade as
proposed, and none of it is acceptance until the owner confirms the limits.

## 1. Why

The last two boots were read by hand, late:

- #1085 was read 15 minutes after boot. The fast monitor showed a 43,050 ms
  10-minute max and skipped 44–48 % of ticks.
- #1086 showed 24.8–43 s passes and a 33–48 % skip share.

Nothing recorded the first minutes of either boot. `/state/route-timings` lives
in memory and was lost at the next restart. `/health` keeps only the last loop
time. A startup window that nobody recorded is lost evidence. A good later cycle
does not erase a failed one (closure:196-198). From this change on, each boot's
window is recorded, and the next boot keeps it.

## 2. BOOT: one origin

**BOOT = process start = `performance.timeOrigin`** (`agent/services/boot-clock.js`).

- Every `sinceBootMs` is measured from BOOT.
- Live events use `performance.now()`, which is monotonic, so a wall-clock
  step cannot distort them.

The docs used three different definitions before this:

| Old wording | Source | Relation to BOOT |
|---|---|---|
| "Database-open to BOOT" | closure:161 | Now `db.openedSinceBootMs` |
| "listening after BOOT" | decision-audit-startup:43 | Now `listening.sinceBootMs` |
| "after container start" | closure:116 | **Not visible from inside the process.** Container start → process start (image entrypoint, npm) needs the platform's deploy timestamps. |

## 3. What is recorded, and where to read it

All of it is on **authenticated** `GET /health`. The public body is unchanged,
and `agent/health-exposure.test.js` checks that.

### 3.1 `bootRecord.current` and `bootRecord.previous`

`current` is read from memory. `previous` is the process this one replaced,
read from `boot_record_prev_json`. It holds these fields:

- **Identity:** `bootId`, `bootAt` (BOOT as ISO), `commit`, `startupWindowMs`
  (900,000 ms, proposed).
- **`db`:** `db.js`'s own phase timings (`init`) and `openedSinceBootMs`.
- **`listening`:** `{at, sinceBootMs}`.
- **`first`:** the first time each of these ran after boot. Each stamp is
  written **once per boot** and records its outcome. A later good pass never
  overwrites a failed first one. The stamps are:
  - `loop`: `{startedAt, ms, ok, phaseMs}`.
  - `fastTick`: `{ms, ok, completed, checked}`.
  - `band`: `{ms, overran, ok, error}`.
  - `protectionAudit`: the first all-account Node audit. Records
    `{ok, accounts, errors, unauditable}`.
  - `cleanProtectionAudit`: the first audit with no error that was not blind.
  - `slowMonitor`: `{positions}`.
  - `equityStop`, `adaptiveBreaker`, `performanceBreaker`: `{ok, …}`.

  The equity stop and both breakers run **only in the main loop**. Their
  first evaluation after boot therefore waits for the whole first loop, which
  measured 58–134 s. So the first loop matters for protection, not only for
  entries, and these stamps show when that protection first ran.
- **`startupLag`:** the worst event-loop stall inside the startup window, as
  `{ms, at, loopPhase, loopPhaseAtArm}`. It comes from the 100 ms probe's tap
  (§4).
- **`startupHttp`:** status counts for requests completed inside the startup
  window.
  - Includes totals by class, `first5xx`, and every route that had a
    4xx, 5xx or `aborted`.
  - `complete: false` means the window is still open, so the counts are
    partial.
- **`budgetOverruns`:** see §3.3.

### 3.2 `latencyWindows`

- **`mainLoop`:** the last 360 completed cycles, with n, p50, p95, p99, max
  and the last value (nearest rank). The first loop is included here and is
  also reported separately in `first.loop`.
- **`eventLoopLag`:** `last10m`, `last2h` and `sinceStart` from the tap. Each
  has n, `maxMs`, `p50LeMs`, `p95LeMs`, `p99LeMs`, `worst` and the full
  histogram.
- **`budgetOverruns`:** see §3.3.

### 3.3 Budget overruns

Heartbeats keep only `last_error`, so these are now counted per 10-minute
window and since boot. Two kinds are counted:

- Every band step whose wait was abandoned (`withBudget`). This covers
  `loss_guardian` (5 s), `protection_audit` (5 s), `trade_guards`,
  `profit_keeper`, `pnl_watch`, `loss_cap`, `profit_ratchet` and `cpp_probe`.
- The protection audit's **4 s per-account** budget, as
  `protection_audit_account`.

### 3.4 Fast-monitor receipts and pass timing

Per-position receipts are in `fast_monitor_position_work_json`. Each receipt now
keeps these fields:

| Field | Meaning |
|---|---|
| `lastPricedAt`, `lastPricingMs` | When the position was last priced, and how long the quote took: about 0 ms from the sidecar, up to the 6 s broker timeout |
| `lastQuoteSource` | `sidecar` or `broker` |
| `lastQuotePick` | `sidecar`, `stale` or `missing`: why the broker was asked |
| `lastOutcome` | `evaluated`, `quote_unavailable` or `error` |
| `lastVolFetchAt`, `lastVolFetchMs` | The relVol trendbar fetch (15 s timeout) |
| `lastTokenWaitMs` | The part of that fetch spent waiting for the shared 4/s historical token bucket. `null` means the fetch never reached that step. It does not mean 0. |

These fields carry over through `not_due` passes. Before this change, a
`not_due` pass 3 s after a pricing pass blanked them.

The pass record (`fast_monitor_pass_json.tick.lastTiming`, and `/health`
`fastMonitor.lastTiming`) keeps the last pass that did broker work. It holds
`{priced, pricingMs, brokerQuotes, volFetches, volFetchMs, tokenWaitMs, passMs}`.

What each field can answer:

- `lastQuotePick` separates two cases:
  - `stale` with a null broker answer: a closed market.
  - `stale` with a broker quote: a quiet symbol in an open market (the
    reviewer's second D1 mechanism).
- `lastTokenWaitMs` shows whether the 43 s first pass was waiting for tokens.

## 4. The event-loop lag tap

`sampleLag()` reads and **resets** its window at every loop phase boundary, so
it cannot serve as a process-wide figure. The 30-second ALIVE line
(`lib/diagnostics.js`) misses any stall that does not cross its due time.

The tap is fed by the same 100 ms probe and is never reset. It keeps three
things:

- a histogram since start;
- one-minute slots, two hours of them;
- the worst stall, with `at` and the main loop's phase label.

Read it with these points in mind:

- **Percentiles are upper bounds.** `p99LeMs` means 99 % of probes were at most
  this late. The bucket edges include 1,000 and 5,000 ms, the proposed limits,
  so the count above each limit is exact.
- **`loopPhase` names what the main loop was doing.** It does not prove the
  cause. `idle` means the loop was asleep, so the stall came from an HTTP
  handler or a ticker. That is D2's candidate class (`/scans`, `/risk-events`
  and broker-history in the reviewer's notes). `pre-cycle` is the work before
  the cycle's mutex.
- **Windows are rounded out to whole one-minute slots.** `coveredFrom` gives
  the actual start of the data.

## 5. Route timings: status codes and bounded keys

`/state/route-timings` rows now carry `status` (2xx, 3xx, 4xx, 5xx, aborted,
other) and `last5xx`. `statusTotals` sums them. Every route is covered,
including `/health` (timed, not logged) and `/actions/*`. The timer runs
before the auth middleware, so 401s are counted too.

**Keys** were `req.path` read at finish. By then a mounted router has stripped
its prefix, so `/state/X` and `/actions/X` were both keyed `/X`. Now:

- A matched route is keyed by `req.baseUrl + route pattern`, for example
  `/state/scans/:symbol`.
- Everything else goes into a fixed bucket: `/state/*`, `/actions/*`,
  `/assets/*`, `/fonts/*` or `/*`.

**What filled the 120-route cap.** It was found before the cap was raised. The
timer runs before `express.static` and the SPA fallback and keyed by raw path.
The cap was spent on four kinds of path:

- every hashed chunk under `/assets`: 31 per build, a new set per deploy, plus
  the previous build's names still requested by open tabs;
- `/fonts`;
- every SPA page and every scanner probe;
- API routes whose ids were short or not numeric: `/state/scans/:symbol`,
  `/state/position/:id` with fewer than 4 digits, `/state/analysis/:id` and
  `/state/backtest-reports/:name`.

With pattern keys, the key set is bounded by the code's route table. The cap is
now 256, which is headroom rather than the fix.

## 6. Proposed limits (owner to confirm; not applied by this change)

| Criterion | Proposed | Read from |
|---|---|---|
| Listening | ≤ 15 s after BOOT | `bootRecord.current.listening.sinceBootMs` |
| Event-loop lag, startup window | max < 5,000 ms, p99 < 1,000 ms | `startupLag`, `eventLoopLag.last10m` histogram |
| 5xx on `/health`, heartbeats, runtime manifest, account and protection routes | 0 | `startupHttp.routes` |
| Report 503s | counted and listed; whether any are tolerated is the owner's decision | `startupHttp.routes` |
| First protection band | completes, no overrun | `first.band` |
| First Node audit | fresh for 7/7 | `first.cleanProtectionAudit` + heartbeats |
| First equity stop / breakers | evaluated within X (**owner sets X**) | `first.equityStop` etc. |
| First loop | bar to be set by the owner (60 s is only a proposal, closure:62) | `first.loop.ms` |
| Main-loop p95 | ≤ 60 s | `latencyWindows.mainLoop.p95` |
| Fast-monitor tick max, skip share | ≤ 6,000 ms, ≤ 10 % per 10 min | `fastMonitor` (existing) |

Grading rules:

- A PASS needs data present in the window.
- Absent or stale data grades **Not Verifiable**, never Passed.

## 7. Still Not Verifiable after this change

- **Container start → process start.** Needs platform deploy timestamps.
- **Broker-confirmed protection latency (p95/p99).** Node-side amend timing is
  M5. Native trail-engine amends are not visible to Node.
- **Due-to-evaluated lateness as a composite with the amend round trip.** The
  receipts give the lateness side (`nextDueAt` vs `lastCompletedAt`). The
  round-trip side is M5.
- **Non-pooled token wait.** The token wait is reported by both request paths.
  Only the pooled path (`CTRADER_WS_POOL=1`) is exercised by a test, because
  the non-pooled `wsRun` opens a real TLS socket and has no test seam.

## 8. Cost

- **Hot paths:** no new database writes. The stamps, rings and tap live in
  memory.
- **Persistence:**
  - `boot_record_json` is written at most once per 30 s: every 30 s inside the
    startup window or after a stamp, and every 5 minutes otherwise.
  - `boot_record_prev_json` is written once per boot.
  - The stored record stays under 16 KB under load (tested).
- **Loop phases:** three more `phase()` calls per cycle, each one `loop_phase`
  state write.
- **Restarts:** Node only. No change under `cpp-*/**` or
  `agent/lib/exec-engine.*`. Behaviour of trading, risk and protection is
  unchanged.
