import { describe, it, expect } from 'vitest'
import { priceTravel, rMultiple, slProximity, velocityRPerHr, fmtDuration, elapsedMs, safeTargetR } from './chrono-math.js'

describe('rMultiple', () => {
  it('long: at TP (2R) reads +2, at SL reads −1', () => {
    expect(rMultiple({ entry: 100, sl: 90, side: 'BUY', price: 120 })).toBeCloseTo(2)
    expect(rMultiple({ entry: 100, sl: 90, side: 'BUY', price: 90 })).toBeCloseTo(-1)
    expect(rMultiple({ entry: 100, sl: 90, side: 'BUY', price: 100 })).toBeCloseTo(0)
  })
  it('short: profit when price falls', () => {
    expect(rMultiple({ entry: 100, sl: 110, side: 'SELL', price: 90 })).toBeCloseTo(1)
  })
})

describe('priceTravel', () => {
  it('long: 0 at SL, 1 at TP, entry between', () => {
    const t = priceTravel({ entry: 100, sl: 90, tp: 120, side: 'BUY', price: 110 })
    expect(t.sl).toBeCloseTo(0)
    expect(t.tp).toBeCloseTo(1)
    expect(t.price).toBeCloseTo((110 - 90) / (120 - 90))
    expect(t.entry).toBeCloseTo((100 - 90) / (120 - 90))
  })
  it('short: target is DOWN, so 1 = at (lower) TP', () => {
    const t = priceTravel({ entry: 100, sl: 110, tp: 80, side: 'SELL', price: 90 })
    expect(t.sl).toBeCloseTo(0)
    expect(t.tp).toBeCloseTo(1)
    expect(t.price).toBeGreaterThan(t.entry) // price moved toward target
  })
})

describe('slProximity', () => {
  it('is 0 at entry, 1 at the stop', () => {
    expect(slProximity({ entry: 100, sl: 90, side: 'BUY', price: 100 })).toBeCloseTo(0)
    expect(slProximity({ entry: 100, sl: 90, side: 'BUY', price: 90 })).toBeCloseTo(1)
    expect(slProximity({ entry: 100, sl: 90, side: 'BUY', price: 95 })).toBeCloseTo(0.5)
  })
})

describe('velocityRPerHr', () => {
  it('null under 30s in trade, else R/hour', () => {
    expect(velocityRPerHr({ r: 1, ms: 10_000 })).toBeNull()
    expect(velocityRPerHr({ r: 2, ms: 3_600_000 })).toBeCloseTo(2)
    expect(velocityRPerHr({ r: 1, ms: 1_800_000 })).toBeCloseTo(2) // 1R in 30min = 2R/hr
  })
})

describe('fmtDuration', () => {
  it('formats M:SS and H:MM:SS', () => {
    expect(fmtDuration(65_000)).toBe('1:05')
    expect(fmtDuration(3_725_000)).toBe('1:02:05')
    expect(fmtDuration(null)).toBe('—')
  })
})

describe('safeTargetR', () => {
  it('accepts a sane positive target', () => {
    expect(safeTargetR(2)).toBe(2)
    expect(safeTargetR(0.5)).toBe(0.5)
  })
  it('rejects a blown-up ratio from a near-zero-risk SL (owner screenshot: "-384.6R")', () => {
    expect(safeTargetR(-384.6)).toBeNull()
    expect(safeTargetR(9999)).toBeNull()
  })
  it('rejects non-finite or non-positive values', () => {
    expect(safeTargetR(NaN)).toBeNull()
    expect(safeTargetR(0)).toBeNull()
    expect(safeTargetR(null)).toBeNull()
  })
})

describe('elapsedMs', () => {
  it('non-negative from a valid ISO, null otherwise', () => {
    expect(elapsedMs('2020-01-01T00:00:00Z', Date.parse('2020-01-01T00:01:00Z'))).toBe(60_000)
    expect(elapsedMs('nope')).toBeNull()
  })
})
