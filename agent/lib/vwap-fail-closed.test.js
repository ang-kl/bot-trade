// VWAP without volume must be NO ANSWER, not a different answer.
//
// Found in the 2026-07-28 volume audit. All three VWAP implementations fell
// back to the bar's own typical price when the window carried no volume, on the
// reasoning that a drawable line beats a NaN. For a chart overlay that is fine.
// For an indicator that GATES LIVE ENTRIES it is the worst possible failure
// mode, because the fallback is not a degraded VWAP — it is a different line
// that tracks price exactly, and it is non-null, so every caller keeps voting.
//
// The sharpest consequence, and the reason these tests exist:
//
//   vwap_trend's long gate is `bar.c > v && v > vPrev && bar.l <= v`.
//   With v = (h+l+c)/3, `bar.l <= v` is ALWAYS TRUE — a bar's low is always at
//   or below the mean of its own high, low and close. So on missing volume the
//   strategy does not go quiet. It fires MORE.
//
// These tests pin the arithmetic of that claim, not just the new return value,
// because the claim is what justifies the change.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { vwapSeries, vwapAnchored } from './indicators.js'
import { vwap } from '../services/fib-strategy.js'
import { computeVwapTrend } from '../services/vwap-trend.js'

const bar = (o, h, l, c, v, t = 0) => ({ o, h, l, c, v, t })

test('with volume, VWAP is the volume-weighted mean — unchanged behaviour', () => {
  const bars = [bar(1, 2, 1, 1.5, 10, 0), bar(1.5, 3, 1.5, 2, 30, 60_000)]
  const s = vwapSeries(bars)
  const tp0 = (2 + 1 + 1.5) / 3
  const tp1 = (3 + 1.5 + 2) / 3
  assert.equal(s[0], tp0)
  assert.ok(Math.abs(s[1] - (tp0 * 10 + tp1 * 30) / 40) < 1e-12)
})

test('vwapSeries returns null — not typical price — when the window has no volume', () => {
  const bars = [bar(1, 2, 1, 1.5, 0, 0), bar(1.5, 3, 1.5, 2, 0, 60_000)]
  assert.deepEqual(vwapSeries(bars), [null, null])
})

test('vwapAnchored returns null when the window has no volume', () => {
  const bars = [bar(1, 2, 1, 1.5, 0, 0), bar(1.5, 3, 1.5, 2, 0, 60_000)]
  assert.deepEqual(vwapAnchored(bars, 86_400_000), [null, null])
})

test('fib-strategy vwap() returns null instead of an unweighted mean', () => {
  const bars = [bar(1, 2, 1, 1.5, 0), bar(1.5, 3, 1.5, 2, 0)]
  assert.equal(vwap(bars), null, 'the old fallback returned sumTypical/n — an SMA wearing VWAP’s name')
  // Sanity: with volume it still computes.
  assert.ok(typeof vwap([bar(1, 2, 1, 1.5, 5), bar(1.5, 3, 1.5, 2, 5)]) === 'number')
})

test('THE INVERSION: the old fallback made vwap_trend’s pullback test always true', () => {
  // This is the arithmetic that justifies the whole change, asserted directly.
  // If vwap were the bar's own typical price, `bar.l <= vwap` could never fail.
  for (const b of [bar(1, 2, 0.5, 1.5, 0), bar(10, 11, 9, 10.5, 0), bar(-1, 5, -3, 0, 0)]) {
    const typical = (b.h + b.l + b.c) / 3
    assert.ok(b.l <= typical, `low ${b.l} must be <= typical ${typical} — that is why the gate could not fail`)
  }
})

test('vwap_trend produces no signal when volume is absent', () => {
  // A rising, pulling-back series that WOULD be an attractive setup — except
  // there is no volume, so there is no VWAP, so there is no trade.
  const bars = []
  for (let i = 0; i < 80; i++) {
    const base = 100 + i * 0.1
    bars.push(bar(base, base + 0.5, base - 0.4, base + 0.2, 0, i * 900_000))
  }
  assert.equal(computeVwapTrend(bars, '15m'), null)
})

test('a mixed window still computes — only a fully volume-less window is null', () => {
  // Zero-volume bars inside an otherwise real window must not poison it; they
  // simply contribute nothing to the weighting.
  const bars = [bar(1, 2, 1, 1.5, 0, 0), bar(1.5, 3, 1.5, 2, 40, 60_000)]
  const s = vwapSeries(bars)
  assert.equal(s[0], null, 'no volume yet at index 0')
  assert.ok(typeof s[1] === 'number', 'volume arrived, so a VWAP exists from there on')
})
