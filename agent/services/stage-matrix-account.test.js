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
  stageOverlayKeys, acctMatrixKey, acctEnabledKey, migrateTradeOverlay,
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
  // THE TRADE CELL IS PINNED LIKE ANY OTHER CELL (05-08-2026). This used to
  // assert the account's legacy WHOLESALE list key had been written, which was
  // the storage shape that made the trade column override differently from its
  // three neighbours: touching one cell froze all fifteen. It now pins one
  // cell in the same overlay scan/backtest/manage use, so the assertion moves
  // to that — the behaviour above (armed here, global and other account
  // untouched) is unchanged and still checked.
  assert.deepEqual(stageOverlayKeys(db, getState, '5203012'), [`strategy:${key}:trade`])
})

test('THE COLUMNS NOW OVERRIDE ALIKE: one trade cell does not freeze the rest', () => {
  // Owner, 05-08-2026: "the pipeline cards doesn't reconcile the top and
  // bottom of the strategies". They could not: Scan, Backtest and Manage
  // merged cell-by-cell with the global while Trade replaced it wholesale, so
  // one table held two different override rules and no reading of it could
  // predict the other.
  const [a, b] = loadStageMatrix(db, getState).strategies
  // Pin ONE account's trade cell for strategy `a`…
  setStage(db, { kind: 'strategy', key: a.key, stage: 'trade', on: false, accountId: '5203012' }, io)
  // …then change a DIFFERENT strategy's trade cell globally.
  const bWas = tradeOn(loadStageMatrix(db, getState), b.key)
  setStage(db, { kind: 'strategy', key: b.key, stage: 'trade', on: !bWas }, io)

  const m = loadStageMatrix(db, getState, '5203012')
  assert.equal(tradeOn(m, a.key), false, 'the pinned cell holds')
  assert.equal(tradeOn(m, b.key), !bWas, 'the UNPINNED cell still follows the global — this is the fix')
})

test('a legacy wholesale list is migrated WITHOUT changing what the account trades', () => {
  // Both demo accounts were carrying one of these on 05-08-2026. The migration
  // must be a representation change and nothing else: every strategy the list
  // named stays armed, every strategy it omitted stays off.
  const all = loadStageMatrix(db, getState).strategies.map(s => s.key)
  const armed = [all[0], all[2]]
  setState(db, acctEnabledKey('5203012'), JSON.stringify(armed))

  const before = loadStageMatrix(db, getState, '5203012').strategies.map(s => [s.key, s.stages.trade])
  migrateTradeOverlay(db, io, '5203012')
  const after = loadStageMatrix(db, getState, '5203012').strategies.map(s => [s.key, s.stages.trade])

  assert.deepEqual(after, before, 'not one cell changes value')
  assert.deepEqual(after.filter(([, on]) => on).map(([k]) => k), armed)
  // …and it is idempotent.
  assert.equal(migrateTradeOverlay(db, io, '5203012').migrated, false)
})

test('an account with no legacy list is left completely alone by the migration', () => {
  const r = migrateTradeOverlay(db, io, '5306502')
  assert.equal(r.migrated, false)
  assert.deepEqual(stageOverlayKeys(db, getState, '5306502'), [])
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
