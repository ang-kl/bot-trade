# P5d account observations and cashflow history

Implementation checkpoint, 22 September 2026. Depends on the native-currency
evidence contract in PR #1019. Implementation and local verification are not
deployment, runtime acceptance, or permission to change an account.

Existing trader reads, successful broker position snapshots and the existing
nightly equity pass now retain account/host/source observations. Each source
keeps its latest observation in each minute; this is **not** a promise of a
one-minute sampling cadence. Balance and floating P&L retain separate receipt
times. A balance response has no broker source timestamp. Missing currency,
missing P&L, estimated P&L and incomplete position data do not become verified
equity. A flat broker response may establish a real zero.

The nightly pass resolves the deposit asset through the account's broker asset
metadata and requests one bounded week of deposit/withdrawal history. These
reads share the existing pool and the pass's existing deadline. Expired work
cannot publish a late successful observation. An unavailable cashflow response
does not imply zero deposits. Older data is not automatically backfilled;
coverage before the first successful fetch remains unknown.

Cashflow ingestion is atomic and keyed by account, host and broker event ID.
Identical repeats are idempotent; conflicting duplicates or malformed amounts
invalidate the window. Currency and moneyDigits must be known. Deposits,
withdrawals and transfers are external flows. Fees, dividends and other known
adjustments remain in the result; unknown classifications prevent an adjusted
change from being reported. This follows the [broker cashflow request](https://help.ctrader.com/open-api/messages/#protooacashflowhistorylistreq)
and [deposit/withdrawal message](https://help.ctrader.com/open-api/model-messages/#protooadepositwithdraw).

`GET /state/account-history` requires an explicit registered account and a
bounded window. It supports pagination and never combines account currencies.
External-flow-adjusted equity change is available only with comparable
observations and complete cashflow coverage across the whole window (see the
B3 correction below; it no longer depends on the page). It is not
closed-trade P&L or a time-weighted return. Sampled drawdown is explicitly
unadjusted and includes cashflows; gaps remain gaps, and snapshots cannot
establish exact intraminute drawdown.

Performance exposes a collapsed account history panel with 24-hour, 7-day and
30-day windows, native currency, protection observations and evidence gaps.
The nightly equity route and daily report now disclose unknown currency and
avoid representing unreconciled changes as verified USD profit.

New observation and coverage-window tables retain 90 days, pruned at most once
a day. Financial cashflow events and existing fills, protection events and
ledgers are retained. Actual mounted-volume capacity, backup and retention
operation still require runtime verification; this change claims no measured
storage quota. Historical rows without currency remain unverified.

Validation covers account/currency isolation, real zeroes, deposits, fees,
unknown operations, gaps, duplicate conflicts, pagination, late-response
fencing, native-currency nightly integration and UI labels. Repository gate
results and publication state are recorded in the PR and progress record.
Authenticated browser interaction and actual broker cashflow responses remain
runtime acceptance checks.

## V3 B3 (P5d-1) correction, 25 September 2026: full-window aggregation

The summary used to be computed over the returned page (2,000 rows by default,
5,000 at most) and was withheld whenever `hasMore` was true. At 09:19 UTC on
25 September 46130058's 24-hour window returned 2,000 points with `hasMore`,
so it reported `cashflow_coverage_gap` and no reconciled span: that was this
defect, not a transient hole. At one observation per source per minute a
7-day window holds at least 10,080 points and could never complete.

The route now keeps the page only for the raw observation table. Equity change,
cashflow coverage, the external-flow-adjusted change, the dated reconciled
portion and sampled drawdown are computed over every retained observation in
`[from, to)`, whatever `limit` or `before` is, and `summaryScope` is
`full_window` with `summaryObservations` counting them. The window is also
aggregated into at most 400 UTC-aligned buckets (`bucketMs`: 5 minutes for
24 hours, 30 minutes for 7 days, 2 hours for 30 days), each with its
observation count, the first, last, lowest and highest comparable equity, and
its cashflows. Bucket cashflows cover the bucket clipped to the comparable
equity span, so they partition exactly the span the whole-window coverage
reads. A bucket with no observation is a gap; a bucket without cashflow
coverage has null sums; a bucket holding two currencies or hosts has no
equity range. A real coverage hole is still `cashflow_coverage_gap`.

The summary reads the new covering index `idx_account_history_summary`
(currency, equity and error extracted from the observation JSON, guarded by
`json_valid`), not the observation rows. Local synthetic timings, 2 KB
observations at two per minute: a 30-day window (86,400 rows) about 220 ms,
7 days about 50 ms; building the index over 86,400 retained rows on the first
boot about 0.85 s, once. These are not production budgets. The Performance
panel requests 240 raw observations per page instead of 2,000.

A full 7- or 30-day span still needs calendar time. The first retained
observation is about 22 September 17:26 UTC and older coverage is not
backfilled, so until about 29 September 17:30 UTC a 7-day request's
`observationSpan` starts at that first observation, not seven days back; read
the span, not the window label. A span that includes a cashflow coverage hole
stays unadjusted.
