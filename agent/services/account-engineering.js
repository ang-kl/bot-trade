// ---------------------------------------------------------------------------
// agent/services/account-engineering.js — per-account ENGINEERING status.
//
// Owner (2026-07-30): "The desk page should display the underlying engineering
// status for each account you are trading or not trading. If I deselect certain
// trading accounts in the connect interface, what will happen? Will the system
// still attempt to scan, analyze, or auto-trade those accounts? I am serious
// about avoiding unnecessary effort and expenses in trading."
//
// That question deserves a screen, not a paragraph. Every row here answers one
// part of "what is the machine actually doing for this account":
//
//   enabled   → in the reconcile sweep and the sidecar roster at all
//   mode      → 'active' dispatches new entries; 'manage_only' manages what is
//               already open and starts nothing; 'paused' does neither
//   S / A / T → the per-account phase switches, EFFECTIVE (master AND override)
//   sidecar   → is this account authorised at the C++ exec engine RIGHT NOW
//   positions → how many open positions it is carrying
//   reconcile → when its broker truth was last compared with our ledger
//   decision  → when the pipeline last recorded a decision about it
//
// ONE ROUTE, ONE DB READ PASS. The browser must not have to fan out across six
// endpoints (or worse, call the sidecar itself) to answer a single question.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM. There is no "last dispatch" figure,
// because nothing in the pipeline writes a row when a dispatch SUCCEEDS —
// decision_log only carries skips and vetoes (grep: no `decision: 'proceed'`
// anywhere). So a healthy, busily-trading account produces NO decision rows,
// and printing "last dispatch: 3h ago" from a skip row would invert the
// meaning: silence here is ambiguous, and the field says so rather than
// guessing. `lastDecision` is reported with its stage and verdict attached so
// the reader can see what kind of event it actually was.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
// The phase resolver stays the single source of truth for what a phase means;
// this module reports it, never re-derives it.
import { masterPhases, effectivePhases } from './account-phases.js'

/** The sidecar's last reported roster, as persisted by probeCppExec. */
export function sidecarRoster(db) {
  let raw = null
  try { raw = getState(db, 'cpp_exec_health_json') } catch { raw = null }
  if (!raw) return { accounts: null, connected: null, at: null, ok: null, error: null }
  try {
    const h = JSON.parse(raw)
    return {
      accounts: Array.isArray(h.accounts) ? h.accounts.map(String) : null,
      connected: h.connected ?? null,
      ok: h.ok ?? null,
      error: h.error ?? null,
      at: h.at ?? null,
    }
  } catch {
    return { accounts: null, connected: null, at: null, ok: null, error: null }
  }
}

/**
 * When this account's broker truth was last reconciled.
 *
 * The key depends on which account it is: non-primary accounts get
 * `acct:<id>:last_reconcile_at` (loop.js passes setAccountState), while the
 * SELECTED account's reconcile writes the GLOBAL `last_reconcile_at`
 * (loop.js passes a plain setState). Falling back to the global key for any
 * other account would report one account's sweep as another's — the same trap
 * telegram-control.js:208 already sidesteps, and the reason the fallback is
 * conditional rather than universal.
 */
export function lastReconcileAt(db, accountId, selectedId) {
  let scoped = null
  try { scoped = getState(db, `acct:${accountId}:last_reconcile_at`) } catch { scoped = null }
  if (scoped) return { at: scoped, source: 'account' }
  if (String(accountId) === String(selectedId ?? '')) {
    let global = null
    try { global = getState(db, 'last_reconcile_at') } catch { global = null }
    if (global) return { at: global, source: 'global' }
  }
  return { at: null, source: null }
}

// A MISSING NUMBER IS null, NOT ZERO. `Number(null)` is 0 and 0 is finite, so
// the naive form reports an account with no recorded balance as holding $0 —
// indistinguishable from a real wipeout, and on this panel that is the one
// number nobody should have to second-guess. (Same trap as clampProposal's
// null-becomes-the-minimum bug, found the same day.)
const NUM = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The whole picture, one row per registry account.
 *
 * Reads the registry rather than taking a list, so an account can never be
 * missing from the panel because a caller forgot it.
 */
export function engineeringView(db) {
  const selectedId = getState(db, 'ctrader_account_id') || null
  const roster = sidecarRoster(db)

  let rows = []
  try {
    rows = db.prepare(
      `SELECT account_id, trader_login, is_live, enabled, mode, base_currency, leverage
         FROM accounts ORDER BY is_live, account_id`
    ).all()
  } catch { rows = [] }

  // Open positions per account in ONE grouped query rather than a query per
  // account. NULL-account rows are counted ONCE globally instead of being
  // attributed to every account — the codebase's usual
  // `(account_id = ? OR account_id IS NULL)` widening is right for *scoping a
  // view*, but here it would report the same legacy position as belonging to
  // all seven accounts at the same time.
  const openByAcct = new Map()
  let legacyOpen = 0
  try {
    for (const r of db.prepare(
      `SELECT account_id, COUNT(*) AS n FROM monitored_positions
        WHERE status = 'active' GROUP BY account_id`
    ).all()) {
      if (r.account_id == null) legacyOpen = r.n
      else openByAcct.set(String(r.account_id), r.n)
    }
  } catch { /* table shape older than this feature — counts stay 0 */ }

  // Most recent pipeline decision per account, from whichever of the two
  // provenance tables is newer. See the header: this is NOT "last dispatch".
  const decByAcct = new Map()
  const noteDecision = (id, at, stage, decision) => {
    if (id == null || !at) return
    const key = String(id)
    const prev = decByAcct.get(key)
    if (!prev || String(at) > String(prev.at)) decByAcct.set(key, { at, stage, decision })
  }
  try {
    for (const r of db.prepare(
      `SELECT account_id, MAX(created_at) AS at, stage, decision
         FROM decision_log WHERE account_id IS NOT NULL GROUP BY account_id`
    ).all()) noteDecision(r.account_id, r.at, r.stage, r.decision)
  } catch { /* pre-3A database */ }
  try {
    for (const r of db.prepare(
      `SELECT account_id, MAX(created_at) AS at, approved
         FROM risk_events WHERE account_id IS NOT NULL GROUP BY account_id`
    ).all()) noteDecision(r.account_id, r.at, 'risk_gate', r.approved ? 'approved' : 'veto')
  } catch { /* pre-M1 database */ }

  const master = masterPhases(db)

  return {
    selectedAccountId: selectedId,
    master,
    sidecar: {
      // null accounts = the sidecar did not report a roster (js exec mode, or
      // never probed). Distinct from [] which means "authorised for nothing".
      rosterKnown: roster.accounts != null,
      accounts: roster.accounts,
      connected: roster.connected,
      ok: roster.ok,
      error: roster.error,
      at: roster.at,
    },
    legacyOpenPositions: legacyOpen,
    accounts: rows.map(r => {
      const id = String(r.account_id)
      const phases = effectivePhases(db, id, master)
      const rec = lastReconcileAt(db, id, selectedId)
      const dec = decByAcct.get(id) || null
      return {
        accountId: id,
        traderLogin: r.trader_login ?? null,
        isLive: r.is_live === 1,
        enabled: r.enabled === 1,
        mode: r.mode ?? null,
        selected: id === String(selectedId ?? ''),
        baseCurrency: r.base_currency ?? null,
        leverage: NUM(r.leverage),
        balance: NUM(getState(db, `acct:${id}:account_balance_usd`)),
        phases: { scan: phases.scan, analyze: phases.analyze, autotrade: phases.autotrade, source: phases.source },
        // true / false / null — null is "unknown", never assumed to be false.
        sidecarAuthorised: roster.accounts == null ? null : roster.accounts.includes(id),
        openPositions: openByAcct.get(id) ?? 0,
        lastReconcileAt: rec.at,
        lastReconcileSource: rec.source,
        lastDecisionAt: dec?.at ?? null,
        lastDecisionStage: dec?.stage ?? null,
        lastDecision: dec?.decision ?? null,
      }
    }),
  }
}
