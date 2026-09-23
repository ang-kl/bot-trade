# V3 release readiness — 23 September 2026

Prepared for owner review. This document does not grant deployment, trading,
scanner-feed, notification or target-policy permission. Standing repository
publication/merge policy remains subject to the controlled-rollout runbook.

## Prepared code

- #1042: use the same bounded, strictly attributed P&L recovery on every
  selected/peer account pass. Its read-only history diagnostic exposes older
  unknown money and the local rows behind an ambiguous position identity.
- Native default-profile package: seven additional ports bring closed-bar
  reference-default coverage to twelve per-symbol strategies; 154 frozen
  reference cases, 900 New York session-hour cases and 24 volume-profile cases.
  Pending/non-default settings retain the JavaScript owner. No scanner feed or
  candidate admission is enabled by deploying this code.
- Watchdog feed producers, independent incident state and outer-observer
  implementation are already merged. Current-source state and HTTP/persistence
  tests pass. No new watchdog implementation is claimed by this checkpoint.
- Follow-on EMA option package: adds pending-entry, optional stacking, stop
  floor/ceiling and time-cap reference parity to the observation-only timeframe
  worker. It is stacked on #1043, with the same Node/timeframe-only proposed
  release scope and no activation permission. See
  `native-ema-options-parity-2026-09-23.md` for exact tests and remaining limits.

## Why a green merge still needs a rollout decision

Production project `1832aca1-bc68-4bba-834f-cb0b3c4c05ca`, environment
`7bc0dfc6-82c5-406c-a621-fd3ff549674d`, still returns no active watch filters.
Main changes have deployed unrelated gateway services. The current gateway
and verifier JSON files place `watchPatterns` at the top level; Railway's
[configuration reference](https://docs.railway.com/config-as-code/reference)
places that property under `build`. This is a likely explanation for the
ineffective filtering, not proof of the platform's internal parsing behavior.
The [watch-path documentation](https://docs.railway.com/builds/build-configuration)
also says patterns are relative to the repository root even with a service root.

The existing controlled-rollout runbook explicitly forbids silently changing
these settings or treating merge approval as permission for coupled gateway
restarts. No such configuration mutation has been performed in this continuation.

## Recommended scoped release — approval required

Apply only the following production watch filters through Railway service
settings, read them back, and establish that they are effective before merging.
These retain the existing gateway/verifier dependency patterns and add the two
new services' own build directories. Do not change source, credentials, regions,
replicas, volumes, account modes or health configuration.

| Service | Service ID | Proposed watch patterns |
|---|---|---|
| cpp-exec | f5a3ba4a-52c0-4f4f-999b-45f758d607f0 | `/cpp-exec/**`, `/agent/lib/exec-engine.*` |
| cpp-acct | a370f641-1e1b-4893-83af-e5eb1e8ffb3c | `/cpp-exec/**`, `/agent/lib/exec-engine.*` |
| cpp-verify | bc8fcb8d-8194-4acd-9a82-4098751e43cc | `/cpp-verify/**`, `/cpp-exec/src/ws_client.*`, `/cpp-exec/src/http_server.*` |
| cpp-scan-tick | f716e9cf-7a7b-4a04-b484-49b05b698e6a | `/cpp-scan-tick/**` |
| cpp-scan-timeframe | c8e47534-3488-4591-b361-c85366c550e0 | `/cpp-scan-timeframe/**` |

Node's existing trigger is unchanged. This release is expected to update Node
and cpp-scan-timeframe only across the two code packages. Existing Node-owned
management can pause during its restart; broker-held protection must be checked
fresh before and after. No zero-downtime guarantee is made. If applying the
filters itself requires a gateway restart or an unrelated staged change, stop:
that is outside this recommended scope. Do not bulk-apply environment patches.

Before each qualifying main merge, re-read its head/base/CI/review state,
per-account broker protection, ownership and pending intents. Preserve the
current deployment IDs and durable state. After each Node restart, verify
broker roster, protection, management resumption and intent recovery; inspect
actual Railway deployment events to confirm unchanged gateways stayed up.
Read the new history diagnostic for both old refused positions and investigate
their exact local row identities before proposing any data correction. Retained
unpriced/written-off records must remain unknown until broker proof exists.

The scanner's new deployment must pass its health check with only its existing
PORT/SCANNER_SECRET configuration. Node's scanner bridge and feed URLs/secrets
remain absent. A successful container deployment is not scanner activation.

Rollback owner: Adrian Ang. Preserve the pre-release Node deployment and
timeframe-scanner deployment. Any code rollback needs the same protection and
intent checks. A gateway restart, if separately approved later, follows V3 §18,
including scoped submission quiescence and one environment at a time where
the platform permits.

## Separate watchdog acceptance boundary

Observation-only supervision can be prepared using `WATCHDOG_ENABLED=1`,
authenticated Node `/state/watchdog`, and gateway/scanner `/watchdog` endpoints,
with existing read-scoped secrets supplied privately. Keep notification master
and incident owner OFF. Verify five target receipt streams, per-account work
times, calendar identity/expiry and persistent `/data` incident state across a
controlled verifier restart. Unconfigured/inactive scanners must not be presented
as active market-feed coverage.

Real notification delivery additionally needs the approved recipient, verifier
sender credentials, `WATCHDOG_MASTER_ENABLED`, and matching incident-owner
handoff in both Node and cpp-verify. Read back master/quiet-hours/urgent-bypass
policy, then verify one test receipt. Node-down, delivery-failure/retry/recovery,
restart deduplication and verifier-down drills need a scoped window. The external
observer requires its approved runtime/schedule/destination and separate
read-only verifier credential. No message or outage drill was executed here.

Scanner activation, target-policy amendments, new strategy promotion, risk
limits and account roster changes remain separate decisions. Release approval
for these code packages does not approve any of them.

## Remaining work estimates

These are effort ranges after their named prerequisites, not completion promises.

| Work | Remaining evidence / prerequisite | Estimated effort |
|---|---|---|
| Reporting/history release acceptance | Scoped rollout; inspect actual ambiguous records | 20–40 minutes; any broker/data repair estimated after diagnosis |
| Full scanner semantics | Inventory active non-default/pending profiles; implement and freeze exact counterparts | 4–8 hours of engineering, subject to profile inventory |
| Peak-feed and protection latency | Representative retained inputs, approved observation-only activation and agreed load window | 1–3 hours plus a representative market observation window |
| Watchdog runtime acceptance | Observation configuration, approved recipient/sender handoff and controlled drill window | 45–90 minutes after prerequisites |
| P0/P3 targets and P2 intended roster | Owner's specific policy/account decisions and fresh position evidence | No honest end-to-end ETA before decisions |
| P6 research and P7 strategy decisions | Attributable production replay inputs/profile hashes, completed evidence gates | Input audit 30–60 minutes; replay runtime measured afterward |
| P8 capacity | Completed protection/scanner load evidence and measured storage/cost | 30–60 minutes to assess after load evidence; no scaling authorised |

V3 is not complete. Reporting fixes, default calculation parity and six deployed
containers do not establish live safety, full native semantics, alert delivery,
research readiness or profitability.
