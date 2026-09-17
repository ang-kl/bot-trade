// ---------------------------------------------------------------------------
// agent/services/hand-pin-watch.js — what the hand pins are costing, measured
// while they cost it.
//
// WHY THIS EXISTS. On 17-09-2026 the owner armed `tsmom_long` globally. Two
// minutes later the edge watchdog disarmed it again on its own measurement:
//
//   07:46:55  Edge watchdog: disarmed tsmom_long (exp $-108.48, PF 0, scopes
//             global, held pins 42993489/43002148/43069009/46979908)
//
// PF 0 means zero winning closes in that window. The owner was shown the
// number, chose to arm three accounts anyway, and that is their call — the
// config records it as a deliberate override. This module is not an argument
// against it. It is the instrument the decision needs.
//
// THE PROBLEM IS THAT THE OVERRIDE IS INVISIBLE WHILE IT RUNS. Both automatic
// actors EXEMPT a hand pin from their POOLED verdict, which is exactly why the
// pins hold where the global switch keeps being turned off. What they do not
// exempt it from is that account's OWN record:
//
//   · adaptive-breaker  `accountsWithOwnStreak`  — own loss streak ≥ 3
//   · edge-watchdog     `accountsWithOwnNoEdge`  — own closes ≥ 15,
//                                                  own expectancy < 0,
//                                                  own PF < 0.95 (window 20)
//
// So a pin survives until the account's own evidence turns, and then it goes.
// Between those two moments nothing reports the distance, and the first news
// of the override's cost is the disarm line that ends it. That is the gap.
//
// WHAT THIS DOES AND DOES NOT DO. It reads. It arms nothing, disarms nothing,
// and changes no threshold. Every number comes from the SAME two functions
// that do the disarming, over the same windows, so a reader comparing this
// line to a later disarm line is comparing like with like rather than two
// implementations that may drift apart.
//
// `wouldDisarmToday` is a MEASUREMENT, not a recommendation and not a
// prediction: it says the account's own evidence already satisfies a disarm
// predicate right now. A pin in that state is being held open against a
// verdict that has already arrived — which is a different thing from a pin
// that is simply young, and the owner should not have to compute the
// difference by hand at the moment it matters.
//
// EVIDENCE-THIN IS NOT SAFE. A cell with four own closes cannot be judged, and
// this module says so in those words rather than printing a healthy-looking
// blank. A strategy nobody can judge yet is the state in which an override
// costs the most before anyone can tell.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { STRATEGY_KEYS } from './strategies.js'
import { acctMatrixKey } from './stage-matrix.js'
import { strategyRollingEdge, loadEdgeWatchdogConfig } from './edge-watchdog.js'
import { strategyLossStreak, loadAdaptiveBreakerConfig } from './adaptive-breaker.js'
import { whyCell } from './arming-log.js'

function readJson(db, key) {
  try {
    const parsed = JSON.parse(getState(db, key) || 'null')
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* corrupt state — treated as absent, never as "pinned" */ }
  return null
}

/**
 * Every (account, strategy) cell explicitly pinned TRUE.
 *
 * ONLY AN EXPLICIT `true` COUNTS. An absent cell inherits the global list, so
 * it is not a pin and reporting it as one would bury the handful of real
 * overrides under every strategy on every account. The distinction is the
 * same one `armedTradeKeys` makes when it lets an explicit cell override the
 * global — this reads the same field it does.
 */
export function handPinnedCells(db) {
  const out = []
  let accounts = []
  try {
    accounts = db.prepare('SELECT account_id, enabled FROM accounts ORDER BY account_id').all()
  } catch { return out }
  for (const a of accounts) {
    const acct = String(a.account_id)
    const overlay = readJson(db, acctMatrixKey(acct))?.strategy || {}
    for (const key of STRATEGY_KEYS) {
      if (overlay[key]?.trade !== true) continue
      out.push({ accountId: acct, enabled: a.enabled === 1 || a.enabled === true, strategy: key })
    }
  }
  return out
}

/**
 * One pinned cell, judged by the two predicates that can end it.
 *
 * `distance` is what it takes to reach each predicate from here, in the units
 * the predicate is written in: closes still needed before a verdict is even
 * possible, and losses still needed to complete a streak.
 */
export function handPinVerdict(db, accountId, strategy, cfg) {
  const edge = strategyRollingEdge(db, strategy, cfg.edge.window, { accountId, ownOnly: true })
  const { streak } = strategyLossStreak(db, strategy, 12, { accountId })

  const judgeable = edge.trades >= cfg.edge.minTrades
  const noEdge = judgeable && edge.expectancy < 0 && edge.profitFactor != null && edge.profitFactor < cfg.edge.pfFloor
  const streakHit = streak >= cfg.breaker.streak

  return {
    accountId, strategy,
    trades: edge.trades,
    expectancy: edge.expectancy,
    profitFactor: edge.profitFactor,
    winRate: edge.winRate,
    net: edge.net,
    streak,
    judgeable,
    noEdge,
    streakHit,
    wouldDisarmToday: noEdge || streakHit,
    distance: {
      closesToJudgeable: Math.max(0, cfg.edge.minTrades - edge.trades),
      lossesToStreak: Math.max(0, cfg.breaker.streak - streak),
    },
    // Who pinned it and why, from the PR-S ledger. `unrecorded` is honest:
    // a cell pinned before the ledger existed has no row, and saying so beats
    // implying nobody decided it.
    why: whyCell(db, { scope: accountId, kind: 'strategy', key: strategy, stage: 'trade', current: true }),
  }
}

/** Every pinned cell on an enabled account, with its own-evidence verdict. */
export function handPinReport(db) {
  const cfg = { edge: loadEdgeWatchdogConfig(db), breaker: loadAdaptiveBreakerConfig(db) }
  const cells = handPinnedCells(db).filter(c => c.enabled)
  const rows = cells.map(c => {
    try { return handPinVerdict(db, c.accountId, c.strategy, cfg) } catch { return null }
  }).filter(Boolean)

  const byAccount = {}
  for (const r of rows) {
    byAccount[r.accountId] ??= { total: 0, strategies: [], atRisk: [], thin: [] }
    const b = byAccount[r.accountId]
    b.total++
    b.strategies.push(r.strategy)
    if (r.wouldDisarmToday) b.atRisk.push(r.strategy)
    if (!r.judgeable) b.thin.push(r.strategy)
  }
  return {
    total: rows.length,
    accounts: Object.keys(byAccount).length,
    wouldDisarmToday: rows.filter(r => r.wouldDisarmToday).length,
    evidenceThin: rows.filter(r => !r.judgeable).length,
    losing: rows.filter(r => r.judgeable && r.expectancy != null && r.expectancy < 0).length,
    rows, byAccount, cfg,
  }
}

/**
 * The log line. NULL when there are no hand pins, and that silence is itself
 * the answer "nothing is being held open against the automatic actors".
 */
export function handPinLine(db) {
  const r = handPinReport(db)
  if (!r.total) return null

  // Worst first: a pin whose verdict has already arrived, then one losing but
  // not yet judgeable, then the rest. A reader who stops after the first
  // clause has still read the part that costs money.
  const rank = (row) => (row.wouldDisarmToday ? 0 : (!row.judgeable ? 1 : 2))
  const detail = [...r.rows]
    .sort((a, b) => rank(a) - rank(b) || (a.expectancy ?? 0) - (b.expectancy ?? 0))
    .slice(0, 8)
    .map((row) => {
      const acct = `…${row.accountId.slice(-4)}`
      if (!row.judgeable) {
        return `${acct}:${row.strategy} ${row.trades}/${r.cfg.edge.minTrades} own closes — NOT YET JUDGEABLE${row.streak > 0 ? `, ${row.streak} loss streak` : ''}`
      }
      const pf = row.profitFactor == null ? '∞' : row.profitFactor
      const verdict = row.wouldDisarmToday
        ? (row.noEdge ? 'WOULD BE DISARMED NOW on its own no-edge verdict' : `WOULD BE DISARMED NOW on its own ${row.streak}-loss streak`)
        : `holding — ${row.distance.lossesToStreak} more loss(es) would end it on streak`
      return `${acct}:${row.strategy} ${row.trades} closes exp $${row.expectancy} PF ${pf} net $${row.net} — ${verdict}`
    })
    .join('; ')

  return `[arming] hand-pinned cells: ${r.total} across ${r.accounts} account(s) — ${r.wouldDisarmToday} would be disarmed right now on their own evidence, ${r.evidenceThin} have too few own closes to judge, ${r.losing} are judgeable and losing. A hand pin is exempt from the POOLED verdict, never from the account's own. ${detail}`
}
