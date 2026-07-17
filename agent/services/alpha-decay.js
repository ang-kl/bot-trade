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

/** Full dashboard payload from the DB. */
export function alphaDecayView(db, { window = 30 } = {}) {
  const trades = db.prepare(
    `SELECT t.net_pnl, t.closed_at, t.opened_at,
            COALESCE(t.label_strategy, t.strategy, 'unknown') AS strat,
            a.analyzed_at AS signal_at
     FROM trades t
     LEFT JOIN analyses a ON a.id = t.analysis_id
     WHERE t.status = 'closed' AND t.net_pnl IS NOT NULL`
  ).all()

  const byStrat = {}
  for (const t of trades) (byStrat[t.strat] ??= []).push(t)
  const strategies = Object.entries(byStrat)
    .map(([strategy, rows]) => ({ strategy, ...rollingDecay(rows, window) }))
    .sort((a, b) => b.total.n - a.total.n)

  // Entry lag needs both timestamps; SQLite datetimes are UTC sans zone.
  const ms = (v) => {
    if (!v) return NaN
    const s = String(v)
    return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  }
  const lagRows = trades
    .map(t => ({ net_pnl: t.net_pnl, lag_sec: (ms(t.opened_at) - ms(t.signal_at)) / 1000 }))
    .filter(r => Number.isFinite(r.lag_sec) && r.lag_sec >= 0 && r.lag_sec < 86_400)

  return {
    window,
    total_closed: trades.length,
    strategies,
    entry_lag: entryLagBuckets(lagRows),
    lag_sampled: lagRows.length,
  }
}
