# Protection scheduling investigation - 23 September 2026

Production Node remains d9d4d23; no production setting or broker write was
changed during this investigation. The independent 20:29 SGT reads still
reported 32 positions with stops and two missing TP1s across seven accounts.
Fresh Accounts rows at approximately 20:40-20:41 SGT identified ETHUSD
242004561 on 46979908 and XRPUSD 242243017 on 47790949 as BOT-owned BUYs,
with stops 2447.97 and 1.309 and no broker target. Quoted bids in the fetched
rows were 2723.45 and 1.5641 respectively; individual quote receipt times
are not exposed. These are historical observations, not executable quotes.
Recorded targets 2571.19 and 1.3223 are below those bids. No replacement
price or exit was selected. Position-specific owner action remains required.

At 12:04:51Z the 5-second loss-cap wait expired after 54 seconds. The same
log timestamp reported Node loopLag=50920ms and a /heartbeats response taking
50815ms. Housekeeping completed on that turn: 17,148 scans and 96,720
cup-handle diagnostics deleted, and 292 closed positions rebuilt. This
places the event-loop stall during housekeeping; it does not isolate one SQL
statement or establish broker amendment latency. Independent cpp-verify
continued checking accounts at 12:04:03-05Z while Node was delayed.

The source contains synchronous bulk retention and a history loop without
event-loop yields. The correction uses bounded 200-row primary-key windows
for operational retention and real yields after each window, each history
position and each housekeeping step. Scan pruning uses 200-row batches with
the same one-million-row maximum and existing time budget. Retention horizons,
referenced analyses and permanent audit records are unchanged. Existing
synchronous public helpers remain available to their existing manual callers.
Per-step wall timings and errors are retained for the next production diagnosis.

Tests exercise actual SQLite pruning and history capture, with ready callbacks
running while work remains. They verify unchanged retention, provenance and
completeness outcomes. These tests establish cooperative scheduling, not a
hard upper bound for an individual SQL statement or production p95/p99 latency.
A scoped Node release and observation through a housekeeping pass remain
required. No timeout, risk, strategy, ownership or notification policy was
relaxed. Scanner feeds and trading activation remain unchanged.

Release affects Node only under the current service filters. Rollback restores
the previous Node image; it restores the known synchronous bulk-work hazard.
No native gateway restart is needed.

Local merge-gate checks: complete backend suite (including native HTTP tests),
ESLint, 936 frontend tests, production build and no-green check executed. The
sole backend failure was the unchanged CPU-ratio timing assertion while two
full suites competed for CPU. Its unchanged seven-test file passed when run
alone on each tree. No skip or threshold change was introduced. Tick-readiness
HTTP timing tests ran separately (28 passed). CI must still pass on the PR.
