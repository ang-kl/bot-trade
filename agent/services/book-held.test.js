// node --test agent/services/book-held.test.js
//
// THE SHARED BOOK-HELD RULE (16-09-2026).
//
// This question — "does the momentum book hold this position?" — was asked in
// `naked-position-guard.js` and `weekend-bank.js` with two copies of the same
// query, and the copies were one commit from diverging: one was corrected to
// close a hole while the other kept it. Both copies filtered
// `position_id IS NOT NULL`, and that column is NULL for every book row opened
// through the resting-limit path, which nothing backfills.
//
// The cost of the hole was different on each side and equally bad: a 1.5R floor
// target on a runner meant to hold for weeks (protection audit), and a close
// ahead of a weekend (weekend bank).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB } from '../db.js'
import { bookHeldPositionIds, bookHeldTradeIds, makeBookHeldCheck } from './book-held.js'

const db0 = () => initDB(':memory:')

const book = (db, { acct = 'A', posId = null, tradeId = null, status = 'open', symbol = '0005.HK' } = {}) =>
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
              VALUES (?, ?, ?, ?, 'long', 160, 159.6, '2026-09-08T01:33:00Z', ?)`)
    .run(tradeId, acct, symbol, posId == null ? null : String(posId), status)

const trade = (db, { acct = 'A', posId, symbol = '0005.HK' }) =>
  db.prepare('INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES (?,?,?,?,?)')
    .run(symbol, 'long', 'open', acct, String(posId)).lastInsertRowid

test('a row with a position id is held by position id', () => {
  const db = db0()
  book(db, { posId: 111 })
  assert.equal(makeBookHeldCheck(db, 'A')(111), true)
})

test('THE HOLE: a row with a NULL position id is held through its TRADE', () => {
  const db = db0()
  const tid = trade(db, { posId: 222 })
  book(db, { tradeId: tid }) // position_id stays NULL, as the resting-limit path leaves it
  assert.equal(bookHeldPositionIds(db, 'A').has('222'), false, 'the position-id question alone cannot see it')
  assert.equal(makeBookHeldCheck(db, 'A')(222), true, 'the exemption must still fail CLOSED')
})

test('a caller that already knows the trade id does not need the lookup', () => {
  // The protection audit's findings carry `tradeId` from the trades join; the
  // weekend bank sees only a broker snapshot and must resolve it.
  const db = db0()
  book(db, { tradeId: 42 }) // no trades row at all
  assert.equal(makeBookHeldCheck(db, 'A')(999, 42), true)
  assert.equal(makeBookHeldCheck(db, 'A')(999), false, 'nothing to resolve through')
})

test('exit_sent counts as held; closed does not — on BOTH keys', () => {
  const db = db0()
  book(db, { posId: 1, status: 'exit_sent' })
  book(db, { posId: 2, status: 'closed' })
  const t3 = trade(db, { posId: 3 }); book(db, { tradeId: t3, status: 'exit_sent' })
  const t4 = trade(db, { posId: 4 }); book(db, { tradeId: t4, status: 'closed' })
  const holds = makeBookHeldCheck(db, 'A')
  assert.deepEqual([holds(1), holds(2), holds(3), holds(4)], [true, false, true, false])
})

test('scoped per account on both keys — the same id on another account is another position', () => {
  const db = db0()
  book(db, { acct: 'B', posId: 5 })
  const t6 = trade(db, { acct: 'B', posId: 6 }); book(db, { acct: 'B', tradeId: t6 })
  const onA = makeBookHeldCheck(db, 'A')
  assert.equal(onA(5), false)
  assert.equal(onA(6), false)
  const onB = makeBookHeldCheck(db, 'B')
  assert.equal(onB(5), true)
  assert.equal(onB(6), true)
})

test("a trade on another account cannot lend this account's book its exemption", () => {
  // The trades lookup is scoped too, so a position id reused across accounts
  // cannot resolve to a trade the other account's book holds.
  const db = db0()
  const tid = trade(db, { acct: 'B', posId: 7 })
  book(db, { acct: 'A', tradeId: tid }) // book row on A, trade row on B
  assert.equal(makeBookHeldCheck(db, 'A')(7), false, 'resolution must not cross accounts')
})

test('null accountId asks across every account', () => {
  const db = db0()
  book(db, { acct: 'A', posId: 8 })
  const t9 = trade(db, { acct: 'B', posId: 9 }); book(db, { acct: 'B', tradeId: t9 })
  const all = makeBookHeldCheck(db, null)
  assert.equal(all(8), true)
  assert.equal(all(9), true)
})

test('a position the book does not hold is not held, by either key', () => {
  const db = db0()
  book(db, { posId: 10 })
  const t11 = trade(db, { posId: 11 }); book(db, { tradeId: t11 })
  trade(db, { posId: 12 }) // a trade with no book row
  const holds = makeBookHeldCheck(db, 'A')
  assert.equal(holds(12), false, 'a trade is not a book row')
  assert.equal(holds(13), false, 'and an unknown position is not held')
  assert.equal(holds(null), false)
  assert.equal(holds(undefined), false)
})

test('an empty book never runs the trade lookup at all', () => {
  const db = db0()
  trade(db, { posId: 14 })
  const realPrepare = db.prepare.bind(db)
  const asked = []
  db.prepare = (sql) => { asked.push(sql); return realPrepare(sql) }
  const holds = makeBookHeldCheck(db, 'A')
  asked.length = 0
  assert.equal(holds(14), false)
  assert.deepEqual(asked, [], 'no trade ids held means nothing to resolve to')
})

test('the check never throws on an unreadable database — it answers "not held"', () => {
  const db = db0()
  const realPrepare = db.prepare.bind(db)
  db.prepare = (sql) => { if (/momentum_book|trades/.test(sql)) throw new Error('no such table'); return realPrepare(sql) }
  const holds = makeBookHeldCheck(db, 'A')
  assert.equal(holds(1), false)
  assert.deepEqual([...bookHeldPositionIds(db, 'A')], [])
  assert.deepEqual([...bookHeldTradeIds(db, 'A')], [])
})

test('bookHeldTradeIds ignores NULL trade ids the way bookHeldPositionIds ignores NULL position ids', () => {
  const db = db0()
  book(db, { posId: 15 })            // trade_id NULL
  book(db, { tradeId: 16 })          // position_id NULL
  assert.deepEqual([...bookHeldPositionIds(db, 'A')], ['15'])
  assert.deepEqual([...bookHeldTradeIds(db, 'A')], ['16'])
})

test('BOTH consumers resolve to this one module', async () => {
  // The whole point of the file. `book-hold-age.js` exists because
  // momentum-book.js imports momentum-account.js and the reverse is forbidden;
  // that constraint does NOT apply here — weekend-bank.js and
  // naked-position-guard.js do not import each other and neither is imported by
  // the momentum modules. Checked, not assumed. The reason for a third file is
  // the duplication rule alone.
  const wb = await import('./weekend-bank.js')
  const npg = await import('./naked-position-guard.js')
  assert.equal(wb.bookHeldPositionIds, bookHeldPositionIds)
  assert.equal(npg.bookHeldPositionIds, bookHeldPositionIds)
  assert.equal(npg.bookHeldTradeIds, bookHeldTradeIds)
  assert.equal(npg.makeBookHeldCheck, makeBookHeldCheck)
})

// ---------------------------------------------------------------------------
// ONE ID, ONE SPELLING (17-09-2026, second review).
//
// `lib/pos-id.js` states the repo-wide rule: every write of a broker position
// id and EVERY IN-JS COMPARISON of one goes through `normPosId`, because some
// paths once stored float-formatted ids ("234698574.0"). Bare `String()` here
// made the exemption fail OPEN on such an id — a book-held runner given a 1.5R
// target, or banked before a weekend. `db.js`'s boot migration repairs
// `trades.ctrader_position_id` but NOT `momentum_book.position_id`, which this
// module reads directly.
// ---------------------------------------------------------------------------

test('a float-formatted position_id in the BOOK is still held when asked as an integer', () => {
  const db = db0()
  book(db, { posId: '777.0' })
  assert.equal(makeBookHeldCheck(db, 'A')(777), true, 'the exemption must not fail open on a spelling')
  assert.equal(makeBookHeldCheck(db, 'A')('777'), true)
})

test('a float-formatted id in the QUERY matches an integer book row', () => {
  const db = db0()
  book(db, { posId: 888 })
  assert.equal(makeBookHeldCheck(db, 'A')('888.0'), true)
})

test('the trade lookup normalises both sides too', () => {
  const db = db0()
  // The trade carries the float spelling; the book row has no position id.
  const tid = db.prepare('INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES (?,?,?,?,?)')
    .run('0005.HK', 'long', 'open', 'A', '999.0').lastInsertRowid
  book(db, { tradeId: tid })
  assert.equal(makeBookHeldCheck(db, 'A')(999), true)
  assert.equal(makeBookHeldCheck(db, 'A')('999.0'), true)
})

test('the id sets themselves are normalised, not just the lookups', () => {
  const db = db0()
  book(db, { posId: '1010.0' })
  book(db, { tradeId: 20 })
  assert.deepEqual([...bookHeldPositionIds(db, 'A')], ['1010'])
  assert.deepEqual([...bookHeldTradeIds(db, 'A')], ['20'])
})
