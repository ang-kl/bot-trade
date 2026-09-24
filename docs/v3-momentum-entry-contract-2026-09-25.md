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
