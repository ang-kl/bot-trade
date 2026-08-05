// ---------------------------------------------------------------------------
// agent/services/trade-gate-resolver.js — "why is this strategy not trading?"
//
// Owner, 05-08-2026: "are there too many same exactly strategy-fields
// switches … make sure all the strategies display on the UI are not
// conflicting with duplicate switches and result in no trading."
//
// There are NINE switches between a signal and an order, spread over four
// screens, and every one of them is an AND. Any single OFF stops everything,
// and until now no screen could say which. The Pipeline matrix knew about two
// of them, the sidebar knew about three, the Accounts page knew about two, and
// nothing held all nine at once — so the honest answer to "why is nothing
// trading" was a tour of the UI.
//
//   1  registry enabled          accounts.enabled          Accounts
//   2  mode permits entry        accounts.mode             Accounts
//   3  master scan               scan_enabled              Sidebar S.A.T.
//   4  master analyze            analyze_enabled           Sidebar S.A.T.
//   5  master autotrade          autotrade_enabled         Sidebar S.A.T.
//   6  account scan override     acct:<id>:scan_enabled    Sidebar S.A.T.
//   7  account analyze override  acct:<id>:analyze_enabled Sidebar S.A.T.
//   8  matrix SCAN cell          stage_matrix_json (+acct) Tune → Pipeline
//   9  matrix TRADE cell         stage matrix trade column Tune → Pipeline
//
// (The per-account AUTOTRADE override and the account's mode are the SAME
// fact stored twice — account-phases.js collapsed them and says so in its own
// comment. It is reported once, at #2, rather than twice with one of them
// unactionable.)
//
// THIS MODULE DECIDES NOTHING. It re-reads the same functions the loop reads —
// effectivePhases, accountCapabilities, loadStageMatrix — and reports. If it
// ever disagrees with the trading path, the trading path is right and this is
// the bug; that is the whole point of it not having its own copy of the rules.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { loadStageMatrix } from './stage-matrix.js'
import { effectivePhases, masterPhases, accountOverrides } from './account-phases.js'
import { accountCapabilities } from './account-capabilities.js'

/** Where the owner goes to change each gate — the half a verdict usually omits. */
export const GATE_WHERE = Object.freeze({
  registry_enabled: 'Accounts → enable the account',
  account_mode: 'Accounts → set the mode to Active',
  master_scan: 'Sidebar → Scan',
  master_analyze: 'Sidebar → Analyze',
  master_autotrade: 'Sidebar → Autotrade',
  account_scan: 'Sidebar → this account → Scan',
  account_analyze: 'Sidebar → this account → Analyze',
  matrix_scan: 'Tune → Pipeline → Scan column',
  matrix_trade: 'Tune → Pipeline → Auto Trade & Open column',
})

/**
 * Every gate between a signal and an order, in the order the pipeline applies
 * them, for ONE strategy on ONE account.
 *
 * @returns {{ok, blockedBy, gates: Array<{key,label,pass,where,detail}>}}
 *   `blockedBy` is the FIRST failing gate — the one to fix, since the rest are
 *   downstream of it and may only look broken because it is.
 */
export function tradeGateChain(db, { accountId, strategy } = {}) {
  const acct = accountId != null && accountId !== 'all' ? String(accountId) : null
  const key = String(strategy || '')
  const known = STRATEGY_REGISTRY.find(s => s.key === key)

  const gates = []
  const add = (k, label, pass, detail) =>
    gates.push({ key: k, label, pass: !!pass, where: GATE_WHERE[k] || null, detail: detail ?? null })

  if (!known) {
    return { ok: false, blockedBy: null, strategy: key, accountId: acct, gates, error: `unknown strategy '${key}'` }
  }

  // --- account-level -------------------------------------------------------
  let caps = { enabled: true, enter: true, mode: null, known: false }
  if (acct) {
    try { caps = accountCapabilities(db, acct) } catch { /* fail open, like the readouts */ }
    add('registry_enabled', 'Account enabled', caps.known ? caps.enabled !== false : true,
      caps.known ? null : 'account not in the registry — treated as enabled')
    add('account_mode', 'Mode permits entry', caps.known ? caps.enter !== false : true,
      caps.mode ? `mode ${caps.mode}` : null)
  }

  // --- the S.A.T. switches -------------------------------------------------
  const master = masterPhases(db)
  add('master_scan', 'Master Scan', master.scan)
  add('master_analyze', 'Master Analyze', master.analyze)
  add('master_autotrade', 'Master Autotrade', master.autotrade)

  if (acct) {
    // Master is an AND that a per-account ON cannot defeat, so the account row
    // is only meaningful where the master is already on — reporting it as the
    // blocker when the master is off would point at the wrong switch.
    const ov = accountOverrides(db, acct)
    const eff = effectivePhases(db, acct, master)
    add('account_scan', 'Account Scan', !master.scan || eff.scan,
      ov.scan === false ? 'switched off for this account' : null)
    add('account_analyze', 'Account Analyze', !master.analyze || eff.analyze,
      ov.analyze === false ? 'switched off for this account' : null)
  }

  // --- the Pipeline matrix -------------------------------------------------
  const mx = loadStageMatrix(db, getState, acct)
  const row = mx.strategies.find(s => s.key === key)
  add('matrix_scan', 'Pipeline · Scan', row?.stages?.scan,
    acct ? `for ${acct}` : 'global default')
  add('matrix_trade', 'Pipeline · Auto Trade & Open', row?.stages?.trade,
    acct ? `for ${acct}` : 'global default')

  const blocked = gates.find(g => !g.pass) || null
  return {
    ok: !blocked,
    blockedBy: blocked ? blocked.key : null,
    reason: blocked ? `${blocked.label} is OFF${blocked.where ? ` — ${blocked.where}` : ''}` : null,
    strategy: key,
    accountId: acct,
    gates,
  }
}

/** One line, for a log or a card. */
export const gateLine = (r) =>
  r.ok
    ? `${r.strategy}: all ${r.gates.length} gates open${r.accountId ? ` on ${r.accountId}` : ''}`
    : `${r.strategy}: blocked at ${r.reason}${r.accountId ? ` (${r.accountId})` : ''}`

/**
 * The whole matrix at once: every registry strategy for one account.
 *
 * This is what lets the Pipeline card and the Liveness card agree — both read
 * THIS, so "top says armed, bottom says not" stops being possible.
 */
export function tradeGateMatrix(db, { accountId } = {}) {
  const rows = STRATEGY_REGISTRY.map(s => tradeGateChain(db, { accountId, strategy: s.key }))
  return {
    accountId: accountId != null && accountId !== 'all' ? String(accountId) : null,
    tradable: rows.filter(r => r.ok).length,
    blocked: rows.filter(r => !r.ok).length,
    // Which single switch is stopping the most strategies — the one worth
    // fixing first when several rows are dark at once.
    topBlocker: (() => {
      const counts = {}
      for (const r of rows) if (r.blockedBy) counts[r.blockedBy] = (counts[r.blockedBy] || 0) + 1
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
      return best ? { gate: best[0], strategies: best[1], where: GATE_WHERE[best[0]] || null } : null
    })(),
    rows,
  }
}
