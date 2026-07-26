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
// either side. 460 bars clears the 450-bar minimum (EMA200 seed decay) with
// margin.
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
  const bars = withPullbackBar(trendBars(460, 100, 0.15), { dir: 1 })
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
  const bars = withPullbackBar(trendBars(460, 200, -0.15), { dir: -1 })
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
  const base = trendBars(460, 100, 0.15)
  const deep = 3 * atr(base, 14) // well past the 2*ATR ceiling
  const bars = withPullbackBar(base, { dir: 1, depth: deep })
  assert.equal(computeEmaPullback(bars, '1h'), null)
})

test('too few bars → null', () => {
  const bars = withPullbackBar(trendBars(55, 100, 0.5), { dir: 1 })
  assert.equal(computeEmaPullback(bars, '1h'), null)
})

test('MIN_BARS is 450, not the old 200 — a 200-bar EMA200 still carries ~13.5% seed bias', () => {
  // withPullbackBar appends one bar, so base=448/449 -> 449/450 total.
  // 449 clears the OLD 200-bar minimum with room to spare but must still
  // refuse, now that the regime filter is the slower EMA200.
  const short = withPullbackBar(trendBars(448, 100, 0.15), { dir: 1 })
  assert.equal(short.length, 449)
  assert.equal(computeEmaPullback(short, '1h'), null, '449 bars must still refuse')
  const long = withPullbackBar(trendBars(449, 100, 0.15), { dir: 1 })
  assert.equal(long.length, 450)
  assert.ok(computeEmaPullback(long, '1h'), '450 bars must fire')
})

// --- New guards (2026-07 stop-integrity revision) --------------------------

test('stop wider than the ATR ceiling → veto, never tightened', () => {
  // A trend steep enough that even the dip low sits > 3*ATR under the close.
  const bars = withPullbackBar(trendBars(460, 100, 0.5), { dir: 1 })
  assert.equal(computeEmaPullback(bars, '1h'), null)
})

test('sub-noise structural stop is widened to the ATR floor', () => {
  const bars = withPullbackBar(trendBars(460, 100, 0.02), { dir: 1, depth: 0.01 })
  const sig = computeEmaPullback(bars, '1h')
  assert.ok(sig, 'expected a signal')
  const a = atr(bars, 14)
  assert.ok(Math.abs((sig.entry - sig.sl) / a - 0.8) < 1e-6, 'stop pinned to the 0.8*ATR floor')
  assert.equal(sig.sl_widened_to_floor, true)
})

test('EMA200 stack filter blocks a 20/50 cross that 200 has not confirmed', () => {
  // Long downtrend, then a sharp rally: EMA20 crosses above EMA50 while
  // EMA200 is still overhead. requireStack must veto; requireStack:false must not.
  const base = trendBars(460, 200, -0.15)
  let bars = [...base]
  for (let i = 0; i < 25; i++) {
    const c = bars[bars.length - 1].c + 0.6
    bars.push({ t: bars.length, o: c - 0.6, h: c + 0.5, l: c - 0.5, c, v: 1 })
  }
  bars = withPullbackBar(bars, { dir: 1 })
  const e20 = emaSeries(bars, 20).at(-1)
  const e50 = emaSeries(bars, 50).at(-1)
  const e200 = emaSeries(bars, 200).at(-1)
  assert.ok(e20 > e50 && e50 < e200, 'fixture: 20>50 but 50 still below 200')
  assert.equal(computeEmaPullback(bars, '1h'), null, 'stack filter vetoes')
})

test('pendingSetup parks the entry at EMA20, above the market', () => {
  const bars = trendBars(460, 100, 0.15)
  const sig = computeEmaPullback(bars, '1h', { pendingSetup: true })
  assert.ok(sig, 'expected a pending setup')
  assert.equal(sig.bias, 'long')
  const e20 = emaSeries(bars, 20).at(-1)
  assert.ok(Math.abs(sig.entry - e20) < 1e-9, 'entry sits exactly on EMA20')
  assert.ok(sig.entry < bars.at(-1).c, 'limit price is better than the close')
  assert.equal(sig.conviction, 8, 'pending setups take the base score only')
  assert.equal(sig.rr, 2)
})

test('time cap is opt-in and derived from bars x timeframe minutes', () => {
  const bars = withPullbackBar(trendBars(460, 100, 0.15), { dir: 1 })
  assert.equal(computeEmaPullback(bars, '1h').time_cap_minutes, null)
  const capped = computeEmaPullback(bars, '1h', { timeCapBars: 24, timeframeMinutes: 60 })
  assert.equal(capped.time_cap_minutes, 1440)
})

test('thesis still matches the label-backfill signature', () => {
  const bars = withPullbackBar(trendBars(460, 100, 0.15), { dir: 1 })
  assert.match(computeEmaPullback(bars, '1h').thesis, /EMA20 (above|below) EMA50/)
})
