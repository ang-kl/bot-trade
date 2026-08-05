> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 11 — Pending-order lifecycle

## Executed

Only one registry strategy is `pendingCapable`: **`fib_618_fade`** — and it is the one
strategy that ships **`defaultOn: false`**. Every other armed strategy is
market-order-only.

That single fact bounds this entire section at the current configuration: with
`fib_618_fade` disarmed, the pending-order path is **not reachable from the autopilot**
at all. It remains reachable through manual routes.

`agent/services/fib-strategy-pending.test.js` exists and passes.

## BLOCKED — DATA UNAVAILABLE

Every §14 branch test needs runtime rows: fill while offline, cancellation racing with
fill, expiry racing with fill, duplicate stale rows, missing order side in the
reconcile payload, account-scoped order book, manual order on the same symbol,
closed-market adoption, missing approval lineage, malformed label, broker order gone
with no matching position, restart between placement and persistence, order accepted
but locally timed out, order locally recorded but broker-rejected.

The §14 requirement that *"every pending order, fill and adopted position must retain
account, strategy, opportunity and risk-approval provenance"* is **not verified**.
Queries in `evidence/data-queries.sql`.
