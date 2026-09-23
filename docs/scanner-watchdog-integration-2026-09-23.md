# Scanner feed, comparison and watchdog integration

This connects observation paths while retaining existing strategy, admission,
order and protection ownership. Scanner services and their mirror transport
were initially unconfigured. Both scanner services were subsequently provisioned
and platform-health-checked on 23 September; their market-data bridge remains
disabled. No target policy, risk limit, credential, market mode,
notification recipient or deployment setting is changed.

## Feed and comparison

The existing timeframe evaluation offers the exact closed-bar input and actual
reference result to a bounded observer. A cache from another account/host is
never relabelled. Only the implemented FX-tuned baseline Fibonacci profile is
eligible in the original integration baseline. The subsequent
[native default profile package](native-default-strategy-parity-2026-09-23.md)
extends coverage to all twelve per-symbol strategies. Non-default semantics
and partial bars remain explicitly unsupported. The strategy still returns its existing
result even if observation fails.

`SCANNER_BRIDGE_ENABLED=1` is an explicit runtime activation step. Without it,
no worker starts. With reviewed profiles/endpoints, a separate worker owns the
HTTP transport, SQLite comparison records and JavaScript tick oracle. It has a
128 MiB heap limit and at most 32 queued observations of at most 4096 bars each.
Network requests have a two-second total deadline, no redirects, scanner-only
credentials and a 256 KiB response cap. Timeframe delivery has three attempts;
retries preserve the original source receipt and cannot make old input fresh.

The tick scanner's authenticated `/comparisons?after=N` publishes the actual
completed quote evaluations, including worker queue-gap resets, native result,
profile and full feed identity. Its ring retains 4096 records. The isolated
JavaScript oracle uses precisely those inputs. A polling pass drains at most
32 pages within a four-second work budget plus its in-flight HTTP deadline.
Restart, overwrite, unknown warm-up, expiry and mismatches remain evidence;
they are never converted into complete parity. V and E use the reference
oracle's documented six-decimal output precision; economic prices and stops
are unchanged. Local setup counters are not cross-process economic identity.

Reference and comparison records retain up to seven days and 100,000 rows each.
These bounded observations are not independent research samples or an entire
trading history. The existing candidate collector checks identity, profile and
expiry before pairing timeframe results with their recorded reference. Mirror
results never create entry intents. Controllers expose the worker queue/drop
state and comparison populations, including missing evidence.

## Watchdog producers

Both gateway roles now expose authenticated `/watchdog` contracts. Reconcile
receipts retain their actual completion times and the existing 30-second sweep
cadence plus its per-account request budget. Quotes retain actual receipt time,
including zero for subscribed instruments never seen. HTTP reads refresh neither.
The service identifies itself from Railway's existing service-name variable.

The Node owner records completed legacy scan batches and the expected rotating
universe. Instruments not visited retain their old completion/deadline; polling
or evaluating another batch cannot freshen them. Per-account session activity
uses complete retained dispatch, intent, fill and blocker populations. Those
overlapping sources are not summed into a false order count. Partial batches,
ambiguous fills and incomplete evidence cannot produce a verified zero. An
acknowledged resting order counts as activity. This is an informational notice
about recorded activity, never a trading fault or reason to submit an order.

The shared broker calendar travels separately from work receipts. cpp-verify
matches account, host and instrument, preserves original observation/expiry
during Node loss and reports unknown hours instead of assuming closure.
Gateway work deadlines and no-order receipt completeness are exercised by the
watchdog engine. Existing master, quiet-hours, urgent bypass and sender-ownership
controls remain in force.

`scripts/verify-observer.mjs` is a standalone read-only outer probe with no
application database or broker/Telegram credential. It checks the verifier's
actual probe attempt timestamps, not just a fresh HTTP timestamp. The manual
GitHub Actions workflow is an execution entry point outside Railway and uses
separate `VERIFY_OBSERVER_URL` / `VERIFY_OBSERVER_SECRET` secrets. No schedule,
recipient, secret or external alert route was activated.

## Acceptance boundaries

Local acceptance includes real C++ HTTP services connected to the Node feed,
collector and reference implementation, bounded queues/retries, input gaps,
duplicate prevention, expected-work rotation, cross-account identity, resting
orders, stale evidence and Node-outage calendar continuity. Fake transports and
isolated databases create no broker order and send no real notification.

Runtime acceptance still requires approved scanner activation,
measured peak-feed/protection latency, authenticated real account/UI readback,
recipient/settings verification and a real Node-down alert drill. The outer
observer still needs its deployed credentials, schedule and alert destination.
The default-profile ports are a separate package from the original integration
baseline; pending/non-default parity remains open. No full scanner parity, live rollout or notification
delivery is claimed from these tests.

At 15:11 SGT on 23 September, authenticated Controllers showed supervision,
durable incidents, urgent notifications, credentials and incident ownership
OFF; the external observer was unconfigured. In this continuation the current-source
C++ watchdog state and HTTP/persistence suites passed locally. Node-down policy
fixtures are not proof that a real recipient received an outage alert. The
[reviewable release and acceptance sequence](v3-release-readiness-2026-09-23.md)
keeps observation, sender handoff, external delivery and fault drills explicit.
