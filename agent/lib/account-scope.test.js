import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { requestedAccount, accountWhere, countUnattributed } from './account-scope.js'

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
