import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { requestedAccount, accountWhere, countUnattributed, scopeCoverage, scopeReport } from './account-scope.js'

function dbWithSelected(selected) {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT)')
  if (selected != null) {
    db.prepare('INSERT INTO agent_state (key, value) VALUES (?, ?)').run('ctrader_account_id', String(selected))
  }
  return db
}

test('requestedAccount falls back to the selected account', () => {
  const db = dbWithSelected('46130058')
  assert.deepEqual(requestedAccount(db, { query: {} }), {
    accountId: '46130058', all: false, explicit: false,
  })
})

test('requestedAccount honours an explicit account', () => {
  const db = dbWithSelected('46130058')
  const s = requestedAccount(db, { query: { account: '46979908' } })
  assert.equal(s.accountId, '46979908')
  assert.equal(s.all, false)
  assert.equal(s.explicit, true)
})

test('requestedAccount treats account=all as the portfolio view', () => {
  const db = dbWithSelected('46130058')
  for (const v of ['all', 'ALL', ' all ']) {
    const s = requestedAccount(db, { query: { account: v } })
    assert.equal(s.all, true, v)
    assert.equal(s.accountId, null, v)
  }
})

test('requestedAccount survives a fresh DB with nothing selected', () => {
  const db = dbWithSelected(null)
  assert.deepEqual(requestedAccount(db, { query: {} }), {
    accountId: null, all: false, explicit: false,
  })
  // No request object at all (an internal caller) must not throw.
  assert.equal(requestedAccount(db).accountId, null)
})

test('accountWhere filters on a real account and not otherwise', () => {
  const on = accountWhere({ accountId: '46130058', all: false }, 'mp.account_id')
  assert.equal(on.active, true)
  // NULL rows ride along, matching risk.js / perf-ledger.js / reconciler.js.
  // Excluding them made the Performance page stop reconciling with its own
  // ledger (PR #499 review).
  assert.equal(on.where, '(mp.account_id = ? OR mp.account_id IS NULL)')
  assert.deepEqual(on.params, ['46130058'])

  // all → no filter, so a route can interpolate unconditionally.
  for (const scope of [{ all: true, accountId: null }, { all: false, accountId: null }, null]) {
    const off = accountWhere(scope)
    assert.equal(off.active, false)
    assert.equal(off.where, '')
    assert.deepEqual(off.params, [])
  }
})

test('a scoped positions query returns ONE account — the whole point', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE monitored_positions (id INTEGER PRIMARY KEY, symbol TEXT, status TEXT, account_id TEXT)`)
  const ins = db.prepare('INSERT INTO monitored_positions (symbol, status, account_id) VALUES (?, ?, ?)')
  ins.run('BTCUSD', 'active', '46130058')
  ins.run('US2000', 'active', '46130058')
  ins.run('SOLUSD', 'active', '46979908')
  ins.run('OLDROW', 'active', null)          // pre-M1, unattributable
  ins.run('CLOSED', 'closed', '46130058')

  const scoped = accountWhere({ accountId: '46130058', all: false }, 'account_id')
  const rows = db.prepare(
    `SELECT symbol FROM monitored_positions WHERE status = 'active' AND ${scoped.where}`
  ).all(...scoped.params)
  // This account's rows, plus the unattributable legacy row — same policy as
  // every other account-scoped query in the codebase.
  assert.deepEqual(rows.map(r => r.symbol).sort(), ['BTCUSD', 'OLDROW', 'US2000'])

  // THE POINT: the OTHER account's position must not appear. This is the bug
  // the owner hit — every page showed every account's positions identically.
  // A NULL row belongs to no account, so including it leaks nothing; a row
  // stamped 46979908 does.
  assert.ok(!rows.some(r => r.symbol === 'SOLUSD'))

  // Unscoped still sees everything, for ?account=all.
  const all = db.prepare(`SELECT symbol FROM monitored_positions WHERE status = 'active'`).all()
  assert.equal(all.length, 4)

  // The NULL row is INCLUDED and counted, so the count can be stated.
  assert.equal(countUnattributed(db, 'monitored_positions', "status = 'active'"), 1)
})

test('countUnattributed is best-effort on a missing table', () => {
  const db = new Database(':memory:')
  assert.equal(countUnattributed(db, 'does_not_exist'), 0)
})

// ---------------------------------------------------------------------------
// S1 — coverage. `countUnattributed` counts NULLs over the WHOLE table, which
// is a footnote, not a per-panel signal. The number that would have caught the
// Go-Live Gate card on 2026-08-03 is the fraction of THE ROWS ON SCREEN that
// carry this account's id: six panels, one labelled LIVE, all showing the same
// 245 closed trades, because every row was NULL and satisfied every scoped
// read identically.
// ---------------------------------------------------------------------------
function tradesDb(selected = 'AAA') {
  const db = dbWithSelected(selected)
  db.exec(`CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT,
           status TEXT, account_id TEXT)`)
  const ins = db.prepare('INSERT INTO trades (status, account_id) VALUES (?, ?)')
  return { db, add: (acct, status = 'closed') => ins.run(status, acct) }
}
const CLOSED = "status = 'closed'"

test('THE GO-LIVE CARD: all-NULL rows report 0% coverage, not a clean answer', () => {
  const { db, add } = tradesDb()
  for (let i = 0; i < 5; i++) add(null)
  const cov = scopeCoverage(db, { table: 'trades', scope: requestedAccount(db, {}), extraWhere: CLOSED })
  assert.equal(cov.total, 5, 'the rows are still returned — this does not hide history')
  assert.equal(cov.attributable, 0)
  assert.equal(cov.unstamped, 5)
  assert.equal(cov.pct, 0, 'and the answer now SAYS none of it is this account')
})

test('a clean per-account read reports 100%', () => {
  const { db, add } = tradesDb()
  for (let i = 0; i < 4; i++) add('AAA')
  const cov = scopeCoverage(db, { table: 'trades', scope: requestedAccount(db, {}), extraWhere: CLOSED })
  assert.equal(cov.pct, 100)
  assert.equal(cov.unstamped, 0)
})

test('a MIXED read reports the fraction — the amber case', () => {
  const { db, add } = tradesDb()
  add('AAA'); add('AAA'); add('AAA'); add(null)
  add('BBB')   // another account's row must count toward neither side
  const cov = scopeCoverage(db, { table: 'trades', scope: requestedAccount(db, {}), extraWhere: CLOSED })
  assert.equal(cov.total, 4, "BBB's row is filtered out entirely")
  assert.equal(cov.attributable, 3)
  assert.equal(cov.unstamped, 1)
  assert.equal(cov.pct, 75)
})

test('coverage respects the CALLER predicate, not the whole table', () => {
  const { db, add } = tradesDb()
  add('AAA', 'closed')
  for (let i = 0; i < 50; i++) add(null, 'open')   // noise countUnattributed would count
  const cov = scopeCoverage(db, { table: 'trades', scope: requestedAccount(db, {}), extraWhere: CLOSED })
  assert.equal(cov.total, 1)
  assert.equal(cov.pct, 100, 'the open rows are not on this panel and must not colour it')
})

test('an EMPTY account is 100%, not a coverage failure', () => {
  const { db } = tradesDb()
  const cov = scopeCoverage(db, { table: 'trades', scope: requestedAccount(db, {}), extraWhere: CLOSED })
  // Painting "no trades yet" amber teaches the operator to ignore amber.
  assert.equal(cov.total, 0)
  assert.equal(cov.pct, 100)
})

test('?account=all is 100% — a portfolio view is doing what was asked', () => {
  const { db, add } = tradesDb()
  add('AAA'); add(null); add('BBB')
  const scope = requestedAccount(db, { query: { account: 'all' } })
  const cov = scopeCoverage(db, { table: 'trades', scope, extraWhere: CLOSED })
  assert.equal(cov.total, 3)
  assert.equal(cov.pct, 100)
  assert.equal(cov.scoped, false)
})

test('coverage NEVER takes the route down — a bad table degrades to unknown', () => {
  const { db } = tradesDb()
  const cov = scopeCoverage(db, { table: 'no_such_table', scope: requestedAccount(db, {}) })
  assert.equal(cov.pct, null, 'null renders as UNKNOWN, never as healthy')
})

test('scopeReport marks complete only at 100%', () => {
  const { db, add } = tradesDb()
  add('AAA'); add(null)
  const scope = requestedAccount(db, {})
  const rep = scopeReport(scope, scopeCoverage(db, { table: 'trades', scope, extraWhere: CLOSED }))
  assert.equal(rep.account, 'AAA')
  assert.equal(rep.coverage.pct, 50)
  assert.equal(rep.coverage.complete, false)
})

// S1 batch 3 — /state/attribution is the first caller to pass a BOUND
// parameter into the coverage predicate (its `closed_at >= ?` window). If the
// placeholders and the params bind out of order the query throws, coverage
// degrades to null, and the panel silently reads UNKNOWN forever — a coverage
// signal that fails open is the failure it exists to catch.
test('extraParams bind in the right order, scoped and unscoped', () => {
  const { db, add } = tradesDb()
  add('AAA', 'closed'); add(null, 'closed'); add('BBB', 'closed')
  add('AAA', 'open')                       // excluded by the predicate

  const scoped = scopeCoverage(db, {
    table: 'trades',
    scope: requestedAccount(db, {}),
    extraWhere: 'status = ?',
    extraParams: ['closed'],
  })
  assert.equal(scoped.total, 2, "AAA's closed row plus the unstamped one")
  assert.equal(scoped.attributable, 1)
  assert.equal(scoped.unstamped, 1)
  assert.equal(scoped.pct, 50)

  const portfolio = scopeCoverage(db, {
    table: 'trades',
    scope: requestedAccount(db, { query: { account: 'all' } }),
    extraWhere: 'status = ?',
    extraParams: ['closed'],
  })
  assert.equal(portfolio.total, 3, 'the open row stays out of both branches')
  assert.equal(portfolio.pct, 100)
})

// S1 batch 4 — /state/signals is "latest signal per symbol", a self-join. It
// needs the SAME predicate on the inner aggregate and on the aliased outer
// select, which is the first use of accountWhere with a qualified column.
// Filtering only the outer half picks the latest row across ALL accounts and
// then discards it if it belongs to another one: the symbol renders EMPTY
// rather than showing its own latest signal — worse than the unscoped answer.
test('accountWhere qualifies a column, so a self-join can scope both halves', () => {
  const db = dbWithSelected('AAA')
  db.exec(`CREATE TABLE signals (id INTEGER PRIMARY KEY AUTOINCREMENT,
           symbol TEXT, recorded_at TEXT, account_id TEXT)`)
  const ins = db.prepare('INSERT INTO signals (symbol, recorded_at, account_id) VALUES (?, ?, ?)')
  ins.run('EURUSD', '2026-01-01', 'AAA')
  ins.run('EURUSD', '2026-01-02', 'BBB')   // newer, but somebody else's
  ins.run('GBPUSD', '2026-01-03', null)    // legacy, unstamped — still ours

  const scope = requestedAccount(db, {})
  const inner = accountWhere(scope, 'account_id')
  const outer = accountWhere(scope, 's.account_id')
  assert.equal(outer.where, '(s.account_id = ? OR s.account_id IS NULL)')

  const rows = db.prepare(`
    SELECT s.* FROM signals s
    INNER JOIN (
      SELECT symbol, MAX(recorded_at) AS max_at FROM signals WHERE ${inner.where} GROUP BY symbol
    ) latest ON s.symbol = latest.symbol AND s.recorded_at = latest.max_at
    WHERE ${outer.where} ORDER BY s.recorded_at DESC
  `).all(...inner.params, ...outer.params)

  assert.deepEqual(rows.map(r => `${r.symbol}@${r.recorded_at}`), ['GBPUSD@2026-01-03', 'EURUSD@2026-01-01'],
    "EURUSD shows OUR latest, not BBB's newer one and not nothing")
})

// S1 batch 8 — /state/activity is a seven-way UNION. Six legs carry
// account_id; `regimes` does NOT, and db.js keeps it that way on purpose
// because a regime is a fact about an INSTRUMENT, not an account. The trap is
// that a UNION binds its parameters POSITIONALLY: six predicates means six
// copies of the same param, in order, and one miscount silently shifts every
// later leg's filter onto the wrong value. This pins the binding.
test('a multi-leg UNION binds one param per scoped leg, and skips the global leg', () => {
  const db = dbWithSelected('AAA')
  db.exec(`
    CREATE TABLE trades  (id INTEGER PRIMARY KEY, symbol TEXT, at TEXT, account_id TEXT);
    CREATE TABLE signals (id INTEGER PRIMARY KEY, symbol TEXT, at TEXT, account_id TEXT);
    CREATE TABLE regimes (id INTEGER PRIMARY KEY, symbol TEXT, at TEXT);
  `)
  db.prepare('INSERT INTO trades  (symbol, at, account_id) VALUES (?,?,?)').run('EURUSD', '2026-01-01', 'AAA')
  db.prepare('INSERT INTO trades  (symbol, at, account_id) VALUES (?,?,?)').run('GBPUSD', '2026-01-02', 'BBB')
  db.prepare('INSERT INTO signals (symbol, at, account_id) VALUES (?,?,?)').run('USDJPY', '2026-01-03', 'BBB')
  db.prepare('INSERT INTO regimes (symbol, at) VALUES (?,?)').run('NAS100', '2026-01-04')

  const scope = requestedAccount(db, {})
  const acct = accountWhere(scope, 'account_id')
  const w = acct.active ? ` WHERE ${acct.where}` : ''
  const p = acct.params
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT 'trade'  AS kind, symbol, at FROM trades${w}
      UNION ALL
      SELECT 'flip'   AS kind, symbol, at FROM signals${w}
      UNION ALL
      SELECT 'regime' AS kind, symbol, at FROM regimes
    ) ORDER BY at DESC
  `).all(...p, ...p)

  const kinds = rows.map(r => `${r.kind}:${r.symbol}`)
  assert.ok(kinds.includes('trade:EURUSD'), "our own account's row is kept")
  assert.ok(!kinds.includes('trade:GBPUSD'), "another account's trade is filtered")
  assert.ok(!kinds.includes('flip:USDJPY'), 'and so is its signal — the second leg bound correctly')
  assert.ok(kinds.includes('regime:NAS100'),
    'the GLOBAL leg survives a scoped read — dropping it would lose a row type, not scope it')
})
