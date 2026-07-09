// node --test agent/services/cup-handle.test.js
// Synthetic-bar tests for the Cup & Handle detector and the screener.

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCupHandleSignal, screenBars, sma } from './cup-handle.js'

const HOUR = 3_600_000
const bar = (i, o, h, l, c, v) => ({ t: i * HOUR, o, h, l, c, v })

/**
 * Build a textbook cup & handle ending in a volume breakout:
 * long uptrend (SMA support) → left rim → rounded sell-off → flat bottom →
 * recovery → tight shallow handle → breakout bar.
 */
function cupHandleBars() {
  const bars = []
  let i = 0
  let p = 50
  // 185 bars of gentle uptrend to 100 — keeps price above all SMAs and
  // leaves >=210 total bars so SMA200 exists at the breakout.
  for (; i < 185; i++) { p += 50 / 185; bars.push(bar(i, p - 0.1, p + 0.3, p - 0.4, p, 1000)) }
  // decline to 88 over 12 bars, volume high early
  for (let k = 0; k < 12; k++, i++) { p -= 1; bars.push(bar(i, p + 1, p + 1.2, p - 0.3, p, 1600 - k * 60)) }
  // rounded bottom: 8 bars flat at ~88, dry volume
  for (let k = 0; k < 8; k++, i++) { bars.push(bar(i, p, p + 0.4, p - 0.25, p + 0.1, 500)) }
  // recovery to ~100 over 12 bars, volume rebuilding
  for (let k = 0; k < 12; k++, i++) { p += 1; bars.push(bar(i, p - 1, p + 0.4, p - 1.1, p, 1200 + k * 40)) }
  // tight handle: 5 bars drifting to ~97.5, low volume
  for (let k = 0; k < 5; k++, i++) { const hp = p - 0.5 * (k + 1) / 2; bars.push(bar(i, hp + 0.2, hp + 0.5, hp - 0.3, hp, 600)) }
  // breakout bar: closes above rim + prior-2 highs on 2× handle volume
  bars.push(bar(i, p - 1, p + 2.2, p - 1.2, p + 2, 1400))
  return bars
}

test('detects a textbook cup & handle breakout', () => {
  const sig = computeCupHandleSignal(cupHandleBars(), '1d')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.strategy, 'cup_handle')
  assert.equal(sig.bias, 'long')
  assert.ok(sig.conviction >= 8, `conviction ${sig.conviction} should reach the autotrade bar`)
  assert.ok(sig.rr >= 1.5)
  assert.ok(sig.tp1 > sig.entry && sig.sl < sig.entry)
})

test('no signal without a breakout bar (handle still forming)', () => {
  const bars = cupHandleBars()
  bars.pop() // remove the breakout
  assert.equal(computeCupHandleSignal(bars, '1d'), null)
})

test('no signal in a downtrend (below SMAs)', () => {
  const bars = []
  let p = 200
  for (let i = 0; i < 260; i++) { p -= 0.3; bars.push(bar(i, p + 0.3, p + 0.5, p - 0.2, p, 1000)) }
  assert.equal(computeCupHandleSignal(bars, '1d'), null)
})

test('too few bars → null (SMA200 undefined)', () => {
  assert.equal(computeCupHandleSignal(cupHandleBars().slice(-100), '1d'), null)
})

test('sma helper', () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ c: i + 1 }))
  assert.equal(sma(bars, 20), 10.5)
  assert.equal(sma(bars, 21), null)
})

test('screenBars: passes a strong uptrend, fails the checks it should', () => {
  const good = cupHandleBars()
  const res = screenBars(good, { minPrice: 20 })
  assert.equal(res.pass, true)
  assert.ok(res.relVol > 1)

  const cheap = screenBars(good, { minPrice: 1000 })
  assert.equal(cheap.pass, false)
  assert.match(cheap.checks.find(c => !c.ok).text, /price/)

  const short = screenBars(good.slice(-50), {})
  assert.equal(short.pass, false)
})
