import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  resolveViewedAccount, viewedAccountOf, scopeClause, whereClause, describeScope, ALL,
} from './viewed-account.js'
import { workspaceCoverage, INTENTIONALLY_GLOBAL } from './workspace-coverage.js'

function freshDb() {
  return initDB(':memory:')
}

function seedAccount(db, id) {
  db.prepare(
    `INSERT OR REPLACE INTO accounts (account_id, is_live, enabled, mode, params, updated_at)
     VALUES (?, 0, 1, 'active', '{}', '2026-08-03T00:00:00Z')`
  ).run(String(id))
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('with nothing requested it falls back to the trading account — today behaviour', () => {
  // This is what makes the resolver inert: a route that adopts it without the
  // UI passing anything answers exactly as it did before.
  const db = freshDb()
  seedAccount(db, '5203012')
  setState(db, 'ctrader_account_id', '5203012')
  const v = resolveViewedAccount(db, undefined)
  assert.equal(v.accountId, '5203012')
  assert.equal(v.scope, 'trading')
  assert.equal(v.known, true)
})

test('an explicit account beats the trading account — the whole point', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  seedAccount(db, '5067353')
  setState(db, 'ctrader_account_id', '5203012')
  const v = resolveViewedAccount(db, '5067353')
  assert.equal(v.accountId, '5067353')
  assert.equal(v.scope, 'explicit')
  assert.equal(v.tradingAccountId, '5203012', 'the trading account is still reported alongside')
})

test('all means unscoped, not "the trading account"', () => {
  const db = freshDb()
  setState(db, 'ctrader_account_id', '5203012')
  const v = resolveViewedAccount(db, ALL)
  assert.equal(v.accountId, null)
  assert.equal(v.scope, 'all')
})

test('with no trading account and nothing requested the read is unscoped, not broken', () => {
  const db = freshDb()
  const v = resolveViewedAccount(db, undefined)
  assert.equal(v.accountId, null)
  assert.equal(v.scope, 'none')
})

test('an unknown account is ANSWERED, not silently swapped for the trading one', () => {
  // The failure this prevents: returning a different account's numbers under
  // the requested account's name.
  const db = freshDb()
  seedAccount(db, '5203012')
  setState(db, 'ctrader_account_id', '5203012')
  const v = resolveViewedAccount(db, '9999999')
  assert.equal(v.accountId, '9999999')
  assert.equal(v.known, false)
  assert.match(describeScope(v), /not in the registry/)
})

test('whitespace and empty strings fall back rather than scoping to ""', () => {
  const db = freshDb()
  setState(db, 'ctrader_account_id', '5203012')
  assert.equal(resolveViewedAccount(db, '   ').accountId, '5203012')
  assert.equal(resolveViewedAccount(db, '').accountId, '5203012')
})

test('viewedAccountOf reads the express query and tolerates a bare object', () => {
  const db = freshDb()
  setState(db, 'ctrader_account_id', '5203012')
  assert.equal(viewedAccountOf(db, { query: { account: '77' } }).accountId, '77')
  assert.equal(viewedAccountOf(db, {}).accountId, '5203012')
  assert.equal(viewedAccountOf(db, null).accountId, '5203012')
})

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

test('the scope clause includes NULL rows — pre-stamping history is not hidden', () => {
  const c = scopeClause({ accountId: 'A' })
  assert.match(c.sql, /IS NULL/)
  assert.deepEqual(c.params, ['A'])
})

test('an unscoped view produces NO clause at all', () => {
  assert.deepEqual(scopeClause({ accountId: null }), { sql: '', params: [] })
  assert.deepEqual(whereClause(null), { sql: '', params: [] })
})

test('whereClause emits a full WHERE so callers never splice keywords by hand', () => {
  const w = whereClause({ accountId: 'A' })
  assert.match(w.sql, /^WHERE /)
  assert.deepEqual(w.params, ['A'])
})

test('the clause can target a qualified column for joins', () => {
  assert.match(scopeClause({ accountId: 'A' }, 't.account_id').sql, /t\.account_id/)
})

test('the fragments actually run against SQLite', () => {
  const db = freshDb()
  db.prepare(`INSERT INTO action_log (method, path, body, account_id) VALUES ('POST', '/x', '{}', 'A')`).run()
  db.prepare(`INSERT INTO action_log (method, path, body, account_id) VALUES ('POST', '/y', '{}', 'B')`).run()
  db.prepare(`INSERT INTO action_log (method, path, body, account_id) VALUES ('POST', '/z', '{}', NULL)`).run()
  const w = whereClause({ accountId: 'A' })
  const rows = db.prepare(`SELECT path FROM action_log ${w.sql} ORDER BY id`).all(...w.params)
  assert.deepEqual(rows.map(r => r.path), ['/x', '/z'], "A's own rows plus the unstamped one")
})

// ---------------------------------------------------------------------------
// Coverage — measured, including the gaps
// ---------------------------------------------------------------------------

test('action_log and backtest_runs are now scoped', () => {
  const db = freshDb()
  const cov = workspaceCoverage(db)
  for (const name of ['action_log', 'backtest_runs']) {
    const t = cov.tables.find(x => x.table === name)
    assert.equal(t.exists, true)
    assert.equal(t.scoped, true, `${name} should carry account_id`)
  }
})

test('every per-account table is scoped, and any that is not is NAMED', () => {
  const db = freshDb()
  const cov = workspaceCoverage(db)
  assert.deepEqual(cov.summary.tablesMissing, [],
    'a table listed as per-account without an account_id column is a gap, not a rounding error')
})

test('the intentionally-global tables are declared with a reason, not just omitted', () => {
  const db = freshDb()
  const cov = workspaceCoverage(db)
  const names = cov.intentionallyGlobal.map(g => g.table)
  for (const n of ['regimes', 'symbol_hours', 'controller_heartbeats', 'token_usage']) {
    assert.ok(names.includes(n), `${n} must be declared global on purpose`)
  }
  for (const g of cov.intentionallyGlobal) assert.ok(g.why, `${g.table} needs a stated reason`)
  assert.ok(INTENTIONALLY_GLOBAL.agent_state.includes('acct:'),
    'agent_state is scoped by key convention, and the note has to say so')
})

test('every route that is NOT account-aware says why', () => {
  // The earlier version of this test asserted there must be at least one gap.
  // That was true when it was written and stopped being true when the three
  // gap routes were scoped — a test that fails on progress is a bad test. The
  // durable property is that a non-aware route is never merely absent: it
  // either reports every account by design, or is correctly global, or is a
  // named gap. Silence is the only unacceptable answer.
  const db = freshDb()
  const cov = workspaceCoverage(db)
  assert.ok(cov.summary.routesAccountAware > 0)
  for (const r of cov.routes.filter(x => !x.accountAware)) {
    assert.ok(r.note, `${r.path} is not account-aware and does not say why`)
  }
})

test('partial scoping is reported as its own thing, not counted as a clean win', () => {
  // strategy-liveness scopes decisions/opened/closed but NOT signals, because
  // scans are account-independent market observations. Folding that into
  // "account-aware" would imply the whole funnel was filtered.
  const db = freshDb()
  const cov = workspaceCoverage(db)
  assert.ok(cov.summary.partiallyScoped.length > 0)
  for (const p of cov.summary.partiallyScoped) {
    assert.match(p.note, /^partial/)
  }
})

test('the report carries its own caveat about being hand-declared', () => {
  const db = freshDb()
  const cov = workspaceCoverage(db)
  assert.match(cov.summary.caveat, /hand-declared/)
  assert.equal(cov.declaredRoutes, cov.routes.length)
})

test('unstamped rows are counted, so "no history" and "old history" are distinguishable', () => {
  const db = freshDb()
  db.prepare(`INSERT INTO action_log (method, path, body, account_id) VALUES ('POST', '/x', '{}', NULL)`).run()
  const cov = workspaceCoverage(db)
  assert.ok(cov.summary.unstampedRows >= 1)
  assert.equal(cov.tables.find(t => t.table === 'action_log').unstamped, 1)
})
