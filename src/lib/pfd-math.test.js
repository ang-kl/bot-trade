import { describe, it, expect } from 'vitest'
import { pfdR, rollFromSamples } from './pfd-math.js'

describe('pfdR (attitude pitch source)', () => {
  it('long: above entry = positive R (profit sky), below = negative', () => {
    // entry 100, SL 98 → risk 2
    expect(pfdR(100, 98, 'BUY', 101)).toBe(0.5)
    expect(pfdR(100, 98, 'BUY', 98)).toBe(-1)
  })
  it('short: profit is price BELOW entry', () => {
    expect(pfdR(100, 102, 'SELL', 99)).toBe(0.5)
    expect(pfdR(100, 102, 'SELL', 102)).toBe(-1)
  })
  it('null on missing data or zero risk', () => {
    expect(pfdR(null, 98, 'BUY', 100)).toBe(null)
    expect(pfdR(100, 100, 'BUY', 101)).toBe(null)
  })
})

describe('rollFromSamples (TP-convergence bank)', () => {
  it('distance shrinking → banks RIGHT (positive)', () => {
    const roll = rollFromSamples([{ t: 0, d: 2 }, { t: 60_000, d: 1.5 }])
    expect(roll).toBeGreaterThan(0)
  })
  it('distance growing → banks LEFT (negative)', () => {
    const roll = rollFromSamples([{ t: 0, d: 1.5 }, { t: 60_000, d: 2 }])
    expect(roll).toBeLessThan(0)
  })
  it('steady distance → wings level', () => {
    expect(rollFromSamples([{ t: 0, d: 1 }, { t: 60_000, d: 1 }])).toBe(0)
  })
  it('caps at ±30°, safe on empty/short input', () => {
    expect(Math.abs(rollFromSamples([{ t: 0, d: 100 }, { t: 60_000, d: 0 }]))).toBeLessThanOrEqual(30)
    expect(rollFromSamples([])).toBe(0)
    expect(rollFromSamples([{ t: 0, d: 1 }])).toBe(0)
  })
})
