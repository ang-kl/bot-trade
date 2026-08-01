// ---------------------------------------------------------------------------
// agent/services/account-phases.js — Scan / Analyze / Autotrade, PER ACCOUNT.
//
// Owner asked three times: "I need switches for each account", "scan/analyze/
// autotrade should be in all account. I don't want all accounts to be traded by
// this bot-trade in the same way", and finally "we are still not having
// independent switches, have you wired them?" — the answer to that last one was
// no. This module is the missing half.
//
// UNTIL NOW THERE WERE EXACTLY THREE FLAGS for the whole system:
// `scan_enabled`, `analyze_enabled`, `autotrade_enabled` in agent_state. The
// sidebar lights and the Tune toggles all read those, so "turn autotrade off
// for the demo account" was not something the system could express.
//
// THE MASTER STAYS A MASTER. A per-account value is an OVERRIDE of the global
// flag, and the master remains an absolute veto:
//
//     effective = master AND (override ?? master)
//
// So master OFF means off everywhere, full stop — the panic button keeps
// working and cannot be defeated by a per-account ON. A per-account OFF turns
// that one account off while the others keep running. An account with no
// override simply follows the master, byte-identically to the old behaviour,
// which is what makes arming this a no-op until someone sets a switch.
//
// Keys: acct:<id>:scan_enabled | analyze_enabled | autotrade_enabled
// Values: 'true' | 'false' | absent (= inherit).
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { setPhaseFlag } from './phase-audit.js'

/** The three phases, in pipeline order. */
export const PHASES = ['scan', 'analyze', 'autotrade']

const MASTER_KEY = {
  scan: 'scan_enabled',
  analyze: 'analyze_enabled',
  autotrade: 'autotrade_enabled',
}

export const acctPhaseKey = (accountId, phase) => `acct:${accountId}:${MASTER_KEY[phase]}`

/**
 * The master (global) flags, read with each one's EXISTING default.
 *
 * The defaults are deliberately asymmetric and must not be "tidied": scan and
 * analyze default ON (`!== 'false'`) while autotrade defaults OFF
 * (`=== 'true'`). That asymmetry is load-bearing — a fresh or unreadable DB
 * must never arrive armed to trade. Matches loop.js:2249-2250 and :886.
 */
export function masterPhases(db) {
  return {
    scan: getState(db, 'scan_enabled') !== 'false',
    analyze: getState(db, 'analyze_enabled') !== 'false',
    autotrade: getState(db, 'autotrade_enabled') === 'true',
  }
}

/** One account's raw overrides: true / false / null (= inherit the master). */
export function accountOverrides(db, accountId) {
  const out = {}
  for (const p of PHASES) {
    let v = null
    try { v = getState(db, acctPhaseKey(accountId, p)) } catch { v = null }
    out[p] = v === 'true' ? true : v === 'false' ? false : null
  }
  return out
}

/**
 * What this account may ACTUALLY do right now.
 *
 * @returns {{scan: boolean, analyze: boolean, autotrade: boolean,
 *            source: Record<string,'master'|'account'>}}
 *   `source` says which level decided each phase, so the UI can show "off
 *   because the master is off" differently from "off for this account" — the
 *   distinction the owner needs to avoid hunting for a switch that would have
 *   no effect.
 */
export function effectivePhases(db, accountId, master = null) {
  const m = master || masterPhases(db)
  if (accountId == null) return { ...m, source: { scan: 'master', analyze: 'master', autotrade: 'master' } }
  const ov = accountOverrides(db, accountId)
  const out = { source: {} }
  for (const p of PHASES) {
    // Master is an AND, never an OR: a per-account ON cannot defeat a global
    // OFF. The kill switch has to stay a kill switch.
    const eff = m[p] && (ov[p] === null ? true : ov[p])
    out[p] = eff
    out.source[p] = !m[p] ? 'master' : (ov[p] === false ? 'account' : 'master')
  }
  return out
}

/**
 * Set or clear one account's overrides.
 *
 * `null` clears an override (back to inheriting). Unknown phases are ignored
 * rather than throwing, so a future phase name in a stale client cannot 500 a
 * route that is otherwise fine.
 *
 * @param {Record<string, boolean|null>} patch e.g. { autotrade: false }
 * @returns {{accountId: string, set: Record<string, boolean|null>}}
 */
export function setAccountPhases(db, accountId, patch = {}, meta = {}) {
  const set = {}
  for (const p of PHASES) {
    if (!(p in patch)) continue
    const v = patch[p]
    const audit = { actor: meta.actor || 'unknown', via: meta.via || null, reason: meta.reason || null, accountId: String(accountId) }
    if (v === null) { setPhaseFlag(db, acctPhaseKey(accountId, p), null, audit); set[p] = null; continue }
    if (typeof v !== 'boolean') continue
    setPhaseFlag(db, acctPhaseKey(accountId, p), v ? 'true' : 'false', audit)
    set[p] = v
  }
  return { accountId: String(accountId), set }
}

/**
 * Would ANY of these accounts use this phase's output?
 *
 * Scan and analyze are done ONCE PER CYCLE for the whole system, not per
 * account (loop.js:2269 scans the shared symbol universe; only dispatch fans
 * out). So switching scan off for one of three accounts cannot save any scan
 * work — the other two still need it. What it CAN do is stop the work entirely
 * once no account wants it, which is the owner's actual concern ("I am serious
 * about avoiding unnecessary effort and expenses in trading").
 *
 * An empty roster returns TRUE deliberately: no roster knowledge is not the
 * same as "nobody wants it", and a registry that failed to load must not
 * silently stop the pipeline.
 *
 * @param {string[]} accountIds the accounts the loop would actually dispatch to
 */
export function phaseWanted(db, phase, accountIds) {
  const m = masterPhases(db)
  if (!m[phase]) return false
  if (!Array.isArray(accountIds) || accountIds.length === 0) return true
  return accountIds.some(id => effectivePhases(db, id, m)[phase])
}

/**
 * The whole picture for a status panel: the master, plus every registry
 * account's overrides and effective state.
 *
 * Reads the registry rather than taking a list, so an account can never be
 * missing from the panel just because a caller forgot it.
 */
export function phasesView(db) {
  const master = masterPhases(db)
  let rows = []
  try {
    rows = db.prepare(
      'SELECT account_id, trader_login, is_live, enabled, mode, base_currency FROM accounts ORDER BY is_live, account_id'
    ).all()
  } catch { rows = [] }
  // Owner (2026-07-31, on the Pipeline switches table): "I need more details
  // like current balance, how many open positions, pending positions,
  // disconnected or active bot-trade." Balance is the per-account stamp the
  // loop maintains (acct:<id>:account_balance_usd) — null means the account
  // has never been reconciled, an honest unknown, not zero. Counts are
  // ATTRIBUTED rows only (account_id = this account): a legacy NULL row
  // cannot be charged to every account at once. Connectivity is stamped by
  // the ROUTE from the sidecar roster (async — this view stays sync).
  const openCount = (() => {
    try { return db.prepare("SELECT COUNT(*) AS n FROM monitored_positions WHERE status = 'active' AND account_id = ?") } catch { return null }
  })()
  const pendingCount = (() => {
    try { return db.prepare("SELECT COUNT(*) AS n FROM pending_orders WHERE status = 'working' AND account_id = ?") } catch { return null }
  })()
  return {
    master,
    accounts: rows.map(r => {
      const id = String(r.account_id)
      const balRaw = getState(db, acctPhaseNs(id, 'account_balance_usd'))
      const balance = balRaw != null && Number.isFinite(Number(balRaw)) ? Number(balRaw) : null
      return {
        accountId: id,
        traderLogin: r.trader_login ?? null,
        isLive: r.is_live === 1,
        enabled: r.enabled === 1,
        mode: r.mode ?? null,
        baseCurrency: r.base_currency ?? null,
        balance,
        openPositions: (() => { try { return openCount?.get(id)?.n ?? null } catch { return null } })(),
        pendingOrders: (() => { try { return pendingCount?.get(id)?.n ?? null } catch { return null } })(),
        overrides: accountOverrides(db, r.account_id),
        effective: effectivePhases(db, r.account_id, master),
        // Ratchet v2 hold (01-08): the profit ratchet no longer disarms any
        // switch — its per-account hold is reported here so the UI can badge
        // the row honestly. 'halt' = floor confirmed; 'soft' = warning band.
        ratchet: getState(db, acctPhaseNs(id, 'ratchet_halt')) === 'true'
          ? 'halt'
          : getState(db, acctPhaseNs(id, 'ratchet_soft')) === 'true' ? 'soft' : null,
      }
    }),
  }
}

/** acct:<id>:<key> for NON-phase state (balance etc) — same namespace as
 *  account-registry's acctKey; duplicated here to avoid a module cycle. */
const acctPhaseNs = (accountId, key) => `acct:${accountId}:${key}`
