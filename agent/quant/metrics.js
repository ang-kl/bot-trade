// ---------------------------------------------------------------------------
// agent/quant/metrics.js — Portfolio performance calculations
// ---------------------------------------------------------------------------

/**
 * Compute comprehensive performance metrics from all closed trades.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{
 *   total_trades: number,
 *   winning_trades: number,
 *   losing_trades: number,
 *   win_rate: number,
 *   profit_factor: number,
 *   sharpe_ratio: number,
 *   max_drawdown_pct: number,
 *   total_pnl: number,
 *   avg_win: number,
 *   avg_loss: number,
 *   avg_rr: number,
 *   best_trade_pnl: number,
 *   worst_trade_pnl: number,
 *   avg_hold_duration_ms: number
 * }}
 */
export function computePerformance(db) {
  const trades = db
    .prepare(
      `SELECT net_pnl, gross_pnl, closed_at, opened_at, hold_duration_ms
       FROM trades
       WHERE status = 'closed'
       ORDER BY closed_at ASC`,
    )
    .all();

  const empty = {
    total_trades: 0,
    winning_trades: 0,
    losing_trades: 0,
    win_rate: 0,
    profit_factor: 0,
    sharpe_ratio: 0,
    max_drawdown_pct: 0,
    total_pnl: 0,
    avg_win: 0,
    avg_loss: 0,
    avg_rr: 0,
    best_trade_pnl: 0,
    worst_trade_pnl: 0,
    avg_hold_duration_ms: 0,
  };

  if (trades.length === 0) return empty;

  // --- Basic win/loss stats ---
  let sumWins = 0;
  let sumLosses = 0;
  let winCount = 0;
  let lossCount = 0;
  let totalPnl = 0;
  let bestPnl = -Infinity;
  let worstPnl = Infinity;
  let totalHoldMs = 0;
  let holdCount = 0;

  for (const t of trades) {
    const pnl = t.net_pnl ?? t.gross_pnl ?? 0;
    totalPnl += pnl;

    if (pnl > 0) {
      sumWins += pnl;
      winCount++;
    } else if (pnl < 0) {
      sumLosses += pnl; // negative
      lossCount++;
    }

    if (pnl > bestPnl) bestPnl = pnl;
    if (pnl < worstPnl) worstPnl = pnl;

    if (t.hold_duration_ms != null) {
      totalHoldMs += t.hold_duration_ms;
      holdCount++;
    }
  }

  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? winCount / totalTrades : 0;
  const profitFactor =
    sumLosses !== 0 ? sumWins / Math.abs(sumLosses) : sumWins > 0 ? Infinity : 0;
  const avgWin = winCount > 0 ? sumWins / winCount : 0;
  const avgLoss = lossCount > 0 ? sumLosses / lossCount : 0; // negative
  const avgRR = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0;
  const avgHoldMs = holdCount > 0 ? totalHoldMs / holdCount : 0;

  // --- Max drawdown (peak-to-trough in cumulative P&L) ---
  let cumPnl = 0;
  let peak = 0;
  let maxDd = 0;

  for (const t of trades) {
    const pnl = t.net_pnl ?? t.gross_pnl ?? 0;
    cumPnl += pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDd) maxDd = dd;
  }

  // Express drawdown as a percentage of peak (0 if peak is 0)
  const maxDrawdownPct = peak > 0 ? (maxDd / peak) * 100 : 0;

  // --- Sharpe ratio (annualised, based on daily returns) ---
  // Group trade P&L by close date to get daily returns
  const dailyMap = new Map();
  for (const t of trades) {
    const dateKey = t.closed_at ? t.closed_at.slice(0, 10) : 'unknown';
    const pnl = t.net_pnl ?? t.gross_pnl ?? 0;
    dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + pnl);
  }

  const dailyReturns = [...dailyMap.values()];
  let sharpe = 0;

  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
      (dailyReturns.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std !== 0 ? (mean / std) * Math.sqrt(252) : 0;
  }

  return {
    total_trades: totalTrades,
    winning_trades: winCount,
    losing_trades: lossCount,
    win_rate: winRate,
    profit_factor: profitFactor === Infinity ? 9999 : profitFactor,
    sharpe_ratio: sharpe,
    max_drawdown_pct: maxDrawdownPct,
    total_pnl: totalPnl,
    avg_win: avgWin,
    avg_loss: avgLoss,
    avg_rr: avgRR,
    best_trade_pnl: bestPnl === -Infinity ? 0 : bestPnl,
    worst_trade_pnl: worstPnl === Infinity ? 0 : worstPnl,
    avg_hold_duration_ms: avgHoldMs,
  };
}

/**
 * Compute performance metrics and persist a snapshot into
 * the `performance_snapshots` table.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Object} — the full snapshot record including computed_at
 */
export function snapshotPerformance(db) {
  const m = computePerformance(db);

  const insert = db.prepare(
    `INSERT INTO performance_snapshots
       (total_trades, winning_trades, losing_trades, win_rate,
        profit_factor, sharpe_ratio, max_drawdown_pct, total_pnl,
        avg_win, avg_loss, avg_rr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const info = insert.run(
    m.total_trades,
    m.winning_trades,
    m.losing_trades,
    m.win_rate,
    m.profit_factor,
    m.sharpe_ratio,
    m.max_drawdown_pct,
    m.total_pnl,
    m.avg_win,
    m.avg_loss,
    m.avg_rr,
  );

  const row = db
    .prepare('SELECT * FROM performance_snapshots WHERE id = ?')
    .get(info.lastInsertRowid);

  return {
    ...row,
    best_trade_pnl: m.best_trade_pnl,
    worst_trade_pnl: m.worst_trade_pnl,
    avg_hold_duration_ms: m.avg_hold_duration_ms,
  };
}
