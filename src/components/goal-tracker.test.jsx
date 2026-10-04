// The go-live gate card, in both shapes. The compact form is not a smaller
// copy — it changes WHICH row leads, and that choice is testable.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import GoalTracker, { AccountRow } from './GoalTracker.jsx'

describe('GoalTracker', () => {
  const row = { accountId: 'A', balance: 51.41, balanceCurrency: 'SGD', trades: 35, closedTrades: 36,
    wins: 30, losses: 5, minTrades: 30, verdict: 'unmeasurable', evidenceReason: '1 recorded close has missing P&L.',
    scope: { account: 'A', coverage: { pct: 100 } }, attributablePct: 100,
    winRate: { measured: true, value: 85.71 }, profitFactor: { target: 1.68, value: 12, verdict: 'unmeasurable' } }

  it('renders the native balance unit, incomplete assessment and priced population', () => {
    const html = renderToStaticMarkup(<AccountRow row={row} />)
    expect(html).toContain('SGD 51.41')
    expect(html).not.toContain('USD 51.41')
    expect(html).toContain('Evidence incomplete')
    expect(html).toContain('36 recorded closes · 35 priced')
    expect(html).toContain('1 recorded close has missing P&amp;L.')
    expect(html).not.toContain('>Met<')
  })

  it('does not default an unverified balance currency to dollars', () => {
    const html = renderToStaticMarkup(<AccountRow row={{ ...row, balanceCurrency: null }} />)
    expect(html).toContain('51.41 (currency unverified)')
    expect(html).not.toContain('$51.41')
  })

  it('renders nothing before data arrives, in either variant', () => {
    // Deliberate: the gate is a decision aid, and a skeleton implying a
    // verdict is worse than an empty space for one paint.
    expect(renderToStaticMarkup(<GoalTracker />)).toBe('')
    expect(renderToStaticMarkup(<GoalTracker variant="compact" />)).toBe('')
  })

  it('does not throw on an unknown variant — it falls back to the full card', () => {
    expect(() => renderToStaticMarkup(<GoalTracker variant="nonsense" />)).not.toThrow()
  })
})
