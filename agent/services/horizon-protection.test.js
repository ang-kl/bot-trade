// node --test agent/services/horizon-protection.test.js
//
// §4-P (21-09-2026, owner: "verify that intraday management rules cannot
// accidentally tighten or close weeks-horizon positions").
//
// THE SHAPE. Every protection a weeks-horizon position has is keyed on
// MEMBERSHIP OF THE MOMENTUM BOOK (`book-held.js`) plus
// `monitored_positions.paused` — nothing reads a horizon. So the two writes
// that create a book row and hand the position over ARE the protection, and
// they were made in three places by three slightly different pieces of code.
//
// A CORRECTION IS RECORDED HERE RATHER THAN QUIETLY DROPPED. The first draft
// of this file asserted that the daily pass writes a book row naming neither a
// trade nor a position on the closed-market path, and tested a "backfill" for
// it. That was WRONG: on a closed market `autoTrade` rests the limit and
// returns null (`loop.js:427`), so every caller's `if (!result) … continue`
// fires ABOVE the row write. No such row is produced anywhere in this tree.
// The backfill was removed. What follows is only what can actually happen.
//
// The two real defects, both measured at source:
//   1. THE HAND-OVER HAD DRIFTED — some paths cleared TP1 while others kept
//      it. The shared hand-over now pauses the keeper and preserves mandatory
//      broker-native TP1 on every path.
//   2. THE WINDOW — the row and the hand-over were two statements. A throw
//      between them leaves the row written (so `book-held.js` exempts the
//      position from keeper, guardian and weekend bank) while `paused` is
//      still 0 (so the fast monitor still manages it): half in each regime.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB } from '../db.js'
import { makeBookHeldCheck } from './book-held.js'
import { bookEntryWrite, pauseForBook } from './book-entry-write.js'

const db0 = () => initDB(':memory:')

/** A filled tsmom trade carrying the 1.5R target a closed-market limit gets. */
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

const ROW = (tradeId) => ({
  tradeId, symbol: 'GD.US', positionId: '240505687', side: 'long',
  entry: 363.61, stop: 345.46, atr: 6, rank: 0.02,
  enteredAt: '2026-09-03T13:41:09Z', note: 'daily pass',
})

// ───────────────────────────────────────────────────────────────────────────
// 1. The hand-over is ONE rule
// ───────────────────────────────────────────────────────────────────────────

test('the hand-over pauses the keeper and preserves broker-native TP1 on both rows', () => {
  const db = db0()
  const tradeId = filledTrade(db)
  assert.deepEqual(monitored(db, tradeId), { paused: 0, current_tp: 390.84 }, 'before: keeper-managed, capped at 1.5R')

  bookEntryWrite(db, { accountId: 'A', row: ROW(tradeId) })

  assert.deepEqual(monitored(db, tradeId), { paused: 1, current_tp: 390.84 }, 'after: book-managed, TP1 preserved')
  assert.equal(db.prepare('SELECT tp_price FROM trades WHERE id = ?').get(tradeId).tp_price, 390.84, 'the trade retains TP1')
  assert.equal(makeBookHeldCheck(db, 'A')(240505687), true, 'and the exemption sees it')
})

test('pauseForBook reports what it actually changed — the log cannot claim a pause that did not happen', () => {
  const db = db0()
  const orphanTrade = db.prepare(
    `INSERT INTO trades (symbol, side, status, account_id, label_strategy) VALUES ('GD.US','BUY','open','A','tsmom_long')`,
  ).run().lastInsertRowid // no monitored_positions row at all
  const out = pauseForBook(db, orphanTrade)
  assert.equal(out.monitorRows, 0, 'nothing was paused, and the caller is told so')

  const real = filledTrade(db, { symbol: 'MRK.US', posId: 99 })
  assert.equal(pauseForBook(db, real).monitorRows, 1)
})

test('a write with no trade id hands nothing over, and says so', () => {
  const db = db0()
  const out = bookEntryWrite(db, { accountId: 'A', row: { ...ROW(null), tradeId: null } })
  assert.equal(out.handedOver, false)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM momentum_book WHERE account_id = 'A'").get().n, 1,
    'the row still records the entry')
})

// ───────────────────────────────────────────────────────────────────────────
// 2. The window is closed
// ───────────────────────────────────────────────────────────────────────────

test('THE WINDOW: the row and the hand-over land together or not at all', () => {
  // If the hand-over throws after the insert, the old code left the row
  // written — so book-held.js exempted the position from the keeper, the
  // guardian and the weekend bank — while `paused` stayed 0, so the fast
  // monitor still managed it. Half in each regime, which no rule is written
  // for. One transaction: a throw leaves the position plainly keeper-managed.
  const db = db0()
  const tradeId = filledTrade(db)

  assert.throws(() => bookEntryWrite(db, {
    accountId: 'A', row: ROW(tradeId),
    pause: () => { throw new Error('pause failed') },
  }), /pause failed/)

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM momentum_book WHERE account_id = 'A'").get().n, 0,
    'the row is rolled back with the hand-over — no half-owned position is left behind')
  assert.equal(monitored(db, tradeId).paused, 0, 'and the position is plainly keeper-managed')
  assert.equal(makeBookHeldCheck(db, 'A')(240505687), false, 'the exemption does not fire for a row that was rolled back')
})

// ───────────────────────────────────────────────────────────────────────────
// 3. THE WIRING — a revert at the call site must go red here
//
// The checker's finding on the first draft: every test called the module
// directly, so restoring the old two-statement code at the call sites turned
// NOTHING red. These drive the real pass.
// ───────────────────────────────────────────────────────────────────────────

test('WIRING: the book ENTRY path preserves the limit target while pausing the keeper', async () => {
  // THE GAP THE CHECKER FOUND, and why it stayed open. `momentum-book.test.js`
  // already drives an entry through `runMomentumBook` — but its fake autoTrade
  // inserts `tp_price` NULL and a monitored row with no `current_tp`, so there
  // was never a target for the entry path to accidentally clear. The guard's
  // trigger never arrived (CLAUDE.md failure mode #3). This gives the path a
  // trade WITH the 1.5R target a closed-market limit really carries, and so
  // goes red if the call site reverts to `SET paused = 1` alone.
  const { runMomentumBook, MOMENTUM_BOOK_CONFIG_KEY, TSMOM_STRATEGY } = await import('./momentum-book.js')
  const { setStage } = await import('./stage-matrix.js')
  const { getState, setState } = await import('../db.js')

  const db = db0()
  const ACCT = '111'
  db.prepare("INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')").run(ACCT)
  setState(db, 'symbol_id_map', JSON.stringify({ 'GD.US': 1 }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: ACCT }, { getState, setState })
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, bookExitCadence: 'every_pass' }))
  db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at)
              VALUES ('GD.US', 'enter', 'long', 1, 9, 100, '1d', 20, 0, ?)`).run(new Date().toISOString())

  let tradeId = null
  const deps = {
    symbolMap: { 'GD.US': 1 },
    bars: async () => Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100 + i * 0.1 })),
    spot: async () => ({ bid: 102.9, ask: 103 }),
    amend: async () => ({}),
    close: async () => ({}),
    positionVolume: async () => 1000,
    phasesOn: () => true,
    mayTrade: () => ({ ok: true, item: null }),
    // The real closed-market limit path stamps a 1.5R target on BOTH rows.
    autoTrade: async (d, symbol, synth, _w, acct) => {
      tradeId = d.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at)
                           VALUES (?, 'BUY', 'open', ?, ?, ?, ?, ?, ?, 'bot_market_dispatch', ?, datetime('now'))`)
        .run(symbol, synth.entry, synth.sl, 390.84, synth.strategy, synth.strategy, acct.accountId, 'pos-gd').lastInsertRowid
      d.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, account_id, status, source)
                 VALUES (?, ?, 'long', ?, ?, 390.84, ?, 'active', 'autopilot')`).run(symbol, tradeId, synth.entry, synth.sl, acct.accountId)
      return { side: 'BUY', tradeId }
    },
  }

  const r = await runMomentumBook(db, { accounts: [{ accountId: ACCT, isLive: false }], credsFor: (a) => ({ accountId: a.accountId, host: 'demo' }), deps, now: Date.now(), log: () => {} })
  assert.equal(r.entries, 1, `the entry path ran — skipped: ${JSON.stringify(r.skipped)}`)
  assert.ok(tradeId, 'a trade was created')
  assert.deepEqual(monitored(db, tradeId), { paused: 1, current_tp: 390.84 },
    'the ENTRY path must retain broker-native TP1 while the keeper is paused')
  assert.equal(db.prepare('SELECT tp_price FROM trades WHERE id = ?').get(tradeId).tp_price, 390.84,
    'the trade record must retain the same TP1')
})

// The ADOPT path's hand-over is already pinned, behaviourally and with a real
// target, by momentum-book.test.js:515 ("an open tsmom_long trade with no book
// row ... is adopted once, keeper paused" — it asserts current_tp and tp_price
// retain their broker-native TP1). Not duplicated here.
