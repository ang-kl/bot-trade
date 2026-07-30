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

import { getState, setState } from '../db.js'

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
export function setAccountPhases(db, accountId, patch = {}) {
  const set = {}
  for (const p of PHASES) {
    if (!(p in patch)) continue
    const v = patch[p]
    if (v === null) { setState(db, acctPhaseKey(accountId, p), null); set[p] = null; continue }
    if (typeof v !== 'boolean') continue
    setState(db, acctPhaseKey(accountId, p), v ? 'true' : 'false')
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
      'SELECT account_id, trader_login, is_live, enabled, mode FROM accounts ORDER BY is_live, account_id'
    ).all()
  } catch { rows = [] }
  return {
    master,
    accounts: rows.map(r => ({
      accountId: String(r.account_id),
      traderLogin: r.trader_login ?? null,
      isLive: r.is_live === 1,
      enabled: r.enabled === 1,
      mode: r.mode ?? null,
      overrides: accountOverrides(db, r.account_id),
      effective: effectivePhases(db, r.account_id, master),
    })),
  }
}
