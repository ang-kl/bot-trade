// Tests for the per-guard veto breakdown (owner 2026-08-01: the data-backed
// version of "which guard eats how many entries").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { vetoBreakdown } from './veto-breakdown.js'

function mkDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, approved INTEGER, veto_reason TEXT,
      checks_json TEXT, proposal_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT, symbol TEXT, timeframe TEXT, strategy TEXT,
      stage TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
      detail_json TEXT, loop_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

test('groups vetoes by the machine-readable reason head, newest example kept', () => {
  const db = mkDb()
  const ins = db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at) VALUES (?,?,?,?)`)
  ins.run('INTC.US', 0, 'unknown_daily_pnl (account): 7 closed trade(s) today have no realised P&L', '2026-08-01 00:10:00')
  ins.run('EURUSD', 0, 'unknown_daily_pnl (account): 3 closed trade(s) today have no realised P&L', '2026-08-01 01:10:00')
  ins.run('BTCUSD', 0, 'tp_required — order has no take profit', '2026-08-01 00:20:00')
  ins.run('ETHUSD', 1, null, '2026-08-01 00:30:00')

  const out = vetoBreakdown(db, { days: 7 })
  assert.equal(out.summary.proposalsApproved, 1)
  assert.equal(out.summary.proposalsVetoed, 3)
  const top = out.guards[0]
  assert.equal(top.guard, 'unknown_daily_pnl (account)')
  assert.equal(top.count, 2)
  // Newest full string is the example, not the oldest.
  assert.match(top.example, /3 closed trade/)
  assert.equal(out.guards.find(g => g.guard.startsWith('tp_required')).count, 1)
})

test('upstream decision_log skips are counted per stage and account-filtered', () => {
  const db = mkDb()
  const ins = db.prepare(`INSERT INTO decision_log (account_id, symbol, stage, decision, reason) VALUES (?,?,?,?,?)`)
  ins.run('46130058', 'EURUSD', 'style_filter', 'skip', 'style mismatch: ranging')
  ins.run('46130058', 'GBPUSD', 'style_filter', 'skip', 'style mismatch: ranging')
  ins.run('47790949', 'USDJPY', 'lesson_decay', 'skip', 'decay below floor')
  ins.run(null, 'XAUUSD', 'dispatch', 'veto', 'market closed')
  ins.run('46130058', 'AUDUSD', 'news_gate', 'proceed', 'clear') // not a skip — excluded

  const all = vetoBreakdown(db, { days: 7 })
  assert.equal(all.summary.upstreamSkips, 4)

  const scoped = vetoBreakdown(db, { days: 7, account: '46130058' })
  // Two own rows + the NULL-account dispatch row; the other account's row is out.
  assert.equal(scoped.summary.upstreamSkips, 3)
  const style = scoped.guards.find(g => g.source === 'upstream:style_filter')
  assert.equal(style.count, 2)
  assert.equal(style.topSymbols.length, 2)
  assert.ok(scoped.note)
})

test('window bounds respected and empty db is a calm empty report', () => {
  const db = mkDb()
  db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at) VALUES (?,?,?,?)`)
    .run('OLD', 0, 'stale_reason', '2020-01-01 00:00:00')
  const out = vetoBreakdown(db, { days: 7 })
  assert.equal(out.summary.proposalsVetoed, 0)
  assert.deepEqual(out.guards, [])
  assert.equal(out.summary.approvalRate, null)
})
