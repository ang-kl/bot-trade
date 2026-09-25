// ---------------------------------------------------------------------------
// agent/services/tick-shadow.js — P6a: the shadow portfolio as evidence
// (docs/tick-momentum/plan.md §2 "Shadow uses its own simulated portfolio",
// §7; register TM-35, the SHADOW_PASSED stage).
//
// The sidecar's shadow book (cpp-exec/src/tick_shadow.*) fills and exits by
// the replayer's rules on the live quotes and hands the keeper its closed
// trades (heartbeat pullTickShadow → tick_shadow_trades), each in R
// multiples of its own stop. This module turns those rows into a portfolio
// verdict per side and per profile — trades, profit factor in R, net R, the
// worst peak-to-trough run in R, the exit mix — and projects it onto each
// account on that side with THAT account's own risk budget (its own stamped
// balance × its own per-trade risk), never the connected account's.
//
// What this never does: read a bar-strategy record, size from the global
// balance key, or lower a threshold. A profile is judged only on trades
// closed under that profile.
//
// PR-L (16-09-2026, docs/plan-execution-audit-2026-09-11.md §16): the view
// also carries a COST-SENSITIVITY line — the portfolio's profit factor at
// 0 x, 1 x and 2 x the per-symbol-class cost schedule
// (agent/config/tick-shadow-sim.json, lib/tick-cost-schedule.js). The 236
// shadow trades already on record were closed spread-only, so their 1 x row
// is NOT their recorded profit factor; it is what they would have earned
// under the schedule, which is the number the owner needs before switching
// anything on.
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { loadRiskConfig, riskBudgetUsd } from './risk.js'
import { engineStatusFor } from './entry-mode.js'
import { expectancyLowerR, blockExpectancyLowerR } from '../lib/tick-replay-sim.js'
import { costSensitivity, loadRepoSchedule, rowChargedUnder, rowIsCosted, scheduleHash, TICK_COST_MAP_KEY } from '../lib/tick-cost-schedule.js'

export const SIDES = Object.freeze(['cpp_exec_demo', 'cpp_exec'])

function rows(db, { side, profilePrefix = null, sinceMs = null, limit = 5000, newest = false } = {}) {
  const where = ['side = ?']; const params = [side]
  if (profilePrefix) { where.push("(profile_hash = ? OR reason = 'lost_restart')"); params.push(profilePrefix) }
  if (sinceMs != null) { where.push('exit_ms >= ?'); params.push(Number(sinceMs)) }
  const cap = Math.max(1, Math.min(50_000, limit))
  try {
    // `newest` (the P2 counterfactual): when the window holds more than the
    // cap, keep the NEWEST rows — still returned in exit order. The default
    // keeps the oldest, as every existing caller has always had it.
    if (newest) return db.prepare(`SELECT * FROM tick_shadow_trades WHERE ${where.join(' AND ')} ORDER BY exit_ms DESC, id DESC LIMIT ?`).all(...params, cap).reverse()
    return db.prepare(`SELECT * FROM tick_shadow_trades WHERE ${where.join(' AND ')} ORDER BY exit_ms, id LIMIT ?`).all(...params, cap)
  } catch { return [] }
}

/**
 * The SHARED shadow trades for a side/profile/window — the same read the
 * portfolio uses, exported so the §2 account execution simulation projects
 * onto exactly the rows this module judges and cannot drift into a second,
 * subtly different population.
 */
export function sharedShadowTrades(db, opts = {}) { return rows(db, opts) }

// PR-H: the bootstrap lives with the replayer (lib/tick-replay-sim.js) so
// the replay and shadow stages judge expectancy by one statistic; kept on
// this module's surface for its importers.
export { expectancyLowerR }

/** The largest number of shadow trades open at once (entry/exit intervals). */
export function maxConcurrentOpen(trades) {
  const ev = []
  for (const t of trades) {
    const a = Number(t.entry_ms ?? t.entryMs), b = Number(t.exit_ms ?? t.exitMs)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    ev.push([a, 1]); ev.push([b, -1])
  }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]) // an exit at the same ms frees before the next entry
  let cur = 0, max = 0
  for (const [, d] of ev) { cur += d; if (cur > max) max = cur }
  return max
}

/**
 * The portfolio's figures in R over a set of shadow rows, in exit order.
 * Rows with reason 'reset' (marked at a switch-off) COUNT as trades with
 * their marked result; rows with reason 'lost_restart' (an open trade the
 * sidecar restart took with it) have no result and are counted apart, so
 * the record says how much of the book vanished unjudged.
 */
export function portfolioStats(rows) {
  let grossWin = 0, grossLoss = 0, net = 0, peak = 0, maxDD = 0, wins = 0, losses = 0, resets = 0, lost = 0
  const exits = {}
  const symbols = new Set()
  const rs = []
  const judged = []
  let firstMs = null, lastMs = null
  for (const t of rows) {
    const reason = t.reason || 'unknown'
    if (reason === 'lost_restart') { lost++; continue }
    const r = Number(t.net_r ?? t.netR)
    if (!Number.isFinite(r)) continue
    judged.push(t); rs.push(r)
    if (r > 0) { grossWin += r; wins++ } else { grossLoss += -r; if (r < 0) losses++ }
    net += r
    if (net > peak) peak = net
    if (peak - net > maxDD) maxDD = peak - net
    exits[reason] = (exits[reason] || 0) + 1
    if (reason === 'reset') resets++
    if (t.symbol_id != null) symbols.add(t.symbol_id)
    const ms = Number(t.exit_ms ?? t.exitMs)
    if (Number.isFinite(ms)) { if (firstMs == null || ms < firstMs) firstMs = ms; if (lastMs == null || ms > lastMs) lastMs = ms }
  }
  const n = judged.length
  // No losing trade yet means the profit factor is UNDEFINED, not infinite:
  // null here, and the validation stage refuses on it (Statistics auditor,
  // 11-09-2026: Infinity passed every floor and was stored as null anyway).
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : null
  return {
    trades: n, wins, losses, winPct: n ? +(100 * wins / n).toFixed(1) : null,
    netR: +net.toFixed(4), avgR: n ? +(net / n).toFixed(4) : null,
    expectancyLowerR: expectancyLowerR(rs),
    blockExpectancy: blockExpectancyLowerR(rs),
    markToMarketDrawdownR: null,
    drawdownBasis: 'closed_trades_only',
    grossWinR: +grossWin.toFixed(4), grossLossR: +grossLoss.toFixed(4), profitFactor,
    maxDrawdownR: +maxDD.toFixed(4), maxConcurrentOpen: maxConcurrentOpen(judged), exits, symbols: symbols.size,
    resets, lost, resetSharePct: (n + lost) ? +(100 * (resets + lost) / (n + lost)).toFixed(1) : null,
    firstExitAt: firstMs != null ? new Date(firstMs).toISOString() : null, lastExitAt: lastMs != null ? new Date(lastMs).toISOString() : null,
    hours: firstMs != null && lastMs != null ? +((lastMs - firstMs) / 3_600_000).toFixed(2) : 0,
    bootIds: [...new Set(rows.map(t => t.boot_id).filter(Boolean))],
  }
}

/**
 * ROUND-TWO CHECKER, MINOR 3: the row populations, counted ONCE and never
 * added across different denominators. A `lost_restart` row is not a closed
 * trade and never was one; reporting "3 of 7" by adding judged closes to
 * every-row-minus-costed was two populations in one fraction.
 *
 *   rows        every row in the window
 *   lostRestart rows with no result (an open trade a sidecar restart took)
 *   closed      rows with a result — the only ones a verdict can rest on
 *   charged     closed rows demonstrably charged `schedule` (rowChargedUnder)
 *   refused     closed rows that were not, by reason
 */
export function costAudit(allRows, schedule = null) {
  const charged = []
  const refused = {}
  let lostRestart = 0, closed = 0
  for (const t of allRows || []) {
    if ((t.reason || '') === 'lost_restart') { lostRestart++; continue }
    closed++
    if (!schedule) continue
    const v = rowChargedUnder(t, schedule)
    if (v.ok) charged.push(t)
    else refused[v.reason] = (refused[v.reason] || 0) + 1
  }
  return {
    charged,
    summary: {
      rows: (allRows || []).length, closed, lostRestart,
      charged: schedule ? charged.length : null,
      refused: schedule ? refused : null,
      preCostModel: (allRows || []).filter(t => (t.reason || '') !== 'lost_restart' && !rowIsCosted(t)).length,
      scheduleHash: schedule ? scheduleHash(schedule) : null,
      note: schedule
        ? 'a closed row counts as evidence only when its recorded cost terms equal this schedule\'s class row AND its own netR is consistent with them — the book\'s arithmetic, not the sidecar\'s declaration'
        : 'no schedule asked for: every closed row is shown, none is treated as evidence',
    },
  }
}

/**
 * PR-L: the cost schedule in force for a side, and the symbol id → class map
 * the keeper resolved when it last pushed it. The schedule itself is the
 * repo's (the file is the source of truth); the map is stored per side at
 * push time because a shadow ledger row carries a symbol ID and no name.
 * `mapped:false` says the keeper has not pushed yet — every row then prices
 * at the fallback class, which the line reports as `viaFallback`.
 */
export function sideCostSchedule(db, side, { file = undefined } = {}) {
  const schedule = loadRepoSchedule(file)
  let stored = null
  try { stored = (JSON.parse(getState(db, TICK_COST_MAP_KEY) || '{}') || {})[side] || null } catch { stored = null }
  const symbolClass = stored && stored.symbolClass && typeof stored.symbolClass === 'object' ? stored.symbolClass : {}
  return {
    schedule,
    symbolClass,
    mapped: Object.keys(symbolClass).length > 0,
    pushedAt: stored?.at ?? null,
    unclassified: Array.isArray(stored?.unclassified) ? stored.unclassified : [],
    pushedHash: stored?.hash ?? null,
    repoHash: Object.keys(schedule.classes).length ? scheduleHash(schedule) : null,
    classOfSymbol: (symbolId) => (symbolId == null ? null : symbolClass[String(symbolId)] || null),
  }
}

/**
 * WHICH ACCOUNTS BELONG TO A SIDE — the ONE routing read of `is_live` in the
 * shadow stack (owner principle 1: only routing may read it; every policy gate
 * reads balance and evidence). `cpp_exec` is the live sidecar's side and
 * `cpp_exec_demo` the other one, so this says which sidecar an account's
 * shadow trades came from and nothing about what it is allowed to do.
 *
 * Exported so the §2 account execution simulation reuses it instead of adding
 * a SECOND reader of the flag.
 *
 * @returns {string[]} account ids, ascending
 */
export function sideAccounts(db, side, { enabledOnly = false } = {}) {
  const env = side === 'cpp_exec' ? 1 : 0
  const where = 'is_live = ?' + (enabledOnly ? ' AND enabled = 1' : '')   // ONE reader of the flag, by design
  try { return db.prepare(`SELECT account_id FROM accounts WHERE ${where} ORDER BY account_id`).all(env).map(r => String(r.account_id)) } catch { return [] }
}

/** The account's own R in dollars: its stamped balance (scoped key only) × its own per-trade risk. */
export function accountRiskPerTrade(db, accountId) {
  const raw = getState(db, `acct:${String(accountId)}:account_balance_usd`)
  const bal = raw == null || String(raw).trim() === '' ? null : Number(raw)
  if (!Number.isFinite(bal)) return { balance: null, usdPerR: null, source: 'balance_not_read' }
  const cfg = loadRiskConfig(db, String(accountId))
  const usd = riskBudgetUsd(bal, cfg, 1)
  return { balance: bal, usdPerR: +usd.toFixed(2), perTradeRiskPct: cfg.perTradeRiskPct ?? null, source: 'own_balance_and_risk_config' }
}

/** One side's portfolio for one profile since a time, plus each account's projection. */
export function shadowPortfolio(db, { side, profilePrefix = null, sinceMs = null, chargedUnder = null } = {}) {
  const allTrades = rows(db, { side, profilePrefix, sinceMs })
  // ROUND-TWO CHECKER, BLOCKER 1/2: the evidence read (`chargedUnder`) keeps
  // only rows the sidecar's book DEMONSTRABLY charged that schedule — class
  // known, four terms equal to the schedule's class row, and the row's own
  // netR consistent with its own grossR under them. A string-emptiness test
  // on `cost_class` was not that, and six all-zero rows passed it.
  const audit = costAudit(allTrades, chargedUnder)
  const trades = chargedUnder ? audit.charged : allTrades
  const stats = portfolioStats(trades)
  // PR-L (plan §16): what this portfolio's profit factor would be at 0 ×, 1 ×
  // and 2 × the cost schedule. An evidence bar that moves under a plausible
  // cost assumption is what the owner needs to see BEFORE switching anything
  // on — and every one of the trades recorded before PR-L was closed
  // spread-only, so their 1 × row is not their recorded profit factor.
  const cost = sideCostSchedule(db, side)
  const sensitivity = { ...costSensitivity(allTrades, cost.schedule, cost.classOfSymbol), symbolMapPushedAt: cost.pushedAt, symbolMapped: cost.mapped, unclassifiedSymbols: cost.unclassified }
  let accounts = []
  try {
    accounts = sideAccounts(db, side).map(id => {
      const st = engineStatusFor(db, id)
      const risk = accountRiskPerTrade(db, id)
      return {
        accountId: `…${String(id).slice(-4)}`,
        tickObservation: st.tickObservation, validationStage: st.validationStage,
        ...risk,
        projectedNetUsd: risk.usdPerR != null ? +(stats.netR * risk.usdPerR).toFixed(2) : null,
        projectedMaxDrawdownUsd: risk.usdPerR != null ? +(stats.maxDrawdownR * risk.usdPerR).toFixed(2) : null,
      }
    })
  } catch { accounts = [] }
  return { side, profile: profilePrefix, since: sinceMs != null ? new Date(sinceMs).toISOString() : null, ...stats,
    costAudit: audit.summary, costSensitivity: sensitivity, accounts, projectionNote: 'a 1R rescale of the R series by each account\'s own risk budget — ignores minimum lots, margin, per-symbol caps and the position cap; a display, not evidence', recent: trades.slice(-20).map(t => ({ at: t.at, symbolId: t.symbol_id, side: t.trade_side, reason: t.reason, netR: t.net_r, holdEvents: t.hold_events, holdMs: t.hold_ms, exitAt: t.exit_ms != null ? new Date(Number(t.exit_ms)).toISOString() : null })) }
}

/** GET /state/tick-shadow: every side, every profile seen, the sidecar's own counters. */
export function tickShadowView(db) {
  const out = { at: new Date().toISOString(), sides: [], note: 'P6a: the shadow portfolio — the sidecar fills the strategy\'s signals by the replayer\'s rules on the live quotes and places nothing; figures are in R of each trade\'s own stop, projected per account with that account\'s own balance and per-trade risk. SHADOW_PASSED is judged on these figures against the owner-held thresholds.' }
  for (const side of SIDES) {
    let profiles = []
    try { profiles = db.prepare('SELECT profile_hash AS p, COUNT(*) AS n FROM tick_shadow_trades WHERE side = ? GROUP BY profile_hash ORDER BY n DESC').all(side) } catch { profiles = [] }
    let sidecar = null
    try { sidecar = JSON.parse(getState(db, `${side}_tick_json`) || 'null')?.status?.shadowPortfolio ?? null } catch { sidecar = null }
    let cursor = null
    try { cursor = JSON.parse(getState(db, 'tick_shadow_cursor_json') || '{}')[side] || null } catch { cursor = null }
    out.sides.push({ side, sidecar, cursor, profiles: profiles.map(pr => shadowPortfolio(db, { side, profilePrefix: pr.p })) })
  }
  return out
}
