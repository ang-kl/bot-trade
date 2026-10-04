import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PerformanceTargets from './PerformanceTargets.jsx'

const row = { accountId: '11', currency: 'SGD', scope: { account: '11', coverage: { pct: 100 } }, conversionFee: 1,
  latest20: { n: 20, eligible: 19, pending: 1, winRatePct: null, profitFactor: null },
  winRate: { status: 'not_assessed', latest20Status: 'unmeasurable', consecutiveDays: 0 },
  profitFactor: { status: 'not_assessed', latest20Status: 'unmeasurable', consecutiveDays: 0 },
  currentDay: { day: '2026-10-04', n: 0 }, days: [], unavailable: 'An undated close requires reconciliation.' }

describe('forward target card', () => {
  it('shows new thresholds and incomplete whole-position evidence without a success or expired deadline', () => {
    const html = renderToStaticMarkup(<PerformanceTargets report={{ accounts: [row] }} accounts={[{ accountId: '11', login: '125' }]} selected="11" />)
    expect(html).toContain('Win rate ≥ 75%')
    expect(html).toContain('Profit factor ≥ 1.68')
    expect(html).toContain('#125 · 11 · SGD')
    expect(html).toContain('20/20 recorded whole-position candidates · 19 complete · 1 pending')
    expect(html).toContain('Evidence incomplete')
    expect(html).toContain('An undated close requires reconciliation.')
    expect(html).not.toContain('>Met<')
    expect(html).not.toContain('2026-08-15')
    expect(html).not.toContain('All accounts')
  })
  it('the expanded body retains all evidence, exposes its read time and has no recursive expand control', () => {
    const html = renderToStaticMarkup(<PerformanceTargets report={{ at: '2026-10-04T01:36:40.000Z', accounts: [row] }} expanded />)
    expect(html).toContain('id="sec-goal-expanded"')
    expect(html).toContain('Assessment read: 2026-10-04T01:36:40.000Z')
    expect(html).toContain('Evidence incomplete')
    expect(html).toContain('11 · SGD')
    expect(html).not.toContain('aria-label="Expand Performance targets"')
  })
  it('renders a reader failure and preserves separate account identities in the compact card', () => {
    const html = renderToStaticMarkup(<PerformanceTargets variant="compact" report={{ unavailable: 'source failed', accounts: [row, { ...row, accountId: '22', currency: 'USD' }] }} />)
    expect(html).toContain('id="sec-goal-mobile"')
    expect(html).toContain('Evidence unavailable: source failed')
    expect(html).toContain('11 · SGD')
    expect(html).toContain('22 · USD')
  })
})
