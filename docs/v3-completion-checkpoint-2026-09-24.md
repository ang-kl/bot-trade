# V3 continuation checkpoint, 24 September 2026 SGT

## Scope and refreshed release

This continues revision 3. No scanner feed, entry activation, risk limit,
credential, notification setting or broker position was changed by this work.
Main initially refreshed to `92e01e4aa228d621b286c41b4e36d9dc00acf2c2`. GitHub reports
#1048 merged at **2026-09-23T17:34:05Z**, superseding its historical release hold.
The earlier checkpoint is historical, not evidence of a current open PR.
Its source head was `1e16010da634e21c69d58fcb2ec93c70e9f7b5dc`.

Railway production configurations were read at approximately 18:03Z:
Node has no watch filter; gateways watch `cpp-exec/**` and `agent/lib/exec-engine.*`;
scanners watch their own directories; verifier watches its own directory and
the shared gateway HTTP/WebSocket sources. A documentation merge also deploys
Node. Both new scanners remain private and their feeds OFF.

| Service | Current successful deployment at review | Source |
|---|---|---|
| Node | `255e6de8-d02b-4902-8c3d-6acb03fd51c0` | `92e01e4` |
| cpp-exec | `3bbc8730-f05a-4d86-a8f9-6b74f51a6cb5` | `92e01e4` |
| cpp-acct | `565b6db5-de06-494b-abed-8d9e07854159` | `92e01e4` |
| cpp-scan-tick | `9ee1fc23-71ac-4c47-8495-b1c9e4b9d209` | `92e01e4` |
| cpp-scan-timeframe | `2eddcee9-60c9-4189-b28d-4e712b33c269` | `82cf025` |
| cpp-verify | `a901bb2e-7eb0-441e-976d-a886ca222bf9` | `761bf3810851aa757636c94fa1d56ecd451bd236` |

The last two correctly skipped #1048. Successful deployment is not production
acceptance. Existing time-based entries remain as observed, with tick entries
blocked for missing profile pin/match, replay evidence and validation stage.

## Remaining-work checklist

1. **Implemented and verified within the recorded test scope:** protection
   reserve/ownership/TP preservation; cooperative housekeeping; independent
   broker receipts; watchdog incident/outbox/retry and external observer code;
   scanner atomic batch admission, bounded gateway retries, profile registration
   and continuous comparison; default native and supported EMA/RSI parity;
   account/history/performance read models. Reuse their existing evidence.
2. **Implementation or diagnosis still required:** reporting isolation below;
   explanation of current gateway calendar UNKNOWNs; native semantics for any
   proposed profiles outside the supported subset; any corrections demonstrated
   by attributable history or replay evidence. Missing broker facts cannot be
   repaired by fabricating accounting rows or targets.
3. **Production acceptance required:** actual broker-confirmed protection
   latency under load; calendar coverage; independent Telegram and external
   observer delivery/recovery; continuously drained comparison at measured peak
   rates; exact profile parity; eligible 48-hour tick shadow evidence; storage,
   restart recovery, cost/capacity and final scoped end-to-end acceptance.
4. **Owner/access/evidence requirements:** two position decisions; intended
   account roster; momentum TP1/runner policy; measured protection latency
   acceptance limits; notification recipient/owner and credential provisioning;
   external observer host; separately approved feed and outage trials; broker
   history sufficient to resolve ambiguous/unattributed accounting.

## Fresh protection and account evidence

Independent cpp-verify broker receipts, relayed in Node logs at 18:23:45.564Z,
were stamped **18:23:37.058Z through 18:23:38.510Z**. All seven reads succeeded.

| Account | Open | Missing SL | Missing TP1 | Snapshot currency/balance |
|---|---:|---:|---:|---|
| 42993489 | 1 | 0 | 0 | SGD 56.87 |
| 43002148 | 0 | 0 | 0 | USD 0 |
| 43069009 | 0 | 0 | 0 | USD 0 |
| 43097342 | 4 | 0 | 0 | SGD 3,116.38 |
| 46130058 | 7 | 0 | 0 | USD 30,004.36 |
| 46979908 | 7 | 0 | 1 | USD 697.16 |
| 47790949 | 13 | 0 | 1 | USD 44,386.54 |

Balances/currencies came from the separate Accounts broker snapshot displayed
at 18:18:27Z through 18:19:45Z, not the independent protection receipt. They are
not USD conversions. SL coverage is 32/32; broker SL-and-TP coverage is 30/32
(93.75%). This does not prove application partial-TP execution or protection
amendment latency. The intended five-demo/one-live roster still differs from
the connected four-demo/three-live roster. Two live accounts are unfunded.

| Position | Account | Refreshed ownership | Entry / SL / broker TP | Snapshot bid / ask |
|---|---|---|---|---|
| ETHUSD 242004561 | 46979908 | BOT, long, TSM, 0.01 lots | 2410.85 / 2447.97 / absent | 2661.73 / 2663.73 |
| XRPUSD 242243017 | 47790949 | BOT, long, TSM, 4.49 lots | 1.2977 / 1.309 / absent | 1.4866 / 1.4916 |

These are dated broker snapshot observations, not executable quotes; individual
quote receipt times are not exposed by this UI. The owner must specify an
exact replacement target or a separately authorised exit for each position,
consistent with mandatory TP1. Recheck quotes and broker constraints before
any later authorised action. No historical target was resubmitted.

## Demonstrated reporting starvation and correction

At **18:10:10.512Z**, Node logged `loopLag=87137ms`. HTTP completion logs at
18:10:09.265Z show `/cup-handle-funnel` taking **108579 ms** and `/symbol-map`
107957 ms. Subsequent 5-second protection-task waits expired. The funnel source
performed six synchronous table scans on the protection event loop. This
demonstrates a scheduling hazard and temporal association; it does not attribute
every millisecond of the production pause to one statement.

The report now runs in the existing read-only worker pool and aggregates in one
pass. Identical reads coalesce; the shared pool permits two active workers,
128 MiB JS old-generation limit per worker and a 15-second response deadline.
Timed-out workers retain their capacity slot until actual exit, including while
native SQLite work is finishing. Failures remain unavailable reports, never
zero activity. No migration or trading calculation changed.

The deterministic benchmark uses 2,600,000 rows, 500 symbols and mixed timestamp
formats. It compares complete output against the unchanged main implementation.
Pass requires exact parity/counts and main-thread timer maximum under 200 ms;
it stops after one baseline/one worker query. At **18:20:15.455Z**, all counts
matched. Baseline query 2391.75 ms, maximum timer interval 2396.99 ms. Worker
query 2718.98 ms, 536 timer samples: p95 5.180 ms, p99 5.383 ms, maximum 6.986 ms.
This is a local event-loop proxy, not a production p95/p99 protection claim.
An earlier indexed variant was slower and was removed before this final run.

Also corrected the selected-account header currency read: it now names that
account explicitly, accepts native account currency even with no positions,
clears currency on account changes, and rejects delayed foreign-account results.
The previous unscoped read inherited `account=all` and received HTTP 400. Neither
the trading selection nor account risk calculations were changed.

Calendar collection's existing stored receipt is now exposed in Controllers,
including account, requested/recorded/unknown counts, errors and age. A fresh
watchdog probe alone never establishes fresh calendar collection.

## Watchdog, history and research review

At 18:26:09Z the watchdog had fresh, valid receipts for Node, both gateways and
both scanners. The new scanners had zero work, consistent with feeds OFF.
Gateway calendar UNKNOWN incidents remained active. Node recorded legitimate
no-order activity separately from failures. Supervision/durable storage were ON;
master notification permission, delivery credentials and incident owner were OFF.
External verifier observer remained unconfigured. No production alert/drill was
executed. There was no evidence allowing a production-delivery Passed claim.

Fresh full-population performance report **18:22:04.259Z**: 22 unpriced closes,
four without an account, zero without a usable close time. Historical conversion
and cashflow completeness remain unverified. Duplicate-looking position rows
must be reconciled by account/position/deal evidence, not deleted by heuristic.
Tune showed insufficient and losing strategy samples; aggregate legacy P&L
across currencies is not promotion evidence. No strategy settings were changed.

The preserved 500-stream failure and corrected result remain in
`evidence/v3-tick-ingress-retry-2026-09-23.json`: 194500 input, baseline 159344
accepted/35156 dropped; corrected 194500 accepted and processed, zero input
drops, 2412 backpressure responses retried. This is synthetic admission evidence.
Gateway retry tests were added separately in #1048; neither establishes a
production lossless feed trial or lossless continuous comparison output.

Supported native observation profiles are enumerated by
`agent/services/scanner-profiles.js`. Defaults and EMA/RSI options have frozen
reference/HTTP parity. Fibonacci filters/class tuning, Cup VWAP, and custom
volume/structure/FVG options must not be registered as compatible without their
exact semantics and matching fixtures. Registration does not change strategy
settings. The proposed trial must pin account/feed/symbol ID, timeframe, full
parameters, code/configuration versions and hashes before activation.

## Scoped release and test proposals

**This reporting release:** Node/frontend only under the checked filters.
Accounts affected by a Node restart: all seven above; broker-held stops remain
at the broker, while Node management may pause. Prerequisites: full green merge
gate, unchanged scanner OFF/entry settings, fresh independent coverage and no
unknown in-flight intents. Observe the report plus management resumption after
deploy. Stop acceptance on degraded coverage, account identity mismatch, lost
TP, duplicate intents, rising queues or unexplained management delay. Restore
Node deployment `255e6de8-d02b-4902-8c3d-6acb03fd51c0` if rollback is required;
this restores the known synchronous-report hazard. No gateway restart is needed.

**Independent alerts, approval pending:** cpp-verify plus an observer outside
Railway's failure domain. Target the owner's specifically verified Telegram
chat using explicitly provisioned credentials. Before enabling delivery, choose
cpp-verify as sole incident sender, reconcile existing Node policy, inspect and
dispose of the retained outbox deliberately, and checkpoint the verifier volume.
Bound the first delivery trial to one labelled synthetic incident and one
recovery. Require Telegram acceptance IDs, durable retry/deduplication receipts
and no duplicate sends. Abort on wrong recipient, duplicate flood or storage
error; restore previous notification/ownership configuration. No send is
authorised by this proposal alone.

**Outage drills, approval pending:** separate Node and cpp-verify windows, one
service at a time, maximum 90 seconds unavailable, with an independent operator
able to restore the previous image. Node-down must deliver via cpp-verify;
cpp-verify-down must deliver via the external observer. Require current complete
protection evidence, no unresolved intents, durable checkpoints, and a separately
approved entry-submission hold for affected accounts. Abort on protection
deterioration or unexpected service loss; restore service immediately. Gate 1
currently prevents treating these prerequisites as passed.

**Observation-only feed trial, approval pending:** first proposed scope is
46130058/demo and 42993489/live, EURUSD/GBPUSD/XAUUSD/BTCUSD on each account's
verified instrument IDs. All six services are observed; new scanner candidates
have no order authority and existing admission remains unchanged. Start with
the existing exact tick profile and default `donchian_breakout`/`rsi2_reversion`
closed H1 observations only after retrieving and pinning their actual profile
hashes, broker increments, TTL and source/configuration versions. An unavailable
symbol/profile fails the prerequisite; do not substitute one silently.
Measure an active-session event window including a burst and comparison drain,
then decide whether it covers the measured peak requirement. Stop after the
specified events and evidence are captured, with a 30-minute initial observation
cap; absence of a representative burst remains Not Verifiable. Count submitted,
accepted, processed, retried, duplicate, dropped and gap/re-warm records across
both transport and comparison. Any unexplained loss, mismatch, unbounded backlog
or protection regression aborts the trial. Restore both scanner feeds OFF and
checkpoint evidence. Larger staged symbol sets need measured capacity first.

**Final production end-to-end, approval pending:** only after the preceding
prerequisites and roster/TP policies pass. Freeze exact code, profiles, accounts
and expected events; observe feed through candidates, Node decisions, natural
permitted execution evidence and independent broker reconciliation. This prompt
does not authorise forced signals, synthetic orders or a position change. If no
eligible natural event occurs within the approved window, order-path acceptance
remains Not Verifiable. Any order-bearing test needs its own exact instrument,
size, SL/TP, limit and rollback/exit authority approved beforehand.

Keep the existing minimum 48-hour tick shadow and all sample/quality thresholds.
Count retained evidence only with matching configuration, timestamps, identity
and eligible continuity. Do not restart that clock automatically. Broker latency
limits, retention requirements, external observer provisioning and service cost
evidence remain specific completion dependencies, not reasons to claim readiness.

## Post-release evidence at 18:50Z

PR #1053 merged as `7981227e833c7877f9e66236c1aa9ba5cb63242c` from tested
source `0d5cb46169d6e3e40649247cd35fba338bf3c6f4`. Node deployment
`1038a226-04a5-463c-b663-eca7eae4ed11` succeeded at **18:39:55.818Z**.
All five native services skipped this release, matching their actual filters.
Both scanner feeds and trading activation remained unchanged.

The full source gate passed: **5,390 backend tests, zero skipped; 937 frontend
tests; ESLint; Vite build; no-green; tick native behaviour; timeframe native,
session/DST and frozen parity; gateway/native-backtest parity**. CI run
`35903161231` and PR review `35903161237` succeeded. Local final tests used Node
22.23.2 and UTC, matching the date assumptions in existing tests. The initial
UTC+7 run exposed timezone-sensitive assertions; no assertion was relaxed.

At **18:49:52.465Z**, one ordinary one-day funnel read returned HTTP 200 in
**1,096 ms proxy / 1,061 ms application time**: 331,349 traces and 46 symbols.
The test question was whether the deployed off-thread report returned a real
population without another long main-thread report stall. Workload: one UI
read; stop after its response or deadline. This narrow report verification
passed. It does not establish peak-load protection acceptance.

Production acceptance did **not** pass. At **18:42:03.505Z**, Node recorded
**73,349 ms event-loop lag** during the first post-release loop, which completed
in 210,949 ms. The recorded scan CPU profile at **18:43:17.844Z** sampled
202,463.3 ms: native `all` 121,428.8 ms, `get` 23,137.6 ms, `run` 20,241.4 ms,
idle 33,891.2 ms. These are sampled frame times, not proof of CPU consumption
versus synchronous I/O. Existing summaries discard the native callers, so they
cannot identify the responsible SQL read sites. Concurrent report requests
shared the same event loop, and several verification tabs were open; the phase
name alone does not prove the scanner caused all the delay. Retained evidence
is in [the runtime receipt](evidence/v3-production-checkpoint-2026-09-24.json).

Independent broker reads recovered. Receipts **18:50:21.481Z to 18:50:22.966Z**
again showed the same seven accounts and 32 positions: all stops present,
two TP1 absent. The UI showed zero reserved/in-flight/unknown intents on all
seven accounts at the subsequent read. Later short protection cycles do not
erase the startup overrun. Production protection p95/p99/max remains
**Not Verifiable** because complete, attributable broker-confirmation events
and a representative workload were not captured.

The calendar diagnostic now names the reason: account 42993489, symbol 12097,
`calendar_holiday_window_unknown` at **18:46:59Z**; earlier batches reported
the same condition for account 46979908, symbols 12095 and 11766. The official
[ProtoOAHoliday reference](https://help.ctrader.com/open-api/model-messages/#protooaholiday)
marks the boundaries optional but supplies no omitted-value business meaning.
Do not infer a full-day holiday or ignore it. Exact broker holiday payloads and
confirmed boundary semantics remain necessary before changing classification.
This explains these collected UNKNOWNs; it does not explain every gateway
UNKNOWN or prove full subscription/calendar identity coverage.

Watchdog receipts at **18:47:29Z** were reachable and valid for all five targets.
Delivery remained disabled: **512 pending records and 88 capacity refusals**.
Backlog disposition, sender ownership, verified recipient/credentials and the
independent host must be resolved before the proposed bounded delivery drill.
No backlog was purged and no notification was sent.

Additional full-plan findings:

- Boot at 18:39:48Z reported 1,308 closed positions in 90 days, 53 complete and
  1,252 incomplete. The source summary's categories do not fully sum to 1,308;
  preserve that discrepancy for identity reconciliation. Of 117 refused records
  since the clean-data cutoff, 72 opened after it. These are real provenance
  gaps, not a reason to fabricate historical reasons.
- Seventeen symbols are armed only on timeframes absent from the scan ladder;
  21 have some unreachable cells. Examples: ASML.US 8h, EURUSD/GBPUSD 3d,
  EURAUD 12h/8h. The current ladder is 1mo/1w/1d/4h/1h/30m/15m/5m.
  Strategy/configuration decisions must choose the intended profiles before
  adding native semantics or rearming cells. No settings were changed.
- One-hour Railway metrics sampled 61 points per service. Node memory peaked
  at 3.867 GB and disk was approximately 4.032 GB; cpp-exec disk 2.264 GB and
  verifier disk 0.924 GB. Scanners were idle with feeds OFF. cpp-acct and the
  new scanners had no mounted volume. These observations do not prove service
  quotas, billing, retention under peak recording, or restart durability.
- Attributable replay remains dependent on exact pinned profiles and eligible
  segment provenance. The implemented replay endpoint has no operator UI;
  available Railway access provides logs/configuration, not remote shell or
  authenticated application invocation. No replacement dataset was invented.

## Native-call attribution release proposal

A second demonstrated collection defect was found at 19:00Z: the collector
looked for subscription IDs and feed account in `/tick-status`, which contains
recorder statistics. Native `main.cpp` publishes those identities in the
authenticated `/health.tick` object. The heartbeat previously discarded that
object from its durable health receipt. The correction retains it there and
consumes that exact account/feed identity. Stale, failed or redacted active
feed evidence marks inventory incomplete. No broker operation or refresh
rate is added; the existing 25-symbol, one-account, one-minute collection
budget remains unchanged. A behaviour test runs the real heartbeat and
collector with the native response shapes and verifies the requested IDs.
This addresses missing collection demand, not ambiguous holiday semantics.

The follow-up diagnostic retains up to three nearest application callers for
native profiler frames, with a 32-parent traversal bound and cycle detection.
It skips dependency wrappers and leaves idle/program/GC accounting unchanged.
Only code locations and sampled durations are retained; no SQL, parameters,
credentials, extra profiler activation or trading behaviour is introduced.
Focused tests verify caller attribution, merged totals and bounded malformed
profiles. The full repository gate is required before a qualifying merge.

Actual deployment scope is **Node only**, affecting management scheduling for
all seven registered accounts during its normal release restart. Existing
broker-held stops remain at the broker. Prerequisites: green full merge gate,
unchanged filters and feeds, fresh independent coverage and no unresolved
in-flight intents. Observe the already-enabled first scan/monitor profile and
at most two normal subsequent cycles; stop after obtaining attribution or six
minutes. Do not run a load test, force a signal, or enable another profiler.
Any unexplained delay remains failed acceptance; loss of coverage, duplicate
intents or a new functional regression stops the release observation. Restore
Node deployment `1038a226-04a5-463c-b663-eca7eae4ed11` for a regression. That
rollback preserves the report isolation but also the unresolved startup hazard.
This proposal is not approval for any gateway, feed, Telegram or outage drill.
