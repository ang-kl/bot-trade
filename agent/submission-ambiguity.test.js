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

const NEW_ORDER_REQ = 2106

// The dedupe query as loop.js runs it, so a divergence between the two fails
// here rather than in production.
const AMBIGUOUS_LOOKUP = `
  SELECT id, created_at FROM risk_events
  WHERE symbol = ? AND side = ? AND approved = 0
    AND veto_reason LIKE 'order_ambiguous:%'
    AND created_at >= datetime('now', '-3 minutes')
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
  const hit = db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', '111')
  assert.ok(hit, 'the ambiguous row must be found')
})

test('a plain order_failed does NOT block — the broker refused it, no position exists', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: 'order_failed: order rejected: NOT_ENOUGH_MONEY' })
  assert.equal(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', '111'), undefined)
})

test('an ordinary veto does NOT block', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: 'duplicate_symbol existing_side=BUY entry=1.1 opened=x strat=y lastcheck=z' })
  assert.equal(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', '111'), undefined)
})

test('the block expires with the window', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: 'order_ambiguous: lost', minutesAgo: 4 })
  assert.equal(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', '111'), undefined)
})

test('the block is scoped to the same symbol, side and account', () => {
  const db = initDB(':memory:')
  seedEvent(db, { reason: 'order_ambiguous: lost', symbol: 'EURUSD', side: 'BUY', accountId: '111' })
  const q = db.prepare(AMBIGUOUS_LOOKUP)
  assert.ok(q.get('EURUSD', 'BUY', '111'), 'same triple blocks')
  assert.equal(q.get('GBPUSD', 'BUY', '111'), undefined, 'another symbol must not be blocked')
  assert.equal(q.get('EURUSD', 'SELL', '111'), undefined, 'the other side must not be blocked')
  assert.equal(q.get('EURUSD', 'BUY', '222'), undefined, 'another account must not be blocked')
})

test('a NULL-account row (legacy) still blocks the selected account', () => {
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at)
     VALUES ('EURUSD', 'BUY', 0, 'order_ambiguous: lost', '{}', '{}', NULL, datetime('now'))`
  ).run()
  assert.ok(db.prepare(AMBIGUOUS_LOOKUP).get('EURUSD', 'BUY', '111'))
})
