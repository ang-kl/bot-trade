// node --test agent/services/horizon-protection.test.js
//
// §4-P (21-09-2026, owner: "verify that intraday management rules cannot
// accidentally tighten or close weeks-horizon positions"). The answer at the
// time of writing was NO, they cannot be verified — they can.
//
// THE SHAPE. Every protection a weeks-horizon position has is keyed on
// MEMBERSHIP OF THE MOMENTUM BOOK (`book-held.js`) plus
// `monitored_positions.paused`, never on the position's horizon. So the
// protection is exactly as good as the book row, and the book row has a hole:
//
//   `momentum-account.js` places the daily entry through `autoTrade`, then
//   looks the filled trade up with a query that requires `status = 'open'`.
//   On the CLOSED-MARKET path the order rests as a limit and no such trade
//   exists yet, so the lookup misses and the book row is inserted with
//   trade_id NULL *and* position_id NULL — an ORPHAN that names nothing.
//
// Two consequences, and the second is the expensive one:
//
//   1. `makeBookHeldCheck` cannot see an orphan row on either key, so the
//      position it stands for is exempt from nothing.
//   2. When the limit finally fills, `momentum-book.js`'s adopt pass asks
//      `openRow.get(accountId, symbol)` and finds the orphan — so it
//      `continue`s. The fill is NEVER adopted, the keeper is NEVER paused,
//      and the 1.5R take profit a closed-market limit carries is NEVER
//      cleared. Permanently, and silently: nothing counts or logs it.
//
// MEASURED IN PRODUCTION 21-09-2026 while writing this file: of 36 open book
// positions, four still carry a `current_tp` — GD.US trade 1447 entry 363.61,
// stop 345.46, target 390.84, i.e. a 1.5R ceiling (risk 18.15, reward 27.23)
// on a trend position opened 03-09 and meant to run for weeks. Those four are
// paused, so this file's cases are the mechanism, not that incident — but a
// 1.5R cap on a weeks-horizon runner is precisely what the hole produces.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB } from '../db.js'
import { makeBookHeldCheck } from './book-held.js'
import { adoptOrBackfill, bookEntryWrite } from './book-entry-write.js'

const db0 = () => initDB(':memory:')

/** A book row exactly as the daily pass writes it when its trade lookup misses. */
const orphanRow = (db, { acct = 'A', symbol = 'GD.US' } = {}) =>
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entry_rank, entered_at, status, note)
              VALUES (NULL, ?, ?, NULL, 'long', 363.61, 345.46, 0.02, '2026-09-03T13:41:09Z', 'open', 'daily pass: vol-target 4 lots')`)
    .run(acct, symbol).lastInsertRowid

/** The trade the resting limit becomes hours later, with its 1.5R target. */
const filledTrade = (db, { acct = 'A', symbol = 'GD.US', posId = 240505687 } = {}) => {
  const id = db.prepare(
    `INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, label_strategy, entry_price, sl_price, tp_price)
     VALUES (?, 'BUY', 'open', ?, ?, 'tsmom_long', 363.61, 345.46, 390.84)`,
  ).run(symbol, acct, String(posId)).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (trade_id, symbol, status, paused, current_sl, current_tp)
     VALUES (?, ?, 'active', 0, 345.46, 390.84)`,
  ).run(id, symbol)
  return id
}

const monitored = (db, tradeId) =>
  db.prepare('SELECT paused, current_tp FROM monitored_positions WHERE trade_id = ?').get(tradeId)

// ───────────────────────────────────────────────────────────────────────────
// 1. The orphan row itself
// ───────────────────────────────────────────────────────────────────────────

test('an orphan book row protects nothing — the exemption cannot see it on either key', () => {
  const db = db0()
  orphanRow(db)
  const tradeId = filledTrade(db)
  const holds = makeBookHeldCheck(db, 'A')
  assert.equal(holds(240505687), false, 'position id: the row names none')
  assert.equal(holds(240505687, tradeId), false, 'trade id: the row names none')
})

// ───────────────────────────────────────────────────────────────────────────
// 2. THE DEFECT — the fill is never adopted because the orphan blocks it
// ───────────────────────────────────────────────────────────────────────────

test('THE DEFECT: an orphan row must be BACKFILLED by the fill, never skipped', () => {
  const db = db0()
  const rowId = orphanRow(db)
  const tradeId = filledTrade(db)

  const out = adoptOrBackfill(db, {
    accountId: 'A',
    trade: db.prepare('SELECT id, symbol, side, ctrader_position_id, entry_price, sl_price FROM trades WHERE id = ?').get(tradeId),
    existingRow: db.prepare('SELECT * FROM momentum_book WHERE id = ?').get(rowId),
    now: Date.parse('2026-09-03T21:10:00Z'),
  })

  assert.equal(out.action, 'backfilled', 'the orphan is completed, not skipped')

  const row = db.prepare('SELECT trade_id, position_id FROM momentum_book WHERE id = ?').get(rowId)
  assert.equal(row.trade_id, tradeId, 'the row now names its trade')
  assert.equal(row.position_id, '240505687', 'and its broker position')

  const only = db.prepare("SELECT COUNT(*) AS n FROM momentum_book WHERE account_id = 'A' AND status = 'open'").get().n
  assert.equal(only, 1, 'backfill completes the row, never duplicates it')
})

test('THE COST: backfilling pauses the keeper and clears the 1.5R limit target', () => {
  const db = db0()
  const rowId = orphanRow(db)
  const tradeId = filledTrade(db)
  assert.deepEqual(monitored(db, tradeId), { paused: 0, current_tp: 390.84 }, 'before: keeper-managed, capped at 1.5R')

  adoptOrBackfill(db, {
    accountId: 'A',
    trade: db.prepare('SELECT id, symbol, side, ctrader_position_id, entry_price, sl_price FROM trades WHERE id = ?').get(tradeId),
    existingRow: db.prepare('SELECT * FROM momentum_book WHERE id = ?').get(rowId),
    now: Date.now(),
  })

  assert.deepEqual(monitored(db, tradeId), { paused: 1, current_tp: null }, 'after: book-managed, no ceiling')
  assert.equal(db.prepare('SELECT tp_price FROM trades WHERE id = ?').get(tradeId).tp_price, null, 'and the trade carries no target')
})

test('after the backfill the exemption sees it on both keys', () => {
  const db = db0()
  const rowId = orphanRow(db)
  const tradeId = filledTrade(db)
  adoptOrBackfill(db, {
    accountId: 'A',
    trade: db.prepare('SELECT id, symbol, side, ctrader_position_id, entry_price, sl_price FROM trades WHERE id = ?').get(tradeId),
    existingRow: db.prepare('SELECT * FROM momentum_book WHERE id = ?').get(rowId),
    now: Date.now(),
  })
  const holds = makeBookHeldCheck(db, 'A')
  assert.equal(holds(240505687), true)
  assert.equal(holds(999, tradeId), true)
})

// ───────────────────────────────────────────────────────────────────────────
// 3. A row that already names its trade is NOT touched
// ───────────────────────────────────────────────────────────────────────────

test('a complete row is left alone — backfill never re-points a live row', () => {
  const db = db0()
  const other = filledTrade(db, { posId: 111 })
  const rowId = db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
                            VALUES (?, 'A', 'GD.US', '111', 'long', 363.61, 345.46, '2026-09-03T13:41:09Z', 'open')`).run(other).lastInsertRowid
  const later = filledTrade(db, { posId: 222 })

  const out = adoptOrBackfill(db, {
    accountId: 'A',
    trade: db.prepare('SELECT id, symbol, side, ctrader_position_id, entry_price, sl_price FROM trades WHERE id = ?').get(later),
    existingRow: db.prepare('SELECT * FROM momentum_book WHERE id = ?').get(rowId),
    now: Date.now(),
  })

  assert.equal(out.action, 'skipped', 'the book already holds this symbol through a real trade')
  assert.equal(db.prepare('SELECT trade_id FROM momentum_book WHERE id = ?').get(rowId).trade_id, other, 'unchanged')
})

test('a half-orphan — position id NULL but trade id set — is already held and is left alone', () => {
  // This is the ordinary resting-limit row `book-held.js` was written for.
  const db = db0()
  const tradeId = filledTrade(db)
  const rowId = db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
                            VALUES (?, 'A', 'GD.US', NULL, 'long', 363.61, 345.46, '2026-09-03T13:41:09Z', 'open')`).run(tradeId).lastInsertRowid
  const out = adoptOrBackfill(db, {
    accountId: 'A',
    trade: db.prepare('SELECT id, symbol, side, ctrader_position_id, entry_price, sl_price FROM trades WHERE id = ?').get(tradeId),
    existingRow: db.prepare('SELECT * FROM momentum_book WHERE id = ?').get(rowId),
    now: Date.now(),
  })
  assert.equal(out.action, 'skipped')
  assert.equal(makeBookHeldCheck(db, 'A')(240505687), true, 'held through its trade, as before')
})

// ───────────────────────────────────────────────────────────────────────────
// 4. The fill → book-row window is atomic
// ───────────────────────────────────────────────────────────────────────────

test('the book row and the keeper pause land together or not at all', () => {
  // The daily pass writes the row and pauses the keeper in two statements. If
  // the second never runs, the position is keeper-managed AND carries an
  // orphan that blocks its own adoption for ever — the worst of both. The
  // write must be one transaction, so a throw leaves the position simply
  // keeper-managed, which is a state the rest of the system understands.
  const db = db0()
  const tradeId = filledTrade(db)
  

  assert.throws(() => bookEntryWrite(db, {
    accountId: 'A',
    row: { tradeId, symbol: 'GD.US', positionId: '240505687', side: 'long', entry: 363.61, stop: 345.46, atr: 6, rank: 0.02, enteredAt: '2026-09-03T13:41:09Z', note: 'daily pass' },
    pause: () => { throw new Error('pause failed') },
  }), /pause failed/)

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM momentum_book WHERE account_id = 'A'").get().n, 0,
    'the row is rolled back with the pause — no orphan is left behind')
  assert.equal(monitored(db, tradeId).paused, 0, 'and the position is plainly keeper-managed')
})

test('the happy path writes both', () => {
  const db = db0()
  const tradeId = filledTrade(db)
  
  bookEntryWrite(db, {
    accountId: 'A',
    row: { tradeId, symbol: 'GD.US', positionId: '240505687', side: 'long', entry: 363.61, stop: 345.46, atr: 6, rank: 0.02, enteredAt: '2026-09-03T13:41:09Z', note: 'daily pass' },
  })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM momentum_book WHERE account_id = 'A'").get().n, 1)
  assert.deepEqual(monitored(db, tradeId), { paused: 1, current_tp: null })
  assert.equal(makeBookHeldCheck(db, 'A')(240505687), true)
})
