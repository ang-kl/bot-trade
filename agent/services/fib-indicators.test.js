// node --test agent/services/fib-indicators.test.js
// Unit tests for the confluence-indicator math (vwap, findFVGs) — pure
// functions over synthetic bars, no broker access.
import test from 'node:test'
import assert from 'node:assert/strict'
import { vwap, findFVGs } from './fib-strategy.js'

const bar = (h, l, c, v = 1) => ({ t: 0, o: c, h, l, c, v })

test('vwap volume-weights typical prices from the anchor', () => {
  const bars = [bar(12, 8, 10, 1), bar(22, 18, 20, 3)]
  assert.ok(Math.abs(vwap(bars, 0) - 17.5) < 1e-10) // (10·1 + 20·3)/4
})

test('vwap anchors mid-series (bars before the anchor excluded)', () => {
  const bars = [bar(100, 100, 100, 5), bar(12, 8, 10, 1), bar(22, 18, 20, 1)]
  assert.ok(Math.abs(vwap(bars, 1) - 15) < 1e-10)
})

// CHANGED 2026-07-28. This previously asserted the equal-weight fallback as
// intended behaviour — vwap() returned sumTypical/n when the window carried no
// volume. The volume audit established that this is not a degraded VWAP but a
// different indicator (an SMA of typical price), and because it was non-null
// the confluence filters kept voting on it without ever seeing a bad input.
// The fallback is now null so those filters fail closed. The null-on-empty half
// of the original assertion is unchanged.
test('vwap returns null on zero volume (no VWAP without volume) and on empty', () => {
  assert.equal(vwap([bar(12, 8, 10, 0), bar(22, 18, 20, 0)], 0), null)
  assert.equal(vwap([], 0), null)
  // Still computes normally when volume exists.
  assert.ok(Math.abs(vwap([bar(12, 8, 10, 1), bar(22, 18, 20, 1)], 0) - 15) < 1e-10)
})

test('findFVGs: bullish 3-bar gap with correct zone', () => {
  const bars = [bar(1.10, 1.09, 1.095), bar(1.12, 1.10, 1.115), bar(1.14, 1.11, 1.13)]
  const gaps = findFVGs(bars)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].dir, 'bull')
  assert.equal(gaps[0].bottom, 1.10)
  assert.equal(gaps[0].top, 1.11)
})

test('findFVGs: a later bar trading through the gap fills it', () => {
  const bars = [bar(1.10, 1.09, 1.095), bar(1.12, 1.10, 1.115), bar(1.14, 1.11, 1.13), bar(1.13, 1.095, 1.10)]
  assert.equal(findFVGs(bars).length, 0)
})

test('findFVGs: bearish gap; gapless bars yield none', () => {
  const bear = [bar(1.14, 1.13, 1.135), bar(1.13, 1.11, 1.115), bar(1.12, 1.10, 1.105)]
  const gaps = findFVGs(bear)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].dir, 'bear')
  const flat = [bar(1.1, 1.0, 1.05), bar(1.12, 1.04, 1.08), bar(1.13, 1.07, 1.1)]
  assert.equal(findFVGs(flat).length, 0)
})
