# V3 gates 1–3 correction review — 23 September 2026

All work in this record is observation or local/repository implementation.
Production remains on main d9d4d232ce3c0b2a672065a5a6be9576def62188 for Node,
761bf3810851aa757636c94fa1d56ecd451bd236 for native services. Both new scanner
feeds stay OFF, Node has no SCANNER_BRIDGE_ENABLED/feed credentials, and no
trading flag, broker position, order, risk limit or credential was changed.

## Reviewable changes

| PR | Exact published commit | Correction |
|---|---|---|
| [1048](https://github.com/ang-kl/bot-trade/pull/1048) | a7f4cc4d525817eac6838e0ca5cfabd4064027e9 | Whole-batch tick admission before sequence advancement |
| [1049](https://github.com/ang-kl/bot-trade/pull/1049) | 6aeefec6401df7b637c8457afc9b37464dc0f4f3 | Bounded cooperative housekeeping and step timings |
| [1050](https://github.com/ang-kl/bot-trade/pull/1050) | e0744f3738101716cbd51612d94f9ada9ea73e0d | Real account-map readers, bounded calendar coverage, active-work export |
| [1051](https://github.com/ang-kl/bot-trade/pull/1051) | 29f75ab8c3d5ea7932ae5e54314d77b81daad42a | Profile registration, continuous collection and independently checked expiry |
| [1052](https://github.com/ang-kl/bot-trade/pull/1052) | e1bee5da7e062d4307aa3ab4d09883b2aaa9a7d8 | Opt-in independent durable failure/recovery alert outbox |

These are draft release holds. #1051 needs #1050's real account-map readers.
The integrated branch combines all five plus this evidence and reproducible
collector runner. The older #1046 RSI-option PR remains draft and unmerged;
its earlier statement that native watch filters were absent is historical.
No claim is made that its unmerged RSI options are deployed.

## Refreshed runtime

Independent cpp-verify broker checks at 13:16:03.544–13:16:04.953Z cover all
seven connected accounts, relayed by Node at 13:16:36.100Z:

| Account | Open | Missing SL | Missing TP1 |
|---|---:|---:|---:|
| 42993489 | 1 | 0 | 0 |
| 43002148 | 0 | 0 | 0 |
| 43069009 | 0 | 0 | 0 |
| 43097342 | 4 | 0 | 0 |
| 46130058 | 7 | 0 | 0 |
| 46979908 | 7 | 0 | 1 |
| 47790949 | 13 | 0 | 1 |

Point-in-time stop coverage is 32/32; target coverage is 30/32 (93.75%). This
is not continuous coverage or detection-to-broker-confirmed amendment latency.
The independent account read timestamps span about 1.409 seconds in this sweep;
that is also not amendment latency.

Accounts UI all-account snapshot refreshed around 12:34–12:35Z and inspected
at 12:40–12:41Z identified both exceptions as BOT-owned BUY positions:

| Account / position | Instrument | Qty | Entry | Existing SL | TP |
|---|---|---:|---:|---:|---|
| 46979908 / 242004561 | ETHUSD | 0.01 | 2410.85 | 2447.97 | Missing |
| 47790949 / 242243017 | XRPUSD | 4.49 | 1.2977 | 1.309 | Missing |

The former recorded targets 2571.19 / 1.3223 were below their respective bids
in that snapshot, so replay is not a valid repair. Quotes are intentionally not
presented as current executable prices. The owner must decide replacement TP1
or exit intent separately for each position; this record authorises neither
execution nor a replacement price. Recheck broker/quote state before any later
approved intervention. Historical position decisions did not block code work.

At 13:03:51Z all five watchdog targets had fresh valid contracts: Node 51 work
items, cpp-exec 62, cpp-acct 57, new scanners zero each. Delivery permission,
credentials and independent owner remained OFF, external observer unconfigured,
257 pending deliveries, zero capacity refusals. Calendar-unknown warnings
remained, with some old work receipts; fresh process health did not count as
completed work. Delivery/outage/restart acceptance remains unexecuted.

The previously recorded 32-second/5-second overrun was reproduced as a newer
54-second expiry at 12:04:51Z with 50,920ms Node event-loop lag, during bulk
housekeeping. Independent verifier reads continued. The bounded-yield correction
addresses demonstrated synchronous work but has not yet been deployed. Existing
logs do not isolate one SQL statement or supply broker latency percentiles.

## Local evidence and limits

* Full integrated gate: 28 isolated HTTP-latency tests + 5,355 remaining backend
  tests = 5,383 passed, zero failed/skipped; 936 frontend tests; ESLint, build,
  no-green passed. Node 22 / UTC. No thresholds weakened. An initial integrated
  runner fixture used an unnecessary host field; using the schema's existing
  default removed that routing-token guard failure. The full gate was rerun.
* Fresh C++ watchdog and HTTP tests passed failure/work/recovery/restart and
  durable exclusive ownership. Native scanner behaviour tests and PR native
  CI passed. The copied native backtest binary missing from an early operator
  gate was restored and the exact parity test passed; final integrated gate
  has no skips.
* Preserved 500-stream failure: 194,500 submitted, 159,344 accepted/processed,
  35,156 dropped in the fresh baseline reproduction. Corrected identical trial:
  194,500 accepted/processed, zero dropped, 2,412 HTTP429 retries. Ack p95/p99
  167.57/239.97ms, health p99 10.25ms, sampled native RSS 41.23MiB. The original
  recorded 48,591-drop failure also remains unchanged.
* Continuous actual-worker/shared-SQLite trial: 50 streams ×389 records,
  19,450 submitted/accepted/processed/compared, zero drops, retries or gaps,
  zero oracle differences and zero order intents. 1,100 matched current
  observations and 18,350 correctly expired archived observations are separate.
  Final shared SQLite write probe (114 samples): p95 229.497ms, p99 330.433ms,
  max 330.661ms. This measures local writer contention, not protection task or
  broker latency. The producer was slowed by that shared database contention;
  the nominal 100ms pacing is not a claim of sustained production throughput.
* The continuous trial exposed and fixed expiry masking. Failed trial records
  are retained alongside the successful run, not replaced. Beyond supported
  bounds, ingress refusal and output gaps remain explicit; a gap resets the
  comparison oracle until fresh snapshot/warmup. No loss is counted as parity.

Raw evidence: [ingress](evidence/v3-tick-ingress-retry-2026-09-23.json),
[continuous collector](evidence/v3-continuous-comparison-2026-09-23.json),
[runtime](evidence/v3-runtime-2026-09-23.json).
Run `TZ=UTC node scripts/v3-continuous-comparison-acceptance.mjs` on the combined
source with its native binary built. It contacts loopback only and supplies no
broker credentials. All supported default/EMA fixture HTTP parity paths are
exercised by the integrated tests; exact production profile registration and
measured peak-feed demand remain unverified while feeds stay disabled.

## Acceptance and next decisions

| Gate | Production acceptance | Remaining condition |
|---|---|---|
| 1 Protection | **Failed** | Two position-specific TP1 decisions; deploy/observe timing correction; actual load p95/p99/max and broker-confirmed latency not established |
| 2 Watchdog | **Not Verifiable** | Calendar corrections undeployed; muted delivery, no external host/destination binding, owner handoff and production outage/restart drills unexecuted |
| 3 Scanners/load | **Not Verifiable** | Local ingress/continuous fixture checks passed; production corrections undeployed, exact profiles/representative peak load/protection fairness and observation trial unaccepted |

No full V3 acceptance or tick-trading readiness follows from these gates.
The roadmap's other acceptance gates and validation thresholds still apply.

1. Approve a scoped correction release and passive observation. Fresh Railway
   configuration shows Node root `/` has no watch filter: **every main merge
   may redeploy Node**, including native-only or external-script changes.
   #1048 also redeploys cpp-scan-tick. Other native filters exclude these changes;
   no gateway/verifier/timeframe restart is expected from them. Keep all feeds,
   trading and delivery settings unchanged. Review each CI result before merge.
2. Resolve ETHUSD and XRPUSD target/exit intent individually. No historical
   quote or arbitrary target will be substituted.
3. Review the [bounded drill proposal](v3-watchdog-production-drill-proposal-2026-09-23.md).
   It separately scopes external provisioning, at most four alert messages,
   at most 90 seconds per Node/verifier outage, abort conditions and restoration.
   Existing pending notifications need a specific disposition before unmuting.
   The independent host/destination is an access/configuration limitation, not
   something a local test can prove. No outage should start without a working
   successful-deployment restart/rollback path.
4. Separately approve an observation-only feed trial with exact profiles and
   explicit load/memory/latency abort limits. No feed is enabled in this work.

## Rollback

No production rollback is currently needed: no release was performed. For an
approved release, restore Node deployment da18316b-6be1-4bd8-83b0-2d56e8b64d63
and tick deployment 3350d396-4b70-4297-a052-4cbd3e6cf48c as applicable. These
restore known defects, so rollback is not acceptance. Keep both scanner feeds
OFF. Stop any later approved external delivery process; retain its journal and
restore the recorded original notification/ownership settings. Do not touch
broker positions/orders or numerical risk limits. Verifier drill restoration
uses a901bb2e-7eb0-441e-976d-a886ca222bf9, not a newer SKIPPED event.

## Repository CI confirmation — 13:19Z

All five published heads passed their required PR CI. Main CI runs:
#1048 35863923000; #1049 35863926625; #1050 35864557780;
#1051 35865659137 (job 107196453648); #1052 35865664010
(job 107196470983). Native scanner workflows also passed for #1048, #1050 and
#1051 (runs 35863922996, 35864557563, 35865659327). The automated review
wrapper is not claimed as an independent review. No merge/release was made.
