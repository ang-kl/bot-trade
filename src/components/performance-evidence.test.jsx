import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import Performance from '../pages/Performance.jsx'
import { DataFeed, RegimeMatrix, BalanceInOut } from './PerfMacroSections.jsx'
import SessionReview from './SessionReview.jsx'
import { scopedPerformanceRows } from '../lib/performance-evidence.js'

describe('Performance evidence availability', () => {
  it('requires a successful, well-formed response for the exact account before accepting empty rows', () => {
    expect(scopedPerformanceRows(null, '11', 'trades')).toBeNull()
    expect(scopedPerformanceRows({ accountId: '11', error: 'timeout', trades: [] }, '11', 'trades')).toBeNull()
    expect(scopedPerformanceRows({ accountId: '22', rows: [] }, '11', 'positions')).toBeNull()
    expect(scopedPerformanceRows({ accountId: '11' }, '11', 'trades')).toBeNull()
    expect(scopedPerformanceRows({ rows: [] }, 'all', 'positions')).toBeNull()
    expect(scopedPerformanceRows({ accountId: '11', trades: [] }, '11', 'trades')).toEqual([])
    expect(scopedPerformanceRows({ accountId: 'all', rows: [{ id: 1 }] }, 'all', 'positions')).toEqual([{ id: 1 }])
  })
  it('does not turn unavailable positions, targets or risk settings into zero or off', () => {
    const html = renderToStaticMarkup(<DataFeed />)
    expect(html).toContain('equity stop')
    expect(html).toContain('unverified')
    expect(html).toContain('— recorded open')
    expect(html).toContain('SL set —/—')
    expect(html).toContain('Feed freshness unavailable')
    expect(html).not.toContain('last refresh')
    const zero = renderToStaticMarkup(<DataFeed openCount={0} slSet={0} tpSet={0} equityStopArmed={false} />)
    expect(zero).toContain('0 recorded open')
    expect(zero).toContain('SL set 0/0')
    expect(zero).toContain('>off<')
  })
  it('preserves unavailable and observed-empty distinctions in quadrant and journal views', () => {
    const props = { positions: [], accounts: [], account: 'all', onAccount: () => {} }
    expect(renderToStaticMarkup(<RegimeMatrix {...props} />)).toContain('Position evidence unavailable')
    expect(renderToStaticMarkup(<RegimeMatrix {...props} positionsAvailable />)).toContain('No recorded open positions in this quadrant')
    expect(renderToStaticMarkup(<SessionReview nowMs={0} />)).toContain('Debrief unavailable')
    const empty = renderToStaticMarkup(<SessionReview nowMs={0} available />)
    expect(empty).toContain('No priced closes in the retained journal sample')
    expect(empty).not.toContain('Nothing closed')
    const cashflows = renderToStaticMarkup(<BalanceInOut />)
    expect(cashflows).toContain('Cashflow detail unavailable here')
    expect(cashflows).not.toContain('No transfers recorded')
    expect(cashflows).not.toContain('not ingest')
  })
  it('the complete disconnected page cannot contradict its unavailable warning with confident empty states', () => {
    const html = renderToStaticMarkup(<MemoryRouter><Performance /></MemoryRouter>)
    expect(html).toContain('Position evidence unavailable')
    expect(html).toContain('Journal evidence unavailable')
    expect(html).toContain('Debrief unavailable')
    for (const falseClaim of ['no open positions at all', 'no open trades in this quadrant', 'no closed trades in this window', 'Nothing closed', 'No transfers recorded', 'SL set 0/0', 'last refresh']) {
      expect(html).not.toContain(falseClaim)
    }
  })
  it('does not hide an available journal observation or expose stale rows as available', () => {
    const props = { nowMs: Date.parse('2026-09-23T01:00:00Z'), allTrades: [
      { id: 1, symbol: 'TESTPAIR', status: 'closed', closed_at: '2026-09-23T00:30:00Z', net_pnl: 5 },
    ] }
    expect(renderToStaticMarkup(<SessionReview {...props} available />)).toContain('TESTPAIR')
    const unavailable = renderToStaticMarkup(<SessionReview {...props} available={false} />)
    expect(unavailable).toContain('Debrief unavailable')
    expect(unavailable).not.toContain('TESTPAIR')
  })
})
