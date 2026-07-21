// ---------------------------------------------------------------------------
// agent/services/edge-watchdog.js — per-strategy alpha-decay enforcement.
//
// Owner mandate: "ensure no alpha decay" — the machine, not a human watching
// a dashboard, should retire a strategy the moment its LIVE edge turns
// negative. Two breakers already existed but each has a blind spot:
//   · adaptive-breaker  — reacts to a per-strategy consecutive LOSS STREAK.
//   · performance-breaker — reacts to the AGGREGATE profit factor of ALL
//     strategies combined, and disarms autotrade wholesale.
// Neither catches a SINGLE strategy grinding to negative expectancy WITHOUT a
// streak (win, lose, lose, win, lose, lose … PF ~0.3, no streak ever hitting
// 3, and the aggregate stays afloat because another strategy is carrying it).
// That grind is exactly how the account bled while every brake stayed quiet.
//
// This watchdog runs once per loop and, for each ARMED strategy, computes its
// rolling live expectancy/PF/win over a full window (now honest — broker
// stop-outs are backfilled). A strategy that is CLEARLY losing over a real
// sample is disarmed at its Auto Trade & Open cell, through the same setStage
// path the Tune matrix and the other breakers use. Acts once per newest trade
// (dedupe), lands in action_log, pings the owner. Auto-disarm defaults ON —
// this is the enforcement the owner explicitly asked the machine to own.
//
// It only ever DISARMS (never arms) and only touches strategies that are
// already live, so the worst case is "stopped trading a loser too eagerly",
// recoverable with one click in Tune — the safe direction to be wrong in.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { enabledStrategies } from './strategies.js'
import { loadStageMatrix, setStage } from './stage-matrix.js'

export const DEFAULT_EDGE_WATCHDOG = {
  on: true,          // enforcement armed by default (owner: "no alpha decay")
  window: 20,        // rolling window of a strategy's most recent closed trades
  minTrades: 15,     // never judge an edge on a handful of trades
  pfFloor: 0.95,     // profit factor must be under this to count as "no edge"
}

export function loadEdgeWatchdogConfig(db) {
  try {
    const p = JSON.parse(getState(db, 'edge_watchdog_json') || 'null')
    if (p && typeof p === 'object') {
      return {
        on: p.on !== false,
        window: Math.min(200, Math.max(5, Math.round(Number(p.window) || 20))),
        minTrades: Math.min(200, Math.max(5, Math.round(Number(p.minTrades) || 15))),
        pfFloor: Math.min(1.5, Math.max(0, Number.isFinite(Number(p.pfFloor)) ? Number(p.pfFloor) : 0.95)),
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_EDGE_WATCHDOG }
}

/**
 * Rolling edge for one strategy over its last `window` closed trades. Only
 * trades with a realized P&L count (NULLs are un-backfilled broker closes —
 * excluding them keeps the maths honest rather than reading a loss as 0).
 */
export function strategyRollingEdge(db, strategyKey, window) {
  const rows = db.prepare(
    `SELECT id, net_pnl FROM trades
      WHERE status = 'closed' AND net_pnl IS NOT NULL AND label_strategy = ?
      ORDER BY closed_at DESC, id DESC LIMIT ?`
  ).all(strategyKey, window)
  const n = rows.length
  if (n === 0) return { trades: 0, expectancy: null, profitFactor: null, winRate: null, net: 0, newestId: null }
  const wins = rows.filter(r => Number(r.net_pnl) > 0)
  const grossWin = wins.reduce((s, r) => s + Number(r.net_pnl), 0)
  const grossLoss = Math.abs(rows.filter(r => Number(r.net_pnl) < 0).reduce((s, r) => s + Number(r.net_pnl), 0))
  const net = rows.reduce((s, r) => s + Number(r.net_pnl), 0)
  return {
    trades: n,
    expectancy: Math.round((net / n) * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0),
    winRate: Math.round((wins.length / n) * 100),
    net: Math.round(net * 100) / 100,
    newestId: rows[0].id,
  }
}

/**
 * One pass — call once per loop cycle. Disarms any armed strategy whose live
 * edge is clearly negative over a full window. Returns the actions taken and
 * the per-strategy evaluation (for the dashboard). Never throws.
 */
export function runEdgeWatchdog(db, { notify } = {}) {
  const cfg = loadEdgeWatchdogConfig(db)
  if (!cfg.on) return { skipped: 'off', actions: [], evaluated: [] }

  const io = { getState, setState }
  const actions = []
  const evaluated = []
  let matrix
  try { matrix = loadStageMatrix(db, getState) } catch { matrix = { strategies: [] } }

  // Only armed strategies are candidates — disarming an already-off strategy
  // is a no-op, and arming is never the watchdog's job.
  const armed = enabledStrategies(db, getState).map(s => s.key)
  for (const key of armed) {
    try {
      const e = strategyRollingEdge(db, key, cfg.window)
      evaluated.push({ strategy: key, ...e })
      if (e.trades < cfg.minTrades || e.newestId == null) continue

      // "Clearly no edge": losing money on average AND a sub-floor profit
      // factor. Requiring both keeps a breakeven-but-noisy strategy
      // (expectancy -0.01, PF 0.99) from being disarmed on a coin-flip.
      const pf = e.profitFactor
      const clearlyLosing = e.expectancy < 0 && pf != null && pf < cfg.pfFloor
      if (!clearlyLosing) continue

      // Act once per newest trade — don't re-disarm every cycle.
      const seenKey = `edge_watchdog_acted_${key}`
      if (String(getState(db, seenKey)) === String(e.newestId)) continue

      const me = matrix.strategies.find(s => s.key === key)
      if (!me || !me.stages.trade) continue // not actually armed — skip

      setState(db, seenKey, String(e.newestId))
      setStage(db, { kind: 'strategy', key, stage: 'trade', on: false }, io)
      const action = { strategy: key, did: 'disarmed_no_edge', expectancy: e.expectancy, profitFactor: pf, winRate: e.winRate, trades: e.trades, net: e.net }
      actions.push(action)
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('WATCHDOG', '/edge', JSON.stringify(action).slice(0, 2000))
      } catch { /* audit best-effort */ }
      try {
        notify?.(`🛑 EDGE WATCHDOG: ${key} disarmed — negative edge over ${e.trades} trades (expectancy $${e.expectancy}, PF ${pf ?? '∞'}, win ${e.winRate}%, net $${e.net}). No alpha-decay: it stopped trading itself. Re-arm from Tune when it earns it back.`)
      } catch { /* best effort */ }
    } catch (err) {
      console.error('[edge-watchdog]', key, err.message)
    }
  }

  // A compact snapshot for the dashboard / audit — the last evaluation and any
  // actions, honestly labelled (no fabricated numbers; nulls stay null).
  try {
    setState(db, 'edge_watchdog_last_json', JSON.stringify({ at: new Date().toISOString(), cfg, evaluated, actions }))
  } catch { /* best effort */ }

  return { actions, evaluated }
}
