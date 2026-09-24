# Momentum partial TP policy — implementation contract

Owner directive: build evidence-based formulas for partial TP1, close percentage,
runner target/exit and minimum-lot handling. Existing-position TP resolution is
separate and does not enroll historical positions in a new partial manager.

Interpretation: derive a reproducible policy from risk geometry, the existing
reward/risk floor, conservative explicit cost inputs and actual broker volume
constraints. Mathematical properties are distinct from profitable strategy
evidence. The 24 September all-account 30-day report contains only 11 eligible
momentum closes (21 adopted/non-clean rows excluded); no tested exit rule reaches
the existing 30-trade minimum. Do not label this candidate optimized/validated.

Candidate formula (both directions and all account environments):

- R is the entry-to-original-stop distance; never recompute it from a later
  ratcheted stop. D is +1 for BUY and -1 for SELL. Missing direction refuses.
- Q is at least the existing required reward/risk floor. C is an explicit
  conservative cost reserve per unit, including the two-exit fee/spread/slippage
  assumptions. Missing C is unknown, not zero. No risk limit is changed.
- Partial trigger = entry + D × (Q × R + C), rounded outward to broker digits.
- Choose the smallest permitted partial volume whose modeled target proceeds
  cover the modeled loss of the remainder at its ORIGINAL stop. Before rounding,
  fraction = (R + C) / (target distance + R). This is a loss-coverage identity,
  not a guaranteed breakeven: realized fees, gaps and slippage can exceed C.
- Round close volume upward to broker step, then require both close and runner
  to meet broker minimum/step constraints. Never increase entry size to make a
  split possible. If unsplittable, use a whole-position native target at the
  partial trigger and explicitly report the minimum-volume fallback.
- A splittable runner holds a native target one original R beyond the trigger,
  retains the existing daily ATR ratchet and rank exit, and never widens its SL.
  The native runner target exists from entry; TP1 is the manager's partial level.

Implementation is staged: pure planner and read-only evidence first, then a
durable account/position/lifecycle-scoped manager and entry integration. A
write-ahead partial intent must survive crash/restart, ambiguous calls cannot
be blindly resubmitted, and success needs a broker receipt/readback. Existing
keeper/guard paths must not acquire ownership of the same partial. No live
execution or automatic activation is part of verification.

Invariants and required checks:

1. Strict direction, original-risk and finite positive-price validation.
2. Reward/risk and modeled coverage preserved after price/volume rounding.
3. Integer broker volume units, valid minimum/step and non-dust remainder.
4. Same formula for demo/live; account identity governs routing and persistence.
5. One partial attempt per durable plan; crash/timeout never duplicates a close.
6. Fresh broker identity/volume/quote and both protection legs before action;
   confirmed broker result before completion.
7. No new entry authority, risk-limit relaxation or empirical qualification.

Scope: new policy/manager modules and tests, entry/book integration, bounded
read-only diagnostics and relevant documentation. The initial pure planner
alone does not satisfy production partial-manager or V3 acceptance.

## Current implementation boundary — 25 September 00:51 SGT

The candidate planner, cost model, immutable account/host/instrument partial
registration, durable one-attempt manager and actual broker adapter are built.
The adapter uses a fresh account-scoped reconcile (no cached sidecar response),
a bounded timestamped quote and the existing close gateway. It requires a
filled closing deal with this attempt's time, exact account/position/instrument,
opposite side, entry and closed volume, followed by the protected residual.
A late receipt from the original request can recover the timed-out state;
an ambiguous attempt without that receipt never becomes permission to resend.

The quote reader requests broker timestamps and closes late connections. It
refuses un-timestamped or one-sided events; local receipt does not renew the
broker price. Both account environments exercise the same adapter in fixtures.
Protocol sources: [spot/execute messages](https://help.ctrader.com/open-api/messages/)
and [deal/close detail fields](https://help.ctrader.com/open-api/model-messages/).

A pure proposal boundary pins fresh symbol precision/volume metadata, quote,
quote-currency conversion and explicit carry reserve. It hashes the complete
sanitized evidence, separates partial trigger from broker runner TP, and always
reports executionAuthorized=false. This is not a runtime arming switch.

Still required: write-ahead entry-intent linkage, confirmed-fill anchoring,
atomic book handover/enrollment, actual market/resting-entry producer wiring,
competing exit coordination, operator-visible status and natural-path runtime
acceptance. The shared websocket close response now retains its broker account
envelope; optional timestamped subscriptions add no behavior to existing callers.
No production caller invokes the new manager and no account is activated.
The foundations alone do not satisfy P0/P3 or V3 acceptance.
