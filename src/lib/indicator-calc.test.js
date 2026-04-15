// Vitest suite for indicator-calc.
// Two cases per exported function: warmup/length contract, then a
// known-value or shape sanity check. Keeps tests tight and deterministic.

import { describe, it, expect } from 'vitest'
import {
  sma, ema, wma, hma, dema, tema,
  trueRange, atr, bollingerBands, keltnerChannel, donchianChannel,
  rsi, macd, stochastic,
  vwap, obv,
  computeIndicator, getIndicatorRenderType,
} from './indicator-calc.js'

const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const candle = (i) => ({ t: i * 1000, o: i, h: i + 0.5, l: i - 0.5, c: i, v: 100 + i })
const candles = Array.from({ length: 10 }, (_, i) => candle(i + 1))

describe('moving averages', () => {
  describe('sma', () => {
    it('null-pads first period-1 entries', () => {
      const out = sma(closes, 3)
      expect(out.length).toBe(closes.length)
      expect(out[0]).toBeNull()
      expect(out[1]).toBeNull()
      expect(out[2]).not.toBeNull()
    })
    it('matches known average for known input', () => {
      const out = sma([1, 2, 3, 4, 5], 3)
      expect(out).toEqual([null, null, 2, 3, 4])
    })
  })

  describe('ema', () => {
    it('returns same length and starts with first value', () => {
      const out = ema(closes, 5)
      expect(out.length).toBe(closes.length)
      expect(out[0]).toBe(closes[0])
    })
    it('approaches the value of a constant series', () => {
      const constSeries = Array(10).fill(7)
      const out = ema(constSeries, 4)
      expect(out[9]).toBeCloseTo(7, 6)
    })
  })

  describe('wma', () => {
    it('null-pads first period-1 entries', () => {
      const out = wma(closes, 3)
      expect(out[0]).toBeNull()
      expect(out[1]).toBeNull()
      expect(out[2]).not.toBeNull()
    })
    it('weights recent values more heavily', () => {
      const out = wma([1, 2, 3], 3)
      // (1*1 + 2*2 + 3*3) / (1+2+3) = 14/6 ≈ 2.333
      expect(out[2]).toBeCloseTo(14 / 6, 6)
    })
  })

  describe('hma', () => {
    it('returns same-length array', () => {
      const out = hma(closes, 4)
      expect(out.length).toBe(closes.length)
    })
    it('has a numeric tail value for a non-trivial series', () => {
      const out = hma(closes, 4)
      expect(typeof out[out.length - 1]).toBe('number')
    })
  })

  describe('dema', () => {
    it('returns same-length array', () => {
      const out = dema(closes, 3)
      expect(out.length).toBe(closes.length)
    })
    it('produces finite numbers for the tail', () => {
      const out = dema(closes, 3)
      expect(Number.isFinite(out[out.length - 1])).toBe(true)
    })
  })

  describe('tema', () => {
    it('returns same-length array', () => {
      const out = tema(closes, 3)
      expect(out.length).toBe(closes.length)
    })
    it('produces finite numbers for the tail', () => {
      const out = tema(closes, 3)
      expect(Number.isFinite(out[out.length - 1])).toBe(true)
    })
  })
})

describe('volatility', () => {
  describe('trueRange', () => {
    it('returns same length as input', () => {
      const out = trueRange(candles)
      expect(out.length).toBe(candles.length)
    })
    it('first element equals h - l', () => {
      const out = trueRange(candles)
      expect(out[0]).toBeCloseTo(candles[0].h - candles[0].l, 6)
    })
  })

  describe('atr', () => {
    it('null-pads first period-1 entries', () => {
      const out = atr(candles, 3)
      expect(out[0]).toBeNull()
      expect(out[1]).toBeNull()
      expect(out[2]).not.toBeNull()
    })
    it('produces a positive number after warmup', () => {
      const out = atr(candles, 3)
      expect(out[5]).toBeGreaterThan(0)
    })
  })

  describe('bollingerBands', () => {
    it('returns three same-length arrays', () => {
      const bb = bollingerBands(candles, 3, 2)
      expect(bb.middle.length).toBe(candles.length)
      expect(bb.upper.length).toBe(candles.length)
      expect(bb.lower.length).toBe(candles.length)
    })
    it('upper >= middle >= lower after warmup', () => {
      const bb = bollingerBands(candles, 3, 2)
      const i = candles.length - 1
      expect(bb.upper[i]).toBeGreaterThanOrEqual(bb.middle[i])
      expect(bb.middle[i]).toBeGreaterThanOrEqual(bb.lower[i])
    })
  })

  describe('keltnerChannel', () => {
    it('returns three same-length arrays', () => {
      const kc = keltnerChannel(candles, 3, 3, 1.5)
      expect(kc.middle.length).toBe(candles.length)
      expect(kc.upper.length).toBe(candles.length)
      expect(kc.lower.length).toBe(candles.length)
    })
    it('upper >= middle >= lower after warmup', () => {
      const kc = keltnerChannel(candles, 3, 3, 1.5)
      const i = candles.length - 1
      expect(kc.upper[i]).toBeGreaterThanOrEqual(kc.middle[i])
      expect(kc.middle[i]).toBeGreaterThanOrEqual(kc.lower[i])
    })
  })

  describe('donchianChannel', () => {
    it('null-pads first period-1 entries', () => {
      const dc = donchianChannel(candles, 3)
      expect(dc.upper[0]).toBeNull()
      expect(dc.lower[0]).toBeNull()
      expect(dc.middle[0]).toBeNull()
    })
    it('upper equals max high in window', () => {
      const dc = donchianChannel(candles, 3)
      const i = 5
      const expected = Math.max(candles[3].h, candles[4].h, candles[5].h)
      expect(dc.upper[i]).toBeCloseTo(expected, 6)
    })
  })
})

describe('momentum', () => {
  describe('rsi', () => {
    it('null-pads first period entries', () => {
      const out = rsi(candles, 4)
      expect(out[0]).toBeNull()
      expect(out[3]).toBeNull()
      expect(out[4]).not.toBeNull()
    })
    it('returns 100 for monotonically rising closes', () => {
      // No losses => avgLoss is 0 => RSI clamps to 100.
      const out = rsi(candles, 4)
      expect(out[4]).toBe(100)
    })
  })

  describe('macd', () => {
    it('returns three same-length arrays', () => {
      const m = macd(candles, 3, 6, 2)
      expect(m.line.length).toBe(candles.length)
      expect(m.signal.length).toBe(candles.length)
      expect(m.histogram.length).toBe(candles.length)
    })
    it('histogram = line - signal at every index', () => {
      const m = macd(candles, 3, 6, 2)
      for (let i = 0; i < m.line.length; i++) {
        expect(m.histogram[i]).toBeCloseTo(m.line[i] - m.signal[i], 6)
      }
    })
  })

  describe('stochastic', () => {
    it('returns k and d arrays of input length', () => {
      const s = stochastic(candles, 3, 2)
      expect(s.k.length).toBe(candles.length)
      expect(s.d.length).toBe(candles.length)
    })
    it('k stays inside [0, 100] after warmup', () => {
      const s = stochastic(candles, 3, 2)
      for (let i = 2; i < s.k.length; i++) {
        expect(s.k[i]).toBeGreaterThanOrEqual(0)
        expect(s.k[i]).toBeLessThanOrEqual(100)
      }
    })
  })
})

describe('volume', () => {
  describe('vwap', () => {
    it('returns same-length array of finite numbers', () => {
      const out = vwap(candles)
      expect(out.length).toBe(candles.length)
      for (const v of out) expect(Number.isFinite(v)).toBe(true)
    })
    it('starts at the first typical price', () => {
      const out = vwap(candles)
      const t0 = (candles[0].h + candles[0].l + candles[0].c) / 3
      expect(out[0]).toBeCloseTo(t0, 6)
    })
  })

  describe('obv', () => {
    it('first value is 0', () => {
      const out = obv(candles)
      expect(out[0]).toBe(0)
    })
    it('rises monotonically when closes rise', () => {
      const out = obv(candles)
      for (let i = 1; i < out.length; i++) {
        expect(out[i]).toBeGreaterThanOrEqual(out[i - 1])
      }
    })
  })
})

describe('dispatcher', () => {
  describe('computeIndicator', () => {
    it('routes ema with default period', () => {
      const r = computeIndicator('ema', {}, candles)
      expect(r.type).toBe('line')
      expect(r.render).toBe('overlay')
      expect(r.data.length).toBe(candles.length)
    })
    it('returns null for unknown id', () => {
      expect(computeIndicator('not-real', {}, candles)).toBeNull()
    })
    it('routes bbands as a band', () => {
      const r = computeIndicator('bbands', {}, candles)
      expect(r.type).toBe('band')
      expect(r.data.middle.length).toBe(candles.length)
    })
  })

  describe('getIndicatorRenderType', () => {
    it('classifies ema as overlay', () => {
      expect(getIndicatorRenderType('ema')).toBe('overlay')
    })
    it('classifies rsi as panel', () => {
      expect(getIndicatorRenderType('rsi')).toBe('panel')
    })
    it('returns none for unknown id', () => {
      expect(getIndicatorRenderType('not-real')).toBe('none')
    })
  })
})
