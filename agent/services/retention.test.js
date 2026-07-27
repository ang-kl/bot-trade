// node --test agent/services/retention.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { loadRetentionConfig, pruneTradeHistory, DEFAULT_RETENTION } from './retention.js'

function freshDB() { return initDB(':memory:') }

function insertTrade(db, { symbol = 'EURUSD', status = 'closed', closedDaysAgo = null } = {}) {
  const closedAt = closedDaysAgo != null
    ? new Date(Date.now() - closedDaysAgo * 86_400_000).toISOString()
    : null
  return db.prepare(
    `INSERT INTO trades (symbol, status, closed_at) VALUES (?, ?, ?)`
  ).run(symbol, status, closedAt).lastInsertRowid
}

function insertPostmortem(db, tradeId, createdDaysAgo = 0) {
  const createdAt = new Date(Date.now() - createdDaysAgo * 86_400_000).toISOString()
  return db.prepare(
    `INSERT INTO trade_postmortems (trade_id, symbol, created_at) VALUES (?, 'EURUSD', ?)`
  ).run(tradeId, createdAt).lastInsertRowid
}

test('defaults: ~2-year horizons; saved values merge; null disables', () => {
  const db = freshDB()
  assert.deepEqual(loadRetentionConfig(db), DEFAULT_RETENTION)
  assert.equal(DEFAULT_RETENTION.tradesDays, 730)
  setState(db, 'retention_json', JSON.stringify({ tradesDays: null }))
  assert.equal(loadRetentionConfig(db).tradesDays, null)
  assert.equal(loadRetentionConfig(db).postmortemsDays, 730) // default preserved
})

test('closed trades past the horizon are pruned; recent ones survive', () => {
  const db = freshDB()
  insertTrade(db, { closedDaysAgo: 800 })
  insertTrade(db, { closedDaysAgo: 10 })
  const r = pruneTradeHistory(db)
  assert.equal(r.trades, 1)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades`).get().n, 1)
})

test('non-closed trades are NEVER pruned, however old', () => {
  const db = freshDB()
  // An ancient open row is a reconciliation problem, not garbage.
  db.prepare(
    `INSERT INTO trades (symbol, status, opened_at) VALUES ('EURUSD', 'open', ?)`
  ).run(new Date(Date.now() - 900 * 86_400_000).toISOString())
  insertTrade(db, { status: 'closed', closedDaysAgo: null }) // closed but no closed_at → untouched too
  const r = pruneTradeHistory(db)
  assert.equal(r.trades, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades`).get().n, 2)
})

test('space-separated closed_at (SQLite datetime format) is compared correctly', () => {
  const db = freshDB()
  const old = new Date(Date.now() - 800 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  db.prepare(`INSERT INTO trades (symbol, status, closed_at) VALUES ('EURUSD', 'closed', ?)`).run(old)
  assert.equal(pruneTradeHistory(db).trades, 1)
})

test('postmortems: pruned past their own horizon; fresh parented ones survive', () => {
  const db = freshDB()
  const keepId = insertTrade(db, { closedDaysAgo: 10 })
  insertPostmortem(db, keepId, 10)      // fresh + parented → survives
  insertPostmortem(db, null, 800)       // ancient, no parent FK → pruned by horizon
  const r = pruneTradeHistory(db)
  assert.equal(r.postmortems, 1)
  assert.equal(r.orphanPostmortems, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trade_postmortems`).get().n, 1)
})

test('null horizons disable the sweep entirely', () => {
  const db = freshDB()
  const id = insertTrade(db, { closedDaysAgo: 3000 })
  insertPostmortem(db, id, 3000)
  setState(db, 'retention_json', JSON.stringify({ tradesDays: null, postmortemsDays: null }))
  const r = pruneTradeHistory(db)
  assert.deepEqual(r, { trades: 0, postmortems: 0, orphanPostmortems: 0 })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades`).get().n, 1)
})

test('pruning an old trade orphans its postmortem → same pass sweeps it', () => {
  const db = freshDB()
  const oldId = insertTrade(db, { closedDaysAgo: 800 })
  insertPostmortem(db, oldId, 10) // postmortem itself is fresh
  const r = pruneTradeHistory(db)
  assert.equal(r.trades, 1)
  assert.equal(r.orphanPostmortems, 1)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trade_postmortems`).get().n, 0)
})
