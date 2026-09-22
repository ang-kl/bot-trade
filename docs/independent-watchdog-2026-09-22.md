# P5a independent watchdog: implementation and activation boundary

This package extends cpp-verify without order-writing code. Supervision is off
unless explicitly configured. No production configuration, credential,
notification recipient, trading mode or deployment has been changed.

The worker probes Node and both configured gateways independently of the broker
ProtectionWatch thread. Configured scanners join the same inventory. Required
gateways without endpoints remain findings. Bounded HTTP probes run in parallel;
Telegram calls happen outside the protection and incident locks. HTTP response
size, connection time and total time are bounded. Redirects are disabled and TLS
verification remains enabled. See [libcurl's total deadline](https://curl.se/libcurl/c/CURLOPT_TIMEOUT_MS.html).

The incident model distinguishes reachability, an identified completed-work
contract, due position management, quote age, scanner progress and unresolved
intent acknowledgements. An acknowledged resting limit is not an unresolved
intent. Zero orders can produce one informational account/session notice, never
a manufactured fault or an order. Broker-confirmed missing SL or mandatory TP1
is urgent; unavailable/stale/contradictory broker evidence cannot clear a prior
missing-protection incident. A lost service groups its dependent work failures.

The initial plan defaults remain 15-second probes, 60-second reachability grace,
60 seconds past a management deadline, 120 seconds past a scanner deadline and
a five-minute no-order notice. `WATCHDOG_POLICY_JSON` can set those documented
fields and `repeatMs`; `accountGraceMs` provides account-specific management and
scanner grace. Values are validated and the effective policy is exposed. These
are observation deadlines, not changes to risk limits or strategy validation.

`GET /state/watchdog` exports Node observations through existing read-tier
authentication. Existing monitor receipts retain their original completion and
due times; a fresh HTTP response never renews them. Registry host/account/symbol
identity selects the shared broker calendar. UTC intervals are projected from
that calendar's IANA time zone and holiday semantics and retained by cpp-verify.
They keep their original evidence expiry, including during a Node outage.
Unknown hours are not closed. An uninterrupted session does not restart at
named liquidity sessions; a continuous market with no observed opening does
not receive an invented daily opening time.

The existing sender's master switch, quiet hours and urgent bypass are exported
as a bounded policy snapshot. cpp-verify can use the last valid snapshot during
Node loss, for at most its 24-hour evidence lifetime. Unknown or expired policy
mutes delivery visibly. It cannot discover a setting changed in an unreachable
Node database until connectivity returns.

Incidents and a bounded outbox share an exclusively locked, atomic,
file-and-directory-fsynced `watchdog-state.json` beneath `VERIFY_JOURNAL_DIR`.
State is persisted before delivery. Failed storage prevents untracked sends;
corrupt state is not silently reset. The outbox prioritises urgent findings,
caps retries at 20, honours Telegram `retry_after`, limits repeats, retains
stable incident identities across restarts and records accepted message IDs.
Resolved history retains 30 days. Saturation/capacity refusals remain visible.
Telegram has no sendMessage idempotency key: a crash after Telegram accepts but
before the acceptance checkpoint can still duplicate a delivery. Acceptance
also does not prove that the device displayed or read it.
See [Telegram's sendMessage and response parameters](https://core.telegram.org/bots/api#sendmessage).

Configuration for a future reviewed rollout:

| Input | Purpose / default |
| --- | --- |
| `WATCHDOG_ENABLED=1` | Enable observation; default off |
| `WATCHDOG_NODE_URL`, `WATCHDOG_EXEC_URL`, `WATCHDOG_ACCT_URL` | Exact read endpoints; required services are never omitted |
| `WATCHDOG_TICK_URL`, `WATCHDOG_TIMEFRAME_URL` | Exact scanner endpoints; a configured missing scanner is a finding |
| Matching `WATCHDOG_*_SECRET` | Read authentication; Node should use its existing read-tier credential |
| `VERIFY_JOURNAL_DIR` | Existing prepared persistent directory; writable lock/checkpoint required |
| `WATCHDOG_MASTER_ENABLED=1` | Additional deployment permission to send; default off |
| `WATCHDOG_INCIDENT_OWNER=cpp-verify` | Sender ownership declaration; default observation only |
| `WATCHDOG_TELEGRAM_TOKEN`, `WATCHDOG_TELEGRAM_CHAT_ID` | Explicit outbound token and intended recipient; never a second command poller |
| Node `watchdog_incident_owner=cpp-verify` | Reviewed handoff declaration; absent means Node retains alerts |

Both ownership declarations and the valid Node master policy are required to
send. After an explicitly approved handoff, Node retains the observations and
audit trail but stops duplicate gateway/fast-monitor liveness and generic
missing-protection notifications. Existing target approval buttons and actual
repair confirmations remain available. Account authorization, internal job and
local-audit failures are distinct observations and remain owned by Node. A
rollback must restore Node ownership and reset the transferred controllers'
legacy `stalled` / `fail_alerted` notification markers so an already-active
condition is announced by its new owner. No handoff or rollback ran here.

Controllers show supervision, storage, master permission, credentials being
configured, effective alert permission, policy deadlines, queued deliveries,
capacity refusals and active incidents. Stale status becomes unavailable. The
independent protection poll keeps a successful broker reading even if the
optional watchdog status request fails.

Acceptance still required:

- Gateway and new-scanner completed-work producers must be connected to this
  contract; an old `/health` payload is deliberately insufficient work evidence.
- The no-orders engine requires the actual strategy owner's complete activity
  and blocker receipt. Engine fixtures do not establish a deployed producer.
- An explicit closed-market management audit cadence remains a P4 contract
  decision; this code reports the missing deadline instead of inventing one.
- Verify recipient, effective settings and real Node-down delivery during the
  approved controlled rollout. Local HTTP fixtures send no real Telegram.
- Provision an observer outside cpp-verify for total verifier/platform failure.
  No provider was selected or provisioned by this package.
- Verify mounted-volume capacity/persistence and authenticated Controllers
  interaction. No runtime or visual acceptance is claimed from local tests.

Tests exercise process loss, reachable-but-stalled work, one overdue account,
stale quotes, missing protection, no-signal/no-order outcomes, resting orders,
intent deadlines, DST folds/gaps, weekends, holidays, second-resolution breaks,
unknown calendars, master/quiet policy, Node-down policy continuity, HTTP
timeouts/response bounds/redirect refusal, retries, recovery, restart state,
exclusive file ownership and preservation of approval actions. Repository gate
results and publication state belong to the PR/progress record.
