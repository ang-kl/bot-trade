// ---------------------------------------------------------------------------
// agent/services/equity-stop.js — the daily max-drawdown circuit, PER ACCOUNT.
//
// Owner (2026-07-30): "ensure the account switches is ironclad, sometimes
// autotrade drops from the accounts and I don't see any trades especially
// today." This module is the answer to the first half; loop.js's inline version
// was the cause of the second.
//
// ===========================================================================
// WHAT WAS WRONG — three scopes that did not match, in one comparison
// ===========================================================================
// The previous implementation (loop.js:2963-3009, replaced by this) did:
//
//   const balance  = getAccountBalance(db)          // ← the SELECTED account
//   const cap      = balance * stopPct
//   const todayPnl = SUM(net_pnl) … WHERE status='closed'   // ← ALL ACCOUNTS
//   if (todayPnl <= -cap) setState(db, 'autotrade_enabled', 'false')  // ← ALL
//
// Three different scopes: a cap sized from ONE account's balance, a loss summed
// across EVERY account, and a disarm applied to EVERY account. Consequences,
// all of them things the owner actually saw:
//
//   * With a small selected account and a large one losing money, the cap is
//     tiny and the sum is large, so the stop trips almost immediately. On this
//     desk the live account holds 33.45 SGD while a demo holds ~51k USD — a cap
//     of a few dollars against a portfolio-wide loss figure.
//   * `autotrade_enabled` is the MASTER flag. account-phases.js computes
//     `effective = master AND (override ?? master)`, so master OFF is an
//     absolute veto: every per-account Autotrade switch the owner had set was
//     silently overridden at once. That is "autotrade drops from the accounts".
//   * It closed `botPositions` across every account, not just the offender.
//   * It logged to stdout only. Nothing in action_log, nothing in the decision
//     log, and the Telegram alert did not name an account — so "I don't see any
//     trades" came with no visible reason anywhere in the UI.
//
// ===========================================================================
// WHAT THIS DOES INSTEAD — one scope, chosen by the owner
// ===========================================================================
// Owner's decision (2026-07-30, asked explicitly): per-account cap, per-account
// loss, per-account disarm. A breach on one account disarms THAT account and
// closes THAT account's positions. Portfolio-wide protection is NOT lost — it
// already lives in the layer built for it, services/global-guards.js (5A:
// portfolio halt, portfolio daily-loss cap, total position cap), which is
// separately configurable. The equity stop had been duplicating that badly.
//
// The disarm sets that account's `accounts.mode` to 'manage_only' (see
// services/account-arming.js), never the master. So the panic button still
// works, the other accounts keep their own switches, and the owner's
// per-account intent survives. It used to write a separate per-account
// agent_state flag; that was a second store of the same fact and is retired.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { acctPhaseKey } from './account-phases.js'
import { setAccountArmed } from './account-arming.js'
// Leaf module — prices NULL-pnl stop-outs at planned risk (audit item 2).
import { estimateStopoutLossUsd } from './stopout-estimate.js'

/** Per-account trip marker, so one account tripping cannot silence another. */
export const trippedKey = (accountId) => `acct:${accountId}:equity_stop_tripped_at`

/**
 * Today's realised P&L for ONE account, over the same FX-day window and the
 * same timestamp normalisation the risk gate uses.
 *
 * ATTRIBUTION, not scoping. `account_id IS NULL` rows are deliberately NOT
 * folded in here. That predicate is right when SCOPING A VIEW (show me
 * everything that might belong to this account) and wrong when ATTRIBUTING
 * MONEY: a legacy row with no account would otherwise be counted against every
 * account simultaneously, so one unattributed loss could trip the stop on all
 * seven at once — the exact failure mode this module exists to remove.
 *
 * Returns `{ pnl, unknownCount, estimatedStopoutUsd }`. `unknownCount` is
 * closed trades whose net_pnl is NULL: those are not worth zero, they are
 * UNKNOWN. Audit item 2 (owner order 2026-08-22): the NULL rows that look
 * like stop-outs are now COUNTED into `pnl` at planned risk (`|entry−sl| ×
 * volume × usdLossPerLot`) instead of waiting for the backfill — this is the
 * circuit that flattens open exposure, and a run of broker-side stop-outs is
 * precisely the day it must not read as flat. `rates` (from risk.js
 * scanRates) prices cross-currency rows; without it those rows stay
 * unpriceable and contribute $0. See services/stopout-estimate.js and
 * services/unresolved-pnl.js for the veto acting on the same fact.
 */
export function accountPnlToday(db, accountId, dayStartSql, rates = null) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(net_pnl), 0) AS pnl,
           SUM(CASE WHEN net_pnl IS NULL THEN 1 ELSE 0 END) AS unknowns
      FROM trades
     WHERE status = 'closed'
       AND account_id = ?
       AND REPLACE(closed_at, 'T', ' ') >= ?
  `).get(String(accountId), dayStartSql)
  // Attributed scope, same as the SUM above: a NULL-account row must not
  // charge every account at once — the exact failure this module removed.
  const est = estimateStopoutLossUsd(db, {
    sinceSql: dayStartSql, accountId, scope: 'attributed', rates,
  })
  return {
    pnl: (Number(row?.pnl) || 0) - est.estUsd,
    unknownCount: Number(row?.unknowns) || 0,
    estimatedStopoutUsd: est.estUsd,
  }
}

/**
 * Has this account already tripped inside the current FX day?
 * Per-account, so a trip on one does not suppress the check on another.
 */
export function alreadyTrippedToday(db, accountId, fxDayOpenMs) {
  const at = Date.parse(getState(db, trippedKey(accountId)) || '')
  return Number.isFinite(at) && at >= fxDayOpenMs
}

/**
 * The decision for ONE account. Pure — no DB writes, no broker calls — so the
 * threshold logic is testable without a loop or a broker.
 *
 * @returns {{breach:boolean, cap:number|null, pnl:number, reason:string|null}}
 */
export function evaluateAccount({ pnl, balance, stopPct, fallbackLimit, openPositions = 0, unknownCount = 0 }) {
  const pct = Number(stopPct)
  const cap = balance != null && Number.isFinite(Number(balance)) && Number(balance) > 0 && Number.isFinite(pct)
    ? Number(balance) * pct
    : (Number.isFinite(Number(fallbackLimit)) ? Number(fallbackLimit) : null)

  if (cap == null || !(Math.abs(cap) > 0)) {
    // No usable cap is NOT a breach. It is an unknown, and closing an account's
    // positions on an unknown threshold would be acting on a number we do not
    // have. The risk gate's own entry veto still applies.
    return { breach: false, cap: null, pnl, reason: null }
  }
  // Nothing to close means nothing for this circuit to do — it exists to flatten
  // OPEN exposure. The entry-side veto is risk.js's job.
  if (openPositions <= 0) return { breach: false, cap, pnl, reason: null }
  if (!(pnl <= -Math.abs(cap))) return { breach: false, cap, pnl, reason: null }

  const unknownNote = unknownCount > 0
    ? ` (plus ${unknownCount} closed trade(s) with unknown P&L, so the real loss is at least this)`
    : ''
  return {
    breach: true,
    cap,
    pnl,
    reason: `equity_stop: account daily loss ${pnl.toFixed(2)} breached cap ${Math.abs(cap).toFixed(2)}${unknownNote}`,
  }
}

/**
 * Record the disarm so it is VISIBLE. The owner's complaint was not only that
 * trading stopped — it was that nothing on screen said why. Three places, on
 * purpose: action_log is the security/ops journal the Desk reads, decision_log
 * is the per-account decision feed, and Telegram is the push.
 */
export function recordDisarm(db, { accountId, reason, pnl, cap, positionsClosed }) {
  const detail = { accountId: String(accountId), reason, pnl, cap, positionsClosed }
  try {
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
      .run('EQUITY_STOP', `/equity-stop/${accountId}`, JSON.stringify(detail))
  } catch { /* the journal must never block the stop itself */ }
}

/**
 * Disarm ONE account, never the master. Returns the key it reports against, so
 * callers and tests can keep asserting the master was left alone.
 *
 * The write now lands on `accounts.mode` (services/account-arming.js) rather
 * than on a per-account agent_state flag. Same guarantee — the master is
 * untouched, so the other accounts keep trading — and one fewer place for
 * "this account may enter" to be stored. It also reads better: a breached
 * account becomes `manage_only`, which is exactly what the stop intends —
 * stop entering, keep managing what is open — and it announces itself on
 * Telegram rather than going quiet until someone opens the page.
 */
export function disarmAccount(db, accountId, nowIso = new Date().toISOString()) {
  const key = acctPhaseKey(accountId, 'autotrade')
  setAccountArmed(db, accountId, false, {
    actor: 'equity_stop',
    reason: 'daily equity stop tripped for this account',
  })
  setState(db, trippedKey(accountId), nowIso)
  return key
}
