// node --test agent/monitor-scope.test.js
//
// Guards the invariant: autopilot's monitor SELECT must only return
// positions it placed itself. Copilot and manual positions — if ever
// ingested into monitored_positions — must be excluded so the
// autonomous loop never overrides a human's decision.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, sweepMonitoredPositionsForAccount, sweepMonitoredPositionsForAccounts } from './db.js'

function mkDb() {
  const db = initDB(':memory:')
  return db
}

const SELECT_ACTIVE = `
  SELECT * FROM monitored_positions
  WHERE status = ?
    AND COALESCE(paused, 0) = 0
    AND (source IS NULL OR source IN ('autopilot', 'external'))
`

function insertPosition(db, { symbol, source, label_raw, paused = 0, status = 'active', account_id = null }) {
  return db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk,
       source, label_raw, paused, status, account_id)
    VALUES (?, 'long', 100, 99, 110, 'x', 1, ?, ?, ?, ?, ?)
  `).run(symbol, source ?? null, label_raw ?? null, paused, status, account_id).lastInsertRowid
}

test('schema: monitored_positions has source + label_raw columns', () => {
  const db = mkDb()
  const cols = new Set(
    db.prepare('PRAGMA table_info(monitored_positions)').all().map(c => c.name),
  )
  assert.ok(cols.has('source'), 'source column should exist')
  assert.ok(cols.has('label_raw'), 'label_raw column should exist')
})

test('SELECT returns autopilot positions', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot', label_raw: 'AP|v1|TREND|HI|LDN|H1|REGT' })
  const rows = db.prepare(SELECT_ACTIVE).all('active')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'autopilot')
})

test('SELECT excludes copilot positions', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'EURUSD', source: 'copilot', label_raw: 'CP|v1|-|-|-|-|-' })
  const rows = db.prepare(SELECT_ACTIVE).all('active')
  assert.equal(rows.length, 0, 'copilot rows must be invisible to autopilot monitor')
})

test('SELECT excludes manual positions', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'USDJPY', source: 'manual', label_raw: 'MAN|v1|-|-|-|-|-' })
  const rows = db.prepare(SELECT_ACTIVE).all('active')
  assert.equal(rows.length, 0, 'manual rows must be invisible to autopilot monitor')
})

test('SELECT keeps legacy rows with NULL source (pre-migration autopilot trades)', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'GBPUSD', source: null, label_raw: null })
  const rows = db.prepare(SELECT_ACTIVE).all('active')
  assert.equal(rows.length, 1, 'NULL source treated as autopilot for backward compat')
})

test('SELECT filters out closed positions regardless of source', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot', status: 'closed' })
  insertPosition(db, { symbol: 'EURUSD', source: 'autopilot', status: 'active' })
  const rows = db.prepare(SELECT_ACTIVE).all('active')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].symbol, 'EURUSD')
})

test('SELECT filters out paused autopilot positions', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot', paused: 1 })
  insertPosition(db, { symbol: 'EURUSD', source: 'autopilot', paused: 0 })
  const rows = db.prepare(SELECT_ACTIVE).all('active')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].symbol, 'EURUSD')
})

test('SELECT includes external positions for monitoring', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'BTCUSD', source: 'external' })
  const rows = db.prepare(SELECT_ACTIVE).all('active')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'external')
})

test('mixed fleet: autopilot + external + legacy rows come back, copilot/manual excluded', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot' })
  insertPosition(db, { symbol: 'EURUSD', source: 'copilot' })
  insertPosition(db, { symbol: 'USDJPY', source: 'manual' })
  insertPosition(db, { symbol: 'GBPUSD', source: null })  // legacy
  insertPosition(db, { symbol: 'BTCUSD', source: 'external' })
  const rows = db.prepare(SELECT_ACTIVE).all('active')
  const symbols = rows.map(r => r.symbol).sort()
  assert.deepEqual(symbols, ['BTCUSD', 'GBPUSD', 'XAUUSD'])
})

// Account scoping — after a broker account switch, rows from the previous
// account (including legacy NULL account_id rows) must stop gating.

test('schema: monitored_positions has account_id column', () => {
  const db = mkDb()
  const cols = new Set(
    db.prepare('PRAGMA table_info(monitored_positions)').all().map(c => c.name),
  )
  assert.ok(cols.has('account_id'), 'account_id column should exist')
})

test('account sweep closes other-account and legacy rows, keeps new-account rows', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot', account_id: '111' })  // old acct
  insertPosition(db, { symbol: 'GBPUSD', source: 'autopilot', account_id: null })   // legacy
  insertPosition(db, { symbol: 'EURUSD', source: 'autopilot', account_id: '222' })  // new acct
  const swept = sweepMonitoredPositionsForAccount(db, '222')
  assert.equal(swept, 2)
  const active = db.prepare("SELECT symbol FROM monitored_positions WHERE status = 'active'").all()
  assert.deepEqual(active.map(r => r.symbol), ['EURUSD'])
  const closed = db.prepare(
    "SELECT last_check_action FROM monitored_positions WHERE status = 'closed'",
  ).all()
  assert.ok(closed.every(r => r.last_check_action === 'closed_account_switch'))
})

test('account sweep leaves already-closed rows untouched', () => {
  const db = mkDb()
  const id = insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot', account_id: '111', status: 'closed' })
  const swept = sweepMonitoredPositionsForAccount(db, '222')
  assert.equal(swept, 0)
  const row = db.prepare('SELECT last_check_action FROM monitored_positions WHERE id = ?').get(id)
  assert.equal(row.last_check_action, null)
})

test('multi-account sweep keeps every configured account, sweeps dropped ones', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot', account_id: '111' }) // still configured
  insertPosition(db, { symbol: 'EURUSD', source: 'autopilot', account_id: '222' }) // still configured
  insertPosition(db, { symbol: 'GBPUSD', source: 'autopilot', account_id: '333' }) // dropped
  const swept = sweepMonitoredPositionsForAccounts(db, ['111', 222]) // mixed string/number ids
  assert.equal(swept, 1)
  const active = db.prepare("SELECT symbol FROM monitored_positions WHERE status = 'active' ORDER BY symbol").all()
  assert.deepEqual(active.map(r => r.symbol), ['EURUSD', 'XAUUSD'])
})

test('multi-account sweep: sweepNull=false preserves legacy NULL rows', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'GBPUSD', source: 'autopilot', account_id: null })
  insertPosition(db, { symbol: 'USDJPY', source: 'autopilot', account_id: '999' })
  const swept = sweepMonitoredPositionsForAccounts(db, ['111'], { sweepNull: false })
  assert.equal(swept, 1)
  const active = db.prepare("SELECT symbol FROM monitored_positions WHERE status = 'active'").all()
  assert.deepEqual(active.map(r => r.symbol), ['GBPUSD'])
})

test('multi-account sweep: empty or invalid keep list sweeps NOTHING', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot', account_id: '111' })
  insertPosition(db, { symbol: 'GBPUSD', source: 'autopilot', account_id: null })
  assert.equal(sweepMonitoredPositionsForAccounts(db, []), 0)
  assert.equal(sweepMonitoredPositionsForAccounts(db, [undefined, null]), 0)
  assert.equal(sweepMonitoredPositionsForAccounts(db, undefined), 0)
  const active = db.prepare("SELECT COUNT(*) AS c FROM monitored_positions WHERE status = 'active'").get()
  assert.equal(active.c, 2)
})

test('single-account wrapper with an undefined id sweeps nothing', () => {
  const db = mkDb()
  insertPosition(db, { symbol: 'XAUUSD', source: 'autopilot', account_id: '111' })
  assert.equal(sweepMonitoredPositionsForAccount(db, undefined), 0)
})
