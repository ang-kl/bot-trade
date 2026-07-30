// ---------------------------------------------------------------------------
// agent/lib/account-scope.js — which account is a /state read about?
//
// Owner (2026-07-30): "it didn't refresh when i change the account. All the
// live positions in performance, trade, monitor, desk are the same when i
// switch account. this is serious."
//
// They were the same because they were never scoped. GET /state/positions read
// `WHERE mp.status = 'active'` and nothing else, so it returned EVERY enabled
// account's open positions, and switching accounts fetched the identical list.
// The account switch was working, the reload was working, the cache epoch was
// bumping — the query was the bug. Same for trades, pending orders, broker
// orders and risk events: M1 gave those tables an account_id column and the
// write paths stamp it, but the read paths never used it.
//
// Every scoped route now answers about ONE account: the one named in
// `?account=`, or the selected account when the caller says nothing. A caller
// that genuinely wants the whole portfolio asks for `?account=all` and gets it
// explicitly, which is the difference between a portfolio view and an
// accident.
//
// NULL account_id rows are NOT silently folded into whichever account is
// selected. They predate stamping (or were written by a global pass), so
// attributing them would be a guess with money attached. They are excluded
// from a scoped read and COUNTED, so a route can report "3 unattributed rows
// hidden" rather than quietly dropping them.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

/**
 * Resolve the account a read is about.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{query?: Record<string, unknown>}} [req] Express request
 * @returns {{accountId: string|null, all: boolean, explicit: boolean}}
 *   `all: true` → do not filter. `accountId: null` with `all: false` → no
 *   account is selected at all (fresh DB); a caller should then not filter
 *   either, because filtering on null would return nothing and read as
 *   "no positions" rather than "no account linked".
 */
export function requestedAccount(db, req) {
  const raw = req?.query?.account
  const asked = raw == null ? '' : String(raw).trim()
  if (asked.toLowerCase() === 'all') return { accountId: null, all: true, explicit: true }
  if (asked) return { accountId: asked, all: false, explicit: true }
  let selected = null
  try { selected = getState(db, 'ctrader_account_id') || null } catch { selected = null }
  return { accountId: selected, all: false, explicit: false }
}

/**
 * SQL fragment + params for a scoped read.
 *
 * Returns `{ where: '', params: [] }` when nothing should be filtered (an
 * explicit `all`, or no account selected) so callers can interpolate
 * unconditionally.
 *
 * @param {{accountId: string|null, all: boolean}} scope
 * @param {string} [column] qualified column name, e.g. 'mp.account_id'
 * @returns {{where: string, params: string[], active: boolean}}
 */
export function accountWhere(scope, column = 'account_id') {
  if (!scope || scope.all || scope.accountId == null) {
    return { where: '', params: [], active: false }
  }
  return { where: `${column} = ?`, params: [String(scope.accountId)], active: true }
}

/**
 * How many rows a scoped read hid because they carry no account_id. Counted,
 * never inferred — the point is to be able to SAY the number.
 *
 * Best effort: a missing table or column reports 0 rather than throwing into
 * a read route.
 *
 * @returns {number}
 */
export function countUnattributed(db, table, extraWhere = '', extraParams = []) {
  try {
    const clauses = ['account_id IS NULL']
    if (extraWhere) clauses.push(`(${extraWhere})`)
    return db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${clauses.join(' AND ')}`
    ).get(...extraParams)?.n ?? 0
  } catch { return 0 }
}
