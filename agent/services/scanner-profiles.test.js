import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeDefaultCompatible, nativeProfileHash, NATIVE_DEFAULT_STRATEGIES } from './scanner-profiles.js'
import { computeFvgSignal } from './fvg-strategy.js'
import { compareSignals } from './scanner-comparison.js'

test('default native coverage refuses option changes that alter reference semantics', () => {
  for (const strategy of NATIVE_DEFAULT_STRATEGIES) {
    assert.match(nativeProfileHash(strategy), /^[a-f0-9]{64}$/)
    assert.equal(nativeDefaultCompatible(strategy, {}, computeFvgSignal.nativeDefaults), true, strategy)
  }
  for (const [strategy, options] of [
    ['cup_handle', { vwapFilter: true }], ['inv_cup_handle', { vwapFilter: true }],
    ['ema_pullback', { pendingSetup: true }], ['ema_pullback', { requireStack: false }],
    ['ema_pullback', { requireStack: null }], ['ema_pullback', { minSlAtr: null }],
    ['ema_pullback', { minSlAtr: 1 }], ['ema_pullback', { maxSlAtr: 4 }],
    ['ema_pullback', { timeCapBars: 4, timeframeMinutes: 60 }], ['rsi_meanrev', { minRr: 1.2 }],
    ['vp_value', { vpType: 'session' }], ['vp_value', { structureGate: false }],
    ['vp_value', { structure: {} }], ['va_breakout', { structure: {} }],
    ['fvg_retrace', { maxAgeBars: null }], ['fvg_retrace', { maxAgeBars: 41 }],
  ]) assert.equal(nativeDefaultCompatible(strategy, options, computeFvgSignal.nativeDefaults), false, `${strategy}/${JSON.stringify(options)}`)
  assert.equal(nativeDefaultCompatible('fvg_retrace', {}, { ...computeFvgSignal.nativeDefaults, minGapAtr: 0.5 }), false)
  assert.equal(nativeDefaultCompatible('fvg_retrace', {}), false)
  assert.equal(nativeDefaultCompatible('not_a_strategy'), false)
})

test('native comparisons include nested pattern provenance and stop treatment', () => {
  const reference = { cup: { leftRim: 12, shape: 'cup' }, fvg: { originBarTime: 123, heightAtr: 0.75 }, stack_confirmed: true }
  const fields = Object.keys(reference)
  assert.deepEqual(compareSignals(reference, structuredClone(reference), fields), [])
  assert.deepEqual(compareSignals(reference, { ...reference, fvg: { ...reference.fvg, originBarTime: 124 } }, fields), ['fvg'])
  assert.deepEqual(compareSignals(reference, { ...reference, cup: { leftRim: 12 } }, fields), ['cup'])
  assert.deepEqual(compareSignals(reference, { ...reference, stack_confirmed: false }, fields), ['stack_confirmed'])
  assert.deepEqual(compareSignals(reference, { ...reference, cup: { ...reference.cup, leftRim: NaN } }, fields), ['cup'])
})
