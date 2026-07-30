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
  // keptReferenced joins the shape — a disabled sweep spares nothing because it
  // never looks, which is different from sparing something deliberately.
  assert.deepEqual(r, { trades: 0, postmortems: 0, orphanPostmortems: 0, keptReferenced: 0 })
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

// ---------------------------------------------------------------------------
// A trade referenced by monitored_positions cannot be deleted, and trying used
// to take the WHOLE sweep down.
//
// db.js:556 sets PRAGMA foreign_keys = ON, and monitored_positions.trade_id is
// `REFERENCES trades(id)` with no ON DELETE clause, so NO ACTION applies. The
// sweep deletes in ONE bulk statement, so a single referenced row raised
// "FOREIGN KEY constraint failed" and rolled the statement back — pruning
// nothing at all, including every unreferenced trade that was legitimately due.
//
// That is the real failure mode: not an orphaned row (the FK prevents that) but
// retention silently ceasing to work. monitored_positions rows are kept after
// they close, so any closed trade that ever had one is a permanent blocker, and
// on a real database that is most of them.
// ---------------------------------------------------------------------------

function insertMonitored(db, tradeId, status = 'active') {
  return db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, status) VALUES ('Corn', ?, ?)`
  ).run(tradeId, status).lastInsertRowid
}

test('a referenced trade is spared, and the OTHER due trades are still pruned', () => {
  const db = freshDB()
  const referenced = insertTrade(db, { symbol: 'Corn', closedDaysAgo: 800 })
  const unreferenced = insertTrade(db, { symbol: 'EURUSD', closedDaysAgo: 800 })
  insertMonitored(db, referenced)

  const r = pruneTradeHistory(db)
  assert.equal(r.trades, 1, 'the unreferenced trade was pruned — the sweep did NOT abort')
  assert.equal(r.keptReferenced, 1, 'and the spared one is reported, not silently skipped')
  assert.ok(db.prepare(`SELECT id FROM trades WHERE id = ?`).get(referenced))
  assert.equal(db.prepare(`SELECT id FROM trades WHERE id = ?`).get(unreferenced), undefined)
})

test('the pre-fix behaviour, demonstrated: an unguarded bulk delete throws and removes NOTHING', () => {
  // Kept as a test rather than a comment because the claim "one row breaks the
  // whole sweep" is the entire justification for the exclusion, and it is the
  // sort of claim that is easy to assert and wrong.
  const db = freshDB()
  const referenced = insertTrade(db, { symbol: 'Corn', closedDaysAgo: 800 })
  const unreferenced = insertTrade(db, { symbol: 'EURUSD', closedDaysAgo: 800 })
  insertMonitored(db, referenced)

  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'FKs are ON — that is what makes this fatal')
  assert.throws(
    () => db.prepare(`DELETE FROM trades WHERE status = 'closed'`).run(),
    /FOREIGN KEY constraint failed/,
  )
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades`).get().n, 2,
    'neither row went — the due-and-unreferenced trade was collateral damage')

  // The guarded sweep gets the one it can.
  const r = pruneTradeHistory(db)
  assert.equal(r.trades, 1)
  assert.ok(db.prepare(`SELECT id FROM trades WHERE id = ?`).get(referenced))
  assert.equal(db.prepare(`SELECT id FROM trades WHERE id = ?`).get(unreferenced), undefined)
})

test('a CLOSED monitored row protects its trade too — the FK does not care about status', () => {
  const db = freshDB()
  const tid = insertTrade(db, { symbol: 'Corn', closedDaysAgo: 800 })
  insertMonitored(db, tid, 'closed')
  const r = pruneTradeHistory(db)
  assert.equal(r.trades, 0)
  assert.equal(r.keptReferenced, 1)
  assert.ok(db.prepare(`SELECT id FROM trades WHERE id = ?`).get(tid))
})

test('a kept parent keeps its postmortem — parent and child use the same predicate', () => {
  const db = freshDB()
  const tid = insertTrade(db, { symbol: 'Corn', closedDaysAgo: 800 })
  insertPostmortem(db, tid, 800)
  insertMonitored(db, tid)
  setState(db, 'retention_json', JSON.stringify({ postmortemsDays: null }))
  const r = pruneTradeHistory(db)
  assert.equal(r.trades, 0)
  assert.equal(r.orphanPostmortems, 0, 'the forensics stayed with the ledger row that was kept')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trade_postmortems`).get().n, 1)
})

test('keptReferenced is 0 when nothing is referenced, and the sweep is unchanged', () => {
  const db = freshDB()
  insertTrade(db, { closedDaysAgo: 800 })
  insertTrade(db, { closedDaysAgo: 10 })
  const r = pruneTradeHistory(db)
  assert.equal(r.trades, 1)
  assert.equal(r.keptReferenced, 0)
})
