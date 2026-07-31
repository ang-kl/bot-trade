// The diagnosis behind the owner's three-day block: "unknown_daily_pnl … 7
// closed trade(s) today have no realised P&L". These tests pin that each row
// gets the RIGHT reason, and — the point of the report — that a row the
// backfill can never fill is called out as unfillable rather than pending.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB } from '../db.js'
import { unknownPnlReport } from './unknown-pnl-report.js'
import { fxDayStartSql } from './risk.js'

let db
beforeEach(() => { db = initDB(':memory:') })

/** Closed inside the current FX day, older than the grace window. */
function closedTrade(over = {}) {
  const dayStart = fxDayStartSql()
  const cols = {
    symbol: 'EURUSD', side: 'BUY', status: 'closed',
    // 30 minutes past the day start, and well past a 15-minute grace.
    closed_at: new Date(Date.parse(dayStart + 'Z') + 30 * 60_000).toISOString().slice(0, 19).replace('T', ' '),
    net_pnl: null, account_id: '46130058', ctrader_position_id: '900001',
    close_reason: 'broker_sl', exit_price: 1.09, ...over,
  }
  const keys = Object.keys(cols)
  const info = db.prepare(
    `INSERT INTO trades (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...keys.map(k => cols[k]))
  return info.lastInsertRowid
}

const opts = { enabledAccounts: ['46130058'], exhaustedAccounts: [] }

test('a row with no broker position id can NEVER be filled — and is named as such', () => {
  closedTrade({ ctrader_position_id: null })
  const out = unknownPnlReport(db, opts)
  assert.equal(out.ok, true)
  assert.equal(out.summary.blocking, 1)
  assert.equal(out.rows[0].reason, 'no_broker_position_id')
  assert.equal(out.rows[0].fillable, false)
  assert.equal(out.summary.unfillable, 1)
  assert.match(out.summary.verdict, /waiting will not clear this/)
})

test('an unattributed row is named — it blocks every account and can never be written off', () => {
  closedTrade({ account_id: null })
  const out = unknownPnlReport(db, opts)
  assert.equal(out.rows[0].reason, 'unattributed_account')
  assert.equal(out.rows[0].fillable, false)
})

test('a row on a disabled account is distinguished from an ordinary pending backfill', () => {
  closedTrade({ account_id: '43097342' })
  closedTrade({ ctrader_position_id: '900002' })
  const out = unknownPnlReport(db, opts)
  const byId = Object.fromEntries(out.rows.map(r => [r.accountId, r.reason]))
  assert.equal(byId['43097342'], 'account_not_enabled')
  assert.equal(byId['46130058'], 'backfill_pending')
  assert.equal(out.summary.byReason.backfill_pending, 1)
  assert.match(out.summary.verdict, /some blocking rows can never be filled/)
})

test('close reasons are counted, so a repeating daily cause is named not guessed', () => {
  closedTrade({ close_reason: 'weekend_flat', ctrader_position_id: '900003' })
  closedTrade({ close_reason: 'weekend_flat', ctrader_position_id: '900004' })
  closedTrade({ close_reason: null, ctrader_position_id: '900005' })
  const out = unknownPnlReport(db, opts)
  assert.equal(out.summary.byCloseReason.weekend_flat, 2)
  assert.equal(out.summary.byCloseReason['(none recorded)'], 1)
})

test('rows inside the grace window, filled rows and written-off rows do not block', () => {
  // Filled — has a P&L, nothing unknown about it.
  closedTrade({ net_pnl: -12.5, ctrader_position_id: '900006' })
  // Fresh close, inside the 15-minute grace: expected to be NULL for a cycle.
  closedTrade({
    ctrader_position_id: '900007',
    closed_at: new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '),
  })
  const id = closedTrade({ ctrader_position_id: '900008' })
  db.prepare('UPDATE trades SET pnl_unresolvable = 1 WHERE id = ?').run(id)
  const out = unknownPnlReport(db, opts)
  assert.equal(out.summary.blocking, 0)
  assert.equal(out.summary.writtenOff, 1)
  assert.match(out.summary.verdict, /nothing is blocking/)
})

test('an empty registry does not turn every row into account_not_enabled', () => {
  closedTrade({ account_id: '99999999' })
  const out = unknownPnlReport(db, { enabledAccounts: [], exhaustedAccounts: [] })
  assert.equal(out.rows[0].reason, 'backfill_pending')
})
