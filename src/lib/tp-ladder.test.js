import { describe, it, expect } from 'vitest'
import { tpLadder } from './tp-ladder.js'

describe('tpLadder', () => {
  it('returns null with no TP at all', () => {
    expect(tpLadder(null, null, 0.04)).toBeNull()
    expect(tpLadder(undefined, 1.1, 0.04)).toBeNull() // tp2 without tp1 is not a ladder
  })

  it('single TP → one level with full lots', () => {
    expect(tpLadder(1.095, null, 0.04)).toEqual([{ n: 1, price: 1.095, lots: 0.04, done: false }])
  })

  it('two TPs → 50/50 split, numbered', () => {
    expect(tpLadder(1.095, 1.101, 0.04)).toEqual([
      { n: 1, price: 1.095, lots: 0.02, done: false },
      { n: 2, price: 1.101, lots: 0.02 },
    ])
  })

  it('odd lot splits keep the sum exact (0.05 → 0.03 + 0.02)', () => {
    const l = tpLadder(1.095, 1.101, 0.05)
    expect(l[0].lots + l[1].lots).toBeCloseTo(0.05, 10)
    expect(l[0].lots).toBeGreaterThanOrEqual(0.01)
    expect(l[1].lots).toBeGreaterThanOrEqual(0.01)
  })

  it('0.01 lots cannot split — collapses to one full-size level', () => {
    expect(tpLadder(1.095, 1.101, 0.01)).toEqual([{ n: 1, price: 1.095, lots: 0.01, done: false }])
  })

  it('unknown lots → ladder with null lots (prices still shown)', () => {
    expect(tpLadder(1.095, 1.101, null)).toEqual([
      { n: 1, price: 1.095, lots: null, done: false },
      { n: 2, price: 1.101, lots: null },
    ])
  })

  it('scaledOut marks level 1 done (partial already banked)', () => {
    const l = tpLadder(1.095, 1.101, 0.04, { scaledOut: true })
    expect(l[0].done).toBe(true)
    expect(l[1].done).toBeUndefined()
  })

  it('identical tp1/tp2 is one level, not a fake ladder', () => {
    expect(tpLadder(1.095, 1.095, 0.04)).toEqual([{ n: 1, price: 1.095, lots: 0.04, done: false }])
  })
})
