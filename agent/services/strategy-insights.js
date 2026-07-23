// ---------------------------------------------------------------------------
// agent/services/strategy-insights.js — per-strategy forecast-vs-actual from
// CLOSED trades (owner: "deep insights in Account page how the strategy
// forecast to actual win/lost"). All figures are live SQL over the trades
// table — the same rows Performance counts — so this can never disagree
// with the P&L the owner already sees. 'rejected' rows (duplicate-adoption
// repairs) are excluded everywhere by the status filter.
//
// Forecast side: planned R:R from each trade's own entry/SL/TP price
// distances (pure ratios — no currency conversion to get wrong), and the
// break-even win rate that planned R:R implies (1 / (1 + RR)). Actual
// side: realized win rate, P&L, profit factor. A strategy whose actual win
// rate sits below its own break-even line is losing by design, not luck.
// ---------------------------------------------------------------------------

export function strategyInsights(db, { sinceDays = null } = {}) {
  const sinceClause = sinceDays ? `AND closed_at >= datetime('now', '-${Math.max(1, Math.floor(sinceDays))} days')` : ''
  let rows = []
  try {
    rows = db.prepare(`
      SELECT COALESCE(NULLIF(label_strategy, ''), NULLIF(strategy, ''), 'manual / external') AS strat,
             COUNT(*)                                                    AS trades,
             SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END)                AS wins,
             SUM(CASE WHEN net_pnl < 0 THEN 1 ELSE 0 END)                AS losses,
             SUM(CASE WHEN net_pnl = 0 THEN 1 ELSE 0 END)                AS flat,
             ROUND(SUM(net_pnl), 2)                                      AS netPnl,
             ROUND(AVG(CASE WHEN net_pnl > 0 THEN net_pnl END), 2)       AS avgWin,
             ROUND(AVG(CASE WHEN net_pnl < 0 THEN net_pnl END), 2)       AS avgLoss,
             ROUND(SUM(CASE WHEN net_pnl > 0 THEN net_pnl ELSE 0 END), 2) AS grossWins,
             ROUND(SUM(CASE WHEN net_pnl < 0 THEN -net_pnl ELSE 0 END), 2) AS grossLosses,
             -- Planned R:R per trade from its own price levels; averaged per
             -- strategy over the trades that HAD both SL and TP set.
             ROUND(AVG(CASE
               WHEN sl_price IS NOT NULL AND tp_price IS NOT NULL
                    AND ABS(entry_price - sl_price) > 0
               THEN ABS(tp_price - entry_price) / ABS(entry_price - sl_price)
             END), 2)                                                    AS plannedRR,
             SUM(CASE WHEN sl_price IS NOT NULL AND tp_price IS NOT NULL THEN 1 ELSE 0 END) AS withLevels
      FROM trades
      WHERE status = 'closed' AND net_pnl IS NOT NULL ${sinceClause}
      GROUP BY strat
      ORDER BY SUM(net_pnl) ASC
    `).all()
  } catch { rows = [] }

  return rows.map(r => {
    const decided = (r.wins || 0) + (r.losses || 0)
    const winRatePct = decided > 0 ? Math.round((r.wins / decided) * 1000) / 10 : null
    // Break-even win rate implied by the strategy's OWN average planned R:R:
    // risking 1 to make RR, you need wins/(wins+losses) >= 1/(1+RR).
    const breakevenWinRatePct = r.plannedRR > 0 ? Math.round((100 / (1 + r.plannedRR)) * 10) / 10 : null
    const profitFactor = r.grossLosses > 0 ? Math.round((r.grossWins / r.grossLosses) * 100) / 100 : (r.grossWins > 0 ? Infinity : null)
    // The verdict the owner actually wants at a glance: is the actual win
    // rate above or below what this strategy's own targets require?
    const edge = winRatePct != null && breakevenWinRatePct != null
      ? Math.round((winRatePct - breakevenWinRatePct) * 10) / 10
      : null
    return {
      strategy: r.strat,
      trades: r.trades,
      wins: r.wins || 0,
      losses: r.losses || 0,
      flat: r.flat || 0,
      winRatePct,
      netPnl: r.netPnl,
      avgWin: r.avgWin,
      avgLoss: r.avgLoss,
      profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
      plannedRR: r.plannedRR,          // forecast: avg TP-distance / SL-distance
      withLevels: r.withLevels,        // how many trades that forecast is based on
      breakevenWinRatePct,             // win rate the forecast REQUIRES
      edgePct: edge,                   // actual − required (negative = losing by design)
    }
  })
}
