# Rollback plan

Every change in the Verified Defect Repair programme is revertible
independently. There is no migration to unwind and no data rewrite: the
programme added columns and records, and changed exactly one trading behaviour
(a veto, on the owner's decision).

| PR | Change | Rollback | Effect of rolling back |
|---|---|---|---|
| #670 | Housekeeping steps isolated — one failure no longer cancels the rest | revert the commit | A throwing step again cancels every later step; the disposition sweep stops running |
| #671 | Read routes stop reporting states they never checked | revert | Routes resume implying checks they did not perform |
| #672 | Cup & Handle detector and diagnostic twin on identical bars | revert | Production and diagnostics become incomparable again |
| #673 | Trade-origin and strategy provenance recorded at entry | revert | New trades stop carrying origin; Phase 7's clean-origin sample stops growing |
| #674 | `sizingBalance()` provenance + `balance_source` on every verdict | revert | Sizing arithmetic is unaffected — this PR added evidence only |
| #674 (step 0a) | **VETO** on a named account with no own balance stamp | revert the `risk.js` step-0a guard alone | Entries resume on unstamped accounts, sized against a borrowed balance. **This is the only rollback that re-opens a capital hazard** |
| #678 | One definition of a lot, taken from the broker | revert | Contract sizes return to assumed values that do not fail closed |
| #680 | Exit-replay harness | revert | Removes a read-only measurement tool; no behaviour change either way |

## Ordering

Roll back in reverse merge order where more than one is involved. #674's
evidence layer and its step-0a veto are separable — the veto can be lifted
without discarding the provenance recording, and that is the preferred partial
rollback if the veto proves too broad in production.

## The one thing to watch after a step-0a rollback

The veto fires only when a **named or selected** account falls back to the
shared `account_balance_usd` key, and only when more than one account is
enabled. If it is lifted, the symptom to watch for is the original one: the
same position size on two accounts with very different balances. The figure
that exposes it is `riskBudgetMultiple` — 7.50× on 43097342 against 0.32× on
46130058 for the same 0003.HK position.

## Not part of any rollback

- No risk limit was raised, so none needs restoring.
- No broker state was changed, so there is nothing to unwind at the broker.
- Live account `42993489` was never touched.
