import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { pnlHistoryReport } from './pnl-history-report.js'
import { unknownPnlReport } from './unknown-pnl-report.js'

const nowMs = Date.parse('2026-09-23T07:00:00Z')
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  const insert = db.prepare(`INSERT INTO trades
    (account_id, ctrader_position_id, symbol, side, status, closed_at, net_pnl)
    VALUES (?, ?, 'EURUSD', 'BUY', ?, '2026-01-01 12:00:00', ?)`)
  return { db, add: (account = '11', position = '7', status = 'closed', pnl = null) =>
    Number(insert.run(account, position, status, pnl).lastInsertRowid) }
}

test('a clear FX day retains an older ambiguous ledger gap without repairing it', t => {
  const { db, add } = fixture(t), closed = add(), open = add('11', '7', 'open')
  const before = db.prepare('SELECT * FROM trades ORDER BY id').all()
  const report = unknownPnlReport(db, { nowMs })
  assert.equal(report.summary.blocking, 0)
  assert.equal(report.history.total, 1)
  assert.equal(report.history.ambiguousPositionRows, 1)
  assert.equal(report.historyRows[0].reason, 'position_ledger_ambiguous')
  assert.deepEqual(report.historyRows[0].ledgerRows, [`${closed}:closed`, `${open}:open`])
  assert.equal(report.historyRows[0].matchingOpenRows, 1)
  assert.deepEqual(db.prepare('SELECT * FROM trades ORDER BY id').all(), before)
})

test('position identities remain account scoped and include priced or numeric-text peers', t => {
  const { db, add } = fixture(t)
  add('11', '7'); add('22', '7', 'closed', 12)
  assert.equal(pnlHistoryReport(db).historyRows[0].reason, 'broker_evidence_required')
  add('11', '007', 'closed', 12)
  const row = pnlHistoryReport(db).historyRows[0]
  assert.equal(row.reason, 'position_ledger_ambiguous')
  assert.equal(row.matchingLedgerRows, 2)
  assert.equal(row.matchingClosedRows, 2)
})

test('unattributed, invalid and written-off records remain explicit unknown money', t => {
  const { db, add } = fixture(t)
  add(null, '7'); add('11', null); add('11', 'not-an-id')
  const writtenOff = add('11', '9')
  db.prepare("UPDATE trades SET pnl_unresolvable=1,pnl_unresolvable_reason='old evidence absent' WHERE id=?").run(writtenOff)
  const report = pnlHistoryReport(db, { nowMs })
  assert.equal(report.history.total, 4); assert.equal(report.history.writtenOff, 1)
  assert.equal(report.history.unattributed, 1)
  assert.deepEqual(report.historyRows.map(r => r.reason), [
    'unattributed_account', 'missing_or_invalid_position_id', 'missing_or_invalid_position_id', 'written_off',
  ])
  assert.equal(report.historyRows[3].writtenOffReason, 'old evidence absent')
  assert.equal(report.historyRows[0].matchingLedgerRows, null)
})

test('bounded detail declares truncation while full counts remain exact', t => {
  const { db, add } = fixture(t)
  for (let i = 1; i <= 105; i++) add('11', String(i))
  for (let i = 0; i < 12; i++) add('11', '1', 'open')
  const report = pnlHistoryReport(db)
  assert.equal(report.history.total, 105); assert.equal(report.history.returned, 100)
  assert.equal(report.history.truncated, true)
  assert.equal(report.history.ambiguousPositionRows, 1)
  assert.equal(report.historyRows[0].matchingLedgerRows, 13)
  assert.equal(report.historyRows[0].ledgerRows.length, 10)
  assert.equal(report.historyRows[0].ledgerRowsTruncated, true)
})

test('failed reads are unavailable, not a zero gap', () => {
  const report = pnlHistoryReport({ prepare() { throw new Error('database unavailable') } })
  assert.equal(report.history.ok, false); assert.equal(report.history.total, null)
  assert.deepEqual(report.historyRows, [])
})
