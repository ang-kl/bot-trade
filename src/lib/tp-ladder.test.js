import { describe, it, expect } from 'vitest'
import { tpLadder, heldMoneyLadder } from './tp-ladder.js'

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

// Claude · № 13,980 13-Oct (owner: Codex P2 on #1348 "TP money from held lots"; claude-builder).
// Source of the expected values: SHOP.US, opened 9.5 lots, broker holds 4.7
// after a partial close (audit № 13,904). The money at the target is what the
// lots still held would earn there, not the lots that were opened.
describe('heldMoneyLadder', () => {
  it('no partial close: the display ladder is the money ladder', () => {
    const tps = tpLadder(1.1, 1.2, 0.04)
    expect(heldMoneyLadder(tps, 0.04, 0.04)).toBe(tps)
    expect(heldMoneyLadder(tps, null, 0.04)).toBe(tps)
  })

  it('single target, partially closed: the held lots go to the target', () => {
    const tps = tpLadder(120, null, 9.5)
    expect(heldMoneyLadder(tps, 4.7, 9.5)).toEqual([{ n: 1, price: 120, lots: 4.7, done: false }])
  })

  it('two targets, not scaled out: the held lots are split across both', () => {
    const tps = tpLadder(120, 130, 9.5)
    const m = heldMoneyLadder(tps, 4.7, 9.5)
    expect(m.map(t => t.price)).toEqual([120, 130])
    expect(m[0].lots + m[1].lots).toBeCloseTo(4.7, 10)
  })

  it('scaled out at TP1: all held lots ride to TP2, TP1 earns nothing more', () => {
    const tps = tpLadder(120, 130, 9.5, { scaledOut: true })
    expect(heldMoneyLadder(tps, 4.75, 9.5)).toEqual([{ n: 2, price: 130, lots: 4.75 }])
  })

  it('no ladder stays no ladder', () => {
    expect(heldMoneyLadder(null, 4.7, 9.5)).toBeNull()
  })
})
