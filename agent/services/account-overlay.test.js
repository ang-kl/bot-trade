// The overlay pattern, once, for every per-account setting that follows it.
//
// Owner, 04-08-2026: "i try to change the setup for different account but it
// didn't work." These are the properties that make the answer "it does now",
// and the ones that would quietly reintroduce the bug if they regressed.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, setState } from '../db.js'
import { loadWithOverlay, saveWithOverlay, overlayKeys, clearOverlay, acctStateKey } from './account-overlay.js'
import { loadLossCapConfig, DEFAULT_LOSS_CAP, LOSS_CAP_KEY } from './loss-cap.js'

let db
const DEFAULTS = { on: true, maxLossUsd: null, scope: 'all' }
const KEY = 'demo_json'
beforeEach(() => { db = initDB(':memory:') })

test('no overlay = the shared config, exactly', () => {
  setState(db, KEY, JSON.stringify({ maxLossUsd: 800 }))
  assert.deepEqual(loadWithOverlay(db, DEFAULTS, KEY, null), { on: true, maxLossUsd: 800, scope: 'all' })
  assert.deepEqual(loadWithOverlay(db, DEFAULTS, KEY, '5203012'), { on: true, maxLossUsd: 800, scope: 'all' })
})

test('an overlay is PARTIAL — unpinned fields keep following the shared value', () => {
  setState(db, KEY, JSON.stringify({ maxLossUsd: 800, scope: 'all' }))
  saveWithOverlay(db, setState, { defaults: DEFAULTS, baseKey: KEY, accountId: '5203012', patch: { maxLossUsd: 200 } })

  // Now change a DIFFERENT field on the shared config.
  setState(db, KEY, JSON.stringify({ maxLossUsd: 800, scope: 'bot' }))
  const acct = loadWithOverlay(db, DEFAULTS, KEY, '5203012')
  assert.equal(acct.maxLossUsd, 200, 'pinned field holds')
  assert.equal(acct.scope, 'bot', 'unpinned field follows the shared change')
})

test('writing for one account moves nothing for anyone else', () => {
  saveWithOverlay(db, setState, { defaults: DEFAULTS, baseKey: KEY, accountId: '5203012', patch: { on: false } })
  assert.equal(loadWithOverlay(db, DEFAULTS, KEY, '5203012').on, false)
  assert.equal(loadWithOverlay(db, DEFAULTS, KEY, '5306502').on, true, 'other account')
  assert.equal(loadWithOverlay(db, DEFAULTS, KEY, null).on, true, 'shared config')
})

test('pinned fields are reportable, and clearing puts an account back on the shared config', () => {
  saveWithOverlay(db, setState, { defaults: DEFAULTS, baseKey: KEY, accountId: '5203012', patch: { on: false, maxLossUsd: 50 } })
  assert.deepEqual(overlayKeys(db, KEY, '5203012').sort(), ['maxLossUsd', 'on'])
  clearOverlay(db, setState, KEY, '5203012')
  assert.deepEqual(overlayKeys(db, KEY, '5203012'), [])
  assert.equal(loadWithOverlay(db, DEFAULTS, KEY, '5203012').on, true)
})

test('a CORRUPT overlay falls back to the shared config, never to "no protection"', () => {
  // The failure that matters: if a broken JSON blob were treated as empty
  // config, an account would silently lose its loss cap.
  setState(db, KEY, JSON.stringify({ maxLossUsd: 800 }))
  setState(db, acctStateKey('5203012', KEY), '{not json')
  assert.equal(loadWithOverlay(db, DEFAULTS, KEY, '5203012').maxLossUsd, 800)
})

test('the loss cap uses it — an account can hold a tighter cap than the shared one', () => {
  setState(db, LOSS_CAP_KEY, JSON.stringify({ on: true, maxLossUsd: 800 }))
  saveWithOverlay(db, setState, {
    defaults: DEFAULT_LOSS_CAP, baseKey: LOSS_CAP_KEY, accountId: '5203012', patch: { maxLossUsd: 100 },
  })
  assert.equal(loadLossCapConfig(db, '5203012').maxLossUsd, 100)
  assert.equal(loadLossCapConfig(db, '5306502').maxLossUsd, 800)
  assert.equal(loadLossCapConfig(db).maxLossUsd, 800)
  // …and the rest of the cap config still comes from the shared settings.
  assert.equal(loadLossCapConfig(db, '5203012').on, true)
})

test('the profit ratchet and Loss Guardian use it too — three layers, one pattern', async () => {
  const { loadProfitRatchetConfig, DEFAULT_PROFIT_RATCHET, PROFIT_RATCHET_KEY } = await import('./profit-ratchet.js')
  const { loadLossGuardianConfig, DEFAULT_LOSS_GUARDIAN, LOSS_GUARDIAN_KEY } = await import('./loss-guardian.js')

  // One account turns the ratchet OFF for itself while the shared config stays
  // on — the case the owner could not express at all before today.
  saveWithOverlay(db, setState, {
    defaults: DEFAULT_PROFIT_RATCHET, baseKey: PROFIT_RATCHET_KEY, accountId: '5203012', patch: { on: false },
  })
  assert.equal(loadProfitRatchetConfig(db, '5203012').on, false)
  assert.equal(loadProfitRatchetConfig(db, '5306502').on, DEFAULT_PROFIT_RATCHET.on)
  assert.equal(loadProfitRatchetConfig(db).on, DEFAULT_PROFIT_RATCHET.on)
  // Its OTHER fields still follow the shared config.
  assert.equal(loadProfitRatchetConfig(db, '5203012').floorAction, DEFAULT_PROFIT_RATCHET.floorAction)

  // The guardian: one account guards external-only, another guards everything.
  saveWithOverlay(db, setState, {
    defaults: DEFAULT_LOSS_GUARDIAN, baseKey: LOSS_GUARDIAN_KEY, accountId: '5203012', patch: { scope: 'external', maxAtrMult: 5 },
  })
  assert.equal(loadLossGuardianConfig(db, '5203012').scope, 'external')
  assert.equal(loadLossGuardianConfig(db, '5203012').maxAtrMult, 5)
  assert.equal(loadLossGuardianConfig(db, '5306502').scope, DEFAULT_LOSS_GUARDIAN.scope)
  assert.equal(loadLossGuardianConfig(db, '5306502').maxAtrMult, DEFAULT_LOSS_GUARDIAN.maxAtrMult)
})
