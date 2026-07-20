// Synthetic-bar tests for the RSI mean-reversion strategy. Bars are shaped
// so the last bar is the exact cross bar: base → steep move → flat drift
// (lets Wilder RSI settle) → sharp counter-move (washout) → reversal bar.
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeRsiMeanrev } from './rsi-meanrev.js'

function bar(c, spread = 0.4) {
  return { o: c, h: c + spread, l: c - spread, c, v: 1000 }
}

/**
 * Uptrend + washout + bounce. base flat bars at 100, rise to 170, flat
 * drift (RSI cools toward 50), `down` bars of -`drop` (RSI dives < 30),
 * then one bounce bar of +`bounce` closing near its high (RSI crosses
 * back above 30 while price is still above SMA50).
 */
function longSetup({ down = 6, drop = 3, bounce = 3 } = {}) {
  const bars = []
  let p = 100
  for (let i = 0; i < 20; i++) bars.push(bar(p))
  for (let i = 0; i < 20; i++) { p += 3.5; bars.push(bar(p)) }
  for (let i = 0; i < 20; i++) bars.push(bar(p))
  for (let i = 0; i < down; i++) { p -= drop; bars.push(bar(p)) }
  const c = p + bounce
  bars.push({ o: p, h: c + 0.1, l: p - 0.5, c, v: 1000 }) // closes near high
  return bars
}

/** Exact mirror: downtrend + overbought pop + fade bar closing near its low. */
function shortSetup({ up = 6, pop = 3, fade = 3 } = {}) {
  const bars = []
  let p = 300
  for (let i = 0; i < 20; i++) bars.push(bar(p))
  for (let i = 0; i < 20; i++) { p -= 3.5; bars.push(bar(p)) }
  for (let i = 0; i < 20; i++) bars.push(bar(p))
  for (let i = 0; i < up; i++) { p += pop; bars.push(bar(p)) }
  const c = p - fade
  bars.push({ o: p, h: p + 0.5, l: c - 0.1, c, v: 1000 }) // closes near low
  return bars
}

test('washout bounce in an uptrend fires a long', () => {
  const sig = computeRsiMeanrev(longSetup(), '1h')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'long')
  assert.equal(sig.strategy, 'rsi_meanrev')
  assert.ok(sig.sl < sig.entry, 'stop below entry')
  assert.ok(sig.tp1 > sig.entry, 'tp1 (SMA20 mean) above entry')
  // tp2 must sit past tp1 on the profit side — position management scales
  // out at tp1 and runs the rest to tp2, so it can never be behind entry.
  assert.ok(sig.tp2 > sig.tp1, 'tp2 (stretch target) beyond tp1')
  assert.ok(sig.rr >= 1.5, `rr ${sig.rr} clears the floor`)
  assert.ok(sig.conviction >= 8 && sig.conviction <= 10)
  assert.equal(sig.time_cap_minutes, 240) // 4 bars of 1h
  assert.equal(sig.timeframe, '1h')
  assert.match(sig.thesis, /dip/)
})

test('deeper washout and strong close lift conviction to 10', () => {
  // drop 7x3 pushes the RSI trough under 25 (+1) and the bounce bar closes
  // in its top third (+1): 8 + 2, capped at 10.
  const sig = computeRsiMeanrev(longSetup({ down: 7, drop: 3, bounce: 3 }), '1h')
  assert.ok(sig)
  assert.equal(sig.conviction, 10)
})

test('overbought fade in a downtrend fires a short', () => {
  const sig = computeRsiMeanrev(shortSetup(), '15m')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'short')
  assert.ok(sig.sl > sig.entry, 'stop above entry')
  assert.ok(sig.tp1 < sig.entry, 'tp1 below entry')
  assert.ok(sig.rr >= 1.5)
  assert.equal(sig.time_cap_minutes, 60) // 4 bars of 15m
  assert.match(sig.thesis, /pop/)
})

test('RSI cross without trend alignment returns null', () => {
  // Same washout-bounce pattern but the prior move is DOWN, so price sits
  // below SMA50 — the falling-knife case the trend gate exists to block.
  const bars = []
  let p = 300
  for (let i = 0; i < 20; i++) bars.push(bar(p))
  for (let i = 0; i < 20; i++) { p -= 3.5; bars.push(bar(p)) }
  for (let i = 0; i < 20; i++) bars.push(bar(p))
  for (let i = 0; i < 6; i++) { p -= 3; bars.push(bar(p)) }
  const c = p + 3
  bars.push({ o: p, h: c + 0.1, l: p - 0.5, c, v: 1000 })
  assert.equal(computeRsiMeanrev(bars, '1h'), null)
})

test('rr below 1.5 is rejected', () => {
  // A huge bounce bar eats most of the distance back to SMA20, so the
  // remaining reward no longer covers 1.5x the risk.
  const sig = computeRsiMeanrev(longSetup({ down: 6, drop: 3, bounce: 8 }), '1h')
  assert.equal(sig, null)
})

test('opts.minRr governs the R:R floor (backtest evaluation profile)', () => {
  // This setup produces a signal with rr ≈ 1.52 (just over the live floor).
  const setup = () => longSetup({ down: 6, drop: 3, bounce: 5 })
  const base = computeRsiMeanrev(setup(), '1h', { minRr: 0 })
  assert.ok(base && base.rr >= 1.5 && base.rr < 1.6, `rr ${base?.rr} is the boundary case`)
  // Default floor is 1.5 — the signal survives.
  assert.ok(computeRsiMeanrev(setup(), '1h'), 'default 1.5 floor keeps a 1.52-rr signal')
  // Raising the floor ABOVE the signal's rr rejects it — the gate reads opts.minRr.
  assert.equal(computeRsiMeanrev(setup(), '1h', { minRr: 1.6 }), null, 'floor above rr rejects')
  // The evaluation profile's lower floor keeps it too.
  assert.ok(computeRsiMeanrev(setup(), '1h', { minRr: 1.2 }), 'eval floor 1.2 keeps it')
})

test('needs at least 60 bars', () => {
  assert.equal(computeRsiMeanrev(longSetup().slice(-59), '1h'), null)
})

test('unparseable timeframe gives null time cap, not a crash', () => {
  const sig = computeRsiMeanrev(longSetup(), 'weird-tf')
  assert.ok(sig)
  assert.equal(sig.time_cap_minutes, null)
})
