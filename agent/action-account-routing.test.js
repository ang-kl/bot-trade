// node --test agent/action-account-routing.test.js
//
// AUDIT F-L4-02 — position management must address the position's OWN account
// and host, not whichever account happens to be selected globally. Before this,
// executeBrokerAction read `ctrader_account_id` and `ctrader_is_live` from
// agent_state, so with two accounts enabled a close for account B went out on
// account A's session — and because `ctrader_is_live` also picks the HOST, a
// demo position could be addressed against the live host. The failure surfaces
// as POSITION_NOT_FOUND, which the amend path treats as "already closed", so a
// live position could be recorded as gone.
//
// These tests cover the resolver and the SQL that feeds it. The WebSocket hop
// itself is exercised against a demo account outside CI.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from './db.js'
import { resolveActionAccount, executeBrokerAction, mayCloseDbOnlyAfterSkip } from './loop.js'

function mkDb() {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '111')
  setState(db, 'ctrader_is_live', 'false')
  db.prepare(
    `INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, ?, 1, 'active')`
  ).run('111', 0)
  db.prepare(
    `INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, ?, 1, 'active')`
  ).run('222', 1)
  return db
}

test('a NULL row account falls back to the selected account (legacy rows unchanged)', () => {
  const db = mkDb()
  const r = resolveActionAccount(db, null)
  assert.equal(r.accountId, '111')
  assert.equal(r.isLive, false)
  assert.equal(r.source, 'selected')
})

test('a row on the selected account resolves to it without touching the registry', () => {
  const db = mkDb()
  const r = resolveActionAccount(db, '111')
  assert.equal(r.accountId, '111')
  assert.equal(r.source, 'selected')
})

test('a row on ANOTHER account resolves to that account, not the selected one', () => {
  const db = mkDb()
  const r = resolveActionAccount(db, '222')
  assert.equal(r.accountId, '222')
  assert.equal(r.source, 'registry')
})

test('the host side comes from the ROW account, so a live row is never addressed on the demo host', () => {
  const db = mkDb() // selected account is DEMO
  const r = resolveActionAccount(db, '222') // …but this row is on a LIVE account
  assert.equal(r.isLive, true, 'live row must resolve isLive:true even while a demo account is selected')
})

test('the reverse also holds: a demo row while a live account is selected stays demo', () => {
  const db = mkDb()
  setState(db, 'ctrader_account_id', '222')
  setState(db, 'ctrader_is_live', 'true')
  const r = resolveActionAccount(db, '111')
  assert.equal(r.accountId, '111')
  assert.equal(r.isLive, false, 'demo row must not be addressed against the live host')
})

test('an account absent from the registry is REFUSED, never silently re-routed', () => {
  const db = mkDb()
  const r = resolveActionAccount(db, '999')
  assert.equal(r.source, 'unknown_account')
  assert.equal(r.accountId, null)
  assert.equal(r.isLive, null)
})

test('selectBrokerContext carries account_id, preferring the monitored row', () => {
  const db = mkDb()
  const stmt = db.prepare(`
    SELECT t.ctrader_position_id AS positionId, t.volume AS volumeLots,
           COALESCE(mp.account_id, t.account_id) AS accountId
    FROM monitored_positions mp
    LEFT JOIN trades t ON t.id = mp.trade_id
    WHERE mp.id = ?
  `)

  // monitored row stamped '222', trade row stamped '111' → monitored wins
  const t1 = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, opened_at, status, ctrader_position_id, account_id)
     VALUES ('EURUSD', 'BUY', 1.1, 0.02, datetime('now'), 'open', '7001', '111')`
  ).run().lastInsertRowid
  const m1 = db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status, account_id)
     VALUES ('EURUSD', ?, 'long', 1.1, 'active', '222')`
  ).run(t1).lastInsertRowid
  assert.equal(stmt.get(m1).accountId, '222')

  // monitored row NULL (pre-stamping) → the trade row's account is used
  const t2 = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, opened_at, status, ctrader_position_id, account_id)
     VALUES ('XAUUSD', 'SELL', 3400, 0.01, datetime('now'), 'open', '7002', '222')`
  ).run().lastInsertRowid
  const m2 = db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status)
     VALUES ('XAUUSD', ?, 'short', 3400, 'active')`
  ).run(t2).lastInsertRowid
  assert.equal(stmt.get(m2).accountId, '222')

  // both NULL → resolver falls back to the selected account
  const t3 = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, opened_at, status, ctrader_position_id)
     VALUES ('GER40', 'BUY', 18000, 0.1, datetime('now'), 'open', '7003')`
  ).run().lastInsertRowid
  const m3 = db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status)
     VALUES ('GER40', ?, 'long', 18000, 'active')`
  ).run(t3).lastInsertRowid
  assert.equal(stmt.get(m3).accountId, null)
  assert.equal(resolveActionAccount(db, stmt.get(m3).accountId).accountId, '111')
})

// ---------------------------------------------------------------------------
// The executor refuses an unknown account BEFORE it can reach a socket.
// ---------------------------------------------------------------------------

test('executeBrokerAction refuses a row whose account is not in the registry', async () => {
  const db = mkDb()
  const s = { selectBrokerContext: { get: () => ({ positionId: '7001', volumeLots: 0.02, accountId: '999' }) } }
  const out = await executeBrokerAction(db, s, { id: 1, symbol: 'EURUSD' }, { action: 'FULL_EXIT', reason: 'test' })
  assert.equal(out.skipped, true)
  assert.match(out.reason, /^account_not_in_registry:999$/)
})

// ---------------------------------------------------------------------------
// AUDIT F-L6-02 — only a genuinely-absent broker may be closed DB-only.
// ---------------------------------------------------------------------------

test('DB-only close is permitted ONLY for ctrader_not_configured', () => {
  assert.equal(mayCloseDbOnlyAfterSkip('ctrader_not_configured'), true)
  for (const reason of [
    'no_ctrader_position_id',
    'unknown_volume',
    'partial_below_min_volume',
    'account_not_in_registry:999',
    'unhandled_action:MOVE_TP',
    undefined,
  ]) {
    assert.equal(
      mayCloseDbOnlyAfterSkip(reason), false,
      `${String(reason)} may hide a live broker position — must NOT close the local row`,
    )
  }
})
