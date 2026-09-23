# V3 continuation checkpoint, 24 September 2026 SGT

## Scope and refreshed release

This continues revision 3. No scanner feed, entry activation, risk limit,
credential, notification setting or broker position was changed by this work.
Main refreshed to `92e01e4aa228d621b286c41b4e36d9dc00acf2c2`. GitHub reports
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
