// node --test agent/services/stage-matrix-s1.test.js
//
// S-1 (26-09-2026, integrated plan row 1.6): honest arming records, the
// picker, and dead cells. No Trade cell VALUE changes anywhere in this file's
// subject — what changes is which list ranks the scan, what the ledger says,
// and whether a cell that cannot bind is accepted.
//
// Measured in production before the change (26-09-2026 01:42–02:44Z):
//   · the shared list armed six intraday strategies and ALL SEVEN accounts
//     carried their own OFF cell for each, so the shared list armed nothing —
//     yet the scan and the picker ranked by it, and the union gate refused
//     vwap_trend / fib_confluence about once a minute;
//   · 17 per-account Trade cells and 7 shared ones had no ledger row;
//   · 7 fib_confluence rows (boot seed, 20-09) gave a reason #972 contradicts;
//   · …0058 stored vp_value Scan OFF, which no code applied.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import {
  rosterArmedTradeKeys, armedTradeKeys, setStage, loadStageMatrix, acctMatrixKey,
  declareUnrecordedTradeCells, tradeFollowers, unappliedOverlayCells, stageMatrixView,
} from './stage-matrix.js'
import { whyCell, applyArmingCorrections, recordArmingChange } from './arming-log.js'
import { bestOf, armedPredicate } from './fib-strategy.js'
import { armedPickerFor } from './armed-analysis-filter.js'
import { STRATEGY_KEYS } from './strategies.js'
import stateRouter from '../routes/state.js'
import actionsRouter from '../routes/actions.js'

const io = { getState, setState }
const ACCTS = ['42993489', '43002148', '43069009', '43097342', '46130058', '46979908', '47790949']

function sevenAccounts() {
  const db = initDB(':memory:')
  for (const id of ACCTS) {
    db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run(id, 0, 1, 'active', id)
  }
  return db
}

/** Every account carries an explicit cell for every strategy, written straight
 *  to state (no ledger row) — the pre-ledger shape the 26-09 read found. */
function pinAllOff(db, except = {}) {
  for (const id of ACCTS) {
    const strategy = {}
    for (const k of STRATEGY_KEYS) strategy[k] = { trade: except[id]?.includes(k) === true }
    setState(db, acctMatrixKey(id), JSON.stringify({ strategy }))
  }
}

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('S-1 picker: vwap ON on the shared list and OFF on every account — neither the scan winner nor the picker is vwap', () => {
  const db = sevenAccounts()
  // The shared list arms vwap_trend (and only it).
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend']))
  // Every account pins every strategy OFF, except one account that arms fib_confluence.
  pinAllOff(db, { 46979908: ['fib_confluence'] })

  const union = rosterArmedTradeKeys(db, getState, ACCTS)
  assert.ok(!union.has('vwap_trend'), 'vwap_trend is armed on no account, so it is not in the union')
  assert.ok(union.has('fib_confluence'), 'the account-armed strategy is')
  assert.ok(armedTradeKeys(db, getState, null).has('vwap_trend'), 'precondition: the shared list does arm vwap_trend')

  // vwap_trend has the higher conviction — under the shared list it won.
  const vwap = { strategy: 'vwap_trend', timeframe: '1h', conviction: 10 }
  const fib = { strategy: 'fib_confluence', timeframe: '1h', conviction: 7 }
  const winner = bestOf([vwap, fib], armedPredicate({ armedStrategyKeys: [...union] }))
  assert.equal(winner.strategy, 'fib_confluence', 'the scan winner ranks by the union')
  const underShared = bestOf([vwap, fib], armedPredicate({ armedStrategyKeys: [...armedTradeKeys(db, getState, null)] }))
  assert.equal(underShared.strategy, 'vwap_trend', 'control: the shared list would have picked vwap_trend')

  const pick = armedPickerFor('armed', { allowedTfs: ['1h'], matrix: null, armedStrategyKeys: [...union] })
  const picked = pick('BTCUSD', null, [vwap, fib])
  assert.equal(picked?.signal?.strategy, 'fib_confluence', 'the analysis picker ranks by the union too')
})

test('S-1 picker: an empty roster falls back to the shared list, like the union gate', () => {
  const db = sevenAccounts()
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  assert.deepEqual([...rosterArmedTradeKeys(db, getState, [])], ['rsi2_reversion'])
})

test('WIRING: the loop ranks the scan and the picker by the roster union, not the shared list', () => {
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /const armedStrategyKeys = \[\.\.\.rosterArmedTradeKeys\(db, getState, getAutopilotAccounts\(db\)\.map\(a => String\(a\.accountId\)\)\)\]/,
    'armedStrategyKeys is the union over the entry roster')
  assert.doesNotMatch(loop, /const armedStrategyKeys = enabledStrategies\(/, 'the shared list no longer ranks the scan')
  assert.match(loop, /runFibScan\([^)]*armedStrategyKeys/, 'the scan is handed it')
  assert.match(loop, /armedPickerFor\(autotradeScope, \{ allowedTfs: armedAllowedTfs, matrix: armedMatrix, armedStrategyKeys \}\)/, 'the picker is handed the same list')
})

test('S-1 records: after the declaration all 91 per-account Trade cells (and the 13 shared) read "recorded", with values unchanged', () => {
  const db = sevenAccounts()
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback', 'vwap_trend', 'fib_confluence']))
  pinAllOff(db, { 46130058: ['tsmom_long'] })
  // Some cells DO have a row (the boot seed's), like production's 72.
  for (const id of ACCTS.slice(0, 3)) {
    recordArmingChange(db, { scope: id, kind: 'strategy', key: 'cup_handle', stage: 'trade', from: true, to: false, actor: 'boot_seed', reason: 'seeded' })
  }
  const before = Object.fromEntries([null, ...ACCTS].map(s => [String(s), [...armedTradeKeys(db, getState, s)].sort()]))
  const unrecordedBefore = [null, ...ACCTS].flatMap(s => STRATEGY_KEYS.filter(k =>
    whyCell(db, { scope: s, key: k, current: armedTradeKeys(db, getState, s).has(k) }).verdict === 'unrecorded'))
  assert.equal(unrecordedBefore.length, 104 - 3, 'precondition: every cell but the three seeded ones is unrecorded')

  const r = declareUnrecordedTradeCells(db, getState)
  assert.equal(r.declared.length, 101)
  let perAccount = 0
  for (const s of [null, ...ACCTS]) {
    const armed = armedTradeKeys(db, getState, s)
    for (const k of STRATEGY_KEYS) {
      const w = whyCell(db, { scope: s, key: k, current: armed.has(k) })
      assert.equal(w.verdict, 'recorded', `${s ?? 'global'}:${k}`)
      if (s != null) perAccount++
    }
  }
  assert.equal(perAccount, 91, 'the 91 per-account cells')
  const after = Object.fromEntries([null, ...ACCTS].map(s => [String(s), [...armedTradeKeys(db, getState, s)].sort()]))
  assert.deepEqual(after, before, 'no Trade value changed')

  // A declared cell says its origin is NOT on record; a seeded one says it is.
  const declared = whyCell(db, { scope: ACCTS[5], key: 'vwap_trend', current: false })
  assert.equal(declared.originRecorded, false)
  assert.match(declared.note, /declared, not explained/)
  assert.equal(whyCell(db, { scope: ACCTS[0], key: 'cup_handle', current: false }).originRecorded, true)

  // Idempotent.
  assert.equal(declareUnrecordedTradeCells(db, getState).declared.length, 0)
})

test('S-1 records: a cell that DISAGREES with its last row is not declared over', () => {
  const db = sevenAccounts()
  pinAllOff(db)
  // The last row says ON, the cell is OFF — an unrecorded writer.
  recordArmingChange(db, { scope: ACCTS[0], kind: 'strategy', key: 'donchian_breakout', stage: 'trade', from: false, to: true, actor: 'boot_seed', reason: 'x' })
  const r = declareUnrecordedTradeCells(db, getState)
  assert.ok(r.disagrees.includes(`${ACCTS[0]}:donchian_breakout`))
  assert.equal(whyCell(db, { scope: ACCTS[0], key: 'donchian_breakout', current: false }).verdict, 'disagrees', 'still visible')
})

const S20 = 'declared OFF in agent/config/strategy-pins.json (_off/_trial — no positive live record, or on trial elsewhere)'

test('S-1 corrections: the 7 wrong fib_confluence reasons are corrected by APPENDED rows, once', () => {
  const db = sevenAccounts()
  const ins = db.prepare(`INSERT INTO arming_log (at, scope, kind, key, stage, from_value, to_value, decision, actor, reason)
                          VALUES (?, ?, 'strategy', ?, 'trade', ?, ?, 'set', ?, ?)`)
  // 18-09: fib pinned ON by the seed (a different, true reason) — not corrected.
  for (const id of ACCTS) ins.run('2026-09-18 22:26:00', id, 'fib_confluence', 'unset', 'true', 'boot_seed', 'declared in agent/config/strategy-pins.json')
  // 20-09 03:51: the seven wrong rows.
  for (const id of ACCTS) ins.run('2026-09-20 03:51:00', id, 'fib_confluence', 'true', 'false', 'boot_seed', S20)
  // The same text on another strategy is NOT one of the seven.
  ins.run('2026-09-18 22:26:00', ACCTS[0], 'vwap_trend', 'true', 'false', 'boot_seed', S20)
  pinAllOff(db)

  const r = applyArmingCorrections(db)
  assert.deepEqual({ appended: r.appended, matched: r.matched }, { appended: 7, matched: 7 })
  const w = whyCell(db, { scope: ACCTS[2], key: 'fib_confluence', current: false })
  assert.equal(w.verdict, 'recorded')
  assert.equal(w.lastSet.reasonAsRecorded, S20, 'the row as written stays visible')
  assert.match(w.lastSet.reason, /scan_dispatch\) was retired/, 'the reason shown is the corrected one')
  assert.match(w.lastSet.reason, /PF 2\.72/)
  assert.ok(w.lastSet.correctedBy?.id > 0)
  assert.equal(whyCell(db, { scope: ACCTS[0], key: 'vwap_trend', current: false }).lastSet.correctedBy, undefined, 'another strategy is untouched')
  assert.equal(applyArmingCorrections(db).appended, 0, 'a second boot appends nothing')

  // A cell that moved AFTER the corrected row is explained by its newer row,
  // not contradicted by the correction.
  setStage(db, { kind: 'strategy', key: 'fib_confluence', stage: 'trade', on: true, accountId: ACCTS[3], actor: 'owner_route', reason: 'test' }, io)
  const moved = whyCell(db, { scope: ACCTS[3], key: 'fib_confluence', current: true })
  assert.equal(moved.verdict, 'recorded')
  assert.equal(moved.lastSet.actor, 'owner_route')
})

test('S-1: the arming log only grows — every earlier row is byte-identical after corrections, declarations and writes', () => {
  const db = sevenAccounts()
  const ins = db.prepare(`INSERT INTO arming_log (at, scope, kind, key, stage, from_value, to_value, decision, actor, reason)
                          VALUES (?, ?, 'strategy', 'fib_confluence', 'trade', 'true', 'false', 'set', 'boot_seed', ?)`)
  for (const id of ACCTS) ins.run('2026-09-20 03:51:00', id, S20)
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend']))
  pinAllOff(db)
  const snap = () => db.prepare('SELECT * FROM arming_log ORDER BY id').all()
  const before = snap()
  applyArmingCorrections(db)
  declareUnrecordedTradeCells(db, getState)
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: true, accountId: ACCTS[1], actor: 'owner_route', reason: 'test' }, io)
  const after = snap()
  assert.ok(after.length > before.length)
  assert.deepEqual(after.slice(0, before.length), before, 'no earlier row changed')

  // And no production code can change one: the #1115 rule, as a census.
  const walk = (dir, out = []) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) { if (!/node_modules/.test(f)) walk(p, out) } else if (/\.js$/.test(f) && !/\.test\.js$/.test(f)) out.push(p)
    }
    return out
  }
  const root = new URL('../', import.meta.url).pathname
  const offenders = walk(root).filter(f => /\b(UPDATE\s+arming_log|DELETE\s+FROM\s+arming_log)\b/i.test(strip(readFileSync(f, 'utf8'))))
  assert.deepEqual(offenders, [], 'nothing updates or deletes an arming row')
})

async function server() {
  const db = sevenAccounts()
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ db, close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` }))
  })
}

test('S-1 dead cells: …0058\'s vp_value Scan OFF is REFUSED with a 400 naming why, and nothing is stored', async () => {
  const s = await server()
  try {
    const before = getState(s.db, acctMatrixKey('46130058'))
    const res = await fetch(s.url('/actions/stage-matrix'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'strategy', key: 'vp_value', stage: 'scan', on: false, accountId: '46130058' }),
    })
    assert.equal(res.status, 400)
    const j = await res.json()
    assert.equal(j.code, 'stage_not_account_scoped')
    assert.match(j.error, /Scan is one shared pass/)
    assert.equal(getState(s.db, acctMatrixKey('46130058')), before, 'the overlay is untouched')
    // Back Test, Live Tweak & Close and a filter's trade flag: refused the same way.
    for (const body of [
      { kind: 'strategy', key: 'vp_value', stage: 'backtest', on: false },
      { kind: 'strategy', key: 'cup_handle', stage: 'manage', on: false },
      { kind: 'filter', key: 'rsi', stage: 'trade', on: false },
    ]) {
      const r = await fetch(s.url('/actions/stage-matrix'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, accountId: '46130058' }),
      })
      assert.equal(r.status, 400, JSON.stringify(body))
    }
    // The per-account Trade cell still takes effect — the one cell that binds.
    const ok = await fetch(s.url('/actions/stage-matrix'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'strategy', key: 'vp_value', stage: 'trade', on: true, accountId: '46130058' }),
    })
    assert.equal(ok.status, 200)
    assert.ok(armedTradeKeys(s.db, getState, '46130058').has('vp_value'))
    // A shared Scan write is still accepted.
    const shared = await fetch(s.url('/actions/stage-matrix'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'strategy', key: 'vp_value', stage: 'scan', on: false }),
    })
    assert.equal(shared.status, 200)
  } finally { s.close() }
})

test('S-1 dead cells: a STORED per-account Scan OFF shows the value that binds, and is listed as unapplied (not removed)', () => {
  const db = sevenAccounts()
  // …0058's stored shape: vp_value scan+backtest OFF, cup_handle manage OFF.
  setState(db, acctMatrixKey('46130058'), JSON.stringify({ strategy: { vp_value: { scan: false, backtest: false, trade: false }, cup_handle: { manage: false } } }))
  const m = loadStageMatrix(db, getState, '46130058')
  const vp = m.strategies.find(r => r.key === 'vp_value')
  assert.equal(vp.stages.scan, true, 'the account view shows the Scan value that is applied (the shared one)')
  assert.equal(vp.stages.trade, false, 'its own Trade cell still binds')
  const cells = m.unapplied.map(u => u.cell).sort()
  assert.deepEqual(cells, ['strategy:cup_handle:manage', 'strategy:vp_value:backtest', 'strategy:vp_value:scan'])
  assert.equal(m.unapplied.find(u => u.cell === 'strategy:vp_value:scan').stored, false)
  assert.ok(getState(db, acctMatrixKey('46130058')).includes('"scan":false'), 'the stored cell is kept (realigning it is the owner\'s call)')
  assert.deepEqual(unappliedOverlayCells(db, getState, '47790949'), [], 'an account without stored cells has none')
})

test('S-1 Tune: the shared view says "followed by N of 7" per strategy', () => {
  const db = sevenAccounts()
  pinAllOff(db)
  // One account drops its own vwap_trend cell and so follows the shared one.
  const o = JSON.parse(getState(db, acctMatrixKey(ACCTS[6])))
  delete o.strategy.vwap_trend
  setState(db, acctMatrixKey(ACCTS[6]), JSON.stringify(o))
  const f = tradeFollowers(db, getState)
  assert.deepEqual(f.vwap_trend, { following: 1, of: 7 })
  assert.deepEqual(f.fib_confluence, { following: 0, of: 7 })
  assert.deepEqual(stageMatrixView(db, getState, {}).followers.vwap_trend, { following: 1, of: 7 })
})
