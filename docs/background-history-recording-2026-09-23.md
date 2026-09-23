# Background account history recording

Production acceptance after #1037 found continuing balance/cashflow receipts
but no new exposure/equity/protection snapshot after the monitor view closed.
`captureSnapshotHistory` was called only by the on-demand broker-positions
route. A browser session therefore controlled that part of the historical
record. The nightly equity pass remains a separate daily series.

The existing trader, reconcile and unrealised-P&L helpers now offer successful
responses to a bounded observation queue. The trading caller receives its
unchanged result before the queue drains. Up to 64 events of at most 64 KB
are retained, with eight deliveries per event-loop turn. Recording failures
and drops remain visible in account history. No new broker request, timer,
subscription, strategy/risk setting or position-writing authority is added.

The independent verifier relay contributes its already-completed protection
reads, including manage-only and empty accounts. Receipts retain the verifier's
original broker-read time; reading its status again does not renew that time.
Unknown volume/side remains unknown, with incomplete exposure labelled.

The recorder accepts only a registered account on its matching host. Equity
requires verified deposit currency, valid response money digits, matching
complete position-ID sets, and balance/P&L/reconcile receipts within 60 seconds
of each other and of the observation. Each component keeps its own receipt
time. Partial P&L cannot imply a flat account; confirmed empty sets can yield
zero. A currency/asset change cannot relabel a previous P&L observation.

The source contract was checked against Spotware's
[unrealised P&L response](https://help.ctrader.com/open-api/messages/#protooagetpositionunrealizedpnlres):
account identity and money digits are required; position P&L is a repeated
field. This recorder rejects malformed evidence without changing the legacy
helper result or its existing risk consumers.

History now shows whether recording is registered, its drop/failure counters,
the latest retained observation and the latest comparable equity date. Active
recording does not assert fresh equity. Broker rejection or absence of a P&L
read stays unavailable; no approximate quote-derived P&L is substituted.

Focused tests exercise the real broker helpers and independent relay, correct
money/identity, confirmed-empty versus partial coverage, stale/repeated/future
receipts, currency changes, bounded queue copies and failed observers. The
first complete local gate passed all seven checks, with 5,332 agent tests,
zero skips and 932 frontend tests. The package is now integrated with #1038;
the combined gate, PR checks and fresh production evidence remain required.
Rollback owner: Adrian Ang.
