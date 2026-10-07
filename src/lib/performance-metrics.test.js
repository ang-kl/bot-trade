// Codex · №11,784 · 2026-10-07; codex-footprint: performance-essentials.
import { describe, it, expect } from 'vitest'
import { historicalMetricGroups, historicalMetricNotes } from './performance-metrics.js'

const sample = { trades: 3, closedTrades: 4, unpricedTrades: 1, unknownCloseTimeN: 2,
  wins: 1, losses: 2, winRate: 33.33, moneyState: 'recorded_account_units',
  net: 5, expectancy: 5 / 3, grossWin: 10, grossLoss: 5, profitFactor: 2,
  avgWin: 10, avgLoss: 2.5, payoff: 4, maxDrawdown: 5,
  bestTrade: 10, worstTrade: -5, bestDay: 5, worstDay: 5, greenDays: 1,
  tradingDays: 1, winStreak: 1, lossStreak: 2, medianHoldMin: 34,
  firstMs: Date.parse('2026-10-07T00:00Z'), lastMs: Date.parse('2026-10-07T01:00Z') }
const metric = (a, label) => historicalMetricGroups(a).flatMap(g => g[1]).find(r => r[0] === label)
describe('Historical metric meaning', () => {
  it('withholds money and green days across identities, even if money fields arrive', () => {
    const a = { ...sample, moneyState: 'unverified_cross_account_units', greenDays: null }
    expect(metric(a, 'Net P&L')[1]).toBe('—')
    expect(metric(a, 'Profit factor')[1]).toBe('—')
    expect(metric(a, 'Best / worst day')[3]).toContain('unavailable')
    expect(JSON.stringify(historicalMetricGroups(a))).not.toContain('null of')
    expect(metric(a, 'Win rate')[1]).toBe('33.33%')
    expect(historicalMetricNotes(a).join(' ')).toContain('No FX conversion is assumed')
  })
  it('distinguishes a zero drawdown and no-loss undefined PF from unavailable money', () => {
    const a = { ...sample, maxDrawdown: 0, profitFactor: null, profitFactorInfinite: true, grossLoss: 0 }
    expect(metric(a, 'Max drawdown')[1]).toBe('0')
    expect(metric(a, 'Profit factor')[1]).toBe('—')
    expect(metric(a, 'Profit factor')[2]).toBe('')
    expect(metric(a, 'Profit factor')[3]).toContain('Undefined')
  })
  it('keeps the priced sample, unknown money, UTC history and scratches explicit', () => {
    const notes = historicalMetricNotes(sample).join(' ')
    expect(notes).toContain('3 priced of 4')
    expect(notes).toContain('1 close without P&L')
    expect(notes).toContain('2 rows without a usable close time')
    expect(notes).toContain('UTC')
    expect(metric(sample, 'Win rate')[3]).toContain('2 non-wins (scratches included)')
    expect(metric(sample, 'Avg non-win loss')[1]).toBe('-2.5')
  })
})
