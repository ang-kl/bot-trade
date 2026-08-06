// ---------------------------------------------------------------------------
// agent/lib/sizing-balance.js — WHOSE money is this position sized against?
//
// THE OBSERVATION (owner, 2026-08-06, two screenshots). The same 0003.HK
// position — 5,000 units, entry 6.91, stop 6.678, target 7.373 — sits on TWO
// accounts at once:
//
//   46130058   balance USD 46,073   risk to stop USD 149   1% budget USD 461
//   43097342   balance USD  1,984   risk to stop USD 149   1% budget USD 19.84
//
// Identical size on accounts whose balances differ 23×. On the small one that
// is 7.5× its own per-trade budget, and USD 4,429 of notional against USD
// 1,984 of equity.
//
// THE MECHANISM THIS GUARDS. `getAccountBalance(db, accountId)` reads
// `acct:<id>:account_balance_usd` and, when that key is missing, falls back to
// the LEGACY GLOBAL `account_balance_usd` — which is, in its own comment,
// "whatever account refreshed it last". For display that fallback is merely
// wrong. For SIZING it is a live hazard: a small account whose per-account
// balance has not been stamped gets sized against a large account's equity,
// and every risk percentage in the config is silently multiplied by the ratio
// between them.
//
// FAIL CLOSED, and say which. A trade that cannot be sized against its own
// account's balance must not be sized against somebody else's. Refusing costs
// a missed entry; accepting costs an unbounded multiple of the intended risk,
// and the multiple is invisible because every downstream number is computed
// from the same wrong balance and therefore agrees with itself.
//
// WHAT THIS FILE DOES NOT DECIDE. It does not set, read or change a risk
// threshold. It answers one question — is this balance actually this account's
// — and returns the answer with its provenance attached so the risk gate can
// record WHY it refused rather than emitting a bare zero.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

/**
 * The balance a position on `accountId` may be sized against.
 *
 * @returns {{balance: number|null, source: 'account'|'selected'|'legacy'|'none',
 *   ok: boolean, accountId: string|null, reason: string|null}}
 *
 *   source 'account'  — `acct:<id>:account_balance_usd`, the only trustworthy one
 *   source 'selected' — no account named; the selected account's own stamp
 *   source 'legacy'   — the global key, owner unknown. ok:false.
 *   source 'none'     — nothing readable at all. ok:false.
 */
export function sizingBalance(db, accountId = null) {
  const id = accountId != null ? String(accountId) : null

  const read = (key) => {
    try {
      const n = Number(getState(db, key))
      return Number.isFinite(n) && n > 0 ? n : null
    } catch { return null }
  }

  // HOW MANY ACCOUNTS COULD THE SHARED KEY BELONG TO? The hazard is a balance
  // borrowed from ANOTHER account, so it requires another account to exist.
  // With one enabled account (or none registered yet) the global key is
  // unambiguous — it is that account's balance, which is what it meant for the
  // whole single-account era. Refusing there would block a correct install to
  // guard against a confusion that cannot occur in it.
  let enabledAccounts = 0
  try {
    enabledAccounts = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE enabled = 1').get()?.n ?? 0
  } catch { enabledAccounts = 0 }
  const ambiguous = enabledAccounts > 1

  if (id != null) {
    const scoped = read(`acct:${id}:account_balance_usd`)
    if (scoped != null) return { balance: scoped, source: 'account', ok: true, accountId: id, reason: null }
    // The legacy value may exist and may even be right — but with more than one
    // enabled account nothing here can tell, and "may be right" is not a basis
    // for sizing real money.
    const legacy = read('account_balance_usd')
    if (legacy != null && !ambiguous) {
      return { balance: legacy, source: 'legacy_single_account', ok: true, accountId: id, reason: null }
    }
    return {
      balance: legacy,
      source: legacy != null ? 'legacy' : 'none',
      ok: false,
      accountId: id,
      reason: legacy != null
        ? `no acct:${id}:account_balance_usd — the only balance available is the legacy global key, which belongs to whichever account refreshed it last`
        : `no balance recorded for account ${id}`,
    }
  }

  // No account named: the selected account is what "the account" meant in the
  // single-account era, and its own stamp is still account-scoped.
  let selected = null
  try { selected = getState(db, 'ctrader_account_id') || null } catch { selected = null }
  if (selected != null) {
    const scoped = read(`acct:${selected}:account_balance_usd`)
    if (scoped != null) return { balance: scoped, source: 'selected', ok: true, accountId: String(selected), reason: null }
  }
  const legacy = read('account_balance_usd')
  if (legacy != null && !ambiguous) {
    return { balance: legacy, source: 'legacy_single_account', ok: true, accountId: selected != null ? String(selected) : null, reason: null }
  }
  // NO ACCOUNT CONTEXT AT ALL — no account named, none selected. Here the
  // legacy key is not ambiguous: there is no second account for it to belong
  // to instead, which is the single-account era this system grew out of. The
  // hazard being guarded is specifically a NAMED account borrowing somebody
  // else's number, and that cannot arise when nothing has been named.
  if (selected == null && legacy != null) {
    return { balance: legacy, source: 'legacy_unscoped', ok: true, accountId: null, reason: null }
  }
  return {
    balance: legacy,
    source: legacy != null ? 'legacy' : 'none',
    ok: false,
    accountId: selected != null ? String(selected) : null,
    reason: legacy != null
      ? `no acct:${selected}:account_balance_usd — the selected account has no balance of its own and the global key belongs to whichever account refreshed it last`
      : 'no balance recorded at all',
  }
}

/**
 * How far outside its own per-trade budget would this position sit?
 *
 * Pure arithmetic, no policy: the caller decides what to do with the ratio.
 * Exists so the "7.5× the budget" figure in an alert is computed once, in a
 * tested place, rather than by whichever panel is printing it.
 *
 * @returns {number|null} riskUsd ÷ budgetUsd, or null when either is unusable
 */
export function riskBudgetMultiple(riskUsd, budgetUsd) {
  // `Number(null)` is 0 and 0 is finite, so a missing risk would otherwise
  // report a confident multiple of zero — "well within budget" for a figure
  // nobody has. Absent is not the same as none.
  if (riskUsd == null || budgetUsd == null) return null
  const r = Number(riskUsd)
  const b = Number(budgetUsd)
  if (!Number.isFinite(r) || !Number.isFinite(b) || b <= 0) return null
  return Math.round((r / b) * 100) / 100
}

/**
 * Does this position risk more than its account's own budget allows?
 *
 * `tolerance` exists because volume steps are discrete: a broker minimum lot
 * can land a few percent over budget with nothing wrong anywhere, and flagging
 * that as a defect would bury the 7.5× case in noise. Default 1.10 — ten per
 * cent of slack, not a licence.
 */
export function overBudget(riskUsd, budgetUsd, tolerance = 1.10) {
  const m = riskBudgetMultiple(riskUsd, budgetUsd)
  return m != null && m > tolerance
}
