// node --test agent/services/pnl-reconciliation.test.js
//
// §70.9 slice 2 — the P&L half of trade lineage.
//
// The defect these tests hold down is not that the repair fails; it is that
// nobody could tell WHETHER it had tried. "We tried repeatedly and gave up" is
// the evidence mark-unresolvable.js requires before writing a row off, and it
// lived in a module-level Map keyed by account — erased on every restart, on a
// service that redeploys with every push to main.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { noteTradeAttempts, exhaustedTradeIds, pnlReconciliationState } from './pnl-backfill.js'
import { CONTROLLERS } from './heartbeat.js'

const closed = (db, { symbol = 'EURUSD', pnl = null, accountId = '5203012', at = '2026-08-04 01:00:00' } = {}) =>
  db.prepare(`INSERT INTO trades (symbol, side, status, net_pnl, account_id, closed_at)
              VALUES (?, 'buy', 'closed', ?, ?, ?)`).run(symbol, pnl, accountId, at).lastInsertRowid

test('an attempt is recorded on every row the repair could not fill', () => {
  const db = initDB(':memory:')
  const stuck = closed(db)
  closed(db, { symbol: 'GBPUSD', pnl: -12.5 })   // already resolved
  assert.equal(noteTradeAttempts(db, { accountId: '5203012' }), 1, 'only the unresolved row')
  const row = db.prepare('SELECT pnl_attempts, pnl_last_attempt_at FROM trades WHERE id = ?').get(stuck)
  assert.equal(row.pnl_attempts, 1)
  assert.ok(row.pnl_last_attempt_at)
})

test('attempts ACCUMULATE — that is the whole point of persisting them', () => {
  // The per-account Map reset to zero on every deploy, so the evidence for
  // writing a row off could never build up on a frequently-deployed service.
  const db = initDB(':memory:')
  const id = closed(db)
  for (let i = 0; i < 5; i++) noteTradeAttempts(db, { accountId: '5203012' })
  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(id).pnl_attempts, 5)
})

test('a row that FILLS stops accruing attempts', () => {
  const db = initDB(':memory:')
  const id = closed(db)
  noteTradeAttempts(db, { accountId: '5203012' })
  db.prepare('UPDATE trades SET net_pnl = -40 WHERE id = ?').run(id)
  noteTradeAttempts(db, { accountId: '5203012' })
  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(id).pnl_attempts, 1)
})

test('an UNATTRIBUTED row is stamped by every account, because every account tried it', () => {
  // Its close may live in any account's deal history — that is exactly why it
  // blocks every account, and every pass genuinely does attempt it.
  const db = initDB(':memory:')
  const orphan = closed(db, { accountId: null })
  noteTradeAttempts(db, { accountId: '5203012' })
  noteTradeAttempts(db, { accountId: '46130058' })
  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(orphan).pnl_attempts, 2)
})

test('another account\'s row is NOT stamped by this account\'s pass', () => {
  const db = initDB(':memory:')
  const foreign = closed(db, { accountId: '99999999' })
  noteTradeAttempts(db, { accountId: '5203012' })
  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(foreign).pnl_attempts, null)
})

// ---------------------------------------------------------------------------
// exhausted = tried and never filled, and NOT a claim about why
// ---------------------------------------------------------------------------

test('a row becomes exhausted only after the threshold, never before', () => {
  const db = initDB(':memory:')
  const id = closed(db)
  for (let i = 0; i < 5; i++) noteTradeAttempts(db, { accountId: '5203012' })
  assert.deepEqual(exhaustedTradeIds(db, { minAttempts: 6 }), [])
  noteTradeAttempts(db, { accountId: '5203012' })
  assert.deepEqual(exhaustedTradeIds(db, { minAttempts: 6 }).map(r => r.id), [id])
})

test('a row already written off is not offered again', () => {
  const db = initDB(':memory:')
  const id = closed(db)
  for (let i = 0; i < 8; i++) noteTradeAttempts(db, { accountId: '5203012' })
  db.prepare('UPDATE trades SET pnl_unresolvable = 1 WHERE id = ?').run(id)
  assert.deepEqual(exhaustedTradeIds(db, { minAttempts: 6 }), [])
})

// ---------------------------------------------------------------------------
// the reading the heartbeat is built on
// ---------------------------------------------------------------------------

test('NEVER TRIED and CANNOT FILL are reported as different numbers', () => {
  // Reporting one number for both is how the earlier "deal history had no
  // matching close" log blamed broker coverage for what was an account-scoping
  // bug. A row nobody reached is our failure; a row tried twenty times is the
  // broker's.
  const db = initDB(':memory:')
  const tried = closed(db, { symbol: 'EURUSD' })
  closed(db, { symbol: 'XAUUSD' })                 // never attempted
  db.prepare('UPDATE trades SET pnl_attempts = 20 WHERE id = ?').run(tried)

  const st = pnlReconciliationState(db)
  assert.equal(st.unresolved, 2)
  assert.equal(st.neverTried, 1)
  assert.equal(st.maxAttempts, 20)
  assert.ok(st.oldestClosedAt)
})

test('a clean ledger reads as zero unresolved, not as an error', () => {
  const db = initDB(':memory:')
  closed(db, { pnl: 12 })
  assert.deepEqual(pnlReconciliationState(db), {
    unresolved: 0, oldestClosedAt: null, maxAttempts: 0, neverTried: 0,
  })
})

test('a broken query reports -1 rather than a confident zero', () => {
  // Zero unresolved is the "everything is reconciled" answer, and a failed
  // lookup must never be able to produce it.
  const db = initDB(':memory:')
  db.exec('DROP TABLE trades')
  const st = pnlReconciliationState(db)
  assert.equal(st.unresolved, -1)
  assert.equal(st.error, true)
})

test('the repair has its own controller light', () => {
  // It had none: a backfill that stopped was invisible until the daily-loss
  // veto fired hours later on a total it could no longer trust.
  assert.ok(CONTROLLERS.pnl_reconcile, 'pnl_reconcile must be registered or the panel cannot show it')
  assert.equal(CONTROLLERS.pnl_reconcile.tiedToLoop, true)
})
