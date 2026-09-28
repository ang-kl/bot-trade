import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { countUnattributed, scopeCoverage } from '../lib/account-scope.js'
import stateRouter from './state.js'

const INDEX = 'idx_risk_events_unattributed'
const scope = { accountId: 'A', all: false }
const retained = db => db.prepare('SELECT * FROM risk_events ORDER BY id').all()

function seed(db) {
  const insert = db.prepare(`INSERT INTO risk_events(account_id,symbol,side,created_at,approved)
    VALUES (?,?,'long','2026-09-27 12:00:00',0)`)
  for (const account of ['A', null, 'B', 'A', null, 'B']) insert.run(account, 'EURUSD')
  insert.run('A', 'GBPUSD')
  insert.run(null, 'GBPUSD')
}

async function readRoutes(db) {
  // A fresh router per observation avoids its response cache masking an
  // index-induced change in the actual HTTP list's tied-timestamp ordering.
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    const out = {}
    for (const query of ['account=A', 'account=all', 'account=unseen', 'account=A&symbol=eurusd&limit=2']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/state/risk-events?${query}`)
      assert.equal(response.status, 200)
      assert.notEqual(response.headers.get('x-cache'), 'hit')
      out[query] = await response.json()
    }
    return out
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test('risk legacy count reads only the NULL-row index without visiting risk-event payloads', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  seed(db)
  const prepare = db.prepare.bind(db)
  let countSql
  db.prepare = sql => {
    if (/SELECT COUNT\(\*\) AS n FROM risk_events WHERE account_id IS NULL/.test(sql)) countSql = sql
    return prepare(sql)
  }
  assert.equal(countUnattributed(db, 'risk_events'), 3)
  assert.ok(countSql, 'inspect the query the production helper actually executes')
  const plan = prepare(`EXPLAIN QUERY PLAN ${countSql}`).all()
  assert.ok(plan.some(row => row.detail.includes(INDEX)), JSON.stringify(plan))
  // The partial index stores ids for NULL-owned rows only. A deferred table
  // cursor is harmless, but reading a payload/account column would negate
  // the intended separation from the large retained-history pages.
  assert.ok(prepare(`EXPLAIN ${countSql}`).all().every(row => row.opcode !== 'Column'))
})

test('risk NULL-index upgrade preserves actual HTTP bodies, tied list order, scope coverage and retained rows', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-null-index-upgrade-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'fixture.db')
  let db = initDB(path)
  t.after(() => { if (db.open) db.close() })
  db.exec(`DROP INDEX IF EXISTS ${INDEX}`)
  seed(db)
  const before = retained(db)
  const coverage = scopeCoverage(db, { table: 'risk_events', scope })
  const response = await readRoutes(db)
  assert.deepEqual(response['account=A&symbol=eurusd&limit=2'].rows.map(r => r.id), [5, 4])
  db.close()
  for (let pass = 0; pass < 2; pass++) {
    db = initDB(path)
    assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('index', INDEX))
    assert.deepEqual(await readRoutes(db), response)
    assert.deepEqual(scopeCoverage(db, { table: 'risk_events', scope }), coverage)
    assert.deepEqual(retained(db), before)
    assert.equal(db.pragma('synchronous', { simple: true }), 2)
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    db.close()
  }
})

test('risk NULL index follows account-column migration and maintains truth through attribution and retention', t => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-null-legacy-upgrade-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'fixture.db')
  const old = new Database(path)
  old.exec(`CREATE TABLE risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, side TEXT, approved INTEGER,
    veto_reason TEXT, checks_json TEXT, proposal_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); INSERT INTO risk_events(symbol,side,approved,created_at) VALUES ('EURUSD','long',0,'2026-09-20')`)
  old.close()
  const db = initDB(path)
  t.after(() => db.close())
  assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('index', INDEX))
  assert.deepEqual(db.prepare('SELECT id,symbol,side,approved,created_at,account_id FROM risk_events').all(),
    [{ id: 1, symbol: 'EURUSD', side: 'long', approved: 0, created_at: '2026-09-20', account_id: null }])
  seed(db)
  const exact = () => assert.equal(countUnattributed(db, 'risk_events'),
    db.prepare('SELECT COUNT(*) AS n FROM risk_events NOT INDEXED WHERE account_id IS NULL').get().n)
  exact()
  db.prepare("UPDATE risk_events SET account_id='A' WHERE id=1").run()
  exact()
  db.prepare('UPDATE risk_events SET account_id=NULL WHERE id=2').run()
  exact()
  db.prepare("DELETE FROM risk_events WHERE created_at < '2026-09-28'").run()
  exact()
  assert.equal(countUnattributed(db, 'risk_events'), 0)
})
