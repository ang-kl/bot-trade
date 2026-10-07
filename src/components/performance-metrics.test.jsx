// Codex · №11,784 · 2026-10-07; codex-footprint: performance-essentials.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PerformanceMetrics from './PerformanceMetrics.jsx'
import { historicalMetricGroups } from '../lib/performance-metrics.js'

describe('Historical metric presentation', () => {
  it('explains withheld money without printing null percentages or days', () => {
    const analytics = { trades: 1362, closedTrades: 1379, unpricedTrades: 17, unknownCloseTimeN: 2,
      wins: 447, losses: 915, winRate: 32.82, greenDays: null, tradingDays: 70,
      moneyState: 'unverified_cross_account_units', winStreak: 10, lossStreak: 28 }
    const html = renderToStaticMarkup(<PerformanceMetrics analytics={analytics} groups={historicalMetricGroups(analytics)} />)
    expect(html).toContain('32.82%')
    expect(html).toContain('915 non-wins')
    expect(html).toContain('17 closes without P&amp;L')
    expect(html).toContain('Money unavailable')
    expect(html).not.toContain('null of')
    expect(html).toContain('min-width:640px')
    expect(html).toContain('overflow-x:auto')
    expect(html).toContain('scope="row"')
  })
})
