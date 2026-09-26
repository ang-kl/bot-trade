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
Since V3 CV-1 (25-09-2026) the timeframe scanner lists only cells with a job
queued or running, so an idle cell carries no scanner deadline; a Node work
item with role `collector` (the scanner observation collector) is judged like a
gateway's reconcile — calendar-free, stalled 60 seconds past its deadline — but
as a warning, since it loses observations, not protection. `/watchdog-status`
also relays Node's `entryDiagnostics`, labelled Node records, not
broker-verified (cpp-verify/README.md).

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

## V3 CV-2 (26-09-2026): delivery muted through a 24 h soak

OD-10 (owner, 26-09-2026 18:05 SGT): delivery is held until after the soak.
cpp-verify now has a delivery gate of its own, on top of the existing switches
(`WATCHDOG_MASTER_ENABLED`, `WATCHDOG_INCIDENT_OWNER`, the Telegram credentials
and Node's `notificationPolicy`).

- **Muted by default.** A fresh state file, a state written before CV-2, or a
  malformed `delivery` block restores muted. The 24 h soak starts at the first
  boot of this build (`beginSoak`) and a restart keeps it: it is never
  restarted. The soak length is not configurable from the environment.
- **Nothing leaves while muted.** The run loop asks `releasable(now)`, which is
  null unless the soak has ended AND the verifier-local mute was lifted. The
  soak's end alone never unmutes.
- **The verifier-local mute** is `POST /watchdog/mute {"muted": true|false}`,
  behind the service bearer, and it answers with Node down. Muting always
  applies; unmuting is refused (409 `soak_active`) during the soak. Calling it
  is an owner step, not part of any merge. The bearer is `EXEC_SECRET`, which
  Node also holds (it is the secret Node's relay uses for `/protection-status`),
  so anything with Node's environment can call it; that is accepted for a mute
  and a post-soak unmute, and it is the reason the unmute is refused in the soak.
- **An unmute is refused over a stale backlog** (409 `stale_backlog`): while
  any held item is older than `repeatMs` (1 h). An unmute releases what the
  mute held, oldest urgent first, one per probe cycle — so a fresh urgent
  missing-SL incident would wait behind it (the next releasable item 71 h old
  in the production-shaped test), or be refused at the bound when all 512 are
  urgent. Refusing is the smaller safe change: the verifier stays in the state
  the soak already runs in, whereas a warning would still let that fresh alert
  queue behind the backlog, and releasing urgent items first would need the
  eviction and ordering changes of the rest of item 26. **Nothing is disposed
  of** by the refusal or by any code here: disposing of the backlog is the
  owner's step (after a `/data` backup, through the `dispose(createdBefore)`
  route still to come). `delivery.staleBacklog` {count, oldestCreatedAtMs,
  olderThanMs} and `delivery.unmuteRefusal` (null when an unmute would apply)
  say where it stands. An already open verifier is never refused by it.
- **A change that is not durable is not "ok".** The reply carries `applied`
  and `durable`; `ok` is true only when both hold. If the state cannot be
  written, the route answers **503 `state_not_durable`**: a mute stays applied
  in this process (the safe direction — and the run loop sends nothing while
  writes fail), but a restart would restore the file's older state, so the
  caller must retry it; an unmute is undone.
- **Unmute before any handoff, and confirm it.** Once Node's
  `watchdog_incident_owner` reads `cpp-verify`, Node stops its own pages for
  what cpp-verify owns: gateway and fast-monitor liveness
  (`heartbeat.js:558`), missing SL (`naked-position-guard.js:432`) and generic
  missing TP (`:706`), by `watchdog-ownership.js:5-8`. A handoff while cpp-verify
  is muted — or a mute after the handoff — leaves an urgent alert with no
  sender at all. So the order is: soak ends, the backlog is disposed of, the
  unmute is applied (`delivery.open: true` on `GET /watchdog-status`), and only
  then the handoff; to mute again later, roll the handoff back first.
- **Only the owner of the state writes.** A mute is applied and persisted only
  once `start()` has taken the lock and restored (or created) the state. With
  supervision off, the lock held by another process, or an unreadable state,
  the route answers `watchdog_not_started` with `durable: false`, never writes
  the file and never clears the start error.
- **One in-flight message.** The message is chosen under the state lock and
  sent outside it, so a mute that lands between the two can still let that one
  already-chosen message go (at most one per probe cycle). Every later
  selection sees the mute.
- **Would-send counters: what an open verifier would have SENT** while
  delivery is closed, by severity (`urgent`, `warning`, `info`), with
  `urgentPerHour` / `totalPerHour` since the first count — the rate the owner
  reads at the end of the soak (OD-10: urgent alerts only). One per opened,
  escalated or recovered transition (a once-only notice once), and at most one
  `still_active` repeat per incident per `repeatMs` while it stays active.
  They run on each incident's own schedule (`wouldSendAtMs`), apart from the
  outbox: an item the 512 bound refuses is never counted again when it is
  offered again next cycle, and an item held pending by the mute does not hide
  the hourly repeats an open verifier would have sent. The held backlog is not
  counted again either: it was counted when it was created. Measured against
  ground truth — an open verifier given the same inputs, releasing one item a
  cycle, its backlog disposed of — in `test_watchdog.cpp`: (A) one persistent
  urgent incident over a full bound, 239 cycles: 1, where the first CV-2 build
  counted 239; (C) the 25-09 production shape (512 urgent held; 129 calendar
  warnings and 18 never-queued no_orders notices, all active, none pending),
  1 h: 147, where it counted each of them every cycle (35,760 in the review's
  149-warning form); (F) one incident, an empty outbox, 3 h: 3, where it
  counted 1.
- **Refusal counter** (`delivery.refused`, by severity): refusals by the
  512-item bound, THROTTLED — one per would-send refused, however many cycles
  its retry is refused again. The retry itself is never delayed: the incident
  is offered again every probe cycle until an item is stored. `dropped` is
  unchanged: it counts every refused offer (so every cycle's retry), every
  eviction and every incident over the 2,048 bound — a count of attempts, not
  of messages (production: about 24,400 an hour on 25-09).
- **Where to read it.** `GET /watchdog-status` → `delivery` and `stateBytes`
  (4 MiB cap); `GET /health` → `watchdog.deliveryMuted`, `deliveryOpen`,
  `soakActive`, `soakEndsAtMs`; Node's `verify_watchdog` heartbeat (quiet: its
  stall is recorded in action_log, never sent) carries the same block as its
  detail on `GET /state/heartbeats`, and `runtime.watchdog.status.delivery` on
  the same route. `effectivePolicyAllowsUrgent` is false while the gate is closed.
  The lifecycle rule STK-08 (v3) reads `delivery.muted: true` as a holding
  setting: a backlog held by the mute is `held_by_setting`, named with the soak's
  end, never a stuck defect; an absent or non-boolean `muted` is unknown.
- **Schema stays 1.** The gate persists under a `delivery` key that a pre-CV-2
  `restore()` ignores, so a rollback still restores the file. **A rollback to a
  pre-CV-2 build re-enables sending under the old gates alone** (master switch,
  incident owner, credentials, Node's policy): that build has no mute and no
  soak, so the would-be backlog becomes deliverable if those gates are open.
- A restored soak window must be exactly the build's soak length from a real
  start; anything else restores muted with no soak (`reason: soak_not_started`
  until `beginSoak`). A start dated after the boot's clock is rejected at
  `beginSoak` and the soak begins at that boot, muted, for its full length.
- The `verify_watchdog` beat is ok when the gate is reported AND `enabled` is
  true AND `error` is empty; it carries `enabled`, `durable` and `error` in its
  detail. It is dormant while `VERIFY_URL` / `EXEC_SECRET` are unset, and while
  cpp-verify reports its supervision switched off (`enabled: false` with no
  error, i.e. `WATCHDOG_ENABLED` unset there): a switch, not a fault, so the
  row reads dormant with the reason instead of error. A busy `/watchdog-status`
  reply (no gate in it) counts as one beat failure; with `factor: 10` on a 30 s
  cadence that does not stall the beat.

Not in this change (the rest of V3-SEQUENCE item 26): severity floor,
per-incident coalescing, confirm delay, oldest-first eviction, the delivery
budget and drill allowlist, the drill-incident and `dispose(createdBefore)`
routes, the receipt ring, delivery health, and the observer nonce /
`lastSeenAtMs`. So in this build an unmute releases warning and info items as
well as urgent ones, one per probe cycle, with no message cap: in the
production shape, the 147 current warnings and notices would all go out in
the 147 probe cycles (about 37 minutes) after an unmute.
