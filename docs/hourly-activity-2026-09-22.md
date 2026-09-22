# P5b complete hourly activity population

The rolling 24-hour headline and hourly close counts previously used the latest
100 journal rows and excluded closed trades whose P&L had not arrived. They now
read one bounded SQL aggregation over the entire ledger. Existing hourly opening
evidence is reused, including scope, provenance and clock checks. Closing dates
use the same UTC millisecond half-open buckets. Undated closes remain explicit
uncertainty, unpriced closes still count, and a successful empty query is zero.

Legacy `net_pnl` rows do not record currency. Recorded amounts remain visible by
account, with priced/total counts. Different accounts' unknown units are never
summed. Partial P&L is not presented as a complete net. A single account's known
recorded amount remains visible, with its currency limitation. Win percentages
state that their denominator is priced closes. None of this establishes broker
completeness or statistical sufficiency.

Hourly balance columns await currency/cashflow reconciliation rather than
subtracting a capped P&L sample from a current balance. The itemised journal
remains a labelled sample. No trading or validation threshold changes.

Full local gate: 5,246 Node passes, one existing skip; 911 Vitest passes;
ESLint zero warnings, production build, no-green and syntax checks. Regression
fixtures exceed 1,200 closes and cover unpriced rows, account/legacy isolation,
unknown currency, unknown dates, exact boundaries and stale/mismatched frontend
evidence. Full runtime/browser acceptance remains outstanding. Implemented and
tested; merge, deployment and acceptance are separate states.
