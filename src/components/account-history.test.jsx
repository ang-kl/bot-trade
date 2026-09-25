import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountHistory, { AccountHistoryReading } from './AccountHistory.jsx'
import { historyPath, fetchAccountHistory, HISTORY_PAGE_LIMIT } from '../lib/account-history-request.js'
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

// V3 B3: the server summarises the whole window; the page only feeds the table.
const bucket = (from, extra = {}) => ({ from, to: from + 300_000, observations: 5, equityObservations: 5, currency: 'USD', mixedUnits: false,
  first: { at: from, equity: 100 }, last: { at: from + 240_000, equity: 104 }, min: 99, max: 105,
  cashflows: { from, to: from + 300_000, covered: true, events: 0, unclassified: 0, external: 0, adjustments: 0 }, ...extra })
const whole = { points: [{ rowId: 7, receivedAt: 0, source: 'broker_trader', currency: 'USD', equity: 100 }], retentionDays: 90,
  summaryScope: 'full_window', summaryComplete: true, summaryObservations: 2500, hasMore: true, latestObservationAt: 900_000,
  recording: { active: true, dropped: 0, failed: 0 }, currency: 'USD', equityChange: 40, externalFlowAdjustedChange: 10,
  cashflows: { complete: true }, observationSpan: { from: 0, to: 900_000 }, bucketMs: 300_000, bucketBasis: 'UTC-aligned buckets',
  buckets: [bucket(0, { cashflows: { from: 0, to: 300_000, covered: true, events: 1, unclassified: 0, external: 30, adjustments: 0 } }),
    bucket(300_000, { observations: 0, equityObservations: 0, first: null, last: null, min: null, max: null }),
    bucket(600_000, { cashflows: { from: 600_000, to: 900_000, covered: false, events: null, unclassified: null, external: null, adjustments: null } })] }

test('a whole-window summary is labelled as such on every page, never as a partial window', () => {
  const html = renderToStaticMarkup(<AccountHistoryReading report={whole} page={1} />)
  expect(html).toContain('1 retained observations in this page of 2500 in the window')
  expect(html).toContain('Change covers comparable observations across the whole window')
  expect(html).toContain('Latest observation in this window')
  expect(html).not.toContain('partial history window')
  expect(html).toContain('External-flow-adjusted change: 10')
})

test('window buckets show gaps and uncovered cashflows as gaps, not zeros', () => {
  const html = renderToStaticMarkup(<AccountHistoryReading report={whole} />)
  expect(html).toContain('Whole window in 3 buckets of 5 minutes · 1 with no observation · 1 without cashflow coverage')
  expect(html).toContain('Gap: none retained')
  expect(html).toContain('Not covered')
  expect(html).toContain('<td class="pr-3">30</td>')
  // A server that does not declare a whole-window summary keeps the page wording.
  const legacy = renderToStaticMarkup(<AccountHistoryReading report={{ ...whole, summaryScope: undefined }} />)
  expect(legacy).toContain('on this page')
})

test('the panel asks for a bounded page because the summary no longer depends on it', () => {
  expect(HISTORY_PAGE_LIMIT).toBe(240)
  expect(historyPath('46130058', 1, 2, null)).toBe('/state/account-history?account=46130058&from=1&to=2&limit=240')
  expect(historyPath('46130058', 1, 2, 99)).toBe('/state/account-history?account=46130058&from=1&to=2&limit=240&before=99')
})

test('the panel fetch asks for that page and accepts only the report for its own account and window', async () => {
  const asked = []
  const get = report => async path => { asked.push(path); return report }
  const own = { accountId: '46130058', from: 1, to: 2, points: [] }
  expect(await fetchAccountHistory(get(own), { accountId: '46130058', from: 1, to: 2 })).toBe(own)
  expect(asked).toEqual(['/state/account-history?account=46130058&from=1&to=2&limit=240'])
  expect(await fetchAccountHistory(get({ ...own, accountId: '47790949' }), { accountId: '46130058', from: 1, to: 2 })).toBe(null)
  expect(await fetchAccountHistory(get({ ...own, to: 3 }), { accountId: '46130058', from: 1, to: 2 })).toBe(null)
  expect(await fetchAccountHistory(async () => { throw new Error('503') }, { accountId: '46130058', from: 1, to: 2 })).toBe(null)
})
