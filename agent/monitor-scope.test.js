// node --test agent/monitor-scope.test.js
//
// Guards the invariant: autopilot's monitor SELECT must only return
// positions it placed itself. Copilot and manual positions — if ever
// ingested into monitored_positions — must be excluded so the
// autonomous loop never overrides a human's decision.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'

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

function insertPosition(db, { symbol, source, label_raw, paused = 0, status = 'active' }) {
  return db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk,
       source, label_raw, paused, status)
    VALUES (?, 'long', 100, 99, 110, 'x', 1, ?, ?, ?, ?)
  `).run(symbol, source ?? null, label_raw ?? null, paused, status).lastInsertRowid
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
