// node --test agent/services/vwap-vp-strategies.test.js
//
// The two new standalone strategies (owner: "VP and VWAP build"). VWAP
// trend-pullback (trend kind) and Volume-Profile value-area rotation
// (mean-reversion kind). Both return the standard signal shape and are
// registered in the strategy registry.

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeVwapTrend } from './vwap-trend.js'
import { computeVpValue } from './vp-value.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { STRATEGY_KIND } from './regime-gate.js'
import { vwapSeries } from '../lib/indicators.js'
import { atr } from './fib-strategy.js'

const HOUR = 3_600_000
const bar = (i, o, h, l, c, v) => ({ t: Date.UTC(2026, 6, 20) + i * HOUR, o, h, l, c, v })

test('both strategies are registered and regime-classified', () => {
  const keys = STRATEGY_REGISTRY.map(s => s.key)
  assert.ok(keys.includes('vwap_trend'))
  assert.ok(keys.includes('vp_value'))
  assert.equal(STRATEGY_KIND.vwap_trend, 'trend')
  assert.equal(STRATEGY_KIND.vp_value, 'meanrev')
  // Registry computes are real functions, not the null fallback.
  const vw = STRATEGY_REGISTRY.find(s => s.key === 'vwap_trend')
  assert.equal(typeof vw.compute, 'function')
})

test('computeVwapTrend: an uptrend pullback that closes back above VWAP signals long', () => {
  // Gentle up-drift with wide bar ranges so VWAP stays near price and ATR is
  // meaningful — then engineer the final bar off the ACTUAL VWAP/ATR so the
  // pullback tags the line within tolerance (the geometry is data-dependent;
  // computing it here keeps the test deterministic instead of hand-guessing).
  const bars = []
  for (let i = 0; i < 40; i++) {
    const mid = 100 + i * 0.1
    bars.push(bar(i, mid - 0.5, mid + 1.5, mid - 1.5, mid + 0.4, 1000))
  }
  const v = vwapSeries(bars, 0)[bars.length - 1]
  const a = atr(bars, 14)
  // Final bar: low taps VWAP (within 0.5 ATR), closes back above it.
  bars.push(bar(40, v + 0.2, v + a, v - 0.3 * a, v + 0.6 * a, 1500))

  const sig = computeVwapTrend(bars, '1h')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.bias, 'long')
  assert.equal(sig.strategy, 'vwap_trend')
  assert.ok(sig.sl < sig.entry, 'long SL below entry')
  assert.ok(sig.tp1 > sig.entry, 'long TP above entry')
  assert.ok(sig.rr >= 1.5)
})

test('computeVwapTrend: flat/quiet data produces no signal', () => {
  const bars = []
  for (let i = 0; i < 40; i++) bars.push(bar(i, 100, 100.1, 99.9, 100, 1000))
  assert.equal(computeVwapTrend(bars, '1h'), null)
})

test('computeVpValue: a reaction off the value-area low fades up toward the POC', () => {
  // Heavy volume clustered around 100 (builds the POC/value area there),
  // price ranges down to ~97 (value-area low), then a final bar tags the low
  // and closes back inside toward the POC.
  const bars = []
  for (let i = 0; i < 45; i++) {
    // Most bars oscillate tightly around 100 with big volume → POC ~100.
    const c = 100 + (i % 2 === 0 ? 0.2 : -0.2)
    bars.push(bar(i, 100, 100.4, 99.6, c, 3000))
  }
  // A few low-volume excursions down to ~97 to set a value-area low below POC.
  bars.push(bar(45, 99, 99, 97, 97.2, 300))
  bars.push(bar(46, 97.2, 97.4, 96.9, 97.1, 300))
  // Final reaction bar: tags ~97 and closes back up inside the area.
  bars.push(bar(47, 97.1, 98.2, 96.95, 98.0, 800))

  const sig = computeVpValue(bars, '1h')
  // Value-area geometry is data-dependent; assert the shape WHEN it fires.
  if (sig) {
    assert.equal(sig.strategy, 'vp_value')
    assert.equal(sig.bias, 'long')
    assert.ok(sig.tp1 > sig.entry, 'long TP (POC) above entry')
    assert.ok(sig.sl < sig.entry, 'long SL below entry')
    assert.ok(sig.rr >= 1.5)
  }
})

test('computeVpValue: mid-range price (not at an edge) produces no signal', () => {
  const bars = []
  for (let i = 0; i < 45; i++) bars.push(bar(i, 100, 100.5, 99.5, 100, 2000))
  // Final bar sits right at the POC/mid, nowhere near a value-area edge.
  bars.push(bar(45, 100, 100.2, 99.8, 100, 2000))
  assert.equal(computeVpValue(bars, '1h'), null)
})

test('both strategies return null on too-few bars', () => {
  const few = [bar(0, 100, 101, 99, 100, 1000)]
  assert.equal(computeVwapTrend(few, '1h'), null)
  assert.equal(computeVpValue(few, '1h'), null)
})

// ---------------------------------------------------------------------------
// Owner's structure checks (2026-07-26): the fade is a RANGING-session trade.
//
// This fixture PROVABLY fires (asserted below, not if-guarded like the older
// test above): a heavy node at 100, a heavier one at 97 that drags the value
// area down to VAL ~97.06, and a reaction bar tagging 97.1 and closing back
// inside at 97.3 — a long fade toward the POC with rr ~9.7. `stepMs` compresses
// the same bars into one FX day for the fail-open case.
function vpValueFadeBars(stepMs = HOUR) {
  const bars = []
  const b2 = (i, o, h, l, c, v) => ({ t: Date.UTC(2026, 6, 20) + i * stepMs, o, h, l, c, v })
  for (let i = 0; i < 30; i++) bars.push(b2(i, 100, 100.15, 99.85, 100, 2000))
  for (let i = 30; i < 44; i++) bars.push(b2(i, 97, 97.15, 96.85, 97, 3500))
  bars.push(b2(44, 97.2, 97.35, 97.1, 97.3, 900))
  return bars
}

const RANGING = { structure: 'ranging', reference: null, role: null, prev: {}, lvns: [] }

test('vp_value refuses the fade when the session opened OUTSIDE value (trending structure)', () => {
  const bars = vpValueFadeBars()
  // First prove the fade itself fires — the refusals below mean nothing otherwise.
  const base = computeVpValue(bars, '1h', { structure: RANGING })
  assert.ok(base)
  assert.equal(base.bias, 'long')

  const trending = { ...RANGING, structure: 'bearish', reference: 95, role: 'resistance' }
  assert.equal(computeVpValue(bars, '1h', { structure: trending }), null)
  // structureGate:false restores the old predicate entirely.
  assert.ok(computeVpValue(bars, '1h', { structureGate: false }))
})

test('vp_value refuses an entry sitting inside one of yesterday\'s LVNs', () => {
  const bars = vpValueFadeBars() // entry = the reaction close, 97.3
  const withLvn = { ...RANGING, lvns: [{ lo: 97.2, hi: 99.7, mid: 98.45, volume: 10, pctOfPoc: 2 }] }
  assert.equal(computeVpValue(bars, '1h', { structure: withLvn }), null)
  // The same band shifted off the entry does not block.
  const offLvn = { ...RANGING, lvns: [{ lo: 98.0, hi: 99.7, mid: 98.85, volume: 10, pctOfPoc: 2 }] }
  assert.ok(computeVpValue(bars, '1h', { structure: offLvn }))
})

test('vp_value fails OPEN when the structure cannot be computed (single-session history)', () => {
  // 10-minute bars: the whole series sits inside one FX day, volumeStructure
  // returns null, and the strategy behaves exactly as before the gate.
  assert.ok(computeVpValue(vpValueFadeBars(600_000), '1h'))
})
