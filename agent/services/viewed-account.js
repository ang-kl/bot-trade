// A5 — the VIEWED account, as an explicit parameter rather than an assumption.
//
// docs/per-account-control-plan.md §5.2, which calls this "the subtle part":
//
//   "Scoped tables are only half the job — every read must scope to the
//    account BEING VIEWED, which is not necessarily the one being traded.
//    Today getState(db, 'ctrader_account_id') is the implicit answer
//    everywhere. Without that, you'll switch the workspace and still be
//    reading the trading account's numbers."
//
// That is exactly the confusion the owner reported on 02-08 from the other
// direction ("each sub-page doesn't tie to the account selected"), and it has
// one cause: there was no name for "the account this page is about". The
// trading account was standing in for it, and the two are only the same by
// coincidence.
//
// ===========================================================================
// THE THREE ANSWERS, IN PRECEDENCE ORDER
// ===========================================================================
//
//   1. ?account=<id>   the caller said which workspace it is looking at
//   2. ?account=all    the caller explicitly wants everything, unscoped
//   3. (absent)        the account currently being traded — today's behaviour
//
// Rule 3 is what makes this inert: a route that adopts the resolver without
// the UI passing anything keeps answering exactly as it did.
//
// ===========================================================================
// WHAT IT REFUSES TO DO
// ===========================================================================
// It does not validate the id against the registry. A workspace read for an
// account the registry has never seen should return that account's (empty)
// data and say so, not fall back to the trading account's numbers — silently
// substituting a DIFFERENT account's figures under the requested account's
// name is the precise failure this exists to prevent. `known` reports whether
// the registry recognises it, so a caller can label the answer.
import { getState } from '../db.js'
import { listAccounts } from './account-registry.js'

export const ALL = 'all'

/**
 * @param {*} db
 * @param {string|null|undefined} requested  the raw ?account= value
 * @returns {{accountId: string|null, scope: 'explicit'|'all'|'trading'|'none',
 *            known: boolean|null, tradingAccountId: string|null}}
 *   accountId null means UNSCOPED (read everything) — either because the
 *   caller asked for `all`, or because there is no trading account to fall
 *   back to.
 */
export function resolveViewedAccount(db, requested) {
  let tradingAccountId = null
  try { tradingAccountId = getState(db, 'ctrader_account_id') || null } catch { tradingAccountId = null }

  const raw = requested == null ? '' : String(requested).trim()
  if (raw === ALL) {
    return { accountId: null, scope: ALL, known: null, tradingAccountId }
  }
  if (raw) {
    let known = null
    try { known = listAccounts(db).some(a => String(a.account_id) === raw) } catch { known = null }
    return { accountId: raw, scope: 'explicit', known, tradingAccountId }
  }
  if (tradingAccountId) {
    let known = null
    try { known = listAccounts(db).some(a => String(a.account_id) === String(tradingAccountId)) } catch { known = null }
    return { accountId: String(tradingAccountId), scope: 'trading', known, tradingAccountId }
  }
  return { accountId: null, scope: 'none', known: null, tradingAccountId: null }
}

/** Express helper: resolve from `req.query.account`. */
export function viewedAccountOf(db, req) {
  return resolveViewedAccount(db, req?.query?.account)
}

/**
 * SQL fragment + params for scoping a query to the viewed account.
 *
 * NULL account_id rows are INCLUDED, matching the convention every other
 * scoped read in this codebase uses: a row written before per-account
 * stamping belongs to whoever is asking. Omitting them would make a workspace
 * look emptier than the account's real history.
 *
 * @param {{accountId: string|null}} viewed
 * @param {string} column  qualified column name when the query joins
 * @returns {{sql: string, params: any[]}}  sql is '' when unscoped
 */
export function scopeClause(viewed, column = 'account_id') {
  if (!viewed || viewed.accountId == null) return { sql: '', params: [] }
  return { sql: `AND (${column} = ? OR ${column} IS NULL)`, params: [viewed.accountId] }
}

/**
 * The same thing for a query with no WHERE yet.
 * Returns a full `WHERE …` or '' so callers do not hand-splice keywords.
 */
export function whereClause(viewed, column = 'account_id') {
  const c = scopeClause(viewed, column)
  return c.sql ? { sql: `WHERE (${column} = ? OR ${column} IS NULL)`, params: c.params } : { sql: '', params: [] }
}

/** A description a route can echo back, so the answer says what it covered. */
export function describeScope(viewed) {
  if (!viewed) return 'unknown'
  if (viewed.scope === ALL) return 'all accounts'
  if (viewed.accountId == null) return 'all accounts (no account selected)'
  if (viewed.known === false) return `account ${viewed.accountId} (not in the registry)`
  return `account ${viewed.accountId}${viewed.scope === 'trading' ? ' (the trading account)' : ''}`
}
