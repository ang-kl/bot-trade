// ---------------------------------------------------------------------------
// agent/services/book-hold-age.js — how long a momentum-book row has been
// held, and the minimum hold a rank exit must respect (PR-K, 16-09-2026).
//
// It lives in its own file because BOTH book paths need the same rule and
// neither may import the other: momentum-book.js already imports
// momentum-account.js, and momentum-account.js is kept free of the reverse
// import (that is why buildEntrySynth is injected). A rule duplicated in two
// files is a rule that drifts in one of them.
//
// THE RULE. A row's hold is measured from the OLDEST stamp that describes the
// same position: the book row's `entered_at` OR the trade's `opened_at`. An
// ADOPTED row is stamped at adoption, not at the fill, so a position filled
// three days ago would otherwise be handed a fresh 24-hour shield every time
// the book adopts it. Unknown age is Infinity — never a reason to hold a
// position the ranking wants out of.
// ---------------------------------------------------------------------------

/**
 * A timestamp as this ledger writes it. The shadow writes ISO
 * (`2026-09-16T05:00:00.000Z`); SQLite's `datetime('now')` writes
 * `2026-09-16 05:00:00` with NO zone and it IS UTC. Date.parse reads the
 * second form as LOCAL time, which on a non-UTC host shifts a hold age by
 * hours, so the zone is supplied here rather than assumed. NaN when
 * unreadable.
 */
export function parseStamp(s) {
  if (s == null) return NaN
  const t = String(s).trim()
  if (!t) return NaN
  const iso = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(t) ? t.replace(' ', 'T') : `${t.replace(' ', 'T')}Z`
  return Date.parse(iso)
}

/**
 * Milliseconds this book row has been held at `now`. Infinity when no stamp
 * on the row or its trade can be read.
 */
export function rowHeldMs(db, row, now) {
  const stamps = [parseStamp(row?.entered_at)]
  if (db && row?.trade_id != null) {
    try { stamps.push(parseStamp(db.prepare('SELECT opened_at FROM trades WHERE id = ?').get(row.trade_id)?.opened_at)) } catch { /* the row's own stamp stands */ }
  }
  const finite = stamps.filter(Number.isFinite)
  return finite.length ? now - Math.min(...finite) : Infinity
}

/**
 * The minimum hold a RANK EXIT must respect, in ms, from the book config.
 * `bookExitCadence: 'every_pass'` is the pre-PR-K restore switch and lifts
 * the hold with the cadence: the hold means "reconsidered on the NEXT DAILY
 * PASS", and under 'every_pass' there is no next daily pass to reconsider on.
 * One stored value therefore restores the pre-PR-K behaviour exactly.
 */
export function minHoldMsFor(bookCfg) {
  if (!bookCfg || bookCfg.bookExitCadence === 'every_pass') return 0
  const h = Number(bookCfg.bookMinHoldHours)
  return Number.isFinite(h) && h > 0 ? h * 3_600_000 : 0
}

/** True when this row may be rank-exited under the minimum hold. */
export function heldLongEnough(db, row, now, bookCfg) {
  const min = minHoldMsFor(bookCfg)
  return min <= 0 || rowHeldMs(db, row, now) >= min
}

/** `12.4` — hours held, for a skip reason an operator reads. */
export function heldHours(db, row, now) {
  const ms = rowHeldMs(db, row, now)
  return Number.isFinite(ms) ? (ms / 3_600_000).toFixed(1) : 'unknown'
}
