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
observations, complete cashflow coverage and a complete result page. It is not
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
