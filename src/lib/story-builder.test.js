import { describe, it, expect } from 'vitest'
import {
  buildStory,
  computePnl,
  computeProgressToTP,
  normalizeSide,
  actionsForState,
} from './story-builder.js'

describe('story-builder: helpers', () => {
  it('normalizeSide maps aliases to long/short', () => {
    expect(normalizeSide('BUY')).toBe('long')
    expect(normalizeSide('Long')).toBe('long')
    expect(normalizeSide('Sell')).toBe('short')
    expect(normalizeSide('short')).toBe('short')
    expect(normalizeSide('\u25BC')).toBe('short')
    expect(normalizeSide(null)).toBe('long')
  })
  it('computePnl returns directional profit', () => {
    expect(computePnl('long', 100, 110, 2)).toBe(20)
    expect(computePnl('short', 100, 90, 2)).toBe(20)
    expect(computePnl('short', 100, 110, 2)).toBe(-20)
  })
  it('computePnl guards non-finite inputs', () => {
    expect(computePnl('long', NaN, 100, 1)).toBe(0)
    expect(computePnl('long', 100, 'abc', 1)).toBe(0)
  })
  it('computeProgressToTP stays in [0,1]', () => {
    expect(computeProgressToTP('long', 100, 100, 110)).toBe(0)
    expect(computeProgressToTP('long', 100, 105, 110)).toBe(0.5)
    expect(computeProgressToTP('long', 100, 200, 110)).toBe(1) // capped
    expect(computeProgressToTP('long', 100, 90, 110)).toBe(0)  // negative clamps to zero
  })
  it('computeProgressToTP inverts sign for shorts', () => {
    expect(computeProgressToTP('short', 100, 95, 90)).toBe(0.5)
    expect(computeProgressToTP('short', 100, 110, 90)).toBe(0)
  })
  it('computeProgressToTP returns 0 when tp === entry', () => {
    expect(computeProgressToTP('long', 100, 105, 100)).toBe(0)
  })
  it('actionsForState returns LIVE actions for LIVE', () => {
    expect(actionsForState('LIVE')).toEqual(['stop', 'why', 'tighten-sl'])
  })
  it('actionsForState returns correct actions for terminal states', () => {
    expect(actionsForState('WON')).toEqual(['timeline', 'save-vault'])
    expect(actionsForState('LOST')).toEqual(['timeline', 'post-mortem'])
    expect(actionsForState('CANCELLED')).toEqual(['why'])
  })
  it('actionsForState returns WATCHING actions', () => {
    expect(actionsForState('WATCHING')).toEqual(['mute', 'remove'])
  })
  it('actionsForState returns PENDING actions', () => {
    expect(actionsForState('PENDING')).toEqual(['approve', 'cancel', 'why'])
  })
})

describe('story-builder: buildStory', () => {
  const basePos = {
    id: 'pos-1',
    symbol: 'BTCUSD',
    side: 'BUY',
    volume: 0.01,
    entryPrice: 67245,
    currentPrice: 67310,
    stopLoss: 66745,
    takeProfit: 68100,
    reasoning: 'Breakout above 67k with rising OI',
    confidence: 8,
    openTimestamp: 1712000000000,
  }

  it('throws on unknown execState', () => {
    expect(() => buildStory(basePos, 'HALTED')).toThrow(/Unknown execState/)
  })
  it('throws when position is missing', () => {
    expect(() => buildStory(null, 'LIVE')).toThrow(/position required/)
  })
  it('builds a LIVE long story with BOUGHT glyph + headline', () => {
    const s = buildStory(basePos, 'LIVE')
    expect(s.state).toBe('LIVE')
    expect(s.side).toBe('long')
    expect(s.symbol).toBe('BTCUSD')
    expect(s.headline).toBe('\u25B2 BOUGHT 0.01 BTCUSD at $67245.00')
    expect(s.actions).toEqual(['stop', 'why', 'tighten-sl']) // LIVE actions
  })
  it('builds a short story with SOLD glyph + ▼', () => {
    const s = buildStory({ ...basePos, side: 'SELL' }, 'LIVE')
    expect(s.side).toBe('short')
    expect(s.headline.startsWith('\u25BC SOLD')).toBe(true)
  })
  it('clamps confidence to 0..10 and rounds', () => {
    expect(buildStory({ ...basePos, confidence: 9.4 }, 'LIVE').confidence).toBe(9)
    expect(buildStory({ ...basePos, confidence: 42 }, 'LIVE').confidence).toBe(10)
    expect(buildStory({ ...basePos, confidence: -3 }, 'LIVE').confidence).toBe(0)
    expect(buildStory({ ...basePos, confidence: 'none' }, 'LIVE').confidence).toBeNull()
  })
  it('computes pnl and progressToTP from entry/current/tp', () => {
    const s = buildStory(basePos, 'LIVE')
    expect(s.pnl).toBeCloseTo((67310 - 67245) * 0.01, 6)
    expect(s.progressToTP).toBeGreaterThan(0)
    expect(s.progressToTP).toBeLessThanOrEqual(1)
  })
  it('reads thesis when reasoning is absent', () => {
    const s = buildStory({ ...basePos, reasoning: null, thesis: 'Macro tailwind' }, 'LIVE')
    expect(s.reasoning).toBe('Macro tailwind')
  })
  it('builds an empty-state WATCHING story from watchlist stub input', () => {
    const s = buildStory({ id: 'watch-EURUSD', symbol: 'EURUSD', entryPrice: 0, currentPrice: 0, volume: 0 }, 'WATCHING')
    expect(s.state).toBe('WATCHING')
    expect(s.headline).toBe('EURUSD - watching')
    expect(s.actions).toEqual(['mute', 'remove'])
  })
  it('maps price precision by magnitude', () => {
    const hi = buildStory({ ...basePos, entryPrice: 123.456 }, 'LIVE')
    expect(hi.headline).toContain('$123.46')
    const fx = buildStory({ ...basePos, entryPrice: 1.0823 }, 'LIVE')
    expect(fx.headline).toContain('$1.0823')
  })
})
