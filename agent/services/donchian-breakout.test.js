// Synthetic-bar tests for the Donchian 20-bar range breakout.
// Bars are built by hand so each gate (range height, overshoot, volume)
// can be flipped on and off independently.

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeDonchianBreakout } from './donchian-breakout.js'

const bar = (c, { spread = 0.5, v = 1000, h, l } = {}) => ({
  o: c, h: h ?? c + spread, l: l ?? c - spread, c, v,
})

// A slow triangle wave between lo and hi: small per-bar true range (low ATR)
// while the 20-bar channel spans the full lo..hi height.
function rangeBars(n, lo, hi, { v = 1000 } = {}) {
  const bars = []
  const half = hi - lo
  for (let i = 0; i < n; i++) {
    const phase = i % 12
    const frac = phase <= 6 ? phase / 6 : (12 - phase) / 6
    bars.push(bar(lo + frac * half, { v }))
  }
  return bars
}

// 45 bars ranging 100..110 (range ~10, ATR ~2), then one breakout bar.
function longSetup(breakoutBar) {
  const bars = rangeBars(45, 100, 110)
  bars.push(breakoutBar)
  return bars
}
// Mirror image for shorts: same range, breakout below.
function shortSetup(breakoutBar) {
  const bars = rangeBars(45, 100, 110)
  bars.push(breakoutBar)
  return bars
}

test('clean breakout long: close just above the channel on volume', () => {
  const sig = computeDonchianBreakout(longSetup(bar(111.5, { h: 111.7, l: 109.5, v: 2000 })), '1h')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'long')
  assert.equal(sig.strategy, 'donchian_breakout')
  assert.equal(sig.entry, 111.5)
  assert.ok(sig.sl < sig.entry, 'long stop below entry')
  assert.ok(sig.tp1 > sig.entry && sig.tp2 > sig.tp1, 'targets stacked above')
  assert.ok(sig.rr >= 1.5, `rr ${sig.rr} >= 1.5`)
  assert.ok(sig.conviction >= 8 && sig.conviction <= 10)
  assert.equal(sig.time_cap_minutes, null)
  assert.equal(sig.timeframe, '1h')
  console.log('long signal:', JSON.stringify(sig))
})

test('clean breakout short: close just below the channel on volume', () => {
  const sig = computeDonchianBreakout(shortSetup(bar(98.5, { h: 100.5, l: 98.3, v: 2000 })), '1h')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'short')
  assert.ok(sig.sl > sig.entry, 'short stop above entry')
  assert.ok(sig.tp1 < sig.entry && sig.tp2 < sig.tp1, 'targets stacked below')
  assert.ok(sig.rr >= 1.5)
  console.log('short signal:', JSON.stringify(sig))
})

test('micro-range rejection: channel height under 2x ATR is noise', () => {
  // Flat closes, wide bars: range ~1.4 while ATR ~2 → range < 2×ATR.
  const bars = []
  for (let i = 0; i < 45; i++) bars.push(bar(100 + (i % 3) * 0.2, { spread: 1 }))
  bars.push(bar(102, { h: 102.2, l: 99.8, v: 5000 })) // breaks out, still rejected
  assert.equal(computeDonchianBreakout(bars, '1h'), null)
})

test('exhausted-breakout rejection: close too far beyond the band', () => {
  // Overshoot ~8 points >> 1×ATR — the move already ran, do not chase.
  const sig = computeDonchianBreakout(longSetup(bar(118, { h: 118.3, l: 109.5, v: 2000 })), '1h')
  assert.equal(sig, null)
})

test('low-volume rejection: breakout without participation', () => {
  // Same clean breakout bar as the long case but volume = the prior average.
  const sig = computeDonchianBreakout(longSetup(bar(111.5, { h: 111.7, l: 109.5, v: 1000 })), '1h')
  assert.equal(sig, null)
})

test('needs at least 40 bars', () => {
  const bars = rangeBars(30, 100, 110)
  bars.push(bar(111.5, { v: 2000 }))
  assert.equal(computeDonchianBreakout(bars, '1h'), null)
})

// Claude · № 14,745 15-Oct (owner order § 14,741·A PR-1; claude-builder): the
// strategy states its premise as a price the monitor reads, strictly between
// the stop and the entry (lib/premise.js). Expected outcome from the trader's
// method (§ 14,740·A) and the monitor's own parser; not self-derived.
import { premiseTrigger as _premiseTrigger } from '../lib/premise.js'
import { _internal as _pm } from './position-manager.js'
function assertPremise(sig, level = null) {
  assert.ok(sig && sig.invalidation, `premise present: ${JSON.stringify(sig?.invalidation)} (${sig?.invalidation_reason})`)
  const { op, price } = sig.invalidation
  if (sig.bias === 'long') { assert.equal(op, '<'); assert.ok(sig.sl < price && price < sig.entry, `${sig.sl} < ${price} < ${sig.entry}`) }
  else { assert.equal(op, '>'); assert.ok(sig.entry < price && price < sig.sl, `${sig.entry} < ${price} < ${sig.sl}`) }
  if (level != null) assert.ok(Math.abs(price - level) < 1e-6, `level ${price} is ${level}`)
  const t = _premiseTrigger(sig.invalidation)
  const parsed = _pm.parsePriceTrigger(t)
  assert.ok(parsed, `monitor reads ${t}`)
  assert.equal(parsed.fired(sig.bias === 'long' ? price - 1e-9 : price + 1e-9), true)
  assert.equal(parsed.fired(sig.entry), false, 'not fired at entry')
}

test('premise (long: back inside the 20-bar range) is a price between the stop and the entry, readable by the monitor', () => {
  assertPremise(computeDonchianBreakout(longSetup(bar(111.5, { h: 111.7, l: 109.5, v: 2000 })), '1h'))
})

test('premise (short: back inside the 20-bar range) is a price between the stop and the entry, readable by the monitor', () => {
  assertPremise(computeDonchianBreakout(shortSetup(bar(98.5, { h: 100.5, l: 98.3, v: 2000 })), '1h'))
})
