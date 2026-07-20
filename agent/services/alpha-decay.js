// ---------------------------------------------------------------------------
// agent/services/alpha-decay.js — is the edge eroding?
//
// Alpha decay has two faces and this module measures both from CLOSED trades:
//
// 1. STRATEGY decay (weeks): rolling expectancy per strategy — the last N
//    trades vs the N before them, in trade-time (not wall-time) so a slow
//    week doesn't fake a trend. A strategy whose expectancy is falling
//    window-over-window is decaying and should be cut on evidence before
//    the adaptive breaker's blunt 3-loss rule has to fire.
//
// 2. SIGNAL decay (minutes): expectancy bucketed by entry lag — the time
//    between the analysis that generated the signal and the broker fill.
//    If slow fills underperform fast fills, we are consuming the decayed
//    tail of our own signals and cadence/timeframes need tightening.
//
// Pure functions over trade rows; the view assembles them from SQLite.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { STRATEGY_REGISTRY, enabledStrategies } from './strategies.js'
import { STRATEGY_KIND } from './regime-gate.js'

const MIN_WINDOW_N = 10 // below this a verdict would be noise, say so instead

/** Basic stats over closed trades: expectancy = mean net PnL per trade. */
export function expectancy(trades) {
  const n = trades.length
  if (n === 0) return { n: 0, expectancy: null, winRate: null, totalPnl: 0 }
  let wins = 0
  let total = 0
  for (const t of trades) {
    const p = Number(t.net_pnl) || 0
    total += p
    if (p > 0) wins++
  }
  return {
    n,
    expectancy: Math.round((total / n) * 100) / 100,
    winRate: Math.round((wins / n) * 1000) / 1000,
    totalPnl: Math.round(total * 100) / 100,
  }
}

/**
 * Rolling decay read for ONE strategy's trades (oldest→newest order not
 * required — sorted internally by closed_at). Compares the newest `window`
 * trades against the `window` before them.
 */
export function rollingDecay(trades, window = 30) {
  const sorted = [...trades].sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)))
  const recent = expectancy(sorted.slice(-window))
  const prior = expectancy(sorted.slice(-2 * window, -window))
  let trend = 'insufficient'
  let delta = null
  if (recent.n >= MIN_WINDOW_N && prior.n >= MIN_WINDOW_N) {
    delta = Math.round((recent.expectancy - prior.expectancy) * 100) / 100
    // Meaningful move = 20% of the prior window's average absolute PnL,
    // floored at 0.01 — scale-aware so a $500-expectancy strategy isn't
    // called "decaying" over a $2 wobble.
    const scale = Math.max(0.01, Math.abs(prior.expectancy) * 0.2)
    trend = delta < -scale ? 'decaying' : delta > scale ? 'improving' : 'stable'
  }
  return { recent, prior, delta, trend, total: expectancy(sorted) }
}

/** Signal-decay read: expectancy by entry lag (signal time → fill time). */
export function entryLagBuckets(rows) {
  const defs = [
    { key: 'fast', label: '< 1 min', min: 0, max: 60 },
    { key: 'medium', label: '1–5 min', min: 60, max: 300 },
    { key: 'slow', label: '> 5 min', min: 300, max: Infinity },
  ]
  return defs.map(d => {
    const inBucket = rows.filter(r => {
      const lag = Number(r.lag_sec)
      return Number.isFinite(lag) && lag >= d.min && lag < d.max
    })
    return { key: d.key, label: d.label, ...expectancy(inBucket) }
  })
}

/** Current run of same-sign results from the newest closed trades. */
export function streakOf(trades) {
  const sorted = [...trades].sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)))
  if (sorted.length === 0) return { kind: null, n: 0 }
  const sign = (Number(sorted[sorted.length - 1].net_pnl) || 0) > 0
  let n = 0
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (((Number(sorted[i].net_pnl) || 0) > 0) !== sign) break
    n++
  }
  return { kind: sign ? 'win' : 'loss', n }
}

/** Full dashboard payload from the DB. */
export function alphaDecayView(db, { window = 30 } = {}) {
  const trades = db.prepare(
    `SELECT t.net_pnl, t.closed_at, t.opened_at, t.source,
            COALESCE(t.label_strategy, t.strategy) AS strat,
            a.analyzed_at AS signal_at
     FROM trades t
     LEFT JOIN analyses a ON a.id = t.analysis_id
     WHERE t.status = 'closed' AND t.net_pnl IS NOT NULL`
  ).all()

  // No "unknown": trades without a strategy label are the owner's manual
  // trades, test fills, and adopted fills — bucketed as 'unlabelled' WITH
  // the source breakdown so the UI can explain instead of shrugging.
  const byStrat = {}
  const unlabelledSources = {}
  for (const t of trades) {
    const key = t.strat || 'unlabelled'
    if (!t.strat) {
      const src = t.source || 'manual'
      unlabelledSources[src] = (unlabelledSources[src] || 0) + 1
    }
    ;(byStrat[key] ??= []).push(t)
  }
  // EVERY registered strategy appears (owner: "Edge Health is meaningless if
  // you don't include all strategy and justify") — even ones that have never
  // traded, so the roster is complete and each row justifies itself with
  // armed state, net P&L and win rate, not just a per-trade expectancy.
  const armed = new Set(enabledStrategies(db, getState).map(s => s.key))
  const nameOf = Object.fromEntries(STRATEGY_REGISTRY.map(s => [s.key, s.name]))
  const registeredKeys = STRATEGY_REGISTRY.map(s => s.key)
  const allKeys = [...new Set([...registeredKeys, ...Object.keys(byStrat)])]
  const strategies = allKeys
    .map((strategy) => {
      const rows = byStrat[strategy] || []
      const decayed = rollingDecay(rows, window)
      return {
        strategy,
        name: strategy === 'unlabelled' ? 'Manual / external' : (nameOf[strategy] || strategy),
        kind: STRATEGY_KIND[strategy] || (strategy === 'unlabelled' ? 'manual' : 'other'),
        armed: armed.has(strategy),
        registered: registeredKeys.includes(strategy),
        netPnl: decayed.total.totalPnl,   // total realized $ — the number the owner is bleeding
        winRate: decayed.total.winRate,    // 0..1
        streak: streakOf(rows),
        ...decayed,
      }
    })
    // Most-traded first, but never bury an armed 0-trade strategy below noise.
    .sort((a, b) => (b.total.n - a.total.n) || (Number(b.armed) - Number(a.armed)) || a.strategy.localeCompare(b.strategy))

  // Entry lag needs both timestamps; SQLite datetimes are UTC sans zone.
  const ms = (v) => {
    if (!v) return NaN
    const s = String(v)
    return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  }
  const lagRows = trades
    .map(t => ({ net_pnl: t.net_pnl, lag_sec: (ms(t.opened_at) - ms(t.signal_at)) / 1000 }))
    .filter(r => Number.isFinite(r.lag_sec) && r.lag_sec >= 0 && r.lag_sec < 86_400)

  const entry_lag = entryLagBuckets(lagRows)

  // Adaptive breaker status — the COMMITTED automation this section must
  // reflect: streaks answered with evidential change, not hope.
  let breaker = { on: true, streak: 3 }
  try {
    const p = JSON.parse(getState(db, 'adaptive_breaker_json') || 'null')
    if (p && typeof p === 'object') breaker = { on: p.on !== false, streak: Number(p.streak) || 3 }
  } catch { /* defaults */ }

  // The owner's backtest baseline ("my edge as tested") — persisted by the
  // Tune backtest job. Null = never run since this feature shipped.
  let backtest = null
  try {
    const b = JSON.parse(getState(db, 'backtest_baseline_json') || 'null')
    if (b && Array.isArray(b.combos)) backtest = b
  } catch { /* none */ }

  // ADVISORY vs COMMITTED: what the owner should consider, and what the
  // machine will do on its own — every line evidential and linkable.
  const advisories = []
  for (const s of strategies) {
    if (s.strategy === 'unlabelled') continue
    if (s.trend === 'decaying') {
      advisories.push({ level: 'advisory', strategy: s.strategy, text: `${s.strategy}: expectancy fell $${s.prior.expectancy} → $${s.recent.expectancy} over the last ${s.recent.n} trades — consider disarming its Auto Trade cell or tightening its filters.`, link: '/tune' })
    }
    if (s.streak.kind === 'loss' && s.streak.n >= 2) {
      advisories.push(breaker.on
        ? { level: 'committed', strategy: s.strategy, text: `${s.strategy}: ${s.streak.n} losses in a row — the adaptive breaker WILL rotate its strategy/filters at ${breaker.streak} straight losses. No action needed unless you want to intervene earlier.`, link: '/tune' }
        : { level: 'advisory', strategy: s.strategy, text: `${s.strategy}: ${s.streak.n} losses in a row and the adaptive breaker is OFF — nothing will respond automatically. Arm it, or disarm the strategy.`, link: '/tune' })
    }
    if (s.streak.kind === 'win' && s.streak.n >= 3) {
      advisories.push({ level: 'advisory', strategy: s.strategy, text: `${s.strategy}: ${s.streak.n}-trade winning streak with ${s.trend === 'improving' ? 'improving' : 'held'} expectancy — evidence supports keeping it armed; revisit sizing only after ${window}+ trades.`, link: '/tune' })
    }
  }
  const fast = entry_lag.find(b => b.key === 'fast')
  const slow = entry_lag.find(b => b.key === 'slow')
  if (fast?.n >= MIN_WINDOW_N && slow?.n >= MIN_WINDOW_N && slow.expectancy < fast.expectancy) {
    advisories.push({ level: 'advisory', text: `Slow fills (> 5 min after signal) earn $${slow.expectancy} vs $${fast.expectancy} for fast fills — we are trading the decayed tail of our own signals. Tighten the position-monitor cadence / loop interval.`, link: '/tune' })
  }
  if (!backtest) {
    advisories.push({ level: 'advisory', text: 'No backtest baseline stored yet — run a backtest in Tune to record YOUR edge; Edge health will then compare live results against it.', link: '/tune' })
  } else {
    const positiveCombos = backtest.combos.filter(c => (c.profitFactor ?? 0) > 1).length
    const liveNegative = strategies.filter(s => s.strategy !== 'unlabelled' && s.total.n >= MIN_WINDOW_N && s.total.expectancy < 0).length
    if (positiveCombos > 0 && liveNegative > 0) {
      advisories.push({ level: 'advisory', text: `Reality gap: ${liveNegative} strategy(ies) run negative live while ${positiveCombos} backtest combo(s) were positive — spread, slippage, or timing differ from the test. Compare fills before sizing up.`, link: '/trade' })
    }
  }
  if (strategies.every(s => s.trend === 'insufficient')) {
    advisories.push({ level: 'advisory', text: `Verdicts need ${MIN_WINDOW_N}+ trades per window — burn-in builds the sample fastest (pace toward the target in Tune).`, link: '/tune' })
  }

  return {
    window,
    total_closed: trades.length,
    strategies,
    unlabelled: byStrat.unlabelled
      ? { n: byStrat.unlabelled.length, sources: unlabelledSources }
      : null,
    entry_lag,
    lag_sampled: lagRows.length,
    breaker,
    backtest,
    advisories,
  }
}
