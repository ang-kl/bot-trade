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
