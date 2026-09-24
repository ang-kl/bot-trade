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
