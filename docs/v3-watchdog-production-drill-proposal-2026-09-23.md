# Bounded production watchdog acceptance proposal

Status: prepared, not executed. Production observation remains enabled; delivery,
incident ownership handoff and the external observer remain disabled/unconfigured.
This proposal does not authorise orders, position changes or scanner feeds.

## External observer implementation

`scripts/verify-observer.mjs --watch` can run outside Railway and Node, at a
30-second completion-paced interval. Existing one-shot/manual workflow remains
available. Delivery is opt-in with VERIFY_OBSERVER_DELIVERY_ENABLED=1 and a
separate absolute VERIFY_OBSERVER_STATE_PATH on durable storage. Provisioning
also requires the existing read-only verifier URL/secret and the approved
Telegram token/chat binding under VERIFY_OBSERVER_TELEGRAM_TOKEN and
VERIFY_OBSERVER_TELEGRAM_CHAT_ID. No credential has been read, copied or changed
for this implementation. The operator supplies existing approved bindings.

Use a single supervised process with an OS lock, for example `flock -n
/var/lib/bot-verify/observer.lock node scripts/verify-observer.mjs --watch` on
the independent host. The directory must exist, be restricted to its service
user and reside on persistent storage. The journal uses atomic rename plus
file/directory fsync, retains at most 128 pending events, and refuses capacity
rather than silently dropping. Corruption fails closed. It persists before a
send and retries with bounded exponential backoff. Only affirmative Telegram
message IDs count as API acceptance. An ambiguous crash/send may repeat the
same event ID; this is at-least-once delivery, not exactly-once or read receipt.
The external supervisor's own failure still requires host-level monitoring.

## Approval A: release and passive observation

Deploy reviewed Node corrections (housekeeping, calendar and profile/collector)
and cpp-scan-tick ingress correction using normal main deployment triggers.
Keep both feeds and SCANNER_BRIDGE_ENABLED OFF; no native gateway restart.
Observe one complete housekeeping pass and every connected account/calendar
refresh. Retain per-step duration, task deadlines, loop lag, independent account
coverage and actual source timestamps. Measure scheduler p95/p99/max separately
from any broker-confirmed protection latency; without an amendment, the latter
is not measured. Stop rollout on missing-stop regression, stale account evidence,
new overlap/ownership defects or repeated database lock failures. Restore prior
Node/scanner images; this restores known old limitations, not acceptance.

## Approval B: bounded notification and outage drill

First provision the independent host and approved destination binding, verify
its durable journal and successful read-only probe, and review the existing
pending cpp-verify outbox (257 at 13:03:51Z). Do not unmute that backlog blindly.
Retain the production notification master/quiet-hour/urgent policy; propose any
specific policy change separately. Establish one alert owner before handoff.

With an approved destination and maintenance window: allow at most one labelled
failure/recovery pair from each observer (four messages total), no repeated
outage. Simulate Node unavailability to cpp-verify by a bounded probe-path
failure if supported; otherwise stop Node for at most 90 seconds, only after
all-account independent stop coverage and manual recovery access are verified.
Verify cpp-verify sends the labelled failure while Node is unavailable, then
restores the original Node deployment and records recovery. Next stop only
cpp-verify for at most 90 seconds and verify the external process delivers its
failure/recovery pair. Restore the exact successful verifier deployment and
confirm durable dedup/outbox continuity. No gateway stop or broker mutation.

Abort immediately if broker protection coverage falls, a service cannot be
restored, an unlabelled backlog starts delivering, or the four-message bound
would be exceeded. Save API receipt IDs, recipient confirmation, timestamps,
incident IDs, deployment IDs and journal state. Stop the external delivery
process and restore original policy/ownership if acceptance fails. Deployment
restart API previously lacked a retained snapshot for a SKIPPED event; verify
an operable dashboard restart/rollback against the successful deployment before
an outage. Until these actions are approved and executed, mark them Not Verifiable.

## Approval C: observation-only feed trial, separately

Select exact account/feed/strategy/configuration hashes from read-only runtime
inventory and register only those profiles. Propose a maximum 15-minute window,
existing subscriptions only, explicit rate/concurrency and memory caps, and
zero order authority. Capture per-second and burst distributions, gaps/retries,
collector lag, broker account coverage and scheduler latency. Abort on any drop,
comparison gap, persistent backlog, memory bound or protection starvation.
This scope requires separate approval; feeds remain OFF now. A paced synthetic
fixture is not a substitute for measured production peak requirements.

Local validation: 5,365 backend tests including 28 isolated latency cases,
936 frontend tests, lint, build and no-green passed. Freshly compiled C++
`test_watchdog` and `test_watchdog_http` passed failure/work/recovery/restart,
bounded HTTP and durable exclusive-state checks. External delivery tests use
only injected transports and temporary local journals; zero Telegram messages
were sent. Production drills remain Not Verifiable.
