// Codex · №12,442 · 2026-10-09; codex-footprint: scan-report-order.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import { scopeCoverage } from './account-scope.js'
import stateRouter from '../routes/state.js'

const INDEX = 'idx_scans_scope_coverage'
const scope = { accountId: 'A', all: false }
const retained = db => db.prepare('SELECT * FROM scans ORDER BY id').all()

function seed(db) {
  const insert = db.prepare(`INSERT INTO scans(account_id,symbol,scanned_at,price,thesis)
    VALUES (?,'EURUSD','2026-09-27 12:00:00',1,?)`)
  for (const account of ['A', null, 'B', 'A', null, 'B']) insert.run(account, 'retained scan '.repeat(200))
  setState(db, 'ctrader_account_id', 'A')
}

async function readRoutes(db) {
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    const out = {}
    for (const query of ['', 'account=A', 'account=all', 'account=unseen']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/state/scans?${query}`)
      assert.equal(response.status, 200)
      assert.notEqual(response.headers.get('x-cache'), 'hit')
      out[query] = await response.json()
    }
    for (const path of ['scans/EURUSD', 'activity']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/state/${path}?account=A`)
      assert.equal(response.status, 200)
      const data = await response.json()
      out[path] = path === 'activity' ? data.activity.filter(row => row.kind === 'scan') : data.scans
    }
    return out
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test('scans coverage uses a compact covering index while the actual list keeps its time index', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  seed(db)
  const prepare = db.prepare.bind(db)
  let coverageSql
  db.prepare = sql => { coverageSql = sql; return prepare(sql) }
  assert.deepEqual(scopeCoverage(db, { table: 'scans', scope }),
    { total: 4, attributable: 2, unstamped: 2, pct: 50, scoped: true })
  const plan = prepare(`EXPLAIN QUERY PLAN ${coverageSql}`).all('A')
  assert.equal(plan.filter(row => /SEARCH scans USING COVERING INDEX idx_scans_account_coverage/.test(row.detail)).length, 2, JSON.stringify(plan))
  // The legacy covering index remains. Reports explicitly retain the time
  // index now that coverage can seek directly through its own account index.
  assert.deepEqual(db.pragma(`index_info(${INDEX})`).map(row => row.name), ['id', 'account_id'])
  const listSql = 'SELECT * FROM scans INDEXED BY idx_scans_at WHERE (account_id = ? OR account_id IS NULL) ORDER BY scanned_at DESC LIMIT 50'
  const listPlan = prepare(`EXPLAIN QUERY PLAN ${listSql}`).all('A')
  assert.ok(listPlan.some(row => row.detail.includes('USING INDEX idx_scans_at')), JSON.stringify(listPlan))
  assert.ok(listPlan.every(row => !row.detail.includes('TEMP B-TREE')), JSON.stringify(listPlan))
})

test('scans index upgrade retains full HTTP bodies, scope, tied rows, attribution and retention through reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'scans-scope-upgrade-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'fixture.db')
  let db = initDB(path)
  t.after(() => { if (db.open) db.close() })
  db.exec(`DROP INDEX IF EXISTS ${INDEX}`)
  seed(db)
  const before = retained(db)
  const response = await readRoutes(db)
  assert.deepEqual(response['account=A'].recentScans.map(row => row.id), [5, 4, 2, 1])
  assert.deepEqual(response[''].recentScans.map(row => row.id), [6, 5, 4, 3, 2, 1])
  assert.deepEqual(response['scans/EURUSD'].map(row => row.id), [5, 4, 2, 1])
  // The original UNION feed keeps insertion order within a tied scan time.
  assert.deepEqual(response.activity.map(row => row.id), [1, 2, 4, 5])
  db.close()
  for (let pass = 0; pass < 2; pass++) {
    db = initDB(path)
    assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('index', INDEX))
    assert.deepEqual(await readRoutes(db), response)
    assert.deepEqual(retained(db), before)
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(db.pragma('synchronous', { simple: true }), 2)
    db.close()
  }
  db = initDB(path)
  const exact = () => {
    const rows = db.prepare('SELECT account_id FROM scans NOT INDEXED WHERE account_id=? OR account_id IS NULL').all('A')
    const expected = { total: rows.length, attributable: rows.filter(row => row.account_id === 'A').length,
      unstamped: rows.filter(row => row.account_id === null).length, scoped: true }
    expected.pct = expected.total === 0 ? 100 : Math.round(expected.attributable / expected.total * 1000) / 10
    assert.deepEqual(scopeCoverage(db, { table: 'scans', scope }), expected)
  }
  db.prepare("UPDATE scans SET account_id='A' WHERE id=2").run(); exact()
  db.prepare('UPDATE scans SET account_id=NULL WHERE id=3').run(); exact()
  db.prepare("DELETE FROM scans WHERE scanned_at < '2026-09-28'").run(); exact()
  assert.equal(retained(db).length, 0)
})

test('scans covering index is created after account-column migration without changing global history', t => {
  const dir = mkdtempSync(join(tmpdir(), 'scans-scope-legacy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'fixture.db')
  const old = new Database(path)
  old.exec(`CREATE TABLE scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, bias TEXT,
    confidence REAL, thesis TEXT, timeframe TEXT, session_fit TEXT, trade_at TEXT,
    price REAL, trade_grade TEXT, desk_note TEXT, strategy TEXT,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now')), loop_id INTEGER
  ); INSERT INTO scans(symbol,scanned_at,price,thesis) VALUES ('EURUSD','2026-09-20',1,'old global scan')`)
  old.close()
  const db = initDB(path)
  t.after(() => db.close())
  assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('index', INDEX))
  assert.deepEqual(db.prepare('SELECT id,symbol,scanned_at,price,thesis,account_id FROM scans').all(),
    [{ id: 1, symbol: 'EURUSD', scanned_at: '2026-09-20', price: 1, thesis: 'old global scan', account_id: null }])
  assert.deepEqual(scopeCoverage(db, { table: 'scans', scope }),
    { total: 1, attributable: 0, unstamped: 1, pct: 0, scoped: true })
  assert.deepEqual(scopeCoverage(db, { table: 'scans', scope: { all: true } }),
    { total: 1, attributable: 1, unstamped: 0, pct: 100, scoped: false })
})
