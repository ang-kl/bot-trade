# V3 P1/P4 — startup and load measurement (M1, 25-09-2026)

Status: **instrument only.** This change records the startup window and the
steady-state latency of every boot. It grades nothing. The limits in §6 are
proposals until the owner confirms them (closure:205). Until then, no reading
below may be called Passed or Failed against them.

M3 (§9) adds the grading: four goal rows marked `proposed`, and a read-only
harness that prints Passed / Failed / Not Verifiable against the **proposed**
limits. It labels every grade as proposed, and none of it is acceptance
until the owner confirms the limits.

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

## 9. Grading: goal rows and the read-only harness (M3, 25-09-2026)

M1 records; M3 grades. The limits in §6 are still **proposals**. Nothing
below is acceptance until the owner confirms them (closure:205, H-P1-1).

### 9.1 Four goal rows, marked `proposed`

`/state/goal-table` has four new rows. Each reads what M1 persists
(`boot_record_json`) or each account's raw protection timestamps.

| Row | Reads | Proposed limit |
|---|---|---|
| `startup_window` | The last boot's record: listening, worst stall, 5xx on critical routes, first band, first clean all-account audit, and any first evaluation that failed | listening ≤ 15 s · stall < 5,000 ms · critical 5xx 0 · band without overrun · clean audit ≤ 300 s |
| `event_loop_lag` | `latencyWindows.eventLoopLag.last10m` | max < 5,000 ms · p99 ≤ 1,000 ms |
| `protection_freshness` | Every ENABLED account's Node audit `at` and independent `checkedAtMs` (a disabled account is not audited by design and is not judged) | audit ≤ 120 s · independent ≤ 120 s (2 × the verifier's 60 s cycle) |
| `loop_latency` | `latencyWindows.mainLoop` over the last 360 loops; the first loop is named apart | p95 ≤ 60 s |

How the verdicts work:

- **`proposed`** replaces `on_track`/`off_track` until the owner stamps
  `p1p4LimitsConfirmedAt` with a date through `POST /actions/goal-table`.
  - The row still shows the reading.
  - `proposedVerdict` says what it would read.
  - `summary.proposed` counts these rows. They are **not** counted as off
    track: a proposal shown as a result is what owner principle 6 forbids.
  - The daily report counts them as `N proposed` beside the other three
    verdicts, and names every proposed row that would read off track
    (`would be off track (limits proposed, not confirmed): …`), so nothing is
    hidden by the exclusion.
- **`not_measurable`** holds whether or not the limits are confirmed. It
  applies when:
  - there is no boot record;
  - the record is more than 10 minutes old;
  - the startup window is still open and nothing has failed yet;
  - fewer than 10 loops are recorded.
- **A failure already seen stays.** A stall over the limit, or no band by
  +300 s, makes `startup_window` read (would-be) off track before the window
  closes.
- **Owner-set limits start unset.** Some limits have no proposal:
  `p1p4FirstLoopMaxSec`, `p1p4FirstProtectionMaxSec` and `p1p4Report5xxMax`.
  They default to `null`, and `goalTargets` keeps a stored `null` as `null`.
  Before this change, `Number(null)` would have read as a zero limit.
- **The skip target is unchanged.** `monitor_cadence` and its 10 %
  `fastMonitorSkipMaxPct` keep their existing Wave 5 verdict. See §9.5.

All limit values live once, in `agent/services/p1p4-grade.js`
(`P1P4_PROPOSED_LIMITS`). The goal table and the harness both read them from
there.

### 9.2 The harness: `scripts/v3-p1p4-acceptance.mjs`

It is **not deployed**. Run it from any machine holding the read-tier token:

```
AGENT_SECRET_READ=… node scripts/v3-p1p4-acceptance.mjs --out p1p4.jsonl          # run until Ctrl-C
AGENT_SECRET_READ=… node scripts/v3-p1p4-acceptance.mjs --out p1p4.jsonl --hours 3
AGENT_SECRET_READ=… node scripts/v3-p1p4-acceptance.mjs --once                     # one round, printed
node scripts/v3-p1p4-acceptance.mjs --grade p1p4.jsonl [--from ISO --to ISO] [--json]
```

What it reads:

- **GET only, with the read token only.** It refuses to start if only
  `AGENT_SECRET` is set. The token goes into the Authorization header and
  nowhere else, and any error that echoes it is scrubbed. Tests check both.
- **Cadence:**

  | Route | Every |
  |---|---|
  | `/health` | 30 s |
  | `/state/heartbeats`, `/state/entry-engines` | 60 s; 30 s for the 6 min after a restart |
  | `/actions/goal-table` | 5 min. This returns the targets only: the limits and the owner's confirmation stamp. It computes nothing (0.28 s on 25-09). |
  | `/state/goal-table` | **Off** by default; `--goal-table-every-min N` opts in. See the deviation note below. |
  | `/state/route-timings`, `/state/runtime-manifest` | 5 min |

  **Deviation from the plan's 5 minutes, measured.** The full table runs on
  the main thread. It took 1,900 ms in the review, and **13,271 ms** from
  Express entry to response in the 14:25:30 UTC read on 25-09
  (`/state/route-timings`, key `/goal-table`, 12,478 B — the full table's
  size; the targets-only read is 841 B).

  **Measured again with the lag tap deployed (M1, 87620f3).** One read at
  16:11:42.9 UTC on 25-09 took 12,520 ms (route-timings), and the 100 ms
  probe recorded a **12,431 ms event-loop stall** ending at 16:11:55.463Z —
  the same millisecond the response finished. The table is a synchronous
  main-thread block: while it builds, the fast monitor, the protection band
  and every HTTP reader wait. Nothing else reads that route (the UI reads
  `/state/goal-tracker`), so every such stall would be the harness's own.
  Polled every 5 minutes it would put a 12 s stall into every window it
  grades, and the lag criterion would record the harness, not the system.

  The harness therefore follows the review's alternative ("poll it every 5
  minutes **or read /health instead**"): it reads the limits and the owner's
  confirmation stamp from the targets-only route (1–4 ms), and the four
  rows' inputs from `/health` and `/state/heartbeats`, which the grader
  judges directly. The full table is read only when `--goal-table-every-min`
  opts in; each such read's duration is recorded, and a stall that overlaps
  it is annotated (`harnessOverlap`) but stays Failed.

  **A finding for M4, not fixed here:** the daily report builds the same
  table in-process (`daily-report.js` `goalsSection`), so the daily report
  pass carries the same ~12 s block once a day (inferred from the same
  computation; not measured).

- **Restart detection:** an uptime reset, a commit change or a boot-record
  change between two `/health` samples.
- **Evidence after each restart.** After the recovery deadline it reads the
  attribution evidence once:
  - `action_log` for **every** account (`?account=all`). Without the
    parameter the route answers for the selected account only, and another
    account's entry-mode change would read as unexplained. The read is the
    newest 1,000 rows; if they do not reach back to the window's start, the
    action log counts as not read (Not Verifiable), never as "no change".
  - the cockpit journal of each still-open position whose SL/TP changed.
    This is `position_events`, including the native trail engine's polled
    amends (`source: cpp_trail_engine`). The journal is read up to the moment
    of the read, not only to the post sample: the trail poll's "last seen"
    map lives in memory (`profit-keeper.js` `lastSeenTrailSl`), so an amend
    the sidecar made while Node was down is journalled at the first keeper
    pass after boot. The cockpit route also draws bars through the broker's
    historical limiter; the harness asks for the smallest set it accepts
    (`timeframe=1d&lookback=1`), at most 20 positions, once per restart.
- **Three kinds of failed request.** `app_5xx` (the application's own JSON
  5xx), `platform` (Railway's "Application failed to respond", a non-JSON 5xx
  page, a connection that failed outright) and `timeout` (the harness's own
  20 s deadline passed with no answer). A timeout is not filed as a gateway
  error: a main thread blocked past the deadline looks exactly like one.
  Platform errors and timeouts are listed apart; neither is ever a pass.

What it writes:

- One compact JSON line per request to `--out`. The ~300 KB heartbeats body
  becomes the per-account protection facts. Tab identities are dropped.
- It appends, so restarting the harness on the same file continues the
  record.

What it prints:

- each boot's startup and recovery grade once its window closes;
- the whole grade every hour;
- the whole grade again on exit.

### 9.3 Grading rules (`agent/services/p1p4-grade.js`, pure)

- **Raw timestamps only.** The grader uses `sinceBootMs`, the audit's `at`,
  `checkedAtMs` and `lastCompletedAt`. It never uses a heartbeat verdict:
  `heartbeat.js` (`BOOT_GRACE_SEC`, :406, applied at :422) suppresses those for
  the first 300 s after boot.
- **Failed stays Failed.** Verdicts combine as Failed over Not Verifiable over
  Passed. One bad sample fails the window, whatever follows it.
- **No data, no pass.** Absent or stale data is Not Verifiable. A fast-monitor
  record older than 5 minutes at the sample does not count as data.
- **Representative windows only.** A window in which no `/health` sample saw
  a visible tab cannot pass: its Passed become Not Verifiable, and its
  Failed stand. The grade names the pages that were visible and says when
  the Desk or the Performance page never was.
- **Platform errors are separate.** Railway's "Application failed to
  respond", a non-JSON 5xx and a connection that failed outright are
  classified `platform`; the harness's own deadline passing is `timeout`.
  Both are listed apart and never counted as application 5xx — nor as a
  pass.
- **Only enabled accounts are graded.** A disabled account is not audited by
  design; the compacted heartbeats name it under `disabled` so its absence
  is visible.
- **Route classes:**
  - *Critical* routes must not return any 5xx: `/health`, heartbeats, the
    runtime manifest, entry engines, and the account, position and
    protection routes.
  - Every other 5xx is *report* class. It is counted and listed; whether any
    are tolerated is the owner's decision (H-P1-2).
- **Startup criteria:** listening, worst stall, p99 (the since-start histogram
  of the last in-window sample, which must cover at least 13.5 of the 15
  min), critical and report 5xx, the first band, the first clean audit by
  +300 s, the first loop, and the first slow-monitor, equity-stop and breaker
  evaluations.
  - The first loop and the first protection evaluations have no bar until
    the owner sets one.
  - A first evaluation that failed is Failed regardless of any bar.
- **Recovery criteria:** the pre-release snapshot is the last sample before
  BOOT, and it must be at most 10 min old. The post sample is the first one
  at or after BOOT + 300 s, and no more than 3 min after it. The grader
  checks:
  - independent readings kept (never cleared), advancing and fresh;
  - Node audit fresh and taken during this boot;
  - every fast-monitor position evaluated within cadence + 60 s, bounded from
    the samples;
  - SL/TP tuples, entry mode, revision, epoch and policy equal to the
    pre-release snapshot, plus changes the evidence explains;
  - zero unsent, in-flight or unknown intents;
  - the two sidecars' boot ids unchanged.

  An **unexplained** difference is Failed when the evidence was read, and
  Not Verifiable when it could not be. A closed position with no evidence
  read is Not Verifiable, not Failed.
- **Steady criteria** cover BOOT + 15 min to the next boot, and need at least
  2 h:
  - main-loop p95, from per-loop durations, with at least 10 observed;
  - fast-monitor skip share and tick max;
  - the band;
  - budget overruns;
  - independent and audit ages;
  - lag max and p99;
  - critical and report 5xx, from the route-timings deltas.

### 9.4 Still Not Verifiable

- **Three of the five native deployment ids.** cpp-verify, cpp-scan-tick and
  cpp-scan-timeframe need a Railway read. Only the two sidecars' boot ids are
  readable GET-only.
- **Closed positions during a restart.** Their journal is reached only
  through `/state/positions`, which lists open positions, so the harness does
  not read it.
- **Native decision-ring events other than trail amends.** `cpp_decisions`
  has no general GET route; the native trail engine's amends reach the
  evidence only through `position_events` (`cpp_trail_engine`). A change the
  sidecar made for any other reason is Not Verifiable or, when a journal was
  read and holds nothing, unexplained.
- **Live-host protection latency.** The live accounts are flat, so there is
  no live amend to time (the review's note; M5's composite).
- **Container start → process start.** See §7.

### 9.5 Owner decisions this does not make

- **Confirm or replace the limits.** Then stamp `p1p4LimitsConfirmedAt`
  (H-P1-1). Also set the first-loop bar and X for the first protection
  evaluations.
- **Report 5xx tolerance** in the startup window (H-P1-2).
- **Whether `monitor_cadence`'s 10 % joins the proposed set.** It is a Wave 5
  code default, not an agreed limit. Moving it to `proposed` would remove an
  off-track row (27–48 % measured) from the count, so it is left as it is
  until the owner says.
- **Whether a window needs more than one visible-tab sample** to count as
  representative, and whether both the Desk and the Performance page must be
  visible (the load-window plan's wording). Today the rule is literal: a
  window with `visibleTabs` 0 throughout is Not Verifiable; the pages seen
  are reported beside it.
- **Who runs the harness, and where.** It is a long-running read-only
  process; nothing in this change deploys or starts it. The plan asks for it
  to run from now across every merge, so every startup window is recorded.

### 9.6 First reading (one `--once` round, 25-09 16:11 UTC)

One round against production, GET-only with the read token, 36 minutes
after the 87620f3 boot (15:34:14.643Z). The harness started after BOOT, so
the restart was not observed and recovery is Not Verifiable; no browser tab
was visible (`visibleTabs` 0), so nothing could pass. Against the
**proposed** limits — not acceptance:

| Criterion | Reading | Grade |
|---|---|---|
| startup.lag_max | 14,701 ms stall at 15:38:05Z in `reconciling broker positions` | **Failed** |
| startup.listening | 8,452 ms after BOOT | Not Verifiable (no visible tab) |
| startup.first_band / first_clean_audit | +77 s, 7 accounts, 0 unauditable | Not Verifiable (no visible tab) |
| startup.first_loop | 126,749 ms (decision audit 57.8 s, scan 57.6 s) | Not Verifiable (no bar set) |
| startup.first_protection | slow monitor +140.6 s; equity stop, both breakers +140.6–140.7 s | Not Verifiable (no X set) |
| steady.fast_monitor_skip | 19.5 % (0.37 h window) | **Failed** (a failure stands in a short window) |
| steady.tick_max | 6,491 ms | **Failed** |

The same round's one `/state/goal-table` read is the 12.4 s stall measured
in §9.2 — the reason that read is now off by default.
