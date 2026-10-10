// vitest — Claude · № 12,812 10-Oct: the Risk page prints each stored value in
// its own unit. Two of these were printed wrong in production on 10-10
// (margin level floor 200 → "20000%", headroom share → "0.3333333333333333").
import { describe, it, expect } from 'vitest'
import { showRiskValue, sameRiskValue, overlaySplit } from './risk-format.js'

describe('showRiskValue', () => {
  it('prints fractions as percentages', () => {
    expect(showRiskValue('dailyLossPct', 0.02)).toBe('2%')
    expect(showRiskValue('maxSpreadFracOfSL', 0.03)).toBe('3%')
    expect(showRiskValue('maxPositionHeadroomShare', 1 / 3)).toBe('33.33%')
    expect(showRiskValue('marginRates', { stock: 0.2, crypto: 0.5 })).toBe('stock 20% · crypto 50%')
    expect(showRiskValue('derisk', { on: true, triggerPct: 0.05, mult: 0.5 })).toBe('on on · triggerPct 5% · mult 0.5')
  })
  it('prints whole-percent keys as stored, not ×100', () => {
    expect(showRiskValue('marginLevelFloorPct', 200)).toBe('200%')
    expect(showRiskValue('minSLDistancePct', 0.15)).toBe('0.15%')
  })
  it('never prints [object Object] and keeps unknowns as dashes', () => {
    expect(showRiskValue('unknownPnl', { block: true, graceMin: 15 })).not.toContain('[object Object]')
    expect(showRiskValue('perTradeRiskUsd', null)).toBe('—')
    expect(showRiskValue('blockedSymbols', [])).toBe('none')
    expect(showRiskValue('maxOpenPositions', 5)).toBe('5')
  })
})

describe('overlaySplit', () => {
  it('separates keys that differ from Global from keys pinned at the same value', () => {
    const eff = { perTradeRiskPct: 0.02, dailyLossPct: 0.02, newsGate: { on: true, minBefore: 30 } }
    const glob = { perTradeRiskPct: 0.01, dailyLossPct: 0.02, newsGate: { minBefore: 30, on: true } }
    expect(overlaySplit(['perTradeRiskPct', 'dailyLossPct', 'newsGate'], eff, glob))
      .toEqual({ differ: ['perTradeRiskPct'], same: ['dailyLossPct', 'newsGate'] })
    expect(sameRiskValue(null, undefined)).toBe(true)
  })
})
