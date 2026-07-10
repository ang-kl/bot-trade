// node --test agent/services/ema-pullback.test.js
// Unit tests for the EMA trend-pullback strategy — pure functions over
// synthetic bars, no broker access. Bars are hand-built so each test pins
// exactly one gate: clean pullback (long + short), chop, too-deep pullback.
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeEmaPullback, emaSeries } from './ema-pullback.js'
import { atr } from './fib-strategy.js'

const K20 = 2 / 21 // EMA20 smoothing factor, used to pre-compute the final EMA

// Steady trend: closes step by `slope` per bar, highs/lows a half-range
// either side. 80 bars clears the 60-bar minimum with margin.
function trendBars(n, start, slope, range = 1) {
  const bars = []
  for (let i = 0; i < n; i++) {
    const c = start + slope * i
    bars.push({ t: i, o: c - slope, h: c + range / 2, l: c - range / 2, c, v: 1 })
  }
  return bars
}

// Append a final closed bar whose LOW touches EMA20 but whose CLOSE stays on
// the trend side. The EMA depends on the close (not the low), so we can
// pre-compute the final EMA20 from the base series and place the low
// exactly `depth` under it.
function withPullbackBar(base, { dir = 1, depth = 0.3 } = {}) {
  const prevEma20 = emaSeries(base, 20)[base.length - 1]
  const c = base[base.length - 1].c + 0.1 * dir // close keeps drifting with trend
  const ema20 = c * K20 + prevEma20 * (1 - K20) // exact final EMA20
  const bar = dir === 1
    ? { t: base.length, o: c, h: c + 0.5, l: ema20 - depth, c, v: 1 }
    : { t: base.length, o: c, h: ema20 + depth, l: c - 0.5, c, v: 1 }
  return [...base, bar]
}

test('uptrend pullback to EMA20 → long signal with rr 2', () => {
  const bars = withPullbackBar(trendBars(80, 100, 0.5), { dir: 1 })
  const sig = computeEmaPullback(bars, '1h')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'long')
  assert.equal(sig.strategy, 'ema_pullback')
  assert.equal(sig.rr, 2) // tp1 at 2R by construction
  assert.equal(sig.timeframe, '1h')
  assert.equal(sig.time_cap_minutes, null)
  const last = bars[bars.length - 1]
  assert.equal(sig.entry, last.c)
  assert.ok(sig.sl < last.l, 'stop sits below the pullback low')
  assert.ok(sig.tp1 > sig.entry && sig.tp2 > sig.tp1, 'targets stack above entry')
  // 2R / 3R geometry, exact
  const risk = sig.entry - sig.sl
  assert.ok(Math.abs(sig.tp1 - (sig.entry + 2 * risk)) < 1e-9)
  assert.ok(Math.abs(sig.tp2 - (sig.entry + 3 * risk)) < 1e-9)
  // steady uptrend → EMA20 slope bonus applies
  assert.ok(sig.conviction >= 9 && sig.conviction <= 10)
  assert.ok(typeof sig.thesis === 'string' && sig.thesis.includes('Uptrend'))
})

test('downtrend bounce to EMA20 → short signal (mirror)', () => {
  const bars = withPullbackBar(trendBars(80, 200, -0.5), { dir: -1 })
  const sig = computeEmaPullback(bars, '4h')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'short')
  assert.equal(sig.rr, 2)
  const last = bars[bars.length - 1]
  assert.ok(sig.sl > last.h, 'stop sits above the bounce high')
  assert.ok(sig.tp1 < sig.entry && sig.tp2 < sig.tp1, 'targets stack below entry')
})

test('no-trend chop → null (EMA20 not above/below EMA50)', () => {
  // Flat closes: EMA20 === EMA50, so neither strict trend test passes even
  // though the bar wicks through both lines every bar.
  const bars = []
  for (let i = 0; i < 80; i++) {
    bars.push({ t: i, o: 100, h: 101, l: 99, c: 100, v: 1 })
  }
  assert.equal(computeEmaPullback(bars, '1h'), null)
})

test('too-deep pullback (> 2*ATR under EMA20) → null', () => {
  const base = trendBars(80, 100, 0.5)
  const deep = 3 * atr(base, 14) // well past the 2*ATR ceiling
  const bars = withPullbackBar(base, { dir: 1, depth: deep })
  assert.equal(computeEmaPullback(bars, '1h'), null)
})

test('too few bars → null', () => {
  const bars = withPullbackBar(trendBars(55, 100, 0.5), { dir: 1 })
  assert.equal(computeEmaPullback(bars, '1h'), null)
})
