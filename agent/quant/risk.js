// ---------------------------------------------------------------------------
// agent/quant/risk.js — Risk exposure tracking
// ---------------------------------------------------------------------------

/**
 * Compute current risk exposure from a list of open positions.
 *
 * @param {import('better-sqlite3').Database} db — reserved for future use (account-level data)
 * @param {Array<{symbol:string, side:string, volume:number, entry_price:number}>} positions
 * @returns {{ totalPositions: number, totalExposureUsd: number, perSymbol: Record<string, number> }}
 */
export function computeExposure(db, positions) {
  const perSymbol = {};
  let totalExposureUsd = 0;

  for (const pos of positions) {
    const notional = Math.abs(pos.volume * pos.entry_price);
    perSymbol[pos.symbol] = (perSymbol[pos.symbol] || 0) + notional;
    totalExposureUsd += notional;
  }

  return {
    totalPositions: positions.length,
    totalExposureUsd,
    perSymbol,
  };
}

/**
 * Check today's trading activity against daily risk limits.
 *
 * Reads all trades from the `trades` table that were opened today and
 * compares usage against the provided risk configuration.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ dailyMaxLossPct: number, maxTradesPerDay: number }} riskConfig
 * @returns {{
 *   dailyPnl: number,
 *   dailyTradesCount: number,
 *   dailyLossUsedPct: number,
 *   limitBreached: boolean,
 *   breachReason: string|null
 * }}
 */
export function checkDailyLimits(db, riskConfig) {
  // All trades opened today (local DB time is UTC via datetime('now'))
  const todayTrades = db
    .prepare(
      `SELECT net_pnl, gross_pnl FROM trades
       WHERE opened_at >= date('now')`,
    )
    .all();

  const dailyTradesCount = todayTrades.length;

  // Sum realised P&L (net_pnl preferred, fall back to gross_pnl, then 0)
  const dailyPnl = todayTrades.reduce((sum, t) => {
    return sum + (t.net_pnl ?? t.gross_pnl ?? 0);
  }, 0);

  // Express loss as a positive percentage (negative pnl → positive loss %)
  // Using absolute value so the comparison with dailyMaxLossPct is intuitive
  const dailyLossUsedPct = dailyPnl < 0 ? Math.abs(dailyPnl) : 0;

  // --- Breach detection ---
  const reasons = [];

  if (
    riskConfig.dailyMaxLossPct !== undefined &&
    dailyLossUsedPct >= riskConfig.dailyMaxLossPct
  ) {
    reasons.push(
      `Daily loss ${dailyLossUsedPct.toFixed(2)}% >= limit ${riskConfig.dailyMaxLossPct}%`,
    );
  }

  if (
    riskConfig.maxTradesPerDay !== undefined &&
    dailyTradesCount >= riskConfig.maxTradesPerDay
  ) {
    reasons.push(
      `Trade count ${dailyTradesCount} >= limit ${riskConfig.maxTradesPerDay}`,
    );
  }

  const limitBreached = reasons.length > 0;

  return {
    dailyPnl,
    dailyTradesCount,
    dailyLossUsedPct,
    limitBreached,
    breachReason: limitBreached ? reasons.join('; ') : null,
  };
}

/**
 * Ensure the risk_exposure table exists.  Called once on first snapshot.
 * @param {import('better-sqlite3').Database} db
 */
function ensureRiskTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_exposure (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      total_positions     INTEGER,
      total_exposure_usd  REAL,
      per_symbol_json     TEXT,
      daily_pnl           REAL,
      daily_trades_count  INTEGER,
      daily_loss_used_pct REAL,
      limit_breached      INTEGER DEFAULT 0,
      breach_reason       TEXT,
      snapshot_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_risk_snapshot_at ON risk_exposure(snapshot_at);
  `);
}

/**
 * Take a combined risk snapshot: compute exposure + check daily limits,
 * then persist into `risk_exposure`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{symbol:string, side:string, volume:number, entry_price:number}>} positions
 * @param {{ dailyMaxLossPct: number, maxTradesPerDay: number }} riskConfig
 * @returns {Object} — the full snapshot record
 */
export function snapshotExposure(db, positions, riskConfig) {
  ensureRiskTable(db);

  const exposure = computeExposure(db, positions);
  const limits = checkDailyLimits(db, riskConfig);

  const insert = db.prepare(
    `INSERT INTO risk_exposure
       (total_positions, total_exposure_usd, per_symbol_json,
        daily_pnl, daily_trades_count, daily_loss_used_pct,
        limit_breached, breach_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const info = insert.run(
    exposure.totalPositions,
    exposure.totalExposureUsd,
    JSON.stringify(exposure.perSymbol),
    limits.dailyPnl,
    limits.dailyTradesCount,
    limits.dailyLossUsedPct,
    limits.limitBreached ? 1 : 0,
    limits.breachReason,
  );

  const row = db
    .prepare('SELECT * FROM risk_exposure WHERE id = ?')
    .get(info.lastInsertRowid);

  return {
    ...row,
    perSymbol: exposure.perSymbol,
    limitBreached: limits.limitBreached,
  };
}
