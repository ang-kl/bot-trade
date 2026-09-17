// ---------------------------------------------------------------------------
// agent/services/book-held.js — "does the momentum book hold this position?"
//
// ONE RULE, ONE PLACE. This question was asked in two files with two copies of
// the same query, and on 16-09-2026 the copies were about to diverge: the
// protection audit's copy was corrected to close a hole while the weekend
// bank's copy kept it. That is the shape `book-hold-age.js` was created for in
// PR-K — "a rule duplicated in two files is a rule that drifts in one of them"
// — and this is the same rule arriving at the same conclusion by the same road.
//
// A NOTE ON WHY THIS FILE EXISTS, SINCE THE REASON IS NOT THE ONE ABOVE IT.
// `book-hold-age.js` lives apart because momentum-book.js imports
// momentum-account.js and the reverse import is forbidden, so neither could
// host the shared rule. That constraint does NOT apply here: `weekend-bank.js`
// and `naked-position-guard.js` do not import each other, neither is imported
// by either momentum module, and either could technically have hosted this.
// Checked, and stated rather than assumed. The reason for a third file is the
// duplication rule alone — a guard importing another guard to borrow one query
// would make the weekend bank depend on the protection audit for no reason but
// where the function happened to be typed first.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE
//
// A momentum-book row at status 'open' or 'exit_sent' HOLDS its position.
// 'exit_sent' counts: the book has already decided that position's fate and a
// second action would race it. Per account — the same position id on another
// account is another position. A fresh db with no table holds nothing.
//
// ASKED BY POSITION ID *AND* BY TRADE ID, because the position-id question
// alone FAILS OPEN.
//
// `momentum_book.position_id` is written ONCE, at insert, as
// `t?.ctrader_position_id != null ? String(...) : null`, and it is NULL
// whenever the trade had no broker position id yet — the resting-limit-then-
// fill path the book uses when the market is closed. Nothing anywhere
// backfills it: `momentum_book SET` touches only status, note, stop and atr.
// Both old copies filtered `position_id IS NOT NULL`, so those rows were
// simply absent from the held set.
//
// MEASURED, both sides:
//  · protection audit — an `open` book row with a NULL position_id was not
//    exempt: the applier set a 1.5R floor target on a position meant to run
//    for weeks, and `momentum-account.js` clears `current_tp` on exactly these
//    rows so target-restore did not cover them either.
//  · weekend bank — the same row is not in the held set, so the bank CLOSES a
//    momentum runner ahead of a weekend. Production 16-09 shows the exemption
//    doing real work on the rows that DO have a position id
//    ("left 0005.HK (position 241443989) to the momentum book's stop"), which
//    is exactly how a hole in the same rule stays invisible.
//
// `trade_id` IS set at insert from the trade the book opened. Asking both
// questions makes the exemption fail CLOSED: held if EITHER key matches.
//
// AND EVERY POSITION ID GOES THROUGH `normPosId` (17-09-2026, second review).
// `lib/pos-id.js` states the rule for the whole repo: every write of a broker
// position id and EVERY IN-JS COMPARISON of one goes through it, because some
// paths once stored float-formatted ids ("234698574.0") while the broker hands
// around "234698574". Bare `String()` comparison here made the exemption fail
// OPEN on such an id — verified with '777.0' against '777': a book-held runner
// was not exempt, so it would be given a 1.5R target or banked before a
// weekend. `db.js`'s boot migration repairs `trades.ctrader_position_id` but
// NOT `momentum_book.position_id`, which this module reads directly, so the
// normalisation has to happen here rather than being assumed upstream.
// ─────────────────────────────────────────────────────────────────────────────

import { normPosId } from '../lib/pos-id.js'

/**
 * Position ids (strings) held by the book — on one account when `accountId` is
 * given, across all accounts otherwise.
 *
 * INCOMPLETE ON ITS OWN. Kept exported because callers and tests name it, and
 * because "which position ids does the book point at" is a real question, but
 * it is NOT the exemption: a NULL-position_id row cannot appear here at all.
 * Use `makeBookHeldCheck` for the exemption.
 */
export function bookHeldPositionIds(db, accountId = null) {
  const held = new Set()
  try {
    const rows = accountId != null
      ? db.prepare(`SELECT position_id FROM momentum_book WHERE account_id = ? AND status IN ('open', 'exit_sent') AND position_id IS NOT NULL`).all(String(accountId))
      : db.prepare(`SELECT position_id FROM momentum_book WHERE status IN ('open', 'exit_sent') AND position_id IS NOT NULL`).all()
    for (const r of rows) { const id = normPosId(r.position_id); if (id != null) held.add(id) }
  } catch { /* table absent — nothing held */ }
  return held
}

/** Trade ids (strings) held by the book. The half that survives a NULL position_id. */
export function bookHeldTradeIds(db, accountId = null) {
  const held = new Set()
  try {
    const rows = accountId != null
      ? db.prepare(`SELECT trade_id FROM momentum_book WHERE account_id = ? AND status IN ('open', 'exit_sent') AND trade_id IS NOT NULL`).all(String(accountId))
      : db.prepare(`SELECT trade_id FROM momentum_book WHERE status IN ('open', 'exit_sent') AND trade_id IS NOT NULL`).all()
    for (const r of rows) { const id = normPosId(r.trade_id); if (id != null) held.add(id) }
  } catch { /* table absent — nothing held */ }
  return held
}

/**
 * THE EXEMPTION. Both sets, read once, behind one predicate.
 *
 * `check(positionId, tradeId)` — pass `tradeId` when the caller already has it
 * (the protection audit's findings carry it from the trades join). When it does
 * not — the weekend bank sees only a broker snapshot — the trade is resolved
 * from `trades.ctrader_position_id`, memoised, and only for positions the
 * position-id set has already missed. So a book row whose `position_id` never
 * got written is still found through the trade it was opened from.
 *
 * Never throws: an exemption that can crash its caller would remove more safety
 * than it adds. An unreadable database answers "not held", which is the same
 * answer the old copies gave for every row.
 *
 * @param {object} db
 * @param {string|null} accountId  scope; null asks across all accounts
 * @returns {(positionId: any, tradeId?: any) => boolean}
 */
export function makeBookHeldCheck(db, accountId = null) {
  const positionIds = bookHeldPositionIds(db, accountId)
  const tradeIds = bookHeldTradeIds(db, accountId)

  // Only built if a lookup is actually needed, and only once.
  let tradeByPosition = null
  const tradeIdFor = (positionId) => {
    if (tradeByPosition == null) {
      tradeByPosition = new Map()
      try {
        // Every trade the book could be holding on this account. Scoped the
        // same way the book sets are, so a position id reused on another
        // account cannot borrow this one's exemption.
        const rows = accountId != null
          ? db.prepare(`SELECT id, ctrader_position_id FROM trades WHERE ctrader_position_id IS NOT NULL AND account_id = ?`).all(String(accountId))
          : db.prepare(`SELECT id, ctrader_position_id FROM trades WHERE ctrader_position_id IS NOT NULL`).all()
        for (const r of rows) {
          const pid = normPosId(r.ctrader_position_id)
          if (pid != null) tradeByPosition.set(pid, normPosId(r.id))
        }
      } catch { /* table absent or unreadable — no resolution available */ }
    }
    return tradeByPosition.get(normPosId(positionId)) ?? null
  }

  return function bookHolds(positionId, tradeId = null) {
    const pid = normPosId(positionId)
    if (pid != null && positionIds.has(pid)) return true
    if (!tradeIds.size) return false
    const tid = tradeId != null ? normPosId(tradeId) : (pid == null ? null : tradeIdFor(pid))
    return tid != null && tradeIds.has(tid)
  }
}
