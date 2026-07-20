// node --test agent/services/asset-controllers.test.js
//
// Per-asset-class trade management (owner: "separate controllers for forex,
// indices, commodities — you seem to be trading like a beginner"). Each
// class resolves its own breakeven/partial/runner triggers on top of the
// global DEFAULT_RULES; owner overrides win; unknown keys can't leak through.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { DEFAULT_RULES } from './position-manager.js'
import {
  rulesForSymbol, assetControllersView, setAssetController, CLASS_RULE_DEFAULTS, MANAGED_KEYS,
} from './asset-controllers.js'

test('rulesForSymbol: a EURUSD (fx) and a NatGas (commodity) get DIFFERENT triggers', () => {
  const db = initDB(':memory:')
  const fx = rulesForSymbol(db, 'EURUSD')
  const gas = rulesForSymbol(db, 'NATGAS')
  assert.equal(fx._assetClass, 'fx')
  assert.equal(gas._assetClass, 'commodity')
  // Commodity locks breakeven sooner than FX (whippier class).
  assert.ok(gas.beTriggerR < fx.beTriggerR)
  // Both still carry the untouched global rules (e.g. partialFraction).
  assert.equal(fx.partialFraction, DEFAULT_RULES.partialFraction)
})

test('rulesForSymbol: an index gives runners more room than FX', () => {
  const db = initDB(':memory:')
  const idx = rulesForSymbol(db, 'JPN225')
  const fx = rulesForSymbol(db, 'EURUSD')
  assert.equal(idx._assetClass, 'index')
  assert.ok(idx.runnerTriggerR >= fx.runnerTriggerR)
})

test('owner override wins and is reflected in the view; clearing restores the default', () => {
  const db = initDB(':memory:')
  setAssetController(db, 'commodity', { beTriggerR: 0.4 })
  assert.equal(rulesForSymbol(db, 'NATGAS').beTriggerR, 0.4)
  const row = assetControllersView(db).find(r => r.class === 'commodity')
  assert.equal(row.beTriggerR, 0.4)
  assert.equal(row.overridden, true)
  // Clearing that key restores the class default.
  setAssetController(db, 'commodity', { beTriggerR: null })
  assert.equal(rulesForSymbol(db, 'NATGAS').beTriggerR, CLASS_RULE_DEFAULTS.commodity.beTriggerR)
  assert.equal(assetControllersView(db).find(r => r.class === 'commodity').overridden, false)
})

test('setAssetController: unknown class rejected, out-of-range clamped, non-managed keys ignored', () => {
  const db = initDB(':memory:')
  assert.throws(() => setAssetController(db, 'nonsense', { beTriggerR: 1 }))
  setAssetController(db, 'fx', { beTriggerR: 999, partialFraction: 0.9 }) // clamp + ignore
  const fx = rulesForSymbol(db, 'EURUSD')
  assert.equal(fx.beTriggerR, 20) // clamped to the max
  assert.equal(fx.partialFraction, DEFAULT_RULES.partialFraction) // untouched
})

test('view covers every class and only exposes managed keys', () => {
  const db = initDB(':memory:')
  const view = assetControllersView(db)
  assert.equal(view.length, Object.keys(CLASS_RULE_DEFAULTS).length)
  for (const row of view) {
    for (const k of MANAGED_KEYS) assert.ok(Number.isFinite(row[k]))
    assert.equal('partialFraction' in row, false)
  }
})
