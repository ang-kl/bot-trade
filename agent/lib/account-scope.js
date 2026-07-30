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
// NULL account_id rows are INCLUDED, following the convention every other
// account-scoped query in this codebase already uses —
// `(account_id = ? OR account_id IS NULL)` at risk.js:61, perf-ledger.js:130,
// reconciler.js:530, lessons-tuner.js:90, pnl-backfill.js:87.
//
// The first version of this file EXCLUDED them, on the reasoning that an
// unattributable row should not be credited to whichever account happens to be
// selected. That reasoning is defensible in isolation and wrong in context:
// buildPerfLedger includes those rows, so excluding them here made the
// Performance page stop reconciling with itself — a ledger carrying the legacy
// P&L beside Today/session tables that omitted it. Caught in review on PR #499.
// One convention, applied everywhere, beats two defensible ones.
//
// Such rows are still COUNTED and reported (`legacyRows`), because "these
// numbers include N rows we cannot attribute" is worth saying out loud. A NULL
// row belongs to no account, so including it cannot leak one account's trades
// into another's view — which is the failure this module exists to fix.
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
  return {
    where: `(${column} = ? OR ${column} IS NULL)`,
    params: [String(scope.accountId)],
    active: true,
  }
}

/**
 * How many rows in a scoped read carry no account_id, and so are counted for
 * every account rather than any one of them. Counted, never inferred — the
 * point is to be able to SAY the number.
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
