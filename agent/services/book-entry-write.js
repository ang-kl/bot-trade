// ---------------------------------------------------------------------------
// agent/services/book-entry-write.js — writing a momentum-book row, and
// completing one that was written blind.
//
// WHY A THIRD FILE, since the reason is not obvious. `momentum-book.js`
// imports `momentum-account.js` and the reverse import is forbidden (the same
// constraint that produced `book-hold-age.js` and `book-held.js`), yet BOTH
// write book rows and both must hand the position over to the book in the same
// breath. A rule duplicated in two files is a rule that drifts in one of them,
// and this particular rule is the only thing standing between a weeks-horizon
// position and the intraday stack. So it lives here, once, and both import it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §4-P (21-09-2026). THE BOOK ROW IS THE ONLY PROTECTION A WEEKS-HORIZON
// POSITION HAS, so writing it is a transaction and completing it is a duty.
//
// Every exemption that keeps an intraday rule off a momentum runner — the
// profit keeper, the loss guardian, the weekend bank, the protection audit's
// target applier — is keyed on `book-held.js` (a book row naming this trade or
// this position) plus `monitored_positions.paused`. Nothing reads a horizon.
// So a book row that names NEITHER key protects nothing, and the two writes
// below are what stand between a trend position and the intraday stack.
//
// TWO DEFECTS THIS CLOSES, both measured at source on 21-09-2026:
//
//  1. THE ORPHAN. `momentum-account.js` places the daily entry, then looks its
//     trade up with `status = 'open'`. On the closed-market path the order is
//     a RESTING LIMIT and no open trade exists yet, so the lookup misses and
//     the row is written with trade_id NULL *and* position_id NULL. When the
//     limit fills hours later, the adopt pass asks `openRow(account, symbol)`,
//     finds that orphan and `continue`s — so the fill is never adopted, the
//     keeper is never paused, and the 1.5R take profit a closed-market limit
//     carries is never cleared. For ever, and silently.
//  2. THE WINDOW. The insert and the pause were two statements. A throw
//     between them (the caller's try/catch swallows it into `summary.skipped`)
//     left the position keeper-managed AND carrying an orphan that blocked its
//     own adoption — the worst of both states. One transaction now: either the
//     book owns the position, or the keeper plainly does.
// ---------------------------------------------------------------------------

/** The keeper hand-over: pause the monitor and drop the limit's target. */
function pauseForBook(db, tradeId) {
  db.prepare(`UPDATE monitored_positions SET paused = 1, current_tp = NULL WHERE trade_id = ?`).run(tradeId)
  db.prepare(`UPDATE trades SET tp_price = NULL WHERE id = ?`).run(tradeId)
}

/**
 * Write a book entry and hand the position over, atomically.
 * `pause` is injectable so a test can prove the rollback; production passes none.
 */
export function bookEntryWrite(db, { accountId, row, pause = null } = {}) {
  const acct = String(accountId)
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(row.tradeId ?? null, acct, row.symbol, row.positionId == null ? null : String(row.positionId),
        row.side || 'long', row.entry ?? null, row.stop ?? null, row.atr ?? null, row.rank ?? null,
        row.enteredAt, row.note ?? null)
    if (row.tradeId != null) {
      if (pause) pause()
      else pauseForBook(db, row.tradeId)
    }
  })
  tx()
  return { ok: true }
}

/**
 * A filled tsmom trade meets the book. Three outcomes:
 *  · `backfilled` — an ORPHAN row (neither key set) is completed from this
 *    trade and the keeper handed over. This is defect 1 above.
 *  · `skipped`    — a row that already names a trade or a position holds this
 *    symbol; it is the book's record and is never re-pointed.
 *  · `adopted`    — no row at all, so one is written (the ordinary path).
 * Never throws for a missing trade; the caller's loop must keep going.
 */
export function adoptOrBackfill(db, { accountId, trade, existingRow = null, now = Date.now() } = {}) {
  if (!trade || trade.id == null) return { action: 'skipped', reason: 'no trade' }
  const acct = String(accountId)
  const posId = trade.ctrader_position_id != null ? String(trade.ctrader_position_id) : null
  const side = String(trade.side || '').toUpperCase() === 'SELL' ? 'short' : 'long'

  if (existingRow) {
    if (existingRow.trade_id != null || existingRow.position_id != null) {
      return { action: 'skipped', reason: 'row already identified', rowId: existingRow.id }
    }
    const tx = db.transaction(() => {
      db.prepare(`UPDATE momentum_book
                     SET trade_id = ?, position_id = ?, side = ?,
                         entry_price = COALESCE(?, entry_price), stop = COALESCE(?, stop),
                         note = COALESCE(note, '') || ' | backfilled from trade ' || ?
                   WHERE id = ?`)
        .run(trade.id, posId, side, trade.entry_price ?? null, trade.sl_price ?? null, String(trade.id), existingRow.id)
      pauseForBook(db, trade.id)
    })
    tx()
    return { action: 'backfilled', rowId: existingRow.id, tradeId: trade.id }
  }

  bookEntryWrite(db, {
    accountId: acct,
    row: {
      tradeId: trade.id, symbol: trade.symbol, positionId: posId, side,
      entry: trade.entry_price ?? null, stop: trade.sl_price ?? null,
      atr: null, rank: null, enteredAt: new Date(now).toISOString(),
      note: `adopted filled order (trade ${trade.id})`,
    },
  })
  return { action: 'adopted', tradeId: trade.id }
}
