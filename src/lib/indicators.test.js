// Vitest coverage for src/lib/indicators.js — MIRROR of agent/lib/indicators.js.
// Same cases as agent/lib/indicators.test.js so the twins are provably equal.
import { describe, it, expect } from 'vitest'
import {
  smaSeries,
  emaSeries,
  vwapSeries,
  avwapSeries,
  findFvgZones,
  volumeProfile,
  rsi,
  macd,
  stochastic,
} from './indicators.js'

const MIN = 60_000
// Synthetic bar helper: flat-ish OHLC around close.
function bar(i, c, v = 100, h = c + 1, l = c - 1) {
  return { t: i * MIN, o: c, h, l, c, v }
}
const closes = (arr) => arr.map((c, i) => bar(i, c))

describe('smaSeries', () => {
  it('warmup nulls + alignment', () => {
    const bars = closes([1, 2, 3, 4, 5])
    const s = smaSeries(bars, 3)
    expect(s.length).toBe(bars.length)
    expect(s.slice(0, 2)).toEqual([null, null])
    expect(s.slice(2)).toEqual([2, 3, 4])
  })
})

describe('emaSeries', () => {
  it('SMA seed at period-1, recursive after, same warmup nulls', () => {
    const bars = closes([1, 2, 3, 4, 5])
    const e = emaSeries(bars, 3)
    expect(e.length).toBe(bars.length)
    expect(e.slice(0, 2)).toEqual([null, null])
    expect(e[2]).toBe(2) // seed = SMA(1,2,3)
    const k = 2 / 4
    expect(e[3]).toBeCloseTo(4 * k + 2 * (1 - k), 12)
    expect(e[4]).toBeCloseTo(5 * k + e[3] * (1 - k), 12)
  })
  it('series shorter than period → all null (sma too)', () => {
    const bars = closes([1, 2])
    expect(smaSeries(bars, 5)).toEqual([null, null])
    expect(emaSeries(bars, 5)).toEqual([null, null])
  })
})

describe('vwapSeries', () => {
  it('cumulative typical-price VWAP from anchor, nulls before', () => {
    const bars = [bar(0, 10, 100), bar(1, 20, 300), bar(2, 30, 100)]
    const w = vwapSeries(bars, 1)
    expect(w[0]).toBeNull()
    expect(w[1]).toBe(20) // tp=20, only bar
    // (20*300 + 30*100) / 400 = 22.5
    expect(w[2]).toBeCloseTo(22.5, 12)
  })
})

describe('avwapSeries', () => {
  it('anchored by timestamp — first bar with t >= anchorT', () => {
    const bars = [bar(0, 10, 100), bar(1, 20, 300), bar(2, 30, 100)]
    // anchorT between bar0 and bar1 → anchor at index 1
    expect(avwapSeries(bars, 0.5 * MIN)).toEqual(vwapSeries(bars, 1))
    // anchor exactly on a bar t
    expect(avwapSeries(bars, 2 * MIN)).toEqual(vwapSeries(bars, 2))
    // anchor after all data → all null
    expect(avwapSeries(bars, 99 * MIN)).toEqual([null, null, null])
  })
})

describe('findFvgZones', () => {
  it('detects bull + bear gaps, fill marking', () => {
    // Bull gap: bar0 h=11, bar2 l=15 → zone 11..15 from idx 2.
    const bull = [
      bar(0, 10, 100, 11, 9),
      bar(1, 13, 100, 14, 12),
      bar(2, 16, 100, 17, 15),
      bar(3, 16, 100, 17, 15.5), // does NOT fill (l > bottom)
      bar(4, 12, 100, 13, 10), // fills: l=10 <= 11
    ]
    const bz = findFvgZones(bull)
    // Fixture yields 3 zones: bull 0→2, bull 1→3 (bar1 h=14 < bar3 l=15.5),
    // and bear 2→4 (bar2 l=15 > bar4 h=13).
    expect(bz).toEqual([
      { dir: 'bull', top: 15, bottom: 11, fromIdx: 2, filledIdx: 4 },
      { dir: 'bull', top: 15.5, bottom: 14, fromIdx: 3, filledIdx: 4 },
      { dir: 'bear', top: 15, bottom: 13, fromIdx: 4, filledIdx: null },
    ])

    // Bear gap: bar0 l=19, bar2 h=15 → zone 15..19, never revisited → filledIdx null.
    const bear = [
      bar(0, 20, 100, 21, 19),
      bar(1, 17, 100, 18, 16),
      bar(2, 14, 100, 15, 13),
      bar(3, 13, 100, 14, 12),
    ]
    expect(findFvgZones(bear)).toEqual([
      { dir: 'bear', top: 19, bottom: 15, fromIdx: 2, filledIdx: null },
      { dir: 'bear', top: 16, bottom: 14, fromIdx: 3, filledIdx: null },
    ])
  })
})

// Volume-profile fixture: 48 one-minute bars; prices 100..110; volume heavily
// concentrated near price 105 in the last 24 bars.
function vpBars() {
  const bars = []
  for (let i = 0; i < 48; i++) {
    const heavy = i >= 24 && i % 2 === 0
    const c = heavy ? 105 : 100 + (i % 11)
    bars.push({ t: i * MIN, o: c, h: c + 0.2, l: c - 0.2, c, v: heavy ? 5000 : 10 })
  }
  return bars
}

function checkProfile(p, heavyPrice) {
  expect(p.rows.length).toBeGreaterThan(0)
  const pctSum = p.rows.reduce((s, r) => s + r.pct, 0)
  expect(pctSum).toBeCloseTo(100, 9)
  expect(Math.abs(p.pocPrice - heavyPrice)).toBeLessThan(0.5)
  expect(p.vahPrice).toBeGreaterThanOrEqual(p.pocPrice)
  expect(p.pocPrice).toBeGreaterThanOrEqual(p.valPrice)
  // rows ascending by price
  for (let i = 1; i < p.rows.length; i++) {
    expect(p.rows[i].price).toBeGreaterThan(p.rows[i - 1].price)
  }
}

describe('volumeProfile', () => {
  it('composite — POC on heavy price, VA ordering, pct≈100', () => {
    checkProfile(volumeProfile(vpBars(), { type: 'composite' }), 105)
  })

  it('visible + fixed are the same math over fromIdx..toIdx', () => {
    const bars = vpBars()
    const vis = volumeProfile(bars, { type: 'visible', fromIdx: 24, toIdx: 47 })
    const fix = volumeProfile(bars, { type: 'fixed', fromIdx: 24, toIdx: 47 })
    checkProfile(vis, 105)
    expect(fix).toEqual(vis)
  })

  it('session — only last sessionMs window used', () => {
    const bars = vpBars()
    // 24-minute session → only bars with t > lastT - 24m; heavy 105 dominates.
    const p = volumeProfile(bars, { type: 'session', sessionMs: 24 * MIN })
    checkProfile(p, 105)
    const full = volumeProfile(bars, { type: 'composite' })
    expect(p.rows).not.toEqual(full.rows)
  })

  it('empty + flat-price edge cases', () => {
    expect(volumeProfile([], { type: 'composite' })).toEqual({
      rows: [],
      pocPrice: null,
      vahPrice: null,
      valPrice: null,
    })
    const flat = [bar(0, 50, 100, 50, 50), bar(1, 50, 200, 50, 50)]
    const p = volumeProfile(flat, { type: 'composite', buckets: 8 })
    expect(p.pocPrice).toBe(p.rows[0].price)
    expect(p.rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(100, 9)
  })
})

describe('rsi', () => {
  it('matches the standard textbook (StockCharts) 14-day example', () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
    ]
    const r = rsi(closes, 14)
    expect(r.slice(0, 14)).toEqual(new Array(14).fill(null))
    // Published tutorial value is 70.53; small drift is expected rounding noise.
    expect(r[14]).toBeCloseTo(70.46, 1)
  })

  it('stays in [0,100]; saturates at the extremes for monotonic series', () => {
    const rising = Array.from({ length: 30 }, (_, i) => i + 1)
    const falling = Array.from({ length: 30 }, (_, i) => 30 - i)
    const rUp = rsi(rising, 14)
    const rDown = rsi(falling, 14)
    for (const v of [...rUp, ...rDown]) {
      if (v != null) expect(v).toBeGreaterThanOrEqual(0)
      if (v != null) expect(v).toBeLessThanOrEqual(100)
    }
    expect(rUp[rUp.length - 1]).toBe(100)
    expect(rDown[rDown.length - 1]).toBe(0)
  })

  it('too few closes → all null', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null])
  })
})

describe('macd', () => {
  it('macdLine = fastEma - slowEma, histogram = macdLine - signalLine', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2)
    const { macdLine, signalLine, histogram } = macd(closes, 12, 26, 9)
    expect(macdLine.length).toBe(closes.length)
    const bars = closes.map((c) => ({ c }))
    const fastEma = emaSeries(bars, 12)
    const slowEma = emaSeries(bars, 26)
    for (let i = 0; i < closes.length; i++) {
      if (fastEma[i] != null && slowEma[i] != null) {
        expect(macdLine[i]).toBeCloseTo(fastEma[i] - slowEma[i], 10)
      } else {
        expect(macdLine[i]).toBeNull()
      }
      if (macdLine[i] != null && signalLine[i] != null) {
        expect(histogram[i]).toBeCloseTo(macdLine[i] - signalLine[i], 10)
      } else {
        expect(histogram[i]).toBeNull()
      }
    }
    // Signal line only starts once enough MACD values exist to seed its EMA.
    const firstMacd = macdLine.findIndex((v) => v != null)
    expect(signalLine.slice(firstMacd, firstMacd + 8)).toEqual(new Array(8).fill(null))
    expect(signalLine[firstMacd + 8]).not.toBeNull()
  })
})

describe('stochastic', () => {
  it('%K from high/low/close range, %D = SMA(%K, dPeriod), values in [0,100]', () => {
    const bars = closes([10, 11, 12, 11, 10, 9, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
    const { k, d } = stochastic(bars, 14, 3)
    expect(k.slice(0, 13)).toEqual(new Array(13).fill(null))
    expect(k[13]).not.toBeNull()
    for (const v of k) if (v != null) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
    for (const v of d) if (v != null) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
    // %D needs dPeriod consecutive %K values, so it lags %K by dPeriod-1.
    expect(d[13]).toBeNull()
    expect(d[15]).toBeCloseTo((k[13] + k[14] + k[15]) / 3, 10)
  })

  it('flat high==low range → %K=100 (matches close-at-top convention)', () => {
    const bars = Array.from({ length: 5 }, (_, i) => ({ t: i * MIN, o: 10, h: 10, l: 10, c: 10, v: 1 }))
    const { k } = stochastic(bars, 5, 3)
    expect(k[4]).toBe(100)
  })
})

describe('chart TF ladder', () => {
  it('exports 5 groups whose tfs are all agent-parseable', async () => {
    const { CHART_TF_GROUPS } = await import('./chart-timeframes.js')
    const { parseTimeframe } = await import('./timeframes.js')
    expect(CHART_TF_GROUPS.map((g) => g.label)).toEqual(['min', 'hour', 'day', 'week', 'month'])
    for (const g of CHART_TF_GROUPS) {
      for (const tf of g.tfs) expect(parseTimeframe(tf), tf).not.toBeNull()
    }
  })
})
