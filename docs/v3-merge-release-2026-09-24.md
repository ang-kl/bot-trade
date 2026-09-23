# V3 conflict resolution and release checkpoint — 24 September 2026

The owner requested “#1046 — branch has conflicts ... resolve and merge all”.
This release covers the six existing V3 PRs, not trading activation, feed trials,
broker mutations, credentials, external alert provisioning or outage drills.

## Merged commits

| PR | Main commit | Result |
| --- | --- | --- |
| #1046 | `82cf0258399f85e6cdd029ba459f99b395e6007a` | Conflict resolved; both historical progress sections retained; RSI observation parity merged |
| #1049 | `bbf3b16383881064b8b82bccbc88ab1ce2291e55` | Cooperative housekeeping; review fix refreshes watchdog only on completed pruning windows |
| #1052 | `4a5dc08a323cce769fea280963e40016a158a784` | Independent observer preparation; full outbox can drain and persist a deferred transition |
| #1050 | `c6d4b9791925ba01c5ea0db79e67067d337eeb6a` | Actual map readers and calendar collector; fairness, staging disarm and incomplete-cache fixes |
| #1051 | `f8f02515716e667a407434f1e1fdbca954687258` | Profile registration and continuous comparison; merged after its #1050 dependency |

## Held PR #1048

The fresh review found a real end-to-end omission: the scanner's new HTTP 429
was retryable, but the gateway discarded the batch. Corrected source is retained
at `c067b9402c725eb45add03e68bba44c316fa770d`, with current main incorporated in
the follow-up branch. No force push or merge-gate bypass was used.

The gateway now retains identical bytes and sequence for bounded transient
retries. Failure/exhaustion remains explicit, bounded memory remains, and the
quote producer never waits. Focused native tests passed, including actual
loopback HTTP 429/202/403/503/408, ambiguous replay, ordering, permanent rejection,
retry exhaustion, gap recovery and nonblocking ingestion. Full cpp-exec CI and
ThreadSanitizer remain pending, not claimed passed.

This changes `cpp-exec/**`: merging now additionally redeploys BOTH broker
gateways. The prior scanner-only scope did not include those restarts. #1048 is
draft/held for the owner's approval of the expanded release described in
[the scoped proposal](v3-tick-ingress-acceptance-2026-09-23.md#review-follow-up-and-expanded-release-proposal---24-september-2026).
Approval would still be conditional on the complete updated merge gate.

## Verification

- Final combined integration `e235d3d`: 5,388 backend tests, zero failures/skips
  (28 strict HTTP-latency cases isolated plus 5,360 remaining tests); 936 frontend
  tests; ESLint, build and no-green passed. No tests or thresholds weakened.
- Exact released application, workflow, execution/verifier and timeframe source
  trees were compared with that integration and match. The retained tick-native
  correction is separately held in #1048.
- Fresh timeframe C++ reference, option parity, refusal, session/DST and volume
  tests passed. Updated PR CI passed before each merge. Runs: #1046 CI
  `35891821164`, scanners `35891821287`; #1049 CI `35892812364`; #1052 CI
  `35892913783`; #1050 CI `35893178886`, scanners `35893178797`; #1051 CI
  `35865659137`, scanners `35865659327` (unchanged head, combined dependency tested).
- #1048 source head CI `35893383625` and scanners `35893383511` passed; cpp-exec
  `35893383411` was still building at this checkpoint. These are not a substitute
  for passing checks on any later branch-update commit.

## Production readback

Railway watch filters were read before merge. Node deploys for every main change;
the timeframe scanner deploys for #1046. All gateway, verifier and tick-scanner
deployment events were correctly skipped. Node intermediate builds were
superseded by later main commits; this is not evidence of a runtime failure.

At 17:11 UTC on 23 September (01:11 SGT on 24 September), Node and timeframe
deployments for #1046 were successful. Final Node deployment
`37676b36-464c-4fa4-bdbd-79f5bdd10fec`, source `f8f02515716e667a407434f1e1fdbca954687258`,
was still building. Post-final-release health/protection readback is pending.

Fresh configuration names show no scanner bridge/feed variables on Node or
either gateway; both scanners have only PORT and SCANNER_SECRET. No configuration
was written. Trading activation, notification permission and credentials were
not changed. No broker orders or position amendments/closes were submitted.

Independent broker receipts at 16:51:01–16:51:02 UTC, before this release,
covered all seven connected accounts: 32 open positions, 32 SLs, 30 TP1s. The
two account-level TP1 exceptions persist. This does not constitute a new
position-specific target/quote decision or a broker-confirmed latency sample.

## Production acceptance — not software-test status

| Gate | Status | Remaining limitation |
| --- | --- | --- |
| 1 Protection | Failed | Two TP1 exceptions remain; representative broker-confirmed p95/p99/max latency not verified |
| 2 Watchdog | Not Verifiable | Bounded production Telegram delivery, Node outage and external verifier-outage drills not authorised/executed |
| 3 Scanner/load | Failed | Current production tick ingress still lacks held #1048; representative feed peaks, deployed exact profiles and protection-under-load remain unverified |

Local tests do not establish full V3 acceptance or tick-trading readiness.
An unresolved position decision did not block the independent corrections.

## Rollback

For the five merged releases, restore Node's pre-release deployment
`da18316b-6be1-4bd8-83b0-2d56e8b64d63` and, if the RSI worker must be reverted,
timeframe deployment `866cb701-78ff-4ff9-a5fd-046177b1b6a2`. Keep feeds OFF and all
activation/credential settings unchanged. No database rollback is required by
these additive observations; prior images ignore the new records. Rollback
restores the old housekeeping/calendar/comparison limitations. Do not touch the
unchanged broker gateways or verifier. #1048's separate proposal records its
expanded rollback targets. No rollback was executed.
