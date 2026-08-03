// Per-account stage matrix.
//
// Owner, 04-08-2026: "i try to change the setup for different account but it
// didn't work." Arming a strategy armed it for every account, because
// /actions/stage-matrix took no accountId and this service had exactly one
// global key.
//
// The rules these tests hold down:
//   · an overlay is PARTIAL — the cells an account did not pin keep following
//     the global matrix, so a global change still reaches it,
//   · writing for one account moves nothing for anybody else,
//   · a pinned cell is REPORTABLE, so the UI can never hide an override,
//   · the union gate stops work only when NO account could act on it.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, getState, setState } from '../db.js'
import {
  loadStageMatrix, setStage, tradeStageGate, anyAccountTradeGate,
  stageOverlayKeys, acctMatrixKey, acctEnabledKey,
} from './stage-matrix.js'

let db
const io = { getState, setState }
beforeEach(() => { db = initDB(':memory:') })

const tradeOn = (m, key) => m.strategies.find(s => s.key === key)?.stages.trade
const scanOn = (m, key) => m.strategies.find(s => s.key === key)?.stages.scan

test('with no overlay an account sees exactly the global matrix', () => {
  const globalM = loadStageMatrix(db, getState)
  const acctM = loadStageMatrix(db, getState, '5203012')
  assert.deepEqual(acctM.strategies, globalM.strategies)
  assert.deepEqual(acctM.filters, globalM.filters)
  assert.deepEqual(stageOverlayKeys(db, getState, '5203012'), [])
})

test('arming a strategy FOR ONE ACCOUNT leaves the global matrix and other accounts alone', () => {
  const key = loadStageMatrix(db, getState).strategies.find(s => !s.stages.trade)?.key
  assert.ok(key, 'need a strategy that is off in Auto Trade & Open')

  setStage(db, { kind: 'strategy', key, stage: 'trade', on: true, accountId: '5203012' }, io)

  assert.equal(tradeOn(loadStageMatrix(db, getState, '5203012'), key), true, 'armed for this account')
  assert.equal(tradeOn(loadStageMatrix(db, getState), key), false, 'global untouched')
  assert.equal(tradeOn(loadStageMatrix(db, getState, '5306502'), key), false, 'other account untouched')
  // The legacy global list is the one the whole system used to read.
  assert.equal(getState(db, acctEnabledKey('5203012')) != null, true)
})

test('an overlay is PARTIAL — unpinned cells still follow the global matrix', () => {
  const key = loadStageMatrix(db, getState).strategies[0].key
  // Pin only the scan cell for this account…
  setStage(db, { kind: 'strategy', key, stage: 'scan', on: false, accountId: '5203012' }, io)
  // …then change a DIFFERENT cell globally.
  setStage(db, { kind: 'strategy', key, stage: 'manage', on: false }, io)

  const m = loadStageMatrix(db, getState, '5203012')
  assert.equal(scanOn(m, key), false, 'pinned cell holds')
  assert.equal(m.strategies.find(s => s.key === key).stages.manage, false, 'unpinned cell follows global')
})

test('a pinned cell is reportable — an override can never be invisible', () => {
  const key = loadStageMatrix(db, getState).strategies[0].key
  setStage(db, { kind: 'strategy', key, stage: 'scan', on: false, accountId: '5203012' }, io)
  const keys = stageOverlayKeys(db, getState, '5203012')
  assert.ok(keys.includes(`strategy:${key}:scan`), keys.join(','))
  assert.deepEqual(stageOverlayKeys(db, getState, '5306502'), [], 'not the other account')
})

test('the per-account gate answers for THAT account', () => {
  const key = loadStageMatrix(db, getState).strategies.find(s => !s.stages.trade)?.key
  setStage(db, { kind: 'strategy', key, stage: 'trade', on: true, accountId: '5203012' }, io)

  assert.equal(tradeStageGate(db, getState, { strategy: key, accountId: '5203012' }).ok, true)
  assert.equal(tradeStageGate(db, getState, { strategy: key, accountId: '5306502' }).ok, false)
  assert.equal(tradeStageGate(db, getState, { strategy: key }).ok, false, 'global still off')
})

test('the union gate passes when ANY account has it armed, and fails when none do', () => {
  const key = loadStageMatrix(db, getState).strategies.find(s => !s.stages.trade)?.key
  const roster = ['5203012', '5306502']
  assert.equal(anyAccountTradeGate(db, getState, { strategy: key, accountIds: roster }).ok, false)

  setStage(db, { kind: 'strategy', key, stage: 'trade', on: true, accountId: '5306502' }, io)
  const u = anyAccountTradeGate(db, getState, { strategy: key, accountIds: roster })
  assert.equal(u.ok, true, 'one armed account is enough to keep the signal alive')
  // …and the per-account gate still refuses the account that did not arm it,
  // which is what stops the union from becoming a back door.
  assert.equal(tradeStageGate(db, getState, { strategy: key, accountId: '5203012' }).ok, false)
})

test('an empty roster falls back to the GLOBAL verdict, never a silent yes', () => {
  const off = loadStageMatrix(db, getState).strategies.find(s => !s.stages.trade)?.key
  assert.equal(anyAccountTradeGate(db, getState, { strategy: off, accountIds: [] }).ok, false)
  const on = loadStageMatrix(db, getState).strategies.find(s => s.stages.trade)?.key
  if (on) assert.equal(anyAccountTradeGate(db, getState, { strategy: on, accountIds: [] }).ok, true)
})

test('a corrupt overlay falls back to the global matrix instead of throwing', () => {
  setState(db, acctMatrixKey('5203012'), '{not json')
  const m = loadStageMatrix(db, getState, '5203012')
  assert.deepEqual(m.strategies, loadStageMatrix(db, getState).strategies)
})
