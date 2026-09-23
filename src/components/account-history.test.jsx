import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountHistory, { AccountHistoryReading } from './AccountHistory.jsx'
import BlockerReport from './BlockerReport.jsx'

test('history and blockers name their own requested account even before evidence loads', () => {
  expect(renderToStaticMarkup(<AccountHistory accountId="46979908" />)).toContain('History scope: Account 46979908')
  expect(renderToStaticMarkup(<BlockerReport accountId="46979908" />)).toContain('Report scope: Account 46979908')
  expect(renderToStaticMarkup(<AccountHistory accountId="all" />)).toContain('History scope: All accounts')
  expect(renderToStaticMarkup(<BlockerReport accountId="all" />)).toContain('Report scope: All registered accounts')
})
test('history shows zero observations separately from unavailable data and names cashflow limitations', () => {
  expect(renderToStaticMarkup(<AccountHistoryReading report={null} />)).toContain('unavailable')
  const html = renderToStaticMarkup(<AccountHistoryReading report={{ points: [], retentionDays: 90,
    equityChange: null, externalFlowAdjustedChange: null, currency: null, cashflows: { complete: false, reason: 'cashflow_coverage_gap' },
    sampledDrawdown: null, drawdownBasis: 'not exact intraminute drawdown', note: 'not a time-weighted return', sampling: 'no interpolation' }} />)
  expect(html).toContain('0 retained observations')
  expect(html).toContain('cashflow_coverage_gap')
  expect(html).toContain('Equity change: Unavailable')
  expect(html).toContain('not exact intraminute drawdown')
})

test('history pagination exposes older observations without presenting a page as the complete window', () => {
  const report = { points: Array.from({ length: 30 }, (_, i) => ({ rowId: i + 1, receivedAt: i * 60_000,
    source: `receipt-${i + 1}`, currency: 'SGD', equity: 100 + i })), retentionDays: 90,
    cashflows: { complete: false, reason: 'cashflow_coverage_gap' }, summaryComplete: false,
    observationSpan: { from: 0, to: 29 * 60_000 } }
  const latest = renderToStaticMarkup(<AccountHistoryReading report={report} />)
  const older = renderToStaticMarkup(<AccountHistoryReading report={report} page={1} />)
  expect(latest).toContain('receipt-30'); expect(latest).not.toContain('receipt-1 /')
  expect(older).toContain('receipt-1'); expect(older).not.toContain('receipt-30')
  expect(older).toContain('partial history window')
  expect(older).toContain('Change covers comparable observations on this page')
})

test('a reconciled portion has its own dates and cannot imply that the newer full window is verified', () => {
  const html = renderToStaticMarkup(<AccountHistoryReading report={{ points: [], retentionDays: 90,
    equityChange: 50, currency: 'EUR', externalFlowAdjustedChange: null, cashflows: { complete: false, reason: 'cashflow_coverage_gap' },
    cashflowCollection: { status: 'failed', reason: 'cashflow_read_timeout', lastSuccessAt: 60000 },
    reconciledSpan: { from: 0, to: 60000, externalFlowAdjustedChange: 20, currency: 'EUR', pendingObservations: 3 } }} />)
  expect(html).toContain('External-flow-adjusted change: Unavailable')
  expect(html).toContain('Reconciled portion only: 1970-01-01T00:00:00.000Z to 1970-01-01T00:01:00.000Z')
  expect(html).toContain('20 EUR')
  expect(html).toContain('3 later equity observations await cashflow coverage')
  expect(html).toContain('full-window change remains unavailable')
  expect(html).toContain('cashflow_read_timeout')
})

test('recorder registration does not imply fresh equity and recording failures stay visible', () => {
  const html=renderToStaticMarkup(<AccountHistoryReading report={{ points:[],retentionDays:90,
    cashflows:{complete:false},recording:{active:true,dropped:2,failed:1},latestObservationAt:120000,latestEquityAt:null }} />)
  expect(html).toContain('Background broker recording: active')
  expect(html).toContain('Latest comparable equity: Not observed')
  expect(html).toContain('2 observations dropped; 1 recording failures')
})
