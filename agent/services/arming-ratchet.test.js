// PR-T: the per-account arming ratchet. The first test reproduces the
// production state measured on 17-09-2026 — the one this module exists for.
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from '../test-support/temp-dir.js'

import { initDB, getState, setState } from '../db.js'
import { setStage } from './stage-matrix.js'
import { ratchetedCells, armingRatchetReport, armingRatchetLine } from './arming-ratchet.js'

const io = { getState, setState }
function freshDb() {
  const db = initDB(join(mkdtempSync(join(tmpdir(), 'ratchet-')), 'test.db'))
  // Everything armed globally, which is what makes a false CELL a refusal
  // rather than agreement with the rest of the system.
  setState(db, 'enabled_strategies_json', JSON.stringify(['tsmom_long', 'rsi2_reversion', 'vwap_trend']))
  return db
}
const addAccount = (db, id) => db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?, 0, 1)').run(id)

test('the measured production case: tsmom_long off on three accounts, armed globally', () => {
  const db = freshDb()
  for (const id of ['47790949', '46130058', '43097342', '46979908']) addAccount(db, id)
  // Three accounts were seeded with tsmom_long and later disarmed; the fourth
  // still carries it. This is the 17-09 boot line, reproduced.
  for (const id of ['47790949', '46130058', '43097342']) {
    setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: id, actor: 'adaptive_breaker', reason: 'loss streak 3 >= 3' }, io)
  }
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: true, accountId: '46979908', actor: 'boot_seed' }, io)

  const cells = ratchetedCells(db).filter(c => c.strategy === 'tsmom_long')
  assert.deepEqual(cells.map(c => c.accountId).sort(), ['43097342', '46130058', '47790949'])
  assert.ok(!cells.some(c => c.accountId === '46979908'), 'an armed account is not ratcheted')
})

test('an ABSENT cell is not ratcheted — it still follows the global', () => {
  const db = freshDb()
  addAccount(db, '5001')
  // No overlay at all. The account trades everything the global trades, and
  // will pick up a new global arm automatically. Counting it as ratcheted
  // would bury the cells that genuinely refuse under every account that
  // simply never diverged.
  assert.equal(ratchetedCells(db).length, 0)
})

test('a strategy that is off GLOBALLY is not a per-account ratchet', () => {
  const db = freshDb()
  addAccount(db, '5002')
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: '5002', actor: 'adaptive_breaker' }, io)
  // The account agrees with the rest of the system. Re-arming it would change
  // nothing, so it is not this report's business.
  assert.equal(ratchetedCells(db).filter(c => c.strategy === 'tsmom_long').length, 0)
})

test('an un-migrated account refusing via its legacy list counts too', () => {
  const db = freshDb()
  addAccount(db, '5003')
  setState(db, 'acct:5003:enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  const cells = ratchetedCells(db)
  assert.ok(cells.some(c => c.accountId === '5003' && c.strategy === 'tsmom_long' && c.refusedBy === 'absent_from_legacy_list'))
})

test('a cell disarmed before the ledger existed reads unrecorded, not a guess', () => {
  const db = freshDb()
  addAccount(db, '5004')
  // Written straight to state, as every pre-PR-S disarm was.
  setState(db, 'acct:5004:stage_matrix_json', JSON.stringify({ strategy: { tsmom_long: { trade: false } } }))
  const r = armingRatchetReport(db)
  const row = r.rows.find(x => x.accountId === '5004' && x.strategy === 'tsmom_long')
  assert.equal(row.reasonVerdict, 'unrecorded')
  assert.equal(row.disarmedBy, null)
  assert.equal(row.disarmReason, null)
  assert.equal(r.unrecorded, r.rows.filter(x => x.reasonVerdict === 'unrecorded').length)
})

test('a cell disarmed after the ledger carries the actor and the figures that did it', () => {
  const db = freshDb()
  addAccount(db, '5005')
  setStage(db, {
    kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, accountId: '5005',
    actor: 'edge_watchdog', reason: 'no edge: expectancy -53.85, PF 0.49 over 31 closes',
  }, io)
  const row = armingRatchetReport(db).rows.find(x => x.accountId === '5005' && x.strategy === 'vwap_trend')
  assert.equal(row.reasonVerdict, 'recorded')
  assert.equal(row.disarmedBy, 'edge_watchdog')
  assert.match(row.disarmReason, /31 closes/)
})

test('thin evidence is never reported as clear', () => {
  const db = freshDb()
  addAccount(db, '5006')
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: '5006', actor: 'adaptive_breaker' }, io)
  const row = armingRatchetReport(db).rows.find(x => x.accountId === '5006')
  // No closes at all on this account. `wouldClearToday` is true only because
  // neither bar FIRES on no data — which is exactly why `evidenceThin` exists
  // beside it and why the note says so. A reader must be able to tell "clear"
  // from "nothing to judge".
  assert.equal(row.ownEvidence.trades, 0)
  assert.equal(row.evidenceThin, true)
})

test('a cell whose own evidence still fails the watchdog bar is flagged as would-disarm-again', () => {
  const db = freshDb()
  addAccount(db, '5007')
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, accountId: '5007', actor: 'edge_watchdog' }, io)
  // Eighteen closed losers on this account's own book. The count matters and
  // is not arbitrary: the watchdog's default bar is minTrades 15, so twelve
  // would read `evidenceThin` — correctly, and the first draft of this test
  // asserted otherwise and went red for exactly that reason. Below the bar the
  // honest answer is "not enough to judge", which is a different fact from
  // "would fire again".
  const ins = db.prepare(`INSERT INTO trades (account_id, symbol, status, net_pnl, label_strategy, closed_at) VALUES (?, 'EURUSD', 'closed', ?, 'vwap_trend', datetime('now'))`)
  for (let i = 0; i < 18; i++) ins.run('5007', -10)
  const row = armingRatchetReport(db).rows.find(x => x.accountId === '5007')
  assert.equal(row.ownEvidence.trades, 18)
  assert.ok(row.ownEvidence.expectancy < 0)
  assert.equal(row.wouldDisarmAgain.noEdge, true, 'the same bar that disarmed it still fails')
  assert.equal(row.wouldClearToday, false)
  assert.equal(row.evidenceThin, false)
})

test('the log line names the strategies, not just a count', () => {
  const db = freshDb()
  addAccount(db, '47790949')
  for (const k of ['tsmom_long', 'vwap_trend']) {
    setStage(db, { kind: 'strategy', key: k, stage: 'trade', on: false, accountId: '47790949', actor: 'adaptive_breaker' }, io)
  }
  const line = armingRatchetLine(db)
  // "8 cells off on …0949" does not tell you the momentum book is among them.
  assert.match(line, /tsmom_long/)
  assert.match(line, /…0949/)
  assert.match(line, /Only the owner re-arms these/)
})

test('nothing ratcheted logs nothing', () => {
  const db = freshDb()
  addAccount(db, '5008')
  assert.equal(armingRatchetLine(db), null)
})

test('the report arms nothing — every cell reads exactly as it did before', () => {
  const db = freshDb()
  addAccount(db, '5009')
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: '5009', actor: 'adaptive_breaker' }, io)
  const before = getState(db, 'acct:5009:stage_matrix_json')
  armingRatchetReport(db)
  armingRatchetLine(db)
  assert.equal(getState(db, 'acct:5009:stage_matrix_json'), before, 'a report that mutates the thing it reports is not a report')
})

test('the loop calls it — the wiring, not just the function', () => {
  // CLAUDE.md failure mode #4: a repair that nothing calls. The call site is
  // invisible from this module and a refactor drops it in silence.
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  assert.match(src, /armingRatchetLine\(db\)/)
  assert.match(src, /arming_ratchet_logged_ms/, 'and it is throttled — a standing condition logged every cycle stops being read')
})
