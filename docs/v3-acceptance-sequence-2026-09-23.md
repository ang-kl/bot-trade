# V3 acceptance sequence — 23 September 2026

The owner requested protection exceptions, watchdog/scanner load acceptance,
then a scoped production end-to-end test before the New York open. This record
separates observed production facts from local tests. It is not trading approval
or a claim that V3 is complete.

## Protection exceptions

Independent cpp-verify broker reads at approximately 17:58 SGT covered seven
accounts and 32 open positions: zero missing stops, two missing profit targets.
Account suffixes 9908 and 0949 each retain one missing TP1. The authenticated
Accounts page's all-account broker snapshot subsequently confirmed the rows:

| Account | Broker position | Instrument / side | Existing SL | Recorded TP refused | Bid shown in the all-account snapshot |
|---|---|---|---|---|---|
| 46979908 | 242004561 | ETHUSD / BUY | 2447.97 | 2571.19 | 2733.61 |
| 47790949 | 242243017 | XRPUSD / BUY | 1.309 | 1.3223 | 1.5935 |

Snapshot rows were read at approximately 18:06 SGT after an all-account refresh.
Bid/ask come from one-shot broker quote reads; the page does not expose their
individual receipt timestamps. Its top update time can advance with a later
selected-account refresh. These numbers are evidence of the reviewed snapshot,
not executable current quotes. A fresh read is required before any intervention.

The two BUY targets remain below the displayed bids. Identical automatic repair
is paused following `TRADING_BAD_STOPS`. No new target, stop or exit was submitted.
The remaining decision is position-specific: an approved replacement target or
an exit decision; neither can be inferred from a generic request to fix targets.
Selected trading account remains 46130058. Viewing another account used the
read-only Accounts scope pills, never the trading-account selector.

## Watchdog production observation

At 17:49 SGT, cpp-verify alone was configured for observation using the existing
read-scoped Node, gateway and scanner credentials through Railway references.
`WATCHDOG_ENABLED=1`, `WATCHDOG_MASTER_ENABLED=0`, incident owner `node`.
The five target URLs are Node `/state/watchdog` and the four native `/watchdog`
endpoints; scanner targets use private Railway DNS. No scanner feeds were enabled.

Deployment `a901bb2e-7eb0-441e-976d-a886ca222bf9` succeeded at 09:50:29Z.
The mounted `/data/verdicts` journal is writable and the application reports
supervision and durable state ON. Delivery permission, delivery credentials and
verifier incident ownership remain OFF. The UI initially showed more than 150
pending delivery records, with no capacity refusals. Startup unavailable-account
warnings were followed by successful independent broker reads.

Existing status presentation omitted service receipt times and incident types,
making calendar warnings indistinguishable from stalled work. This change
displays the five required services, receipt age, current reachability/contract
validity, retained work counts, and each active incident's cause, symbol ID,
market state and actual work/deadline timestamps. Stale probes render UNVERIFIED.
An empty scanner work inventory explicitly does not imply an active feed.

Real delivery, recipient receipt, ownership handoff, independent observer
provisioning and controlled production outage/restart drills remain unaccepted.
The current GitHub observer workflow is manual and has no scheduled delivery
path. Notification permission has not been inferred from an enabled observer.

## Scanner load evidence

Run `TZ=UTC node scripts/v3-scanner-load-acceptance.mjs` with Node 22 and both
native binaries built. The runner launches loopback-only synthetic trials with
only PORT and a local test secret, eight concurrent clients, and 500 distinct
fixture feed identities. No production service or broker is contacted. The
retained [raw result](evidence/v3-scanner-local-load-2026-09-23.json) records
binary source/hash, compiler, workload and measurement details.

| Measurement | Tick scanner | Timeframe scanner |
|---|---|---|
| Input | 194,500 classified quote records | 500 windows × 450 closed EMA bars |
| Completion time | 3.063 seconds | 0.559 seconds |
| Acknowledgment p95 / p99 | 150.02 / 312.72 ms | 13.25 / 15.97 ms |
| Concurrent health p99 | 12.70 ms | 16.01 ms |
| Peak sampled RSS | 43.17 MiB | 14.35 MiB |
| Input records dropped | **48,591** | No window rejected after admission |
| 513th feed identity | HTTP 429 | HTTP 429 |
| Retained feed bound | 512 | 512 |
| Lossless trial | **FAILED** | Passed for this workload |

The tick run reported 2,005 ingress backpressure responses, retried within a
fixed budget. Every input is reconciled as accepted or explicitly dropped, and
processed input equals accepted input after drain. The undrained comparison ring
correctly exposed its overwrite gap. Neither backpressure nor explicit gaps are
hidden as successful parity. The runner exits nonzero for dropped input.

These acknowledgment/health measurements do not measure broker protection
latency. The frozen burst is not established as a representative production
peak. Lossless tick capacity, continuous comparison collection, source/config
freshness and p95/p99 protection under actual peak feed remain unaccepted.

Production scanner profiles are read from `scanner_mirror_profiles_json`, but
only tests currently write it: there is no operator registration path. Node's
bridge/feed variables and gateway tick mirror variables remain absent. The
scanner services retain only PORT/SCANNER_SECRET and no broker credentials.
Neither deployment nor this local trial establishes active scanner coverage.

## Scoped release preparation

At approximately 18:06 SGT, the five reviewed native-service watch filters from
`v3-release-readiness-2026-09-23.md` were applied through Railway service settings
and read back under `build.watchPatterns`, with no staged changes. Node's source,
trigger, account settings and trading permissions were not changed. No native
service redeployment was requested by the filter updates. The actual next merge
must still be checked for unintended deployment events; saved configuration
alone does not prove the trigger behaviour.

This PR changes the read-only status display, a local acceptance runner and its
evidence. It requires only the Node release. A Node restart may briefly pause
its management loop; broker-held stops were present on all reviewed positions.
The two TP1 exceptions prevent declaring full protection acceptance.

## Released and observed — approximately 18:26 SGT

#1047 merged as `d9d4d232ce3c0b2a672065a5a6be9576def62188` after 5,362
local backend tests, 936 frontend tests, lint, build, no-green and syntax/diff
checks passed. Local native watchdog failure/recovery/restart and bounded
HTTP/exclusive durable-state checks passed. GitHub test job `107137135959`
passed on final PR head `198db3da3372b9262481c6875ae5c7a11d4dec64`.
The review wrapper succeeded but its AI review step was skipped; no independent
review is claimed.

Only Node deployed: `da18316b-6be1-4bd8-83b0-2d56e8b64d63`, SUCCESS at
10:19:41Z. All five native services produced SKIPPED merge events, confirming
the watch filters worked. The previous Node deployment received SIGTERM and
was then marked REMOVED. Broker-held protection and trading settings were not
changed by the release.

The first Node independent-protection polls were absent/timed out. Successful
reads were relayed again at 10:21:45Z and 10:22:26Z. Final authenticated UI reads
at approximately 18:26 SGT exposed independent broker timestamps of
10:25:19–21Z: seven accounts, 32 open positions, zero missing stops, two missing
TP1, and zero reserved/in-flight/unknown intents on every account. Management
audits resumed and continued reporting zero naked positions and two targetless
positions. This is fresh point-in-time coverage, not a continuous latency claim.

The released watchdog table showed all five services reachable with valid
contracts at 10:22:46Z and again at 10:24:47Z:

| Service | Retained work items | Evidence |
|---|---:|---|
| node | 51 | Fresh valid receipt |
| cpp-exec | 62 | Fresh valid receipt |
| cpp-acct | 57 | Fresh valid receipt |
| cpp-scan-tick | 0 | Fresh valid receipt; feed inactive |
| cpp-scan-timeframe | 0 | Fresh valid receipt; feed inactive |

At the earlier reading, 145 active calendar warnings were visible (54 cpp-acct,
47 cpp-exec, 44 Node). Two Node scanner work items were overdue: account suffix
0058, symbol IDs 10014 and 10015, last completed 10:17:16Z, due 10:20:16Z,
incidents opened 10:22:17Z. The watchdog also retained the two independently
observed missing-target incidents, opened 09:51:26Z. There were 203 pending
delivery records then, 204 at the later reading, and zero capacity refusals.
Delivery permission remained OFF; no delivery acceptance is claimed.

Node's 10:22:26Z logs additionally recorded a loss-cap/protection-band step
exceeding its 5-second budget after 32 seconds, and later overlap skips.
Protection timing acceptance therefore remains FAILED, even though broker-held
stops and subsequent audits were present. Calendar coverage and scanner work
freshness also remain acceptance gaps. No freshness/risk threshold was relaxed.

The production verifier restart drill could not be completed with the available
deployment control. `redeploy` refuses the latest SKIPPED event
`2be17938-9be8-45e0-8160-18e7c201b491` because it has no build snapshot.
Reapplying the existing `WATCHDOG_ENABLED=1` with deployment enabled did not
produce a new deployment in the observed events. No functioning configuration
was changed to force a restart. The Railway CLI is unavailable in this workspace.
Verifier `a901bb2e-7eb0-441e-976d-a886ca222bf9` remains running; a controlled
restart of its successful snapshot and durable-state readback remain required.

The scoped production read-only chain was exercised: broker → independent
verifier → Node relay → authenticated status UI, alongside five watchdog
contracts and actual overdue-work detection. A production order-flow test was
NOT conducted: target exceptions, timing/load failures, inactive scanner feeds,
missing profile registration, delivery handoff and external observation remain
unresolved. No V3 trading activation or test order was performed. Existing
time-based trading permissions remain as they were. #1046 remains a separate
unmerged RSI observation-parity package.

## Correction checkpoint — 21:17 SGT

The prior release and failures above remain historical evidence. Fresh checks,
five prepared PRs, full combined test results, position-specific decisions and
separate production release/drill boundaries are recorded in
[v3-gates-1-3-review-2026-09-23.md](v3-gates-1-3-review-2026-09-23.md).
Both new scanner feeds and trading activation remain unchanged. No correction
in this checkpoint has been released to production. No full V3 or tick-trading
acceptance is claimed.
