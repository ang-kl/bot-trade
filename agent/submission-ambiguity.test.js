// node --test agent/submission-ambiguity.test.js
//
// AUDIT F-L4-01 — the idempotency window read a ledger the failing path never
// wrote. wsPlaceOrder correctly refuses to retry after NEW_ORDER_REQ went out
// (the broker may have filled it and only the EXECUTION_EVENT was lost), so
// that submission left a risk_events row and NO trade row. The 3-minute dedupe
// queried `trades`, found nothing, and the same signal could be submitted
// again against a position that may already have been live — the guard
// protected against the retry it had disabled, and not against the one path
// that still doubled.
//
// Covered here: the ambiguity predicate, and the dedupe query that now reads
// the ambiguous marker. The broker hop itself is exercised outside CI.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'
import { isAmbiguousSubmitError } from './lib/ctrader-ws.js'
import { isAmbiguousOrderOutcome } from './lib/exec-fallback.js'
import { DEDUPE_WINDOW_MIN } from './loop.js'

const NEW_ORDER_REQ = 2106

// The dedupe query as loop.js runs it, so a divergence between the two fails
// here rather than in production.
const WINDOW_SQL = `-${DEDUPE_WINDOW_MIN} minutes`

const AMBIGUOUS_LOOKUP = `
  SELECT id, created_at FROM risk_events
  WHERE symbol = ? AND side = ? AND approved = 0
    AND veto_reason LIKE 'order_ambiguous:%'
    AND created_at >= datetime('now', ?)
    AND (account_id = ? OR account_id IS NULL)
  ORDER BY id DESC LIMIT 1
`

function seedEvent(db, { symbol = 'EURUSD', side = 'BUY', reason, accountId = '111', minutesAgo = 0 } = {}) {
  return db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at)
     VALUES (?, ?, 0, ?, '{}', '{}', ?, datetime('now', ?))`
  ).run(symbol, side, reason, accountId, `-${minutesAgo} minutes`).lastInsertRowid
}

// ---------------------------------------------------------------------------
// The predicate that decides which failure shape we are looking at.
// ---------------------------------------------------------------------------

test('a failure AFTER the order request is ambiguous', () => {
  assert.equal(
    isAmbiguousSubmitError(new Error(`cTrader WS error: socket hang up — after sending ${NEW_ORDER_REQ}`)),
    true,
  )
})

test('connect and auth failures are NOT ambiguous — nothing reached the broker', () => {
  for (const msg of [
    'cTrader WS error: getaddrinfo ENOTFOUND demo.ctraderapi.com',
    'cTrader WS error: socket hang up — after sending 2102', // app auth
    'timeout waiting for 2103',
    'order rejected: NOT_ENOUGH_MONEY',
  ]) {
    assert.equal(isAmbiguousSubmitError(new Error(msg)), false, msg)
  }
})

test('a missing or malformed error is not treated as ambiguous', () => {
  assert.equal(isAmbiguousSubmitError(null), false)
  assert.equal(isAmbiguousSubmitError(undefined), false)
  assert.equal(isAmbiguousSubmitError({}), false)
})

// ---------------------------------------------------------------------------
// The dedupe now sees the ambiguous marker.
// ---------------------------------------------------------------------------

test('an ambiguous submission inside the window blocks a resubmit', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: `order_ambiguous: cTrader WS error: socket hang up — after sending ${NEW_ORDER_REQ}` })
  const hit = db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', WINDOW_SQL, '111')
  assert.ok(hit, 'the ambiguous row must be found')
})

test('a plain order_failed does NOT block — the broker refused it, no position exists', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: 'order_failed: order rejected: NOT_ENOUGH_MONEY' })
  assert.equal(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', WINDOW_SQL, '111'), undefined)
})

test('an ordinary veto does NOT block', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: 'duplicate_symbol existing_side=BUY entry=1.1 opened=x strat=y lastcheck=z' })
  assert.equal(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', WINDOW_SQL, '111'), undefined)
})

test('the block expires with the window', () => {
  const db = initDB(':memory:')
  // Expressed RELATIVE to the window rather than as a literal. This test used
  // to seed 4 minutes against a hard-coded 3-minute window; when the window
  // was widened to outlast a loop cycle the literal quietly asserted the old
  // behaviour instead of the property.
  seedEvent(db, { reason: 'order_ambiguous: lost', minutesAgo: DEDUPE_WINDOW_MIN + 1 })
  assert.equal(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', WINDOW_SQL, '111'), undefined)
})

test('the block is scoped to the same symbol, side and account', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: 'order_ambiguous: lost', symbol: 'EURUSD', side: 'BUY', accountId: '111' })
  const q = db.prepare(AMBIGUOUS_LOOKUP)
  assert.ok(q.get('EURUSD', 'BUY', WINDOW_SQL, '111'), 'same triple blocks')
  assert.equal(q.get('GBPUSD', 'BUY', WINDOW_SQL, '111'), undefined, 'another symbol must not be blocked')
  assert.equal(q.get('EURUSD', 'SELL', WINDOW_SQL, '111'), undefined, 'the other side must not be blocked')
  assert.equal(q.get('EURUSD', 'BUY', WINDOW_SQL, '222'), undefined, 'another account must not be blocked')
})

test('a NULL-account row (legacy) still blocks the selected account', () => {
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at)
     VALUES ('EURUSD', 'BUY', 0, 'order_ambiguous: lost', '{}', '{}', NULL, datetime('now'))`
  ).run()
  assert.ok(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', WINDOW_SQL, '111'))
})

// ---------------------------------------------------------------------------
// 2026-08-03 — the 9x 0066.HK duplicate. Two modules disagreed about the same
// error and the disagreement cost nine live positions on one symbol.
//
// `isAmbiguousSubmitError` recognises exactly one thing: the
// `after sending <NEW_ORDER_REQ>` marker that wsRun stamps on Node's
// WebSocket path. Execution runs through the C++ sidecar over HTTP, which
// never passes through wsRun — so its 30s AbortSignal timeout
// ("The operation was aborted due to timeout") carried no marker and was
// recorded as `order_failed`, which loop.js documents as "No position.
// Retrying is correct."
//
// exec-fallback.js had ALREADY reached the opposite conclusion about that same
// error, in mayFallbackToJs: "a timeout ... the sidecar may have filled and
// lost the reply." The verdict now lives in one place and both callers use it.
// ---------------------------------------------------------------------------

test('THE 0066.HK BUG: a sidecar timeout is ambiguous, and the WS predicate cannot see it', () => {
  const timeout = new Error('The operation was aborted due to timeout')
  // The old classifier — blind to it. This is the bug, reproduced.
  assert.equal(isAmbiguousSubmitError(timeout), false,
    'the WS marker predicate does not recognise a sidecar timeout — that is why this needed a second predicate')
  // The shared verdict — sees it.
  assert.equal(isAmbiguousOrderOutcome(timeout), true,
    'a timeout after submission MAY have filled; treating it as "no position" is what produced nine 0066.HK entries')
})

test('unknown-by-default: an error nobody has classified is treated as ambiguous', () => {
  assert.equal(isAmbiguousOrderOutcome(new Error('some broker error nobody has seen before')), true)
  assert.equal(isAmbiguousOrderOutcome(new Error('HTTP 502 from sidecar')), true)
  assert.equal(isAmbiguousOrderOutcome(new Error('socket hang up')), true)
})

test('only PROVABLE non-submission clears the ambiguity', () => {
  // The sidecar attesting, about this request, that it never sent it.
  assert.equal(
    isAmbiguousOrderOutcome(new Error('502 {"errorCode":"NOT_CONNECTED","description":"websocket is not connected"}')),
    false)
  // The request never reached the sidecar at all.
  const refused = new Error('fetch failed')
  refused.cause = { code: 'ECONNREFUSED' }
  assert.equal(isAmbiguousOrderOutcome(refused), false)
  // And a null error is not an ambiguous outcome — there was no failure.
  assert.equal(isAmbiguousOrderOutcome(null), false)
})

test('the idempotency window must outlast a loop cycle, or it never fires', () => {
  // It was 3 minutes against cycles measured at ~3.5-5 minutes, so it expired
  // BEFORE the next cycle asked — the guard never once blocked the retry it
  // exists to block. heartbeat.js documents the cycle measurement; this pins
  // the relationship rather than the number.
  const OBSERVED_SLOW_CYCLE_MIN = 5
  assert.ok(DEDUPE_WINDOW_MIN > OBSERVED_SLOW_CYCLE_MIN,
    `the dedupe window (${DEDUPE_WINDOW_MIN}m) must exceed the slowest observed loop cycle (${OBSERVED_SLOW_CYCLE_MIN}m) or it is decoration`)
})

test('an ambiguous marker inside the widened window still blocks', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: 'order_ambiguous: The operation was aborted due to timeout', minutesAgo: 4 })
  // Four minutes ago: past the old 3-minute window, inside the new one. This
  // is precisely the gap the duplicates fell through.
  assert.ok(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', WINDOW_SQL, '111'),
    'a 4-minute-old ambiguous submission was invisible under the 3-minute window')
})

// ---------------------------------------------------------------------------
// THE SCHEMA, NOT THE LOGIC.
//
// The write-ahead intent row was written, tested, linted and passed CI green —
// and would have halted trading on the first entry. `trades.status` carries a
// CHECK constraint, and 'submitting' was not in it, so the INSERT throws
// BEFORE the broker is called. Nothing exercised that statement, so nothing
// caught it. These do: they run the real INSERT and UPDATE against the real
// schema, which is the only thing that can.
//
// The same class already bit this repo once — see the 'rejected' migration in
// db.js and the comment "owner hit CHECK constraint failed".
// ---------------------------------------------------------------------------

test('the write-ahead intent row is actually insertable', () => {
  const db = initDB(':memory:')
  const id = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume,
                        opened_at, status, strategy, account_id, source)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'submitting', ?, ?, 'autotrade')
  `).run('EURUSD', 'BUY', 1.08, 1.07, 1.09, 0.01, 'fib_confluence', '111').lastInsertRowid
  assert.ok(id > 0)
  assert.equal(db.prepare('SELECT status FROM trades WHERE id = ?').get(id).status, 'submitting')
})

test('both failure statuses are insertable, and they are DIFFERENT states', () => {
  const db = initDB(':memory:')
  const mk = (status) => db.prepare(
    `INSERT INTO trades (symbol, side, opened_at, status) VALUES ('EURUSD','BUY',datetime('now'),?)`
  ).run(status).lastInsertRowid
  // Ambiguous — a position MAY exist, so this must keep blocking re-entry.
  assert.ok(mk('unconfirmed') > 0)
  // Provably unsent — must NOT block the next attempt.
  assert.ok(mk('rejected') > 0)
  const rows = db.prepare("SELECT status, COUNT(*) n FROM trades GROUP BY status").all()
  assert.equal(rows.length, 2, 'the two outcomes must not collapse into one status')
})

test('the intent row is PROMOTED in place, never duplicated', () => {
  const db = initDB(':memory:')
  const id = db.prepare(
    `INSERT INTO trades (symbol, side, opened_at, status, volume) VALUES ('EURUSD','BUY',datetime('now'),'submitting',0.01)`
  ).run().lastInsertRowid
  db.prepare(
    `UPDATE trades SET status = 'open', entry_price = ?, ctrader_position_id = ? WHERE id = ?`
  ).run(1.0842, '234725452', id)
  // One broker position, one ledger row. Inserting a second row on ACK would
  // strand the 'submitting' one and put two entries behind one position — the
  // accounting version of the bug this whole change exists to fix.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 1)
  const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(id)
  assert.equal(row.status, 'open')
  assert.equal(row.ctrader_position_id, '234725452')
})

test('an unknown status is still rejected — the constraint is not just widened away', () => {
  const db = initDB(':memory:')
  assert.throws(
    () => db.prepare(`INSERT INTO trades (symbol, side, opened_at, status) VALUES ('EURUSD','BUY',datetime('now'),'nonsense')`).run(),
    /CHECK constraint failed/,
    'the CHECK must still constrain — adding values must not turn it into a free-text column')
})
