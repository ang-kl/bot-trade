# V3: current readings and calendar-day Performance

Intent (directive): make the requested Performance, Desk and browser-session
surfaces report the data they actually receive, across the seven-account roster.
This is the owner's 25 September UI correction, under the continuing build
approval. The confirmed Performance day is midnight in the displayed timezone;
broker-day risk limits remain separate. Partial TP retains the approved policy
and entry-handover contract; no additional trading algorithm is introduced here.

Understanding: realised closes, current floating P&L, and equity changes over
a period are distinct measures. Refreshing a rolling window is supported.
Current observations must retain broker receipt times, account identity and
currency; neither a read nor a browser refresh makes old data fresh.

Assumptions: local calendar day confirmed by owner. Twenty-four-hour browser
expiry origin (human inactivity or login time) remains pending. Do not implement
that dependent behaviour until answered. Browsers cannot reliably close a
manually opened tab; disconnection stops its application access and updates.

Scope: agent/shared/performance-calendar.js; agent/services/account-overview.js;
agent/services/performance-populations.js; agent/routes/state.js; agent/routes/actions.js (read-only price stream); related new
tests; src/pages/Performance.jsx; src/pages/Desk.jsx; src/pages/BrowserSessions.jsx;
src/components/AccountHistory.jsx, BlockerReport.jsx, PerfAccountScope.jsx,
PerfMacroSections.jsx, SessionFooter.jsx, ReportChart.jsx; src/components/CurrentAccountReadings.jsx and AllTimeAccounts.jsx; src/lib report/refresh
helpers; route/navigation wiring; UI inventory; this evidence and CLAUDE ledger.

Invariants and checks:
- Reporting alone changes: existing risk-day helper and entry settings stay
  unchanged; diff inspection and existing backend suite.
- Local day has exact timezone boundaries, including DST; new calendar tests.
- A current amount belongs to one account, host, currency and receipt time;
  new overview tests cover foreign/stale/partial readings and zero balances.
- Seven roster rows remain even when one has no data; overview/UI checks.
- Verified current currency does not retroactively verify historical P&L;
  separate aggregation tests and source inspection.
- Sleeping tabs stop report/quote traffic and wake to fresh readings; fake-clock
  and browser checks. Session lifetime awaits the outstanding owner answer.
- No trading operation, activation or risk-policy mutation is used as a test.

Evidence (24 September 23:09 UTC):
- Local read-only HTTP/calendar/account tests cover Singapore midnight, DST,
  exact account membership, unchanged broker-day default, zero balances, stale
  receipts, foreign hosts/currencies, missing P&L and the full account roster.
- 952 frontend checks passed before the final feed-detail and stream-reconnect
  additions. Three focused stream checks cover sleep, wake, backoff and late
  old callbacks; five existing availability checks pass after retaining the
  missing-evidence message. Final full suites are still running.
- Headless browser review uses seven synthetic accounts, never production
  credentials: Performance, Desk and Sessions render without page errors.
  Advancing an idle tab proves no new overview/population/hourly/decision/quote
  requests; trusted keyboard activity refreshes the overview immediately.
  Desktop 1440px and mobile 390px reviewed; tables scroll inside their cards.
- Authenticated production reads (not a deployed-code claim): account 46130058
  at 22:53 UTC held balance 30004.36, equity 30134.08 and floating 129.72 USD.
  Its broker receipts establish available data the old UI left blank. The last
  observed close before this review was still on the previous Singapore date;
  zero realised Today need not be an error.
- The one-account-model guard retains every assertion and exact token counts.
  Its routing/display allowlist now names the new read-only host checks and
  account badges. No policy distinction was added.

Remaining boundaries: 24-hour session expiry awaits its clock-origin answer.
OHLCV detail displays retained daily bars and their bar-start times; it cannot
claim live receipt/latency for other timeframes. Current quotes show their
account, midpoint, spread and change since the first page tick. Historical
currency verification and missing retained evidence remain explicit.

V3 acceptance is not implied by this reporting change. The frozen closure
register still governs; the partial-TP producer-to-fill path remains incomplete
and no activation or new entry permission is introduced.

Source-refresh finding (23:12 UTC): current trader balances continued arriving,
but detailed P&L/position snapshots and retained equity stopped at 22:53 UTC
when no view requested them. Polling the saved snapshot alone cannot provide
current readings. Performance and Desk now share the existing read-only
`broker-positions` request at most once per minute per browser credential,
including one in-flight request. The server also coalesces concurrent readers.
The cheap overview still paints first and polls independently; sleeping tabs
start no broker refresh. Desk selects its own account from the shared response
before painting scoped controls. No new background broker scheduler is added.

Validation update (23:16 UTC): before incorporating the owner's #1081 merge,
5,535 backend checks passed (four skipped), 955 frontend checks passed, and
desktop/mobile sleep/wake checks also covered the broker-source refresh.
Exact final combined-source gates and deployed readback remain outstanding.
A production read at 23:14 UTC overlapped Railway's #1081 deployment and
returned a gateway error; health subsequently confirmed b95975f running.
That interrupted read is not counted as successful snapshot verification.

Deployed verification and correction (23:29 UTC): #1083 merged as d61d84d,
Railway deployment bea01482-72f7-4f4d-8aeb-635651380235 succeeded. Final combined
gates passed: 5,537 backend tests, four skipped; 955 frontend tests, lint,
build, colour gate and UI inventory. Current seven-account readings refreshed
from broker receipts; crypto midpoint/change and upstream blockers rendered.
Entry configuration readback matched the pre-deploy snapshot on every account.
The protection audit still reported 32 positions with both protections.

Live verification found an obsolete ledger caption and UTC date formatting,
despite the corrected calendar computation. The follow-up passes the displayed
timezone into both desktop and mobile labels. Concurrent historical requests
also hit the existing two-worker limit (decisions/analytics capacity errors).
Performance and its chart now share one bounded, coalescing read queue; current
readings stay independent, sleeping tabs start no queued reads, and a changed
connection cannot execute work queued under the previous credential. Server
worker limits, report formulas and trading behaviour remain unchanged.
Named check: report-read-queue.test.js covers coalescing, serialized starts,
failure recovery, sleep and bounded pending work. These paths are within the
existing report/refresh-helper scope. No new trading target is introduced.
