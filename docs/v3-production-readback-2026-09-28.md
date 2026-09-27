# V3 release and production readback

Version 1.0 - 28 September 2026. Observation checkpoint: 07:13 SGT.

## Authority and release

The owner explicitly approved resolving and merging PRs #1169 and #1170 after
passing CI, including their resulting Railway deployments. The named releases
are complete. Scanner registration, account selection, trading activation and
the separate final partial-fill follow-up have not been published or applied
by this continuation.

| PR | Verified source head | Squash on main | Merged (UTC, 27 September) |
|---|---|---|---|
| [#1169](https://github.com/ang-kl/bot-trade/pull/1169) | `9f33c7d72981fd919fb7d4ad4a33f06a9d54a710` | `4f8cbac5fd10729528320adb0dce891edf7c65ba` | 22:35:52 |
| [#1170](https://github.com/ang-kl/bot-trade/pull/1170) | `aaf3d7b48e4fcf9c4d46455f8128b62ac5585921` | `1a0d34429f80db95c4476defe615b05961fbfa12` | 22:59:46 |

#1169 passed [application CI](https://github.com/ang-kl/bot-trade/actions/runs/36302065741).
#1170 passed final-head [application CI](https://github.com/ang-kl/bot-trade/actions/runs/36356489638),
[scanner CI](https://github.com/ang-kl/bot-trade/actions/runs/36356489618) and
[execution CI](https://github.com/ang-kl/bot-trade/actions/runs/36356489604),
including native production compilation, unit tests, ThreadSanitizer and Node
delegation. The automated review action was skipped; its successful wrapper
does not count as independent review. There were no open review threads.

The CLAUDE ledger conflict was combined without discarding either history.
After #1169's squash, a second ancestry resolution retained exactly tree
`363428d244e26e3579891cc9b5a1da14cac99ef7`. Final main has that same tree.
Both merges used the verified expected head.

## Railway and broker recovery

#1169's Node deployment `be08d6ed-a445-4885-a306-5214826e7905` succeeded.
Following #1170, these deployments all succeeded:

| Service | Deployment | Runtime boot (UTC, 27 September) |
|---|---|---|
| bot-trade | `9f44c6c2-39e4-4c91-9796-51df6e7d0a87` | 23:00:19 |
| cpp-exec, demo | `084822b3-4998-44aa-a441-9d2596ccd9e7` | 23:01:19.800 |
| cpp-acct, live | `1bda8de8-6c0c-4760-9e72-b4441ade36e2` | 23:01:13.298 |

The unchanged cpp-verify and both scanner deployments remain successful.
Their path filters skipped redeployment. An unrelated old staged Railway
change was left untouched; the plugin reports zero changes while the canvas
shows one edited service. Neither observation authorises applying it.

Authenticated production UI readback at 07:08 SGT showed web and agent
`1a0d344`, seven acknowledged active account engines, and broker receipt times
23:08:06 UTC for all seven accounts. All 26 positions had SL and TP. These
receipts are after the new gateway boots. At 07:12 SGT the health panel reported
40 healthy controllers, one retired and one idle, with a current protection
audit covering all seven accounts and all 26 positions.

Read-only, unauthenticated local `/health` responses through the authorised
Railway consoles confirmed:

| Evidence | Demo gateway | Live gateway |
|---|---:|---:|
| Connected accounts | 4 | 3 |
| Last reconcile, UTC | 23:08:14.611 | 23:09:19.737 |
| Connected spot feed | true | true |
| Tick count | 6,619 | 8,185 |
| Recorded events | 6,614 | 8,185 |
| Recorder symbols | 53 | 53 |
| Dropped events / gaps | 0 / 1 | 0 / 1 |
| Recording / shadow | true / true | true / true |
| Tick entry placement / sent | false / 0 | false / 0 |
| Session timeouts / disconnects | 0 / 0 | 0 / 0 |
| Require bracket / target | true / true | true / true |

Public health confirms counts, not individual account identity. The
authenticated UI supplies the seven-account receipt/protection evidence.
The reads did not access environment variables or credentials. No broker
order, amendment, cancellation or close was sent by the verification.

## Scanner finding

The comparison collector is active after deployment: at 23:08:46 UTC it
retained 47,488 tick contract rejections, up from 28,678 before this release.
It retained 208 input gaps, last recorded at 23:01:06 UTC. Its queue and drop
counters were zero. Timeframe records remain historical: 54 delivery failures
and 414 matches, last recorded on 26 September.

The new visible warning reports that the scanned account ending 9908 has no
matching profiles among 690 timeframe setups. The earlier account-scoped
readback found current tick feed anchors 9908/3489 while registered tick
profiles belonged to 0058/9009. Current rejections and the explicit warning
show that the release did not resolve alignment. Reachable workers and flowing
gateway ticks do not prove scanner coverage or valid comparison results.

The separately prepared 106-profile addition, preserved in the private
proposal described in `exit-attribution-replay-2026-09-28.md`, remains
unapplied. It needs a fresh account/map/revision check and scoped approval.
Returning selection to 0058 is a separate operation and cannot relocate an
already established tick feed. No account/profile mutation is inferred here.

At 23:14:51 UTC, independent watchdog receipts showed Node, both gateways and
both scanners reachable with valid work contracts. Retained work items were
100, 62, 56, 106 and zero respectively. Zero timeframe work is not active feed
coverage. Urgent delivery remains muted, with 512 pending deliveries; the
external verifier observer is unconfigured. These existing monitoring limits
remain open, and no notification setting was changed.

## Performance and session evidence

The release's first Node loop took 134,303 ms. Initial cashflow and performance
report deadlines later recovered; the final healthy panel does not erase them.
Database initialisation took 407.304 ms, including 329.915 ms of legacy repairs.
Later completed loops included 55,103 ms and 15,845 ms.

| Bounded Railway HTTP sample (UTC) | Requests | Status counts | Median | Nearest-rank p95 |
|---|---:|---|---:|---:|
| 23:00:33.607-23:01:50.184 | 57 | 51 x 200; 5 x 499; 1 x 503 | 236 ms | 4,315 ms |
| 23:07:00.004-23:08:58.519 | 501 | 490 x 200; 10 x 304; 1 x 499 | 285 ms | 1,095 ms |

Durations include every returned status. Railway documents total duration in
[milliseconds](https://docs.railway.com/cli/logs#http-logs). The later request
asked for 500 rows and received 501; these are bounded returned samples, not
complete window counts or like-for-like workload comparisons. Status 499 is
kept separate from 5xx responses. Neither sample establishes browser latency.
The reproducible, sanitised records and Node CPU phase summaries are in
`v3-production-performance-2026-09-28.json`.

At the UI's 23:08:19 UTC process checkpoint, maximum decision-audit event-loop
delay was 1,421 ms, with CPU/wall ratio 0.11 for that stall. The scan sample
covered 3,471.4 ms, including 1,869.3 ms idle and 1,401.3 ms in `run`; the monitor
sample covered 6,129.1 ms, including 5,500 ms idle. These observations identify
remaining latency. They do not prove its cause or satisfy a performance target.

Full desktop/throttled-phone DevTools traces, LCP and CLS remain Not Verifiable:
the connected browser exposes no tracing capability. No substitute browser
control or credential extraction was used. Existing process profiles and
HTTP samples are recorded with their limits.

Two bounded read-only automation schedules were created for later session
checks: 28 September at 21:30, 22:30 and 23:30 SGT, then 29 September at 00:30;
and 29 September at 04:00 and 05:00 SGT. They prohibit release/configuration/
trading actions and distinguish synthetic browser presence from the owner's
visible Desk and Performance tabs. They are point observations, not the
continuous P1/P4 harness. The approved 13:30-16:00 UTC load window and the
US-closed hour are future evidence at this checkpoint. No session acceptance,
profit factor 1.71 or V3 completion is claimed.

## Invariants report

| Invariant / gate | Verdict | Evidence or remaining limit |
|---|---|---|
| Named PRs merged only after final CI | Passed | GitHub final heads, workflows, guarded merges and exact resulting tree. |
| Resulting deployments and fresh broker protection | Passed at checkpoint | Railway success; new runtime versions; post-boot receipts and 26 protected positions. |
| No added trading authority or relaxed risk/size/caps | Passed for this operation | No settings or broker writes; guards held; tick placement false. |
| Actual scanner account/profile alignment | Failed | Growing contract rejections and current timeframe mismatch. |
| Final partial-fill lifecycle | Passed in local focused tests; production Not Verifiable | Separate unpublished implementation and final gate in its progress log; no natural final fill observed. |
| Full browser traces and market-session acceptance | Not Verifiable yet | Missing trace capability; later session checks scheduled, continuous harness/owner visibility unproved. |
| Empirical strategy qualification | Not Verifiable | No new qualifying holdout or complete uncensored outcome set. |

The named release gate is complete. Full V3 acceptance remains open. The
partial-fill continuation is documented separately in
`v3-final-partial-fill-2026-09-28.md` and its append-only progress log.
