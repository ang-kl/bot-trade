# Reporting and history acceptance

The Performance page now exposes the retained first-blocker evidence through
`GET /state/blocker-report`. An explicit registered account or `all`, UTC window
and bounded detail page are required. Totals cover the full retained population;
detail pagination does not change their denominator. Unassigned records are
excluded from individual accounts and counted separately.

Recorded upstream stops, gate refusals, post-approval failures, approvals and
other stops remain separate. A management skip or unknown stage cannot establish
which entry checks ran. Missing checks remain unrecorded and downstream checks
after a known entry stop are not evaluated. Approval does not prove submission
or fill. Repeated refusal counters cover a row's lifetime, not exact attempts in
the selected window; duplicate observations across logs are not unique signals.

V3 C4 (25-09-2026, SEQUENCE PR-4) adds the tick side to the same report, and
moves it off the protection event loop into the isolated report worker
(`readBlockerReport`; a full report pool answers 503 with a retry hint, a
failed worker read 500, a malformed or unregistered request 400):

- `tick_refusal` is its own kind: the sidecar's ring rows `fire_refused`
  (the stopping check in `code`, `fire_stale` included), `fire_reject` and
  `fire_abandoned` from `cpp_decisions`. Each row is marked at the permit, the
  sidecar's own checks and the broker, never at the bar risk gate; rows are
  dated when Node pulled them (the sidecar's clock is in the detail), and a
  ring record overwritten between pulls is not counted.
- `byStage` ranks up to five entry stops per account (upstream, risk,
  after-approval and tick refusals), with the newest record's reason.
- `tick` says whether tick entries were evaluated at all, per registry
  account: `evaluated` only when a permit-feed pass pushed to the sidecar in
  the last six minutes with the account listed, `admitted_not_pushed`, or
  `not_evaluated` with the reason (on 25-09 every account is bar-only, so
  every account reads `not_evaluated — basis_not_admitted`). Zero tick
  refusals on such an account is not a pass.

The same records feed the watchdog contract: each `entry_activity` item now
carries `blocker` as a string (the no_orders notice printed an empty blocker
from the object before), tick-only and dual accounts get `entry_activity` from
the tick permit feeder's own receipt (`tick_entry_work_json`), and a bounded
`entryDiagnostics` block (Node records, never broker-verified) rides the
contract. Since V3 CV-1 cpp-verify relays it on `/watchdog-status` labelled
`node_records_relayed` / `brokerVerified: false`, keeps it in memory only (its
fsynced watchdog state stores the contract without it), and the Controllers
panel shows it as "Entry refusals — Node records relayed by cpp-verify (not
broker-verified)", with each account's open-position count from cpp-verify's
own broker read beside it. The no_orders notice prints the `blocker` line
(`watchNotificationText`), pinned from both sides by
`cpp-verify/src/tests/fixtures/node-entry-activity.json`.

Two limits of C4, recorded rather than carried silently:

- A stalled tick permit feeder goes quiet instead of raising an alarm. Its
  receipt stops being evidence after six minutes, the tick `entry_activity`
  items leave the inventory, and cpp-verify retires any open no_orders
  incident on them as `work_no_longer_in_complete_inventory`. (The bar scan
  receipt has no such age limit, so its `scanner` items stay in the inventory
  and can raise the stall alarm while their market is open.)
  **Addressed by V3 F4 (26-09-2026), on the Node side:** every cpp_probe, after
  the sides are probed, `agent/services/tick-feeder-stall.js` sets each side's
  tick-admitting accounts beside its latest receipt. No complete pass for
  two cadences (240 s or more, so the second missed 120 s probe) while an
  account admits tick is `stalled`; a failed or
  empty push is `incomplete`. The verdict is the `tick_feeder` heartbeat
  (`GET /state/heartbeats`: warn on the first failed check, error from the
  third; the side and reason in `last_error`, the per-side table in `detail`;
  `dormant` with its reason while no account admits tick) and a
  `tick_feeder_stall:<side>` finding in the log inspector (`GET
  /state/inspector`). The controller is registered `quiet`: its stall and
  failure events go to `action_log`, no message is sent (delivery is OD-10's).
  cpp-verify's own inventory is unchanged: no per-side feeder work item was
  added to the watchdog contract.
- Worker cost: on a synthetic database (7 accounts, 100k `decision_log` rows
  over 3 days, 200k tick signal rows) the independent checker measured the
  watchdog contract build at 1.5 s before C4 and 2.35 s after, inside the
  reserved watchdog worker (15 s deadline, polled every 15 s):
  `entryDiagnostics` about 460 ms, and each per-item blocker read about 30%
  slower. Production volume was not measured.

Account history requires two comparable observations at different times before
reporting change or sampled drawdown. A single reading remains monetary evidence
without becoming a zero return. Page change explicitly names its observation
span. Older observations are accessible in the UI; incomplete batches do not
claim complete cashflow-adjusted change or drawdown. Browsing older history
freezes the requested time window, and account changes reset the reader. The
Performance local clock names the actual device timezone.

Behavioural acceptance covers the real Express routes against an isolated
SQLite database, complete totals beyond the detail cap, UTC boundary handling,
account isolation, malformed evidence, read-only behaviour, cashflow adjustment,
single and simultaneous observations, and the rendered empty/unavailable and
paginated states. No production credential, account setting or target policy
is changed by these reads.

Production acceptance is not complete: the available browser session is not
connected to the agent. Its unavailable state was observed; authenticated real
account API/UI and mounted retention/cashflow coverage still need readback.
Fixture results must not be represented as production history acceptance.

Post-merge classification review: successful pending, closed-market and HTF
placement receipts are retained as `placement_receipt`, outside risk-approval
totals. A receipt proves recorded placement, not a fill or a second gate
evaluation. JSON boolean checks are parsed structurally. The submission-boundary
`symbol_position_cap` is a post-approval failure; the established
`regime_block`, `evidence_gate` and `producer_retired` stages are upstream.
Fixture regressions cover these cases, account scope, pagination and rendering.

The workspace disconnected during the scanner integration gate on 23 September.
These reporting corrections are therefore published through GitHub and require
the full PR CI gate; no local execution is claimed for this follow-up.
