# V3 final partial-fill completion

Version 1.0 - 28 September 2026

## Intent and interpretation

The owner's 28 September continuation requests final partial-fill completion,
production/scanner verification and performance/session evidence. PRs #1169 and
#1170 and their resulting deployments are explicitly approved. This follow-up
implements and verifies the remaining lifecycle defect locally; it does not
expand that release approval to another production deployment.

A partially filled limit whose remainder is cancelled or expired remains
reserved today because FILLED does not distinguish a full fill from a partial
execution. Its original-volume target plan also cannot bind to the smaller
position. The done-check is an evidence-backed handover of the final executed
volume to a valid TP1 plan, with the counted position replacing the reservation.

## Invariants and scope

- Preserve the immutable original proposal, risk approval, stop distance,
  target arithmetic, cost reserve, numerical caps and account allow-list.
- Require the exact account/order/position/instrument/side and integer broker
  units. Filled opening deals must total the order's final executed volume and
  the fresh position volume. A smaller position alone is not a final fill.
- Read the terminal order first, then a new account-owned reconcile snapshot
  proving the remainder absent. Missing, stale, conflicting or incomplete
  evidence retains the reservation and AWAITING_BIND.
- Register TP1 and hand over ownership atomically. Binding alone cannot release
  capacity. A minimum-size partial that changes the required broker target
  remains refused; no order or bracket mutation is introduced.
- Preserve manual ownership and all unrelated orders. No credentials, account
  selection, scanner registration, trading settings or production data change.

Scope: `agent/services/momentum-limit-fill-evidence.js`,
`agent/services/momentum-entry-contract.js`,
`agent/services/momentum-entry-producer.js`,
`agent/services/resting-exposure.js`,
`agent/services/closed-market-limits.js`, corresponding lifecycle tests and
append-only project evidence logs.

Checks: regression of cancelled/expired final partials; account/order/deal and
unit mismatches; duplicate/missing deals; remainder reappearance; temporal
ordering; manual volume changes; ownership and enrollment failure; restart
idempotence; deferred runtime integration; existing backend, lint and build
gates. Natural broker fills and full production trace acceptance remain separate
evidence requirements.

Protocol basis: cTrader's official [model messages](https://help.ctrader.com/open-api/model-messages/)
define executedVolume and filledVolume in hundredths of a unit, and CANCELLED
and EXPIRED can follow partial fills. [Order details](https://help.ctrader.com/open-api/messages/#protooaorderdetailsres)
returns an order with its related deals. Checked 28 September 2026.
