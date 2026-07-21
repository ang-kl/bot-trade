// node --test agent/services/loss-guardian.test.js
//
// Loss Guardian: conservative loss-side safety net. Protects NAKED positions
// and enforces an optional time cap; never touches a valid mean-reversion stop.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { decideLossGuardian, loadLossGuardianConfig, DEFAULT_LOSS_GUARDIAN } from './loss-guardian.js'

const CFG = { ...DEFAULT_LOSS_GUARDIAN }

test('defaults: on, scope all; saved values merge; explicit off wins', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadLossGuardianConfig(db), DEFAULT_LOSS_GUARDIAN)
  assert.equal(DEFAULT_LOSS_GUARDIAN.on, true)
  setState(db, 'loss_guardian_json', JSON.stringify({ on: false }))
  assert.equal(loadLossGuardianConfig(db).on, false)
  setState(db, 'loss_guardian_json', JSON.stringify({ maxHoldHours: 12 }))
  assert.equal(loadLossGuardianConfig(db).maxHoldHours, 12)
  assert.equal(loadLossGuardianConfig(db).on, true) // default preserved
})

test('a position that already HAS a stop is never touched (respect the plan)', () => {
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 96, currentSl: 94, atr: 1, digits: 2, ageHours: 20 })
  assert.equal(d.action, null)
})

test('naked long, still inside the cap → protective stop at maxAtrMult×ATR from entry', () => {
  // dist = 3 × 1 = 3 → SL at 97; price 98.5 is above it → set the stop
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 98.5, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.sl, 97)
  assert.match(d.reason, /protective stop/)
})

test('naked short, still inside → protective stop above entry', () => {
  const d = decideLossGuardian(CFG, { side: 'SELL', entry: 100, price: 101.5, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.sl, 103) // 100 + 3×1
})

test('naked position already beyond max loss → close, do not set an unreachable stop', () => {
  // dist 3 → level 97; price 95 is BELOW it (long already blown through) → close
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 95, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.close, true)
  assert.match(d.reason, /beyond max loss/)
})

test('ATR unavailable → falls back to fallbackAdversePct of entry', () => {
  // 2% of 100 = 2 → SL at 98; price 99 above → set
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 99, currentSl: null, atr: null, digits: 2, ageHours: 1 })
  assert.equal(d.action.sl, 98)
})

test('time cap breached → close even if a stop exists', () => {
  const cfg = { ...CFG, maxHoldHours: 10 }
  const d = decideLossGuardian(cfg, { side: 'BUY', entry: 100, price: 99, currentSl: 95, atr: 1, digits: 2, ageHours: 12 })
  assert.equal(d.action.close, true)
  assert.match(d.reason, /time_cap/)
})

test('time cap off by default → a stopped position inside the cap holds', () => {
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 90, currentSl: 88, atr: 1, digits: 2, ageHours: 200 })
  assert.equal(d.action, null) // maxHoldHours null → never time-cap; has a stop → untouched
})
