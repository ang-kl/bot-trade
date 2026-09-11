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
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { loadRiskConfig, riskBudgetUsd } from './risk.js'
import { engineStatusFor } from './entry-mode.js'

export const SIDES = Object.freeze(['cpp_exec_demo', 'cpp_exec'])

function rows(db, { side, profilePrefix = null, sinceMs = null, limit = 5000 } = {}) {
  const where = ['side = ?']; const params = [side]
  if (profilePrefix) { where.push("(profile_hash = ? OR reason = 'lost_restart')"); params.push(profilePrefix) }
  if (sinceMs != null) { where.push('exit_ms >= ?'); params.push(Number(sinceMs)) }
  try {
    return db.prepare(`SELECT * FROM tick_shadow_trades WHERE ${where.join(' AND ')} ORDER BY exit_ms, id LIMIT ?`).all(...params, Math.max(1, Math.min(50_000, limit)))
  } catch { return [] }
}

/** A small deterministic PRNG (mulberry32) so the bootstrap is reproducible. */
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** The 5th percentile of bootstrapped mean R (plan §7 "uncertainty"): the
 *  expectancy a run of this many trades cannot rule out. null below 2 trades. */
export function expectancyLowerR(rs, { resamples = 1000, seed = 7, pct = 0.05 } = {}) {
  const xs = rs.filter(Number.isFinite)
  if (xs.length < 2) return null
  const rand = rng(seed)
  const means = []
  for (let b = 0; b < resamples; b++) {
    let sum = 0
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(rand() * xs.length)]
    means.push(sum / xs.length)
  }
  means.sort((a, b) => a - b)
  return +means[Math.min(means.length - 1, Math.floor(pct * means.length))].toFixed(4)
}

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
    grossWinR: +grossWin.toFixed(4), grossLossR: +grossLoss.toFixed(4), profitFactor,
    maxDrawdownR: +maxDD.toFixed(4), maxConcurrentOpen: maxConcurrentOpen(judged), exits, symbols: symbols.size,
    resets, lost, resetSharePct: (n + lost) ? +(100 * (resets + lost) / (n + lost)).toFixed(1) : null,
    firstExitAt: firstMs != null ? new Date(firstMs).toISOString() : null, lastExitAt: lastMs != null ? new Date(lastMs).toISOString() : null,
    hours: firstMs != null && lastMs != null ? +((lastMs - firstMs) / 3_600_000).toFixed(2) : 0,
    bootIds: [...new Set(rows.map(t => t.boot_id).filter(Boolean))],
  }
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
export function shadowPortfolio(db, { side, profilePrefix = null, sinceMs = null } = {}) {
  const trades = rows(db, { side, profilePrefix, sinceMs })
  const stats = portfolioStats(trades)
  let accounts = []
  try {
    const env = side === 'cpp_exec' ? 1 : 0
    accounts = db.prepare('SELECT account_id FROM accounts WHERE is_live = ? ORDER BY account_id').all(env).map(r => {
      const st = engineStatusFor(db, r.account_id)
      const risk = accountRiskPerTrade(db, r.account_id)
      return {
        accountId: `…${String(r.account_id).slice(-4)}`,
        tickObservation: st.tickObservation, validationStage: st.validationStage,
        ...risk,
        projectedNetUsd: risk.usdPerR != null ? +(stats.netR * risk.usdPerR).toFixed(2) : null,
        projectedMaxDrawdownUsd: risk.usdPerR != null ? +(stats.maxDrawdownR * risk.usdPerR).toFixed(2) : null,
      }
    })
  } catch { accounts = [] }
  return { side, profile: profilePrefix, since: sinceMs != null ? new Date(sinceMs).toISOString() : null, ...stats, accounts, projectionNote: 'a 1R rescale of the R series by each account\'s own risk budget — ignores minimum lots, margin, per-symbol caps and the position cap; a display, not evidence', recent: trades.slice(-20).map(t => ({ at: t.at, symbolId: t.symbol_id, side: t.trade_side, reason: t.reason, netR: t.net_r, holdEvents: t.hold_events, holdMs: t.hold_ms, exitAt: t.exit_ms != null ? new Date(Number(t.exit_ms)).toISOString() : null })) }
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
