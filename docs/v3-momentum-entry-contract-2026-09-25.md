# P0/P3: durable entry-to-partial handover

Intent: continue the approved momentum target build by carrying the prepared
policy through an immutable pre-submit entry record, broker-confirmed fill and
atomic book handover. Existing-position repairs remain separate.

The prior foundation PR does not connect a producer. This next contract
requires the entry proposal's account/host/instrument/cost hash before any send;
its actual fill must retain original-risk geometry and valid native protection.
An accepted order without a confirmed fill cannot enroll a partial manager.
Historical/adopted positions, another account, another lifecycle, altered plans
or a minimum-volume whole-position plan never acquire a partial close intent.
Book ownership and enrollment commit together, with complete rollback on error.
(T4, 26-09: the entry is now two atomic steps, deliberately: see "T4" below.)

Scope: new entry-contract service/tests, shared book-entry handover integration,
market/resting-entry call sites and read-only status needed to expose incomplete
handover. No production financial action or automatic activation is verification.
Keep the deployed entry permissions unchanged until the entire producer-to-fill
contract is implemented and tested. No enabled flag is written by this build.

Evidence must cover immutable pre-submit persistence, reload after a process
restart, confirmed slippage anchoring, both account environments, malformed or
foreign receipts, partial fills, competing owner/exit, and rollback of the book
and manager rows. Code completion and natural broker acceptance stay separate.

## Implemented handover slice

The new `momentum-entry-contract.js` records an immutable proposal against the
existing submitting trade, rejects pre-submit evidence older than five seconds,
and checks exact broker-unit volume rather than silently rounding it. A fresh,
account/host/instrument-owned full fill binds the original risk/cost geometry
at the actual entry. Missing, stale, foreign, partially filled or unprotected
positions cannot bind. Book insertion, monitor pause and partial enrollment
then share one transaction; a lifecycle conflict rolls the transaction back.
Minimum-volume whole-position plans preserve their native TP without registering
a partial. Existing book entries with no new target intent retain their behavior.

`GET /state/momentum-targets` is a bounded read-only diagnostic. It preserves
pending or damaged evidence, scopes accounts strictly, never creates tables or
plans, and returns an explicit unavailable result on a database failure. It
states `runtimeIntegration: INCOMPLETE` and grants no execution permission.

Eighteen focused checks pass, including real file close/reopen, atomic rollback,
minimum-volume behavior, both directions on both broker environments, exact
lifecycle identity, stale inputs, failed mandatory-write rollback and real HTTP
status/account isolation. Existing horizon-protection assertions remain intact.

Producer submission/fill call sites, resting-order identity and competing-exit
coordination remain the next portions of the approved contract. This slice does
not call the new planner/manager from a production producer or turn on trading.
It is not P0/P3 or V3 acceptance. Full repository/CI checks and deployment
readback are required for this slice before merging.

## T1 correction: bind arithmetic in ticks and integers (25 September)

The P0 reviewer found that the slice above did not yet anchor confirmed
slippage. Its tests used only integer geometry, so they could not show this.
- The fill-shifted stop was compared unrounded, so a BUY 265.87/247.77 filled
  at 265.91 compared the broker's 247.81 with 247.81000000000003 and refused.
  That refused 5,057 of the reviewer's 30,000 simulated fills and 252 of the
  2,000 randomized cases in `momentum-plan-arithmetic.test.js`.
- The recorded lots were checked against the broker volume with a 1e-8
  tolerance. At FX lotSize 1e7 that refused 32 of the 1,000 sizes from 0.01
  to 10 lots, the first at 8.04 lots.

What changed:
- The bind moves the stop by the fill's slippage in whole ticks. A fill off
  the grid rounds the stop outward.
- The bind compares broker prices with the plan in ticks. The book handover,
  the partial manager and the rank exit compare in ticks too, through one
  ownership rule.
- The record compares volume as an integer. Float residue passes; a
  fractional broker unit still refuses.

The trade row's own entry, stop and target stay exact identity checks at
record time, because the producer writes them from the plan itself.
Production effect: none. No plan is recorded (`recordedPlans` 0) and no
producer calls this path.

## T1b correction: off-grid prices and tick-space targets (25 September)

T1's post-merge check found three things, and measuring the first found a
fourth.

- **H1: an off-grid planned stop bound worse than before T1.** Today's
  producer builds an ATR stop (`loop.js` `synth.sl`) that is off the grid,
  and only its relative distance is snapped when the order is sent. Planned
  from the raw stop, the plan's risk was a fraction of a tick off. The bind
  snaps the shifted stop, so its recomputed target moved by about Q + 1
  times that fraction, and the bind refused on the take-profit after the
  order was live. Measured on main after T1, on 20,000 simulated fills
  (0/2/3/5 decimals, 1-5 ticks of slippage, the broker anchoring the
  relativePoints distances to the fill): 3,190 bound and 16,810 refused.
  The T1 checker's own model gave 6,685 bound after T1 and 10,190 before.
  - Now the proposal refuses an entry or stop more than 1e-6 ticks off the
    grid with `price_off_grid`, before anything is recorded or sent. Float
    residue a few ulps beside a grid price is on the grid.
  - A producer builds the stop from `relativePoints` exactly as it sends it.
    That stop is on the grid, and all 20,000 simulated fills bind.
  - The check is in the proposal, not in `planMomentumTargets`. A bound
    plan's entry is the fill, which may be an off-grid average.
- **Found while measuring H1: a cost reserve on the rounding tolerance.**
  With the stop on the grid, 1 of 16,000 simulated fills still refused. The
  ask-minus-bid float (2904.25 - 2904.24 = 0.010000000000218279) lifts the
  reserve's upward rounding to 0.4900000001. At 2 decimals that is 1e-8
  ticks, exactly the tolerance of the planner's outward rounding, so float
  residue in the summed price decided the tick. BUY 2904.25/2830.44 planned
  a trigger of 3126.17. Filled 3 ticks higher, the bind recomputed 3126.21
  against the broker's 3126.20.
  - From an entry on the grid, the planner now computes the trigger and
    runner distances in whole ticks from the risk in ticks, then adds them
    to the entry's ticks. A proposal and its slipped fill have the same
    risk in ticks, so they get the same distances.
  - An off-grid entry keeps the price rounding.
  - Across 300,000 random planner inputs, main and this branch agree on
    298,584. Every one of the 1,416 differences is a 2-decimal input whose
    reserve is a whole number of ticks plus 1e-10. On those boundary
    reserves, a proposal and its slipped fill failed to move by exactly the
    slip in 18,136 of 300,000 cases on main, and in 0 on this branch.
- **N1: off-grid fills are not supported.** A multi-deal average fill
  (265.905, 265.9133, 265.875 for the BUY 265.87/247.77 case) rounds the
  shifted stop outward. That moves the plan's risk by a fraction of a tick,
  so the recomputed target misses the broker's.
  - The bind now refuses with `entry fill off the price grid (multi-deal
    average): bracket not bound`, not the plain bracket mismatch, so it is
    not read as a wrong broker bracket. An on-grid fill keeps the plain
    reason. The intent stays PREPARED.
  - Simulated with the broker anchoring the distances to the average: 0 of
    20,000 such fills bound. With the broker anchoring them to an on-grid
    first deal: 1,226 of 20,000 bound, by coincidence. How cTrader anchors a
    multi-deal fill's relative bracket is unverified, which is why this
    stays open for T2 (competing and recovered closes) and T4 (the producer
    and resting limits). Until then an off-grid fill whose bracket does not
    match is not bound, and the position stays with the keeper.
  - The "A fill off the grid rounds the stop outward" line in T1's section
    above describes the stop only. It does not mean those fills bind.
- **N2: tick comparisons that no test could turn red.** Switching these
  checks back to float comparisons left every test green:
  - the bind's stop and take-profit;
  - the partial manager's entry and take-profit;
  - the rank exit's entry.

  New tests give the broker side the same grid prices a few ulps away, with
  the stop on the wider side as a float. A float comparison refuses them;
  the tick comparison accepts them; a real tick away still refuses.

Production effect: none. `recordedPlans` is still 0, and no producer calls
the proposal or the bind.

## T3: the partial manager runs each loop and reports its real state (25 September)

Before T3 nothing called the partial manager. A registered plan would have
sat ARMED past its trigger with nobody watching, and the status route said
`runtimeIntegration: INCOMPLETE` from a constant.

What runs now (`agent/services/momentum-partial-runtime.js`, called from
`agent/loop.js` once per cycle):
- After the momentum book, outside everything that gates the book: the
  symbols block, the scan switch, weekend quiet, `ctraderCreds.ready` and
  the book's own `enabled`. Plans outlive all of those. It has its own
  try/catch and its own heartbeat, `momentum_partial` (record:
  `momentum_partial_pass_json`). It sits after the later phases of the
  cycle (pending orders, autopilot, breakers), not directly after the book
  call: an uncaught throw in one of those skips the pass for that cycle,
  and the pass then reads stale, which is what the website shows.
- Each account with a plan in ARMED, SENDING, AMBIGUOUS or RECEIVED runs
  with its own registered credentials and a 15 s budget; accounts run
  concurrently. An account without credentials is recorded, and the others
  still run.
- An ARMED plan is pre-filtered on the book's marks `{ c, at, bt }`: only a
  mark whose PRICE is at most 15 minutes old and more than 0.25 R short of
  the trigger skips the broker. The price's age is taken from the bar stamp
  `bt` (the trendbar's open time, with `markAgeMs` from
  `book-open-drawdown.js`), never from `at`: the book writes `at` on every
  pass, but its close comes from the scan's cached daily bars, which can be
  up to 24 hours old. A bar's close is observed at or after its open, so
  the bar stamp can only over-state the price's age. A stale, missing,
  unstamped (no usable `bt`) or near mark, or a ledger row that is no
  longer open, falls through to the authoritative read. With the default
  daily book the pre-filter therefore skips only in the first minutes after
  a daily bar opens; every other pass reads the broker, bounded by the 60 s
  limit and the 15 s account budget. `lastScanPrice` is not used: it has no
  timestamp.
- At most one authoritative check per plan per 60 s.
- A proven partial receipt gets exactly one `scale_out` position event
  (deal id, volume, price), marked on the plan row in the same transaction.
  It is written as soon as the plan holds a receipt that reads as a proven
  deal (account, position, deal id, the plan's close volume, a price and an
  execution time; T2's `validReceipt` admitted it), whatever state the plan
  is then in: RECEIVED, CONFIRMED, or CLOSED_EXTERNALLY / VOLUME_CHANGED
  after the partial. The deal happened in each of those, so the journal
  records it; the plan's state says what followed it. Plans already
  journaled are filtered out in SQL.
- An `AWAITING_BIND` intent (T4's deferred bind) becomes `BIND_ABANDONED`
  once its book row is `exit_sent`/`closed`, its trade is terminal, or a
  close is journaled. No plan is registered; the record stays visible with
  its reason, evidence and time.

What the status says (`GET /state/momentum-targets`):
- `passHeartbeatAt` and `pass` (fresh within three loop intervals, else
  "unavailable" with the reason), per account when scoped. `pass.available`
  is false, with the reason, also when the pass is fresh but its last run
  could not act on the account (no credentials, unreadable credentials, the
  account's pass failed) or could not read its plans; each row carries
  `passUnavailable` for its own account.
- `wiring`: market and limit producers, both "not wired" until T4.
  `MOMENTUM_TARGET_PRODUCERS` is pinned by a test to the production callers
  of `recordMomentumEntry`, of which there are none.
- `runtimeIntegration` is COMPLETE only when both producers are wired and
  the pass is fresh, so it cannot be COMPLETE before T4. `integrationGaps`
  names each missing part. `executionAuthorized` stays false.
- Each row carries the partial target (trigger, runner TP, close volume) and
  the attempt (state, reason, attempt time, order id, receipt deal id).

The website shows the partial trigger, not only the runner TP: the cockpit's
armed actions carry it as a `scale_out` from `momentum_partial_manager`, and
the Performance page has a "Momentum partial targets (TP1)" card. When the
pass is stale, or its last run could not act on the position's account,
both show the trigger labelled unavailable with the reason, never armed.

Production effect: none while `recordedPlans` is 0. The pass reads no
credentials and makes no broker call; it writes its record and beats.

## T4 (P0-3): the market producer, built OFF (26 September)

Owner, 26-09 18:05 SGT: OD-3 accepted (swap = broker rate × median nights;
deferred binding: yes). OD-1 (resume momentum entries) and OD-15 (resting
orders count toward the caps) are NOT answered. So T4 is built so that it
changes no live behaviour until they are.

**The switch.** `agent/config/momentum-entries.json` ships `"market": false`.
Only the literal `true` turns it on; a missing or malformed file is off
(`momentum-entry-switch.js`). While it is off, `autoTrade` asks nothing new
of the broker and takes exactly the pre-T4 path for every producer: a
momentum proposal carries no target and the shared execution boundary
refuses it (`guard_no_target`). A test drives that through the real
`autoTrade` (`momentum-entry-t4.test.js`, "SWITCH OFF").

**With the switch on** (only after the owner's OD-1), for the book's
`cross_sectional_book` and the daily `daily_momentum_account` entries:

- A closed market is refused by name, `momentum_closed_market_entry: …`,
  once per closed spell, and nothing is rested for the next open (OD-1(b)).
- An entry that would rest as an HTF limit is refused by name,
  `momentum_resting_limit_held: …`: resting momentum limits carry no plan
  (P0-4 is not built) and wait for OD-15. `wiring.limit` stays "not wired".
- Before the risk gate, the account's own broker evidence is read (its symbol
  list and assets for the quote currency and the USD conversion symbol, a
  fresh symbol read for lot size, grid and swap, the conversion quote, and
  the traded quote last). The entry is the live quote, the stop is the
  approved distance exactly as `relativePoints` sends it, and the gate is
  shown TP1 at the partial trigger (the stricter R:R) and TP2 at the runner
  target. Q is `effectiveRrFloor(db, account, 'tsmom_long')`. A gate that
  would stretch the target is refused by name, not obeyed.
- After sizing, fresh evidence again (quote last) and the plan with the
  integer broker volume. **Step one:** the `submitting` trade row (entry,
  stop, broker target and integer-consistent volume from the plan) and
  `recordMomentumEntry` share one transaction; if the intent cannot be
  recorded there is no row and no order.
- **Step two, deferred:** after the send the intent is marked
  `AWAITING_BIND` with the broker's position and bound from a live position
  read that proves the bracket. The ledger then carries the bound plan (the
  stop and targets moved to the fill in whole ticks). A bind not proven at
  once stays `AWAITING_BIND`: the book takes the position (its broker stop
  and runner target are already on it; `enrollMomentumBook` answers
  `awaiting_bind`) and the partial pass binds and enrols it later, in one
  transaction. An exited position still becomes `BIND_ABANDONED` (T3).
- Swap (OD-3): the broker's nightly rate for the side from the fresh symbol
  read, per `swapCalculationType` (PIPS, POINTS, PERCENTAGE / 360; an absent
  type is read as the proto default PIPS and recorded as assumed), times the
  book's median holding nights over its closed rows, plus two nights for each
  triple-swap day the holding can span (ceil(nights / 7)). A positive swap is
  a credit and never lowers C. The basis rides the intent as `carry`.

`/state/momentum-targets` now reads `wiring.market` "wired" with
`enabled: false, switch: "off"`, `wiring.limit` "not wired", and keeps
`runtimeIntegration: INCOMPLETE` with the switch named as a gap: a wired
producer that is switched off feeds the partial manager nothing.

The producers' synths still carry `tp1: null` (`buildEntrySynth` is
unchanged): the plan is attached inside `autoTrade`, behind the switch, so
the four `tp1: null` assertions in the book and account tests stay true and
were not rewritten.

Tested end to end through `autoTrade`'s test-only transport seam (honoured
only under `node --test`, pinned) and the fake broker: entry → bind →
`bookEntryWrite` → ARMED → trigger → one close → CONFIRMED, with the
database closed and reopened between stages. Not covered: P0-4 (resting
limits) and F8 (how cTrader anchors a multi-deal average fill's bracket; such
a fill is refused at the bind by name and stays `AWAITING_BIND`).
