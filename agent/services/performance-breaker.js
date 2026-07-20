// ---------------------------------------------------------------------------
// agent/services/performance-breaker.js — the "all hands on deck" checkpoint.
//
// Owner: "performance is bad now, what checkpoints would you have to trigger
// 'all hands on deck' to 'turn the tide'?" Two safeguards already existed
// (equity-stop: a same-day $ drawdown closes everything; adaptive-breaker: 3
// losses in a row on ONE strategy changes it), but neither catches a
// strategy that's just STRUCTURALLY losing without ever stringing 3 losses
// back to back — e.g. win, lose, lose, win, lose, lose can grind a profit
// factor of 0.2 with no streak ever hitting 3. This checks the AGGREGATE
// edge over a rolling window, the same profit-factor/expectancy numbers the
// Desk Performance panel already shows.
//
// Deliberately alert-first: auto-disarming autotrade on an aggregate stat is
// a bigger claim than a single day's $ drawdown or one strategy's streak, so
// autoDisarm defaults OFF — the alert fires, the owner decides, unless they
// explicitly arm the auto-disarm toggle in Tune.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

export const DEFAULT_PERFORMANCE_BREAKER = {
  on: true,          // alerting armed by default — it only ever sends a message
  window: 20,         // rolling window of closed trades
  minTrades: 15,      // don't judge an edge on a handful of trades
  pfThreshold: 0.8,   // profit factor below this over the window = trouble
  // Owner armed this 2026-07-20 after PF hit 0.15 (Net −$2019): auto-disarm
  // ON. The trigger only fires below a 0.8 profit factor over 15+ trades —
  // "clearly bleeding" territory — so stopping new entries there and waiting
  // for a human is the right default now, not a per-account opt-in. Toggle
  // back off in Tune if you'd rather it only alerts.
  autoDisarm: true,
}

export function loadPerformanceBreakerConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'performance_breaker_json') || 'null')
    if (parsed && typeof parsed === 'object') {
      return {
        on: parsed.on !== false,
        window: Math.min(200, Math.max(5, Math.round(Number(parsed.window) || DEFAULT_PERFORMANCE_BREAKER.window))),
        minTrades: Math.min(200, Math.max(5, Math.round(Number(parsed.minTrades) || DEFAULT_PERFORMANCE_BREAKER.minTrades))),
        pfThreshold: Math.min(2, Math.max(0.1, Number(parsed.pfThreshold) || DEFAULT_PERFORMANCE_BREAKER.pfThreshold)),
        autoDisarm: parsed.autoDisarm === true,
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_PERFORMANCE_BREAKER }
}

/** Rolling stats over the last `window` closed trades (all strategies). */
export function rollingStats(db, window) {
  const rows = db.prepare(
    `SELECT id, net_pnl FROM trades
      WHERE status = 'closed' AND net_pnl IS NOT NULL
      ORDER BY closed_at DESC, id DESC LIMIT ?`
  ).all(window)
  const trades = rows.length
  const wins = rows.filter(r => Number(r.net_pnl) > 0)
  const losses = rows.filter(r => Number(r.net_pnl) < 0)
  const grossWin = wins.reduce((s, r) => s + Number(r.net_pnl), 0)
  const grossLoss = Math.abs(losses.reduce((s, r) => s + Number(r.net_pnl), 0))
  const net = rows.reduce((s, r) => s + Number(r.net_pnl), 0)
  return {
    trades,
    winRate: trades ? Math.round((wins.length / trades) * 100) : null,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0),
    expectancy: trades ? Math.round((net / trades) * 100) / 100 : null,
    net: Math.round(net * 100) / 100,
    newestId: rows[0]?.id ?? null,
  }
}

/**
 * One pass — call once per loop cycle (cheap: one indexed query). Fires the
 * alert AT MOST once per newest-trade-id (same "act once per streak"
 * dedupe pattern as adaptive-breaker), so it doesn't repeat every cycle
 * while the window stays bad.
 */
export function runPerformanceBreaker(db, { notify } = {}) {
  const cfg = loadPerformanceBreakerConfig(db)
  if (!cfg.on) return { skipped: 'off' }

  const stats = rollingStats(db, cfg.window)
  if (stats.trades < cfg.minTrades || stats.newestId == null) return { skipped: 'insufficient_sample', stats }
  if (stats.profitFactor == null || stats.profitFactor >= cfg.pfThreshold) return { skipped: 'above_threshold', stats }

  const seenKey = 'performance_breaker_acted_id'
  if (String(getState(db, seenKey)) === String(stats.newestId)) return { skipped: 'already_alerted', stats }
  setState(db, seenKey, String(stats.newestId))

  if (cfg.autoDisarm) setState(db, 'autotrade_enabled', 'false')

  const msg = `🚨 ALL HANDS ON DECK: last ${stats.trades} closed trades — profit factor ${stats.profitFactor.toFixed(2)} (floor ${cfg.pfThreshold}), ${stats.winRate}% win rate, expectancy ${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy}/trade, net ${stats.net >= 0 ? '+' : ''}${stats.net}.${cfg.autoDisarm ? ' Autotrade DISARMED pending review.' : ' Autotrade left running — arm auto-disarm in Tune if you want this to pause it automatically.'}`
  try {
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
      .run('PERF_BREAKER', '/performance', JSON.stringify({ stats, autoDisarm: cfg.autoDisarm }).slice(0, 2000))
  } catch { /* audit best-effort */ }
  try { notify?.(msg) } catch { /* non-fatal */ }

  return { triggered: true, stats, autoDisarmed: cfg.autoDisarm, message: msg }
}
