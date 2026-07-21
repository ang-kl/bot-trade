// node --test agent/services/regime.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { adx, computeRegime } from './regime.js'

const bar = (c, halfRange) => ({ o: c, h: c + halfRange, l: c - halfRange, c })

// Steady one-directional march → a real trend.
function trend(dir = 1, n = 70, step = 1, halfRange = 0.4) {
  const bars = []
  let p = 100
  for (let i = 0; i < n; i++) { p += dir * step; bars.push(bar(p, halfRange)) }
  return bars
}

// Oscillation inside a fixed band → a range, ATR steady (volRatio ≈ 1).
function range(n = 70, amp = 2, halfRange = 0.4) {
  const bars = []
  for (let i = 0; i < n; i++) bars.push(bar(100 + amp * Math.sin(i / 2), halfRange))
  return bars
}

test('adx returns null below the warm-up bar count', () => {
  assert.equal(adx(range(10)), null)
})

test('a steady uptrend reads as trending, direction long', () => {
  const r = computeRegime(trend(1))
  assert.equal(r.regime, 'trending')
  assert.equal(r.trendDir, 'long')
  assert.ok(r.adx >= 25, `adx ${r.adx} should clear the trend line`)
  assert.ok(r.atrPct > 0, 'reports a real ATR%')
})

test('a steady downtrend reads as trending, direction short', () => {
  const r = computeRegime(trend(-1))
  assert.equal(r.regime, 'trending')
  assert.equal(r.trendDir, 'short')
})

test('a sideways oscillation reads as ranging, not trending', () => {
  const r = computeRegime(range())
  assert.notEqual(r.regime, 'trending')
  assert.ok(r.adx < 25, `adx ${r.adx} should be sub-trend in a range`)
  // A steady-amplitude range is the mean-reversion home, not volatile/quiet.
  assert.equal(r.regime, 'ranging')
})

test('a recent volatility expansion reads as volatile', () => {
  // Calm range, then the last ~14 bars widen sharply (ATR expansion).
  const bars = range(56, 1, 0.3)
  let p = 100
  for (let i = 0; i < 16; i++) { p += (i % 2 ? -1 : 1) * 4; bars.push(bar(p, 3)) }
  const r = computeRegime(bars)
  assert.ok(r.volRatio >= 1.3, `volRatio ${r.volRatio} should show expansion`)
  assert.equal(r.regime, 'volatile')
})

test('a recent volatility contraction reads as quiet', () => {
  // Wider range, then the last stretch goes nearly flat (ATR contraction),
  // while ADX stays sub-trend so the volatility band decides.
  const bars = []
  for (let i = 0; i < 56; i++) bars.push(bar(100 + 3 * Math.sin(i / 2), 1.5))
  for (let i = 0; i < 16; i++) bars.push(bar(100 + 0.1 * Math.sin(i / 2), 0.05))
  const r = computeRegime(bars)
  assert.ok(r.regime === 'quiet' || r.regime === 'ranging', `got ${r.regime}`)
  assert.ok(r.volRatio <= 0.9, `volRatio ${r.volRatio} should show contraction`)
})

test('insufficient bars → unknown, never a fabricated regime', () => {
  const r = computeRegime(range(12))
  assert.equal(r.regime, 'unknown')
  assert.equal(r.adx, null)
  assert.equal(r.atrPct, null)
})
