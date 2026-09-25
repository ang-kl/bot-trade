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
