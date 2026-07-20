// node --test agent/services/fib-class-tuning.test.js
//
// Instrument-class SL/TP tuning (owner: "do you think current TP/SL for
// commodities and INDICES make sense... tweaking should be dynamic based on
// type of trade"). Before this, computeFibSignal used ONE fixed leg-size
// floor / SL buffer / TP2 extension for every symbol. tuningFor() now maps
// each instrument class to its own set, and computeFibSignal actually uses
// whatever opts.classTuning it's handed (defaulting to the original
// FX-tuned numbers when none is passed, so every pre-existing caller and
// test is unaffected).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeFibSignal, atr, tuningFor, CLASS_TUNING, DEFAULT_TUNING } from './fib-strategy.js'

const HOUR = 3_600_000

// Same decline-then-rally shape as fib-strategy-pending.test.js's fixture,
// but the retrace tail lands INSIDE the 61.8% zone so normal (non-pending)
// mode fires without needing pendingSetup — this test cares about the
// signal's sl/tp2 shape, not the pending-mode branch.
function buildInZoneBars() {
  const bars = []
  const t0 = Date.UTC(2026, 0, 5)
  const push = (i, p) => bars.push({
    t: t0 + i * HOUR, o: p + 0.1, h: p + 0.3, l: p - 0.4, c: p, v: 100,
  })
  for (let i = 0; i <= 15; i++) push(i, 96.4 - 0.4 * i + 0.4)   // decline into the low
  bars[15] = { ...bars[15], l: 90, c: 90.4 }                     // swing low anchor
  for (let i = 16; i <= 30; i++) push(i, 90 + (20 / 15) * (i - 15)) // rally to the high
  for (let i = 31; i <= 39; i++) push(i, 110 - 1.373 * (i - 30))   // retrace INTO the 61.8% zone
  return bars
}

test('tuningFor: FX/metal keep the original numbers; other classes get their own', () => {
  assert.equal(tuningFor('EURUSD'), DEFAULT_TUNING)
  assert.equal(tuningFor('XAUUSD'), DEFAULT_TUNING)
  assert.deepEqual(tuningFor('JPN225'), CLASS_TUNING.index)
  assert.deepEqual(tuningFor('NATGAS'), CLASS_TUNING.commodity)
  assert.deepEqual(tuningFor('COCOA'), CLASS_TUNING.soft)
  assert.deepEqual(tuningFor('CORN'), CLASS_TUNING.grain)
  assert.deepEqual(tuningFor('BTCUSD'), CLASS_TUNING.crypto)
  // Every class's leg floor/buffer/extension is >= the FX baseline — this
  // tuning only ever widens tolerance for gappier instruments, never
  // tightens it below what FX/metal already use.
  for (const t of Object.values(CLASS_TUNING)) {
    assert.ok(t.minLegAtrMult >= DEFAULT_TUNING.minLegAtrMult)
    assert.ok(t.slBuffer >= DEFAULT_TUNING.slBuffer)
    assert.ok(t.tp2Extension >= DEFAULT_TUNING.tp2Extension)
  }
})

test('computeFibSignal: no classTuning passed = identical to the original hardcoded behaviour', () => {
  const bars = buildInZoneBars()
  const signal = computeFibSignal(bars, '1h', {})
  assert.ok(signal, 'in-zone leg produces a signal with no classTuning override')
  assert.equal(signal.bias, 'long')
})

test('computeFibSignal: a wider class buffer moves the SL further from entry, same leg', () => {
  const bars = buildInZoneBars()
  const range = 20.3
  assert.ok(range > CLASS_TUNING.index.minLegAtrMult * atr(bars), 'leg clears even the widest class floor')

  const fxSignal = computeFibSignal(bars, '1h', { classTuning: DEFAULT_TUNING })
  const indexSignal = computeFibSignal(bars, '1h', { classTuning: CLASS_TUNING.index })
  assert.ok(fxSignal && indexSignal)

  // Long fade: SL sits below swingA — a wider buffer pushes it FURTHER down.
  assert.ok(indexSignal.sl < fxSignal.sl, 'index tuning (wider SL buffer) sits further from swingA than FX tuning')
  const fxBufferDist = fxSignal.swingA - fxSignal.sl
  const indexBufferDist = indexSignal.swingA - indexSignal.sl
  assert.ok(Math.abs(indexBufferDist / fxBufferDist - CLASS_TUNING.index.slBuffer / DEFAULT_TUNING.slBuffer) < 1e-6)
})

test('computeFibSignal: a wider TP2 extension pushes TP2 further beyond the swing end', () => {
  const bars = buildInZoneBars()
  const fxSignal = computeFibSignal(bars, '1h', { classTuning: DEFAULT_TUNING })
  const commoditySignal = computeFibSignal(bars, '1h', { classTuning: CLASS_TUNING.commodity })
  assert.ok(fxSignal && commoditySignal)
  // Long fade: TP2 sits above swingB — wider extension pushes it FURTHER up.
  assert.ok(commoditySignal.tp2 > fxSignal.tp2, 'commodity tuning (wider TP2 extension) reaches further than FX tuning')
})

test('computeFibSignal: a taller minLegAtrMult rejects a leg the default tuning accepts', () => {
  // Same in-zone fixture, but with an inflated minLegAtrMult that the leg
  // can't clear — proves the leg-size floor itself reads from classTuning,
  // not just the downstream SL/TP shape covered by the tests above.
  const bars = buildInZoneBars()
  const impossiblyStrict = { ...DEFAULT_TUNING, minLegAtrMult: 1000 }
  assert.ok(computeFibSignal(bars, '1h', { classTuning: DEFAULT_TUNING }), 'default tuning accepts this leg')
  assert.equal(computeFibSignal(bars, '1h', { classTuning: impossiblyStrict }), null, 'a strict enough floor rejects the same leg')
})
