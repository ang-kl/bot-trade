// npx vitest run src/lib/side.test.js
//
// Owner, 2026-07-30, with a screenshot of ten open positions: "wrong estimate
// Dollar calculation for Stop-Loss for 'short' trade, it is positive dollar
// while 'Take-Profit' is negative dollar."
//
// The dollars were right; the SIDE was wrong. Two vocabularies (broker BUY/SELL,
// database long/short) were compared with `=== 'BUY'`, so every long held in
// monitored_positions rendered as "Short" AND had its estimated SL/TP money sign
// inverted. These tests pin the vocabulary and the money direction together,
// because they are the same bug seen from two ends.
import { describe, it, expect } from 'vitest'
import { isLong, sideDir, sideLabel, sideLabelUpper } from './side.js'
import { bracketMoney } from './std-trade-rows.js'

describe('side vocabulary', () => {
  it('accepts the BROKER words', () => {
    expect(isLong('BUY')).toBe(true)
    expect(isLong('SELL')).toBe(false)
  })

  it('accepts the DATABASE words — the case this bug was about', () => {
    expect(isLong('long')).toBe(true)
    expect(isLong('short')).toBe(false)
    // The row builders upper-case before handing over, which is exactly how
    // 'long' became 'LONG' and stopped matching 'BUY'.
    expect(isLong('LONG')).toBe(true)
    expect(isLong('SHORT')).toBe(false)
  })

  it('accepts the raw proto enums', () => {
    expect(isLong(1)).toBe(true)
    expect(isLong(2)).toBe(false)
  })

  it('returns NULL for unknown rather than falling through to short', () => {
    // Guessing here is a lie about direction, and direction decides whether a
    // number is a profit or a loss.
    for (const junk of [null, undefined, '', 'sideways', 'BUYY', {}]) {
      expect(isLong(junk)).toBe(null)
      expect(sideDir(junk)).toBe(null)
      expect(sideLabel(junk)).toBe(null)
      expect(sideLabelUpper(junk)).toBe(null)
    }
  })

  it('labels and directions agree', () => {
    expect(sideLabel('long')).toBe('Long')
    expect(sideLabelUpper('long')).toBe('LONG')
    expect(sideDir('long')).toBe(1)
    expect(sideLabel('SELL')).toBe('Short')
    expect(sideDir('SELL')).toBe(-1)
  })
})

describe('bracket money follows the side, in EITHER vocabulary', () => {
  // A long: stop below entry loses, target above entry profits.
  const long = { symbol: 'EURUSD', qty: 1, entry: 1.1000, sl: 1.0950, tp: 1.1100 }
  // A short: stop ABOVE entry loses, target BELOW entry profits.
  const short = { symbol: 'EURUSD', qty: 1, entry: 1.1000, sl: 1.1050, tp: 1.0900 }

  it("'long' produces the SAME signs as 'BUY' (the reported bug)", () => {
    const a = bracketMoney({ ...long, side: 'BUY' })
    const b = bracketMoney({ ...long, side: 'long' })
    const c = bracketMoney({ ...long, side: 'LONG' })
    expect(a.slMoney).toBeLessThan(0)
    expect(a.tpMoney).toBeGreaterThan(0)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it("'short' produces the SAME signs as 'SELL'", () => {
    const a = bracketMoney({ ...short, side: 'SELL' })
    const b = bracketMoney({ ...short, side: 'short' })
    expect(a.slMoney).toBeLessThan(0)
    expect(a.tpMoney).toBeGreaterThan(0)
    expect(b).toEqual(a)
  })

  it('a stop trailed PAST entry is locked-in profit, not a loss', () => {
    // The sign is real, not assumed by which bracket it is.
    const { slMoney } = bracketMoney({ symbol: 'EURUSD', side: 'long', qty: 1, entry: 1.1000, sl: 1.1020 })
    expect(slMoney).toBeGreaterThan(0)
  })

  it('an unknown side returns NO money rather than a wrong sign', () => {
    const { slMoney, tpMoney } = bracketMoney({ ...long, side: 'sideways' })
    expect(slMoney).toBe(null)
    expect(tpMoney).toBe(null)
  })
})
