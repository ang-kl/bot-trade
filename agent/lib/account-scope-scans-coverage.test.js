// Codex · №12,434 · 2026-10-09; codex-footprint: reporting-query.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { accountWhere, scopeCoverage } from './account-scope.js'

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

function addScanRows(db, accounts) {
  const insert = db.prepare(`INSERT INTO scans
    (account_id,symbol,scanned_at)
    VALUES (?,?,'2026-09-27 12:00:00')`)
  db.transaction(() => accounts.forEach((account, i) => insert.run(account, i % 3 ? 'EURUSD' : 'GBPUSD')))()
}

test('scan coverage reads only the account range and NULL-row index in one statement', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  addScanRows(db, ['A', null, 'B', 'A', null, 'B'])
  const prepare = db.prepare.bind(db)
  const statements = []
  db.prepare = sql => { statements.push(sql); return prepare(sql) }
  assert.deepEqual(scopeCoverage(db, { table: 'scans', scope: ACCOUNT }),
    { total: 4, attributable: 2, unstamped: 2, pct: 50, scoped: true })
  assert.equal(statements.length, 1, 'one statement gives both counts the same SQLite snapshot')
  const plan = prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all(...Array(
    prepare(statements[0]).source.match(/\?/g).length).fill('A')).map(row => row.detail)
  assert.ok(plan.some(detail => /SEARCH scans USING COVERING INDEX idx_scans_account_coverage/.test(detail)), plan.join('\n'))
  assert.equal(plan.filter(detail => /SEARCH scans USING COVERING INDEX idx_scans_account_coverage/.test(detail)).length, 2, plan.join('\n'))
  assert.ok(plan.every(detail => !detail.includes('idx_scans_lookback') && detail !== 'SCAN scans'), plan.join('\n'))
})

test('scan coverage retains exact scoped, NULL, skewed, empty and unscoped counts through reopen and mutations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-scope-coverage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'fixture.db')
  let db = initDB(path)
  t.after(() => { if (db.open) db.close() })
  const compare = () => {
    for (const scope of [ACCOUNT, { accountId: 'B' }, { accountId: 'unseen' },
      { accountId: '' }, { accountId: 123 }, { accountId: null }, { all: true }, null]) {
      const options = { table: 'scans', scope }
      assert.deepEqual(scopeCoverage(db, options), originalCoverage(db, options), JSON.stringify(scope))
    }
  }
  compare()
  addScanRows(db, Array(100).fill(null)); compare()
  db.prepare("UPDATE scans SET account_id='B'").run(); compare()
  addScanRows(db, [...Array(1000).fill('B'), 'A', null, '123', '']); compare()
  db.prepare("UPDATE scans SET account_id='A' WHERE id%7=0").run(); compare()
  db.prepare('UPDATE scans SET account_id=NULL WHERE id%11=0').run(); compare()
  const before = db.prepare('SELECT * FROM scans ORDER BY id').all()
  db.exec('DROP INDEX idx_scans_account_coverage')
  db.close(); db = initDB(path); compare()
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_scans_account_coverage'").get())
  assert.deepEqual(db.prepare('SELECT * FROM scans ORDER BY id').all(), before)
  db.prepare('DELETE FROM scans WHERE id%5=0').run(); compare()
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
  assert.equal(db.pragma('synchronous', { simple: true }), 2)
})

