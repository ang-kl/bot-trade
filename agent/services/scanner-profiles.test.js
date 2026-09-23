import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeDefaultCompatible, nativeOptionsFor, nativeProfileHash, NATIVE_DEFAULT_STRATEGIES } from './scanner-profiles.js'
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

test('EMA observation profiles bind every effective option and reject malformed settings', () => {
  assert.deepEqual(nativeOptionsFor('ema_pullback'), {})
  const options = nativeOptionsFor('ema_pullback', { pendingSetup: true, timeCapBars: 4, timeframeMinutes: 60 })
  assert.deepEqual(options, { pendingSetup: true, requireStack: true, minSlAtr: 0.8, maxSlAtr: 3, timeCapMinutes: 240 })
  const original = nativeProfileHash('ema_pullback', options)
  assert.notEqual(original, nativeProfileHash('ema_pullback'))
  for (const change of [{ pendingSetup: false }, { requireStack: false }, { minSlAtr: 1 }, { maxSlAtr: 4 }, { timeCapMinutes: null }])
    assert.notEqual(nativeProfileHash('ema_pullback', { ...options, ...change }), original)
  assert.equal(nativeProfileHash('ema_pullback', { ...options, minSlAtr: -0 }), nativeProfileHash('ema_pullback', { ...options, minSlAtr: 0 }))
  for (const change of [{ pendingSetup: 'true' }, { requireStack: null }, { minSlAtr: null }, { maxSlAtr: Infinity },
    { minSlAtr: -1 }, { timeCapBars: '4', timeframeMinutes: 60 }, { timeCapBars: 1e16, timeframeMinutes: 60 }])
    assert.equal(nativeOptionsFor('ema_pullback', { pendingSetup: true, ...change }), null)
  for (const bad of [null, [], { ...options, extra: 1 }, { ...options, timeCapMinutes: NaN }, { ...options, pendingSetup: 1 }])
    assert.equal(nativeProfileHash('ema_pullback', bad), null)
  assert.equal(nativeProfileHash('rsi_meanrev', options), null)
  assert.deepEqual(nativeOptionsFor('rsi_meanrev', { minRr: 1 }), { minRr: 1 })
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


test('RSI observation profiles bind the reference floor without changing defaults', () => {
  for (const minRr of [undefined, null, 1.5]) assert.deepEqual(nativeOptionsFor('rsi_meanrev', { minRr }), {})
  const hashes = new Set()
  for (const minRr of [0, 0.1, 1, 1.51, Number.MAX_SAFE_INTEGER]) {
    const options = nativeOptionsFor('rsi_meanrev', { minRr })
    assert.deepEqual(options, { minRr })
    const hash = nativeProfileHash('rsi_meanrev', options)
    assert.match(hash, /^[a-f0-9]{64}$/)
    assert.notEqual(hash, nativeProfileHash('rsi_meanrev'))
    hashes.add(hash)
  }
  assert.equal(hashes.size, 5)
  assert.equal(nativeProfileHash('rsi_meanrev', { minRr: -0 }), nativeProfileHash('rsi_meanrev', { minRr: 0 }))
  for (const minRr of ['1', false, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(nativeOptionsFor('rsi_meanrev', { minRr }), null)
    assert.equal(nativeProfileHash('rsi_meanrev', { minRr }), null)
  }
  assert.equal(nativeProfileHash('rsi_meanrev', { minRr: 1, extra: true }), null)
})
