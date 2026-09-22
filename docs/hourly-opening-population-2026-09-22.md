# P5b opening-population correction

Authority: revision 3 section 8. This reporting change uses the existing P2
account scope and is independent of target policy or scanner activation.

The hourly Opened count previously came from `scopedClosed`: only closed trades
with non-null P&L in the latest 100 journal rows. It therefore omitted still-open
trades, unpriced closes and older openings beyond that cap.

The new `/state/hourly-openings` read aggregates all ledger rows whose status is
open or closed, grouped into the exact 24 rolling windows displayed by the page.
It excludes rejected/cancelled orders and unresolved submissions. The response
contains 24 aggregate rows rather than an unbounded journal. Timestamps are UTC
epoch milliseconds with half-open bounds; the existing SGT/UTC labels remain.
No broker requests, trade writes, migration or new trading gate are introduced.

The explicit account is checked against the registry. `all` is deliberate. The
repository's legacy NULL-account inclusion convention is retained and its count
is shown. Adopted rows are also counted and disclosed because their existing
opening timestamp can be reconciliation time, not the broker's opening event.

A successful empty ledger query shows 0. A valid small population remains
visible. Failed, stale, foreign-account or wrong-window responses show a dash.
Unknown opening times are disclosed; positive counts become lower bounds and
empty buckets say unknown. The two-minute display freshness limit is separate
from all risk/entry thresholds. Requests superseded by an account/window change
cannot repaint the current account, and cached data cannot renew its query time.
These are recorded ledger counts, not a claim of fresh broker completeness.

Local evidence: seven Node behaviour tests include the HTTP route and a
1,205-trade population, both timestamp formats/offsets, millisecond boundaries,
account isolation, invalid timestamps, zero activity and failed database reads.
Five frontend tests cover freshness, scope/window rejection, sparse/zero/unknown
rendered labels and malformed aggregates. Full gate: 5,212 Node passes, one
existing skip; 905 Vitest passes; ESLint, production build, no-green and syntax
checks pass. The generated UI inventory is refreshed. PR CI is required next.

State: implemented and locally tested; not yet merged, deployed or runtime
verified. Browser verification remains unavailable as documented in the
continuation record. All numerical limits, mandatory TP1, manual ownership,
account isolation and validation thresholds are preserved.

This is one P5b slice. Closed-trade/P&L columns and detail lists still use the
capped journal sample; a visible note states that limitation. Reconstructed
balances are labelled and cashflows remain unreconciled. Complete close
populations, cashflow-aware accounting and first-blocker attribution remain
separate follow-ups. This patch does not silently claim those are fixed.

## Integration checkpoint

Reconciled #1009/#1010 after the owner's merges. Both new state imports are
preserved and the control inventory is regenerated. Against main `4dbdc82`,
the full gate passes: 5,225 Node tests, one existing skip; 909 Vitest tests;
ESLint, build and no-green pass. On a synthetic 100,000-row in-memory ledger,
the aggregate returned all 1,000 in-window rows in 31.2 ms on this executor.
That is a local profiling observation, not a production latency guarantee.
