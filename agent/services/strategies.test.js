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
  // Owner (2026-07-27): all strategies default on EXCEPT fib_618_fade
  // (chosen manually in Tune). ema_pullback was held back at first (same-day
  // disarm for a real loss) but the owner explicitly confirmed re-arming it.
  assert.ok(STRATEGY_KEYS.includes('fib_618_fade'))
  assert.equal(strategyByKey('fib_618_fade').defaultOn, false)
  assert.equal(strategyByKey('fib_618_fade').pendingCapable, true)
  assert.equal(strategyByKey('ema_pullback').defaultOn, true)
  assert.equal(strategyByKey('cup_handle').defaultOn, true)
})

test('registry contains the five contracted keys', () => {
  for (const k of ['fib_618_fade', 'cup_handle', 'ema_pullback', 'donchian_breakout', 'rsi_meanrev']) {
    assert.ok(STRATEGY_KEYS.includes(k), `missing ${k}`)
  }
})

// Registry order, defaultOn strategies only — everything except
// fib_618_fade (2026-07-27 owner decision).
const DEFAULT_ON_KEYS = ['cup_handle', 'inv_cup_handle', 'ema_pullback', 'donchian_breakout', 'rsi_meanrev', 'vwap_trend', 'vp_value', 'rsi2_reversion', 'fib_confluence', 'va_breakout']

test('enabledStrategies: missing state falls back to the defaultOn set', () => {
  const { db, getState } = fakeState({})
  assert.deepEqual(keysOf(enabledStrategies(db, getState)), DEFAULT_ON_KEYS)
})

test('enabledStrategies: corrupt JSON falls back to defaults', () => {
  const { db, getState } = fakeState({ enabled_strategies_json: '{not json[' })
  assert.deepEqual(keysOf(enabledStrategies(db, getState)), DEFAULT_ON_KEYS)
})

test('enabledStrategies: non-array JSON falls back to defaults', () => {
  const { db, getState } = fakeState({ enabled_strategies_json: '"cup_handle"' })
  assert.deepEqual(keysOf(enabledStrategies(db, getState)), DEFAULT_ON_KEYS)
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
  // legacy flag with NO json list — cup_handle is already in the default set
  let s = fakeState({ cup_handle_enabled: 'true' })
  assert.deepEqual(keysOf(enabledStrategies(s.db, s.getState)), DEFAULT_ON_KEYS)
  // legacy flag alongside a list that omits cup — flag still wins (back-compat)
  s = fakeState({ cup_handle_enabled: 'true', enabled_strategies_json: JSON.stringify(['fib_618_fade']) })
  assert.deepEqual(keysOf(enabledStrategies(s.db, s.getState)), ['fib_618_fade', 'cup_handle'])
  // flag off adds nothing
  s = fakeState({ cup_handle_enabled: 'false' })
  assert.deepEqual(keysOf(enabledStrategies(s.db, s.getState)), DEFAULT_ON_KEYS)
})

test('enabledStrategies returns registry entries (compute callable)', () => {
  const { db, getState } = fakeState({})
  for (const s of enabledStrategies(db, getState)) {
    assert.equal(typeof s.compute, 'function')
    assert.equal(typeof s.name, 'string')
  }
})
