# P5b complete recorded performance populations

The Performance page's market bands, strategy/market matrix, crypto panels,
account-day figures, gradients, session statistics, rankings and realised-P&L
curve now read complete recorded close aggregates. The capped /state/trades
response remains the explicitly labelled recent journal/debrief sample. It
cannot supply a period total or prove the absence of older trades.

`GET /state/performance-populations` iterates every recorded closed trade.
Canonical close timestamps and the existing shared DST-aware 17:00 New York
anchors define half-open ledger windows. Approximate fixed UTC session buckets
remain reporting buckets; they do not claim an exchange is open or closed.
Every close counts, including unpriced closes. Invalid/unknown dates, future
dates and missing account identities are counted in portfolio coverage. Named
accounts include only their stamped rows. Unstamped rows never migrate to the
currently selected account. Rankings retain six best/worst records per account
from the whole 30-day population. Unpriced rows cannot be ranked.

Historical trade currency/conversion provenance is not established by a current
registry label. Monetary arithmetic therefore stays within one stamped account
in **recorded account units**. Cross-account sums, money-weighted ratios and
rankings are unavailable when units cannot be verified. Counts and win rates
remain visible; their denominators distinguish priced closes from all closes.
Unpriced-only means unavailable P&L, not zero. Partial priced totals are labelled
by coverage. Exact numerical zero remains visible.

Gradient footings use unrounded numbers, not formatted strings. Their windows
overlap and the UI still labels the footing as double-counting. The former
"equity" curve is now correctly a daily realised-P&L series starting at zero
within the chosen UTC days, over complete recorded closes. It is neither broker
balance nor floating equity nor cashflow-adjusted return. Unpriced closes or
incomparable accounts make that money curve unavailable. Its daily drawdown can
miss intraday movements. Daily decisions use the server aggregate (up to 90
days), never a fallback to the capped event journal.

The perf-ledger route stops reconstructing historical balances from today's
stored balance minus closes: cashflows make that arithmetic insufficient.
Stored per-account sizing inputs remain explicitly unverified display inputs,
never another account's or a portfolio balance. Displayed loss-cap usage is
unavailable until the P&L units are verified against that input; risk evaluation
and every configured numerical limit are unchanged. Native account/history
integration is supplied by #1019/#1023 and is a separate integration gate.
The reporting-only analytics option excludes unstamped, invalid and future
rows; the existing admission/research consumers retain their own semantics.

Disk-backed reports run in read-only SQLite workers, with no migrations or
protection-loop queries. Concurrent identical reads coalesce; at most two
workers per database run, each with a 15-second deadline and a 128 MiB V8 heap
limit. Population reports bound 24,000 aggregate groups, 100,000 median inputs
and an 8 MiB serialized result. A bound or read failure returns unavailable,
never a truncated prefix disguised as a complete total. These bounds are not
a 500-symbol runtime capacity claim.

## Verification and status

Full Node22 suite: **5,252 passed, one existing skip**. Vitest: **918 passed**.
ESLint zero warnings, production build, no-green, syntax and regenerated control
inventory passed. Final display-only corrections repeated the UI gates. Tests
include 253 closes (beyond the journal cap), unpriced/undated/future records,
strict account identity, complete session medians/rankings, exact gradient
footings, cross-account currency refusal, a coalesced read-only disk worker and
unchanged legacy analytics policy.

Implemented and locally tested; this package is based on #1022. No deployment,
authenticated visual acceptance or production population reconciliation is
claimed. Local browser acceptance remains unavailable in this executor.
