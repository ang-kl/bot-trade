// PHASE 3 GATE (cockpit live-wiring prompt): "chart values can be checked
// against returned bars." Every assertion here is hand arithmetic over known
// bars — the module is pure, so nothing else can be smuggled in.
import { test } from 'node:test'
import assert from 'node:assert'
import { buildBarsAndIndicators, barCountFor } from './cockpit-bars.js'

const M15 = 15 * 60 * 1000
/** n flat-ish bars, oldest first, volume 100 except where overridden. */
function mkBars(n, { t0 = 1_700_000_000_000, price = (i) => 100 + i, vol = () => 100 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const c = price(i)
    return { t: t0 + i * M15, o: c - 0.5, h: c + 1, l: c - 1, c, v: vol(i) }
  })
}

test('empty bars are a status, never synthetic candles', () => {
  const out = buildBarsAndIndicators([], { timeframe: '15m', sinceMs: 1_700_000_000_000 })
  assert.equal(out.bars.status, 'unknown')
  assert.deepEqual(out.bars.rows, [])
  assert.equal(out.indicators.status, 'unknown')
  // A fetch ERROR is distinguishable from an empty answer, and says why.
  const err = buildBarsAndIndicators([], { fetchError: 'Broker returned no bars' })
  assert.equal(err.bars.status, 'unavailable')
  assert.match(err.bars.detail, /no bars/)
})

test('indicator arrays align one-to-one with the bars', () => {
  const bars = mkBars(60)
  const out = buildBarsAndIndicators(bars, { timeframe: '15m', sinceMs: bars[0].t })
  for (const k of ['ema9', 'ema20', 'ema50', 'vwap']) {
    assert.equal(out.indicators[k].length, bars.length, `${k} must have one value per bar`)
  }
  // EMA warm-up: null before the period completes, numbers after — never a
  // fabricated early value.
  assert.equal(out.indicators.ema50[48], null)
  assert.notEqual(out.indicators.ema50[49], null)
})

test('VWAP checks out against hand arithmetic on the returned bars', () => {
  // Two bars: typical prices (h+l+c)/3 = 100 and 104, volumes 1 and 3.
  const bars = [
    { t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 },
    { t: M15, o: 104, h: 105, l: 103, c: 104, v: 3 },
  ]
  const out = buildBarsAndIndicators(bars, { timeframe: '15m', sinceMs: 0 })
  // cum PV = 100·1 + 104·3 = 412 ; cum V = 4 → 103
  assert.ok(Math.abs(out.indicators.vwap[1] - 103) < 1e-9)
})

test('RVOL is the last bar over the prior mean — and refuses a thin baseline', () => {
  // 13 bars: 12 priors at v=100, last at v=250 → rvol 2.5 exactly.
  const bars = mkBars(13, { vol: (i) => (i === 12 ? 250 : 100) })
  const out = buildBarsAndIndicators(bars, { timeframe: '15m', sinceMs: bars[0].t })
  assert.equal(out.indicators.rvol, 2.5)
  // 11 priors is below the floor: null, not a ratio over noise.
  const thin = buildBarsAndIndicators(mkBars(12, { vol: (i) => (i === 11 ? 250 : 100) }), { timeframe: '15m', sinceMs: 0 })
  assert.equal(thin.indicators.rvol, null)
})

test('the volume profile POC lands where the volume actually is', () => {
  // All volume concentrated at price ~110; a thin tail elsewhere.
  const bars = mkBars(40, { price: (i) => (i < 30 ? 110 : 130), vol: (i) => (i < 30 ? 1000 : 10) })
  const out = buildBarsAndIndicators(bars, { timeframe: '15m', sinceMs: bars[0].t })
  const vp = out.indicators.volumeProfile
  assert.equal(vp.status, 'derived')
  assert.ok(Math.abs(vp.pocPrice - 110) < 2, `POC ${vp.pocPrice} should sit at the volume cluster`)
  assert.ok(vp.valueAreaLow <= vp.pocPrice && vp.pocPrice <= vp.valueAreaHigh)
})

test('partial history is stated, not padded', () => {
  const bars = mkBars(20)
  // Asked for history starting 10 hours before the first held bar.
  const out = buildBarsAndIndicators(bars, { timeframe: '15m', sinceMs: bars[0].t - 36_000_000 })
  assert.equal(out.bars.status, 'partial')
  assert.match(out.bars.detail, /history starts/)
  // Bars held exactly from the window start are LIVE, not partial.
  const full = buildBarsAndIndicators(bars, { timeframe: '15m', sinceMs: bars[0].t })
  assert.equal(full.bars.status, 'live')
})

test('barCountFor covers the lookback within the chart route bounds', () => {
  assert.equal(barCountFor('15m', 48 * 3_600_000), 193)   // 192 bars + 1
  assert.equal(barCountFor('15m', 1 * 3_600_000), 30)     // floor
  assert.equal(barCountFor('1m', 168 * 3_600_000), 300)   // cap
})
