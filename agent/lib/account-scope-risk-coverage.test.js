import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { accountWhere, scopeCoverage } from './account-scope.js'
import stateRouter from '../routes/state.js'

const ACCOUNT = { accountId: 'A', all: false }

function originalCoverage(db, { table, column = 'account_id', scope, extraWhere = '', extraParams = [] }) {
  const out = { total: 0, attributable: 0, unstamped: 0, pct: null, scoped: false }
  try {
    const acct = accountWhere(scope, column)
    const filt = extraWhere ? `WHERE (${extraWhere})` : ''
    if (!acct.active) {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${filt}`).get(...extraParams)
      out.total = Number(r?.n || 0)
      out.attributable = out.total
      out.pct = 100
      return out
    }
    out.scoped = true
    const r = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN ${column} = ? THEN 1 ELSE 0 END) AS attributable,
      SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END) AS unstamped
      FROM ${table} ${filt ? filt + ' AND' : 'WHERE'} ${acct.where}
    `).get(String(scope.accountId), ...extraParams, ...acct.params)
    out.total = Number(r?.total || 0)
    out.attributable = Number(r?.attributable || 0)
    out.unstamped = Number(r?.unstamped || 0)
    out.pct = out.total === 0 ? 100 : Math.round((out.attributable / out.total) * 1000) / 10
  } catch { out.pct = null }
  return out
}

function addRiskRows(db, accounts) {
  const insert = db.prepare(`INSERT INTO risk_events
    (account_id,symbol,side,created_at,approved)
    VALUES (?,?,'long','2026-09-27 12:00:00',0)`)
  db.transaction(() => accounts.forEach((account, i) => insert.run(account, i % 3 ? 'EURUSD' : 'GBPUSD')))()
}

test('risk coverage reads only the account range and NULL-row index in one statement', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  addRiskRows(db, ['A', null, 'B', 'A', null, 'B'])
  const prepare = db.prepare.bind(db)
  const statements = []
  db.prepare = sql => { statements.push(sql); return prepare(sql) }
  assert.deepEqual(scopeCoverage(db, { table: 'risk_events', scope: ACCOUNT }),
    { total: 4, attributable: 2, unstamped: 2, pct: 50, scoped: true })
  assert.equal(statements.length, 1, 'one statement gives both counts the same SQLite snapshot')
  const plan = prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all(...Array(
    prepare(statements[0]).source.match(/\?/g).length).fill('A')).map(row => row.detail)
  assert.ok(plan.some(detail => /SEARCH risk_events USING COVERING INDEX idx_risk_events_account_latest/.test(detail)), plan.join('\n'))
  assert.ok(plan.some(detail => detail.includes('idx_risk_events_unattributed')), plan.join('\n'))
  assert.ok(plan.every(detail => !detail.includes('idx_risk_events_lookback') && detail !== 'SCAN risk_events'), plan.join('\n'))
})

test('risk coverage retains exact scoped, NULL, skewed, empty and unscoped counts through reopen and mutations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-scope-coverage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'fixture.db')
  let db = initDB(path)
  t.after(() => { if (db.open) db.close() })
  const compare = () => {
    for (const scope of [ACCOUNT, { accountId: 'B' }, { accountId: 'unseen' },
      { accountId: '' }, { accountId: 123 }, { accountId: null }, { all: true }, null]) {
      const options = { table: 'risk_events', scope }
      assert.deepEqual(scopeCoverage(db, options), originalCoverage(db, options), JSON.stringify(scope))
    }
  }
  compare()
  addRiskRows(db, Array(100).fill(null)); compare()
  db.prepare("UPDATE risk_events SET account_id='B'").run(); compare()
  addRiskRows(db, [...Array(1000).fill('B'), 'A', null, '123', '']); compare()
  db.prepare("UPDATE risk_events SET account_id='A' WHERE id%7=0").run(); compare()
  db.prepare('UPDATE risk_events SET account_id=NULL WHERE id%11=0').run(); compare()
  const before = db.prepare('SELECT * FROM risk_events ORDER BY id').all()
  db.close(); db = initDB(path); compare()
  assert.deepEqual(db.prepare('SELECT * FROM risk_events ORDER BY id').all(), before)
  db.prepare('DELETE FROM risk_events WHERE id%5=0').run(); compare()
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
  assert.equal(db.pragma('synchronous', { simple: true }), 2)
})

test('coverage preserves predicates, aliases, unindexed tables and unknown-schema fallback', t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE risk_events (id INTEGER PRIMARY KEY, account_id TEXT, status TEXT);
    CREATE TABLE scans (id INTEGER PRIMARY KEY, account_id TEXT, status TEXT);
    CREATE TABLE old_risk_events (id INTEGER PRIMARY KEY, status TEXT);`)
  for (const table of ['risk_events', 'scans']) {
    const insert = db.prepare(`INSERT INTO ${table}(account_id,status) VALUES (?,?)`)
    for (const [account, status] of [['A','closed'], [null,'closed'], ['B','closed'], ['A','open']]) insert.run(account,status)
  }
  for (const options of [
    { table: 'risk_events', scope: ACCOUNT },
    { table: 'risk_events', scope: ACCOUNT, extraWhere: 'status = ? AND id >= ?', extraParams: ['closed', 2] },
    { table: 'risk_events AS r', column: 'r.account_id', scope: ACCOUNT, extraWhere: 'r.status = ?', extraParams: ['closed'] },
    { table: 'scans', scope: ACCOUNT },
    { table: 'old_risk_events', scope: ACCOUNT },
    { table: 'absent_table', scope: ACCOUNT },
    { table: 'risk_events', column: 'absent_column', scope: ACCOUNT },
    { table: 'risk_events', scope: ACCOUNT, extraWhere: 'status = ?', extraParams: [] },
    { table: 'risk_events', scope: ACCOUNT, extraParams: ['unexpected'] },
    { table: 'risk_events', scope: { all: true }, extraWhere: 'status = ?', extraParams: ['closed'] },
  ]) assert.deepEqual(scopeCoverage(db, options), originalCoverage(db, options), JSON.stringify(options))
  assert.deepEqual(scopeCoverage(db, { table: 'absent_table', scope: ACCOUNT }),
    { total: 0, attributable: 0, unstamped: 0, pct: null, scoped: true })
})

async function readRiskRoutes(db, original = false) {
  const prepare = db.prepare.bind(db)
  if (original) db.prepare = sql => {
    if (sql.includes('AS attributable') && sql.includes('AS unstamped') && sql.includes('FROM risk_events')) {
      return { get: account => {
        const { total, attributable, unstamped } = originalCoverage({ prepare }, { table: 'risk_events', scope: { accountId: account } })
        return { total, attributable, unstamped }
      } }
    }
    return prepare(sql)
  }
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
    db.prepare = prepare
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test('actual risk-event HTTP bodies and tied list order match the original coverage query', async t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  addRiskRows(db, ['A', null, 'B', 'A', null, 'B', 'A', null])
  const before = await readRiskRoutes(db, true)
  assert.deepEqual(before['account=A&symbol=eurusd&limit=2'].rows.map(row => row.id), [8, 5])
  assert.deepEqual(await readRiskRoutes(db), before)
})
