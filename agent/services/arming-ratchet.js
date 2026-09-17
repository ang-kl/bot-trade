// ---------------------------------------------------------------------------
// agent/services/arming-ratchet.js — PR-T: the per-account slide to dark,
// measured.
//
// WHAT WAS MEASURED (17-09-2026, production boot on 625b92b):
//
//   [boot] strategy pins: 0 applied, 67 unchanged, 24 held (seeded before,
//   since disarmed: 42993489:donchian_breakout … 43097342:tsmom_long …
//   46130058:tsmom_long … 47790949:tsmom_long)
//
//   [loop] momentum book: … ran on 2 — 3 not armed for tsmom_long
//
// THE MECHANISM, read from the code rather than inferred. Exactly one code
// path writes a per-account strategy trade cell to TRUE:
// `seedStrategyPinsFromConfig` (stage-matrix.js), and it is deliberately
// seed-once — a cell it has seeded before is reported `held`, never re-applied.
// Meanwhile the adaptive breaker and the edge watchdog write FALSE cells on
// every qualifying verdict, and the nightly autopilot re-arms only the GLOBAL
// list — which `armedTradeKeys` lets an explicit cell override.
//
// So a per-account cell is a ONE-WAY RATCHET. It can be turned off by two
// automatic actors and turned back on by nobody but the owner. Twenty-four
// cells across four accounts are already in that state, including `tsmom_long`
// on the three accounts where the momentum book — the only family in this repo
// with measured positive expectancy at its horizon — reports "not armed" and
// cannot enter.
//
// WHAT THIS MODULE DOES, AND DELIBERATELY DOES NOT DO. It measures and
// reports. It does not re-arm anything. Re-arming is a risk-control decision:
// most of these cells were written false by a loss streak or a no-edge
// verdict, and an automatic re-arm would be a guard being overridden by the
// thing it guards against. CLAUDE.md P7 keeps that ask-first. What the owner
// needs in order to decide is the list, the reason each cell went off, and
// what that account's OWN evidence says NOW — which is what this produces,
// using the same functions the breaker and the watchdog judge with, so the
// numbers are comparable to the ones that did the disarming.
//
// THE REASON COLUMN IS HONEST ABOUT ITS OWN AGE. PR-S started recording who
// disarmed a cell and why, but only from its deploy. Every cell disarmed
// before that reads `unrecorded`, and this report says so per row rather than
// offering the most plausible actor. That distinction is the whole point of
// the ledger and it must not be smoothed over here.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { STRATEGY_KEYS, enabledStrategies } from './strategies.js'
import { acctMatrixKey, acctEnabledKey } from './stage-matrix.js'
import { strategyRollingEdge, loadEdgeWatchdogConfig } from './edge-watchdog.js'
import { strategyLossStreak, loadAdaptiveBreakerConfig } from './adaptive-breaker.js'
import { whyCell } from './arming-log.js'

function readJson(db, key) {
  try {
    const parsed = JSON.parse(getState(db, key) || 'null')
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* corrupt state — treated as absent, never as "all off" */ }
  return null
}

/**
 * Every (account, strategy) cell that is EXPLICITLY false while the strategy
 * is armed globally — i.e. the account is refusing a strategy the rest of the
 * system is trading.
 *
 * A cell that is merely ABSENT is not ratcheted: it follows the global and
 * will arm the moment the global does. Only an explicit false overrides, and
 * only an explicit false is a decision somebody made. That distinction is why
 * the arming ledger keeps `unset` and `false` apart.
 */
export function ratchetedCells(db) {
  const globallyArmed = new Set(enabledStrategies(db, getState).map(s => s.key))
  const out = []
  let accounts = []
  try {
    accounts = db.prepare('SELECT account_id, enabled FROM accounts ORDER BY account_id').all()
  } catch { return out }
  for (const a of accounts) {
    const acct = String(a.account_id)
    const overlay = readJson(db, acctMatrixKey(acct))?.strategy || {}
    // An un-migrated account still reads its wholesale list; absence from that
    // list is the same refusal an explicit false is, so it counts too.
    const legacy = readJson(db, acctEnabledKey(acct))
    const legacySet = Array.isArray(legacy) ? new Set(legacy.filter(k => STRATEGY_KEYS.includes(k))) : null
    for (const key of STRATEGY_KEYS) {
      if (!globallyArmed.has(key)) continue          // off everywhere — not a per-account ratchet
      const cell = overlay[key]?.trade
      let refusedBy = null
      if (cell === false) refusedBy = 'explicit_false_cell'
      else if (cell === undefined && legacySet && !legacySet.has(key)) refusedBy = 'absent_from_legacy_list'
      if (!refusedBy) continue
      out.push({ accountId: acct, enabled: a.enabled === 1 || a.enabled === true, strategy: key, refusedBy })
    }
  }
  return out
}

/**
 * The full report: every ratcheted cell, why it went off (from the arming
 * ledger, or an explicit `unrecorded`), and what that account's OWN closes say
 * about the strategy NOW — measured with the same two functions that did the
 * disarming, over the same windows, so the numbers are directly comparable to
 * the verdicts that wrote the cell false.
 *
 * `wouldClearToday` is NOT a recommendation and arms nothing. It says only:
 * on this account's own evidence, right now, neither automatic actor would
 * disarm this cell if it were armed. A cell that would be disarmed again the
 * moment it came back is a different conversation from one that is off because
 * of a streak that ended three weeks ago, and the owner should not have to
 * compute that difference by hand.
 */
export function armingRatchetReport(db) {
  const wd = loadEdgeWatchdogConfig(db)
  const br = loadAdaptiveBreakerConfig(db)
  const rows = ratchetedCells(db).map((c) => {
    const edge = strategyRollingEdge(db, c.strategy, wd.window, { accountId: c.accountId, ownOnly: true })
    const { streak } = strategyLossStreak(db, c.strategy, 12, { accountId: c.accountId })
    const why = whyCell(db, { scope: c.accountId, kind: 'strategy', key: c.strategy, stage: 'trade', current: false })
    // The two bars, evaluated exactly as their owners evaluate them.
    const noEdgeNow = edge.trades >= wd.minTrades && edge.expectancy < 0
      && edge.profitFactor != null && edge.profitFactor < wd.pfFloor
    const streakNow = streak >= br.streak
    return {
      ...c,
      disarmedBy: why.verdict === 'recorded' ? why.lastSet.actor : null,
      disarmReason: why.verdict === 'recorded' ? why.lastSet.reason : null,
      disarmedAt: why.verdict === 'recorded' ? why.lastSet.at : null,
      reasonVerdict: why.verdict,
      ownEvidence: { trades: edge.trades, expectancy: edge.expectancy, profitFactor: edge.profitFactor, winRate: edge.winRate, net: edge.net, lossStreak: streak },
      bars: { window: wd.window, minTrades: wd.minTrades, pfFloor: wd.pfFloor, streak: br.streak },
      wouldDisarmAgain: { noEdge: noEdgeNow, lossStreak: streakNow },
      // Enough of its own closes to say anything at all. Below this the honest
      // answer is "no evidence either way", which is NOT the same as "clear".
      evidenceThin: edge.trades < wd.minTrades,
      wouldClearToday: !noEdgeNow && !streakNow,
    }
  })
  const byAccount = {}
  for (const r of rows) {
    byAccount[r.accountId] = byAccount[r.accountId] || { total: 0, strategies: [], wouldClear: 0, thin: 0 }
    byAccount[r.accountId].total++
    byAccount[r.accountId].strategies.push(r.strategy)
    if (r.wouldClearToday) byAccount[r.accountId].wouldClear++
    if (r.evidenceThin) byAccount[r.accountId].thin++
  }
  return {
    rows,
    byAccount,
    total: rows.length,
    unrecorded: rows.filter(r => r.reasonVerdict === 'unrecorded').length,
    wouldClearToday: rows.filter(r => r.wouldClearToday).length,
    evidenceThin: rows.filter(r => r.evidenceThin).length,
    note: 'a ratcheted cell is one this account refuses while the strategy is armed globally. Nothing here re-arms anything: the only automatic writer of a TRUE per-account cell is the boot seed, and it is seed-once by design, so these cells return only by the owner\'s word. `wouldClearToday` means neither the breaker nor the watchdog would disarm it on this account\'s own evidence right now — it is not a recommendation, and `evidenceThin` rows have too few closes to say anything either way.',
  }
}

/**
 * One stdout line per pass, because the state routes need a bearer token and
 * the token has been the standing blocker since 07-09. A report the owner
 * cannot read is the same shape as a guard that cannot fire.
 *
 * Silent when there is nothing ratcheted, and it names the strategies rather
 * than only counting them — "8 cells off on …0949" does not tell you the
 * momentum book is among them.
 */
export function armingRatchetLine(db) {
  const r = armingRatchetReport(db)
  if (!r.total) return null
  const per = Object.entries(r.byAccount)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([acct, v]) => `…${acct.slice(-4)}: ${v.total} (${v.strategies.join(', ')})`)
    .join('; ')
  return `[arming] ratcheted off per account: ${r.total} cell(s) across ${Object.keys(r.byAccount).length} account(s) — ${r.wouldClearToday} would not be disarmed again on today's own evidence, ${r.evidenceThin} have too few own closes to judge, ${r.unrecorded} have no recorded reason (disarmed before the arming ledger). Only the owner re-arms these. ${per}`
}
