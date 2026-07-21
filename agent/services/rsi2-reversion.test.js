// node --test agent/services/rsi2-reversion.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeRsi2 } from './rsi2-reversion.js'
import { minRrFor, STRATEGY_MIN_RR } from './strategies.js'

const bar = (c, hw = 0.4) => ({ o: c, h: c + hw, l: c - hw, c })

// A long-term uptrend (price ends well above its 100-bar mean), then a sharp
// 2-bar washout that collapses RSI(2) without dropping below the trend.
function uptrendWashout(n = 120, step = 1, drop = 5) {
  const bars = []
  let p = 100
  for (let i = 0; i < n; i++) { p += step; bars.push(bar(p)) }
  bars.push(bar(p - drop))
  bars.push(bar(p - 2 * drop)) // two down closes → RSI(2) → ~0
  return bars
}

function downtrendSpike(n = 120, step = 1, pop = 5) {
  const bars = []
  let p = 300
  for (let i = 0; i < n; i++) { p -= step; bars.push(bar(p)) }
  bars.push(bar(p + pop))
  bars.push(bar(p + 2 * pop))
  return bars
}

test('oversold washout in an uptrend fires a long with ~1.2R geometry', () => {
  const sig = computeRsi2(uptrendWashout(), '1h')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'long')
  assert.equal(sig.strategy, 'rsi2_reversion')
  assert.ok(sig.sl < sig.entry, 'stop below entry')
  assert.ok(sig.tp1 > sig.entry, 'target above entry')
  assert.ok(sig.rr >= 1.1 && sig.rr <= 1.3, `rr ${sig.rr} ≈ 1.2 by construction`)
  assert.ok(sig.conviction >= 8 && sig.conviction <= 10)
  assert.equal(sig.time_cap_minutes, 300) // 5 bars of 1h
})

test('overbought spike in a downtrend fires a short', () => {
  const sig = computeRsi2(downtrendSpike(), '4h')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'short')
  assert.ok(sig.sl > sig.entry, 'stop above entry')
  assert.ok(sig.tp1 < sig.entry, 'target below entry')
  assert.equal(sig.time_cap_minutes, 1200) // 5 bars of 4h
})

test('refuses low timeframes below the 1h floor (the baked-in lesson)', () => {
  // The exact washout that fires on 1h is REJECTED on 5m-30m, where the
  // 2026-07-21 backtest showed RSI-2 bleeds on spread/noise.
  for (const tf of ['5m', '10m', '15m', '30m']) {
    assert.equal(computeRsi2(uptrendWashout(), tf), null, `${tf} must be refused`)
  }
  assert.ok(computeRsi2(uptrendWashout(), '1h'), '1h still fires')
  assert.ok(computeRsi2(uptrendWashout(), '4h'), '4h still fires')
})

test('no signal when RSI(2) is not extreme', () => {
  // Steady uptrend, no washout on the last bars → RSI(2) high, not oversold.
  const bars = []
  let p = 100
  for (let i = 0; i < 120; i++) { p += 1; bars.push(bar(p)) }
  assert.equal(computeRsi2(bars, '1h'), null)
})

test('no long when the wash-out also breaks the trend (price below SMA100)', () => {
  // Short history that dumps below its own mean — Connors requires the dip to
  // stay ABOVE the longer trend; a break below is a falling knife, not a fade.
  const bars = []
  let p = 200
  for (let i = 0; i < 100; i++) { p -= 1; bars.push(bar(p)) } // falling into the entry
  bars.push(bar(p - 5)); bars.push(bar(p - 10))
  const sig = computeRsi2(bars, '1h')
  // Either no signal, or a SHORT — never a long into a downtrend.
  if (sig) assert.equal(sig.bias, 'short')
})

test('needs the full trend-filter warm-up', () => {
  assert.equal(computeRsi2(uptrendWashout().slice(-50), '1h'), null)
})

test('unparseable timeframe gives a null time cap, not a crash', () => {
  const sig = computeRsi2(uptrendWashout(), 'weird')
  assert.ok(sig)
  assert.equal(sig.time_cap_minutes, null)
})

test('per-strategy R:R floor: rsi2 is 1.0, others fall back to the caller default', () => {
  assert.equal(STRATEGY_MIN_RR.rsi2_reversion, 1.0)
  assert.equal(minRrFor('rsi2_reversion', 1.5), 1.0)
  assert.equal(minRrFor('fib_618_fade', 1.5), 1.5)
  assert.equal(minRrFor('unknown_key', 1.2), 1.2)
})
