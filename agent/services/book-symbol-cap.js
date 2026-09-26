// ---------------------------------------------------------------------------
// agent/services/book-symbol-cap.js — a ceiling on how many ACCOUNTS may hold
// the same symbol in the same direction at the same time.
//
// WHAT HAPPENED (measured from the 60 complete position_history records,
// 18-09-2026, and written up in docs/book-symbol-exposure-plan-2026-09-18.md):
//
//   NATGAS: 23 of 60 closed trades, net −980.84.
//   Everything else: 37 trades, 54.1% win, +156.51, profit factor 1.45.
//
//   One symbol was larger than the entire loss. Excluding it the book makes
//   money.
//
// WHY EVERY EXISTING GUARD MISSED IT, and this is the whole point of the file.
// The first diagnosis was "one account stacked seven NATGAS longs". That was
// WRONG, and grouping the same records by account is what refuted it:
//
//   16-09 02:02  acct=46130058  long va_breakout  −70.50
//   16-09 02:02  acct=43097342  long va_breakout   −3.82
//   16-09 02:02  acct=46979908  long va_breakout   −1.50
//   16-09 02:02  acct=47790949  long va_breakout  −77.00
//
// Four simultaneous longs, FOUR DISTINCT ACCOUNTS, one position each. The same
// shape at 06:5x (three accounts) and 15:3x (three accounts).
//
// symbol-position-cap.js's ceiling of 3 was NEVER BREACHED ON ANY ACCOUNT.
// Every account was individually compliant while the book carried 4× the
// intended exposure to one contract — because every guard in the system
// measures PER ACCOUNT, and the risk is borne PER OWNER.
//
// That is CLAUDE.md failure mode #3 one level up: a guard that is on,
// configured, and out of reach of what it guards. So this does NOT replace the
// per-account ceiling — that one works as designed, and both must pass.
//
// WHY THE SAME SIGNAL REACHES EVERY ACCOUNT. The cluster rule (owner,
// 09-09-2026) turns every strategy on for every account. That is deliberate
// and is not revisited here. Its unintended consequence is that one signal
// produces one LEGAL position per account, so book exposure to any symbol
// scales with the number of enabled accounts rather than with conviction.
//
// DIRECTION-SCOPED, because additive risk is the hazard. Four accounts long
// NATGAS is one bet at 4× size. Two accounts on opposite sides is net-flat at
// the book level — it pays double spread, which is a different and smaller
// problem, and is deliberately not addressed here.
//
// FIRST-COME, so owner principle 9 ("no restricted trading for certain
// accounts") stays intact: the restriction is on the SYMBOL, and any account
// may be the one that gets it.
//
// A CONCURRENCY LIMIT, NOT A QUOTA — the same rule symbol-position-cap.js
// states. Every input is live state: active positions, submitting/unconfirmed
// orders, working limits. A symbol traded twenty times last week, all closed,
// is at zero. This caps simultaneous exposure and never rations opportunity
// over time.
// ---------------------------------------------------------------------------

import { IN_FLIGHT_STATUSES } from './symbol-position-cap.js'

/**
 * Owner default, 18-09-2026.
 *
 * THE DATA ARGUES FOR 1. Across the 11 measured multi-account clusters, an
 * expected +404.03 at a cap of 1 against +220.98 at 2 (random ordering; the
 * figures are NET of the winning clusters a cap also forfeits — 0016.HK short
 * +162.76 across two accounts, ABBV.US short +50.44 across four).
 *
 * IT SHIPS AT 2 ANYWAY, and the reason is stated rather than hidden: 1 is the
 * most aggressive possible reduction in book breadth, chosen off 60 records
 * covering 4.7% of closed history, none of them independently verified. 2
 * recovers most of the measured damage while leaving real cross-account
 * diversification intact. It is a SETTING, not a constant — moving it to 1
 * needs no code change.
 */
export const DEFAULT_MAX_ACCOUNTS_PER_SYMBOL = 2

const norm = (s) => String(s || '').trim().toUpperCase()

/** BUY/LONG → 'BUY'; SELL/SHORT → 'SELL'; anything else → null (uncounted). */
export function normalizeSide (direction) {
  const d = norm(direction)
  if (d === 'BUY' || d === 'LONG') return 'BUY'
  if (d === 'SELL' || d === 'SHORT') return 'SELL'
  return null
}

/**
 * Which OTHER accounts hold this symbol in this direction right now?
 *
 * Returns the distinct account ids, excluding `accountId` itself — the
 * proposing account's own exposure is the per-account ceiling's job, and
 * counting it here would double-charge it.
 *
 * NULL-account rows are counted under a single synthetic id rather than
 * ignored: a legacy row is real exposure, and lumping them together is the
 * conservative reading (they can only ever add one to the count, never
 * disappear from it).
 */
export function accountsHolding (db, { symbol, direction, accountId = null } = {}) {
  const sym = norm(symbol)
  const side = normalizeSide(direction)
  if (!sym || !side) return []
  const self = accountId == null ? null : String(accountId)
  const ids = new Set()

  const add = (rows) => {
    for (const r of rows || []) {
      const id = r.account_id == null ? '(unassigned)' : String(r.account_id)
      if (self != null && id === self) continue
      ids.add(id)
    }
  }

  // C8 (SEQUENCE PR-8, 26-09-2026). BOTH position tables store the direction
  // in `side` (agent/db.js: trades.side, monitored_positions.side). The first
  // cut of these two queries read a `direction` column that exists in neither,
  // so each threw into its empty catch and, from #939 until this fix, the
  // ceiling counted ONLY resting limits — every held position and every
  // in-flight order read as zero. The tests now build on initDB, the real
  // schema, so a wrong column name goes red instead of silent.
  try {
    add(db.prepare(`
      SELECT DISTINCT account_id FROM monitored_positions
       WHERE status = 'active' AND UPPER(symbol) = ? AND UPPER(side) IN (?, ?)
    `).all(sym, side, side === 'BUY' ? 'LONG' : 'SHORT'))
  } catch { /* table shape varies in older databases; a missing read must not open the gate wider than it already is */ }

  try {
    const marks = IN_FLIGHT_STATUSES.map(() => '?').join(',')
    add(db.prepare(`
      SELECT DISTINCT account_id FROM trades
       WHERE status IN (${marks}) AND UPPER(symbol) = ? AND UPPER(side) IN (?, ?)
    `).all(...IN_FLIGHT_STATUSES, sym, side, side === 'BUY' ? 'LONG' : 'SHORT'))
  } catch { /* as above */ }

  try {
    // A resting limit is exposure the moment it is placed: nobody has to press
    // anything for it to become a position. Same reasoning as the per-account
    // ceiling, which learned this the expensive way.
    // `pending_orders` stores direction as `dir` INTEGER (1 buy / −1 sell),
    // NOT a text side — checked against both writers rather than assumed. The
    // first cut of this query read a `side` column that does not exist, which
    // the empty-catch below would have swallowed into a permanently open gate.
    add(db.prepare(`
      SELECT DISTINCT account_id FROM pending_orders
       WHERE status = 'working' AND UPPER(symbol) = ? AND dir = ?
    `).all(sym, side === 'BUY' ? 1 : -1))
  } catch { /* as above */ }

  return [...ids]
}

/**
 * May this account open `symbol` in `direction`?
 *
 * @returns {{allow:boolean, others:string[], cap:number, reason:string|null}}
 */
export function checkBookSymbolCap (db, { symbol, direction, accountId = null, cap = DEFAULT_MAX_ACCOUNTS_PER_SYMBOL } = {}) {
  const limit = Number(cap)
  // A cap of 0 or less DISABLES the ceiling rather than refusing everything.
  // The opposite reading would turn a misconfigured number into a total
  // trading halt, which is a worse failure than the one this guards.
  if (!(limit > 0)) return { allow: true, others: [], cap: limit, reason: null }

  const side = normalizeSide(direction)
  if (!side) return { allow: true, others: [], cap: limit, reason: null }

  const others = accountsHolding(db, { symbol, direction, accountId })
  // `others` excludes this account, so it may join while FEWER than `limit`
  // accounts already hold the symbol — at limit 2, one other holder is fine,
  // two is not.
  if (others.length < limit) return { allow: true, others, cap: limit, reason: null }

  return {
    allow: false,
    others,
    cap: limit,
    reason: `book_symbol_cap: ${others.length} account(s) already hold ${norm(symbol)} ${side} `
      + `(${others.join(', ')}), book ceiling is ${limit} — one signal across accounts is one bet at N× size`,
  }
}
