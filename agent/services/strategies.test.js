// ---------------------------------------------------------------------------
// agent/services/strategies.test.js — registry shape + enabledStrategies
// resolution rules. Uses a fake getState (no sqlite) — enabledStrategies only
// ever calls getState(db, key), so a plain lookup object is a faithful stand-in.
// ---------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import { STRATEGY_REGISTRY, STRATEGY_KEYS, strategyByKey, enabledStrategies } from './strategies.js'

// Fake db/getState pair: `state` is a plain { key: value } object.
function fakeState(state = {}) {
  return { db: null, getState: (_db, key) => state[key] ?? null }
}

function keysOf(entries) { return entries.map(s => s.key) }

test('registry shape: every entry has key, name, compute fn and both flags', () => {
  assert.ok(STRATEGY_REGISTRY.length >= 5, 'expected at least 5 strategies')
  for (const s of STRATEGY_REGISTRY) {
    assert.equal(typeof s.key, 'string')
    assert.ok(s.key.length > 0)
    assert.equal(typeof s.name, 'string')
    assert.ok(s.name.length > 0)
    assert.equal(typeof s.compute, 'function')
    assert.equal(typeof s.defaultOn, 'boolean')
    assert.equal(typeof s.pendingCapable, 'boolean')
  }
  // keys are unique — duplicate keys would make state resolution ambiguous
  assert.equal(new Set(STRATEGY_KEYS).size, STRATEGY_REGISTRY.length)
  // the baseline exists and is the only defaultOn strategy today
  assert.ok(STRATEGY_KEYS.includes('fib_618_fade'))
  assert.equal(strategyByKey('fib_618_fade').defaultOn, true)
  assert.equal(strategyByKey('fib_618_fade').pendingCapable, true)
})

test('registry contains the five contracted keys', () => {
  for (const k of ['fib_618_fade', 'cup_handle', 'ema_pullback', 'donchian_breakout', 'rsi_meanrev']) {
    assert.ok(STRATEGY_KEYS.includes(k), `missing ${k}`)
  }
})

test('enabledStrategies: missing state falls back to the defaultOn set (fib only)', () => {
  const { db, getState } = fakeState({})
  assert.deepEqual(keysOf(enabledStrategies(db, getState)), ['fib_618_fade'])
})

test('enabledStrategies: corrupt JSON falls back to defaults', () => {
  const { db, getState } = fakeState({ enabled_strategies_json: '{not json[' })
  assert.deepEqual(keysOf(enabledStrategies(db, getState)), ['fib_618_fade'])
})

test('enabledStrategies: non-array JSON falls back to defaults', () => {
  const { db, getState } = fakeState({ enabled_strategies_json: '"cup_handle"' })
  assert.deepEqual(keysOf(enabledStrategies(db, getState)), ['fib_618_fade'])
})

test('enabledStrategies: explicit list is honoured, in registry order', () => {
  const { db, getState } = fakeState({
    enabled_strategies_json: JSON.stringify(['rsi_meanrev', 'ema_pullback', 'fib_618_fade']),
  })
  assert.deepEqual(keysOf(enabledStrategies(db, getState)), ['fib_618_fade', 'ema_pullback', 'rsi_meanrev'])
})

test('enabledStrategies: fib is a normal toggle — an explicit list without fib excludes it', () => {
  const state = { enabled_strategies_json: JSON.stringify(['ema_pullback']) }
  const keys = enabledStrategies({}, (_db, k) => state[k]).map(s => s.key)
  assert.deepEqual(keys, ['ema_pullback'])
})

test('enabledStrategies: empty list is legal — the scan idles instead of inventing a base', () => {
  const state = { enabled_strategies_json: '[]' }
  assert.deepEqual(enabledStrategies({}, (_db, k) => state[k]), [])
})

test('enabledStrategies: unknown keys are dropped silently', () => {
  const { db, getState } = fakeState({ enabled_strategies_json: JSON.stringify(['fib_618_fade', 'moon_phase']) })
  assert.deepEqual(keysOf(enabledStrategies(db, getState)), ['fib_618_fade'])
})

test('enabledStrategies: legacy cup_handle_enabled=true adds cup_handle', () => {
  // legacy flag with NO json list
  let s = fakeState({ cup_handle_enabled: 'true' })
  assert.deepEqual(keysOf(enabledStrategies(s.db, s.getState)), ['fib_618_fade', 'cup_handle'])
  // legacy flag alongside a list that omits cup — flag still wins (back-compat)
  s = fakeState({ cup_handle_enabled: 'true', enabled_strategies_json: JSON.stringify(['fib_618_fade']) })
  assert.deepEqual(keysOf(enabledStrategies(s.db, s.getState)), ['fib_618_fade', 'cup_handle'])
  // flag off adds nothing
  s = fakeState({ cup_handle_enabled: 'false' })
  assert.deepEqual(keysOf(enabledStrategies(s.db, s.getState)), ['fib_618_fade'])
})

test('enabledStrategies returns registry entries (compute callable)', () => {
  const { db, getState } = fakeState({})
  for (const s of enabledStrategies(db, getState)) {
    assert.equal(typeof s.compute, 'function')
    assert.equal(typeof s.name, 'string')
  }
})
