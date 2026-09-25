// ---------------------------------------------------------------------------
// agent/services/performance-snapshots.js — the loop's performance snapshot,
// ONE ROW PER ACCOUNT plus the pooled row (plan P1, 25-09-2026).
//
// Measured before this file: the loop wrote one row per pass over EVERY
// account's closed trades with no account_id, and /state/metrics served that
// pooled row as each account's own (account-scope's OR-NULL convention).
// GET /state/metrics for one account returned a 1,315-trade, PF 0.72 row that
// was every account's.
//
// Now: one row per non-null account_id with account_id stamped, and the
// pooled row as before with account_id NULL — which is what a NULL row here
// really is. The routes read them strictly (state.js /metrics).
//
// DEFINITION: these rows stay on MONEY, as they always were — win is
// net_pnl > 0, loss net_pnl <= 0, PF = gross money won / lost. They are NOT
// the r-net-v1 definition of /state/basis-performance and carry no such
// stamp. The formula is moved here unchanged.
//
// GROWTH: the table has no prune (the only DELETE is POST /actions/reset-data,
// routes/actions.js), so a per-account row multiplies its write volume by the
// number of accounts with closed trades (about 8× today). A prune is a
// separate owner decision, not added here.
// ---------------------------------------------------------------------------

const AGG = `SELECT COUNT(*) as total,
                    SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) as wins,
                    SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END) as losses,
                    SUM(net_pnl) as total_pnl,
                    AVG(CASE WHEN net_pnl > 0 THEN net_pnl END) as avg_win,
                    AVG(CASE WHEN net_pnl <= 0 THEN net_pnl END) as avg_loss`

function insertRow(db, stats, accountId) {
  if (!stats || !(stats.total > 0)) return false
  const winRate = stats.wins / stats.total
  // TRUE profit factor = gross win / gross loss. The old formula was
  // |avg_win / avg_loss| — the PAYOFF ratio, which ignores how OFTEN
  // you win, so at a 19% win rate it overstated PF ~4x (a real 0.15
  // showed as ~0.64). Reconstruct the gross sums from the averages ×
  // counts. Same null-on-no-losses convention as performance-breaker.
  const grossWin = (stats.avg_win || 0) * stats.wins
  const grossLoss = Math.abs((stats.avg_loss || 0) * stats.losses)
  const profitFactor = grossLoss > 0
    ? Math.round((grossWin / grossLoss) * 100) / 100
    : (grossWin > 0 ? null : 0)
  db.prepare(
    `INSERT INTO performance_snapshots (total_trades, winning_trades, losing_trades, win_rate, profit_factor, total_pnl, avg_win, avg_loss, account_id, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(stats.total, stats.wins, stats.losses, winRate, profitFactor, stats.total_pnl, stats.avg_win, stats.avg_loss, accountId)
  return true
}

/**
 * Write this pass's snapshot rows: one per account with closed trades, then
 * the pooled (account_id NULL) row.
 *
 * @returns {{accounts: number, pooled: boolean}}
 */
export function writePerformanceSnapshots(db) {
  const perAccount = db.prepare(`${AGG}, account_id FROM trades WHERE status = 'closed' AND account_id IS NOT NULL GROUP BY account_id ORDER BY account_id`).all()
  let accounts = 0
  for (const s of perAccount) if (insertRow(db, s, String(s.account_id))) accounts++
  const pooled = insertRow(db, db.prepare(`${AGG} FROM trades WHERE status = 'closed'`).get(), null)
  return { accounts, pooled }
}
