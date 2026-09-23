# Position-specific recovery for old closed trades

After #1037, two not-written-off closed rows remained overdue on account
42993489. Their positions predate the verified 14-day account-history window.
The strict recovery correctly refused to use a recent partial close as the
whole lifetime P&L. Widening every account query would consume more of the
same bounded read budget without proving the opening history was retained.

Spotware's documented `ProtoOADealListByPositionIdReq` (2179) and response
(2180) provide a position-specific query with optional timestamps and a
required `hasMore` response field. The helper asks from epoch zero through
the fixed read cutoff, using the existing historical-request token bucket.
Sources: [messages](https://github.com/spotware/openapi-proto-messages/blob/main/OpenApiMessages.proto)
and [model](https://github.com/spotware/openapi-proto-messages/blob/main/OpenApiModelMessages.proto).

The cross-side recovery may now read one old attributed position per account
pass, within its existing ten-second budget and five-second request deadline.
An unsettled transport retains its overlap lock. A durable thirty-second
account interval and fifteen-minute per-position failure interval prevent
restart/retry loops while permitting another position to advance. Existing
written-off rows and unattributed rows remain excluded from this addition.

Money is accepted only for one unambiguous closed ledger row, matching
account/position/symbol, unique deals, explicit `hasMore: false`, valid money
and filled volumes, an observed opening, and exactly balanced opening and
closing volumes in execution order. A retained suffix without its opening
cannot pass. More than 500 deals, partial pages, unsupported nonzero P&L
conversion fees and ambiguous evidence remain explicit failures. They do
not increment trade exhaustion counts or manufacture money.

The existing aggregation and consistency audit are reused with a narrowed
account-and-position scope. Both old and recent partial closes contribute;
exit prices use filled volume for this path. Existing non-null P&L is
preserved. Only a complete empty response can count an unsuccessful search,
and only against the actual searched position. Closing receipts and the
observed opening dates remain in `broker_deals`; the durable recovery state
and loop log record the outcome.

Seventy-three focused tests passed, including the actual WS message helper,
100-day lifecycle recovery, partial-close money/price weighting, mismatch,
partial/duplicate/malformed evidence, account isolation, ambiguous local rows,
durable failure fairness, late replies and a permanently queued transport.
The complete repository gate, CI/review and broker readback remain required.
The first full gate subsequently passed all seven checks, with 5,346 agent
tests without skips and 932 frontend tests; PR #1040 CI passed. Review found
two additional cases, now corrected: JSON-omitted zero swap/commission follow
the existing broker validator's zero-default convention, and missing/invalid
local opening dates may be resolved from independently complete broker
lifecycles. Future local dates are likewise outside the recent verified window.
The durable rotation prevents expired retry cooldowns from starving later
positions. The corrected full gate and PR review remain required.
No broker write, account selection, numerical risk setting, target policy or
scanner activation changes. Rollback owner: Adrian Ang.

The next review identified that the same-side loop still used the older
account-window-only repair. Both callers now use one account-scoped service:
selected account, other enabled same-side accounts and opposite-side accounts
share strict history proof, pacing, the ten-second account budget, five-second
read deadline and real unresolved-transport lock. Selected/peer demo recovery
and a still-pending transport across a selection change pass focused tests.
No account selection is changed by recovery. Final combined gates are required.
