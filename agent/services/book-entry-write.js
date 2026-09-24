// ---------------------------------------------------------------------------
// agent/services/book-entry-write.js — writing a momentum-book row and handing
// the position over to the book, in one place and in one transaction.
//
// WHY A THIRD FILE. `momentum-book.js` imports `momentum-account.js` and the
// reverse import is forbidden (the constraint that already produced
// `book-hold-age.js` and `book-held.js`), yet THREE call sites write book rows
// and all three must hand the position over in the same breath. A rule
// duplicated across files is a rule that drifts in one of them — and it had
// already drifted, see below.
//
// WHAT THIS PROTECTS. Every exemption that keeps an intraday management rule
// off a weeks-horizon momentum runner — the profit keeper, the loss guardian,
// the weekend bank, the protection audit's target applier — is keyed on
// `book-held.js` (a book row naming this trade or this position) plus
// `monitored_positions.paused`. Nothing reads a horizon. So these two writes
// ARE the protection.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO DEFECTS THIS CLOSES, both measured at source 21-09-2026
//
// 1. THE HAND-OVER HAD DRIFTED. Some writers cleared the broker target while
//    others preserved it. Broker-native TP1 is now mandatory, so the shared
//    hand-over has one rule: pause intraday management without changing TP1.
//
// 2. THE WINDOW. The row and the hand-over were two separate statements at
//    every writer. A throw between them — and the callers catch into
//    `summary.skipped` — leaves the row written (so `book-held.js` exempts the
//    position from the keeper, the guardian and the weekend bank) while
//    `paused` is still 0 (so the fast monitor still manages it). Half in the
//    book's care and half in the keeper's, which is a state no rule is written
//    for. One transaction now: either the book owns the position, or the
//    keeper plainly does.
//
// WHAT THIS FILE DOES **NOT** CLAIM. An earlier draft of this module asserted
// that the daily pass writes a book row naming neither a trade nor a position
// on the closed-market path, and built a backfill for it. That was WRONG and
// the branch was removed: on a closed market `autoTrade` rests the limit and
// returns null (`loop.js:427`), so every caller's `if (!result) … continue`
// fires five lines ABOVE the row write. No such row is produced by any path in
// this tree, and the fill is booked later by the adopt pass exactly as its
// docstring says. The correction is recorded here rather than quietly dropped.
// ---------------------------------------------------------------------------

import { enrollMomentumBook } from './momentum-entry-contract.js'

/**
 * The keeper hand-over. ONE rule, so it cannot drift again: the monitor is
 * paused while broker-native TP1 is preserved on both the monitor row and the
 * trade. Returns what it actually changed, because a caller that logs "keeper
 * paused" must be able to tell whether anything was.
 */
export function pauseForBook(db, tradeId) {
  const paused = db.prepare(`UPDATE monitored_positions SET paused = 1 WHERE trade_id = ?`).run(tradeId)
  return { monitorRows: paused.changes, tradeRows: 0 }
}

/**
 * Write a book entry and hand the position over, atomically.
 *
 * `pause` is injectable so a test can prove the rollback; production passes
 * none. Returns `{ handedOver }` — false when there was no trade id to hand
 * over, or when no monitor row matched — so no caller has to guess.
 */
export function bookEntryWrite(db, { accountId, row, pause = null } = {}) {
  const acct = String(accountId)
  let handed = { monitorRows: 0, tradeRows: 0 }
  let targetPolicy = null
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(row.tradeId ?? null, acct, row.symbol, row.positionId == null ? null : String(row.positionId),
        row.side || 'long', row.entry ?? null, row.stop ?? null, row.atr ?? null, row.rank ?? null,
        row.enteredAt, row.note ?? null)
    if (row.tradeId != null) {
      if (pause) pause()
      else handed = pauseForBook(db, row.tradeId)
      targetPolicy = enrollMomentumBook(db, { accountId: acct, tradeId: row.tradeId,
        positionId: row.positionId == null ? null : String(row.positionId) })
    }
  })
  tx()
  return { ok: true, handedOver: handed.monitorRows > 0, handed, ...(targetPolicy ? { targetPolicy } : {}) }
}
