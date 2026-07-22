// ---------------------------------------------------------------------------
// agent/services/trade-integrity.js — detect duplicate CLOSED trade records.
//
// Owner spotted it in the Trade-lessons panel: several "different" trades
// sharing the exact same symbol/side/entry/exit/net_pnl to the cent, at the
// same timestamp (e.g. 7 AUDUSD SELL rows all -$508.37/-1.01R at the exact
// same minute). trade_postmortems.trade_id is UNIQUE, so those are NOT the
// same trade re-classified — they are genuinely separate rows in `trades`
// with identical values, which is essentially impossible for independent
// real fills. The likely cause is the same class of bug the reconciler's
// "duplicate-adoption guard" and "dedup sweep" already fix for STILL-OPEN
// trades (agent/services/reconciler.js) — but those only ever look at
// status='open' rows, so a duplicate that already got closed independently
// (e.g. via the orphan sweep) is invisible to that cleanup.
//
// This is read-only and deliberately conservative: it REPORTS candidate
// duplicate groups (and how much of net P&L they'd double-count) so a human
// can decide what to do, rather than silently deleting trade history.
// ---------------------------------------------------------------------------

/**
 * Group CLOSED trades sharing symbol+side+entry+exit+net_pnl. Real
 * independent fills essentially never match on all four to the cent, so
 * any group with >1 row is a duplicate-record candidate.
 */
export function findDuplicateTrades(db, { windowDays = 90 } = {}) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT id, symbol, side, entry_price, exit_price, net_pnl, closed_at,
             ctrader_position_id, label_strategy
      FROM trades
      WHERE status = 'closed' AND closed_at >= datetime('now', ?)
        AND entry_price IS NOT NULL AND exit_price IS NOT NULL AND net_pnl IS NOT NULL
    `).all(`-${windowDays} days`)
  } catch { return { groups: [], totalExtraRows: 0, totalExtraPnl: 0 } }

  const byKey = new Map()
  for (const r of rows) {
    const key = [r.symbol, r.side, r.entry_price, r.exit_price, r.net_pnl].join('|')
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }

  const groups = [...byKey.values()]
    .filter(g => g.length > 1)
    .map(g => ({
      symbol: g[0].symbol,
      side: g[0].side,
      entry_price: g[0].entry_price,
      exit_price: g[0].exit_price,
      net_pnl: g[0].net_pnl,
      strategy: g[0].label_strategy || null,
      count: g.length,
      // If every row in the group shares one broker position id, that's
      // near-certain confirmation it's the SAME broker fill recorded
      // multiple times locally, not a coincidence.
      samePositionId: g[0].ctrader_position_id != null && g.every(x => x.ctrader_position_id === g[0].ctrader_position_id),
      tradeIds: g.map(x => x.id),
      closedAts: [...new Set(g.map(x => x.closed_at))],
    }))
    .sort((a, b) => b.count - a.count)

  return {
    groups,
    // "Extra" = the rows beyond the first legitimate one in each group —
    // this is exactly how much net P&L / trade-count these duplicates are
    // artificially adding to Performance/Edge-health stats.
    totalExtraRows: groups.reduce((s, g) => s + (g.count - 1), 0),
    totalExtraPnl: Math.round(groups.reduce((s, g) => s + (g.count - 1) * (Number(g.net_pnl) || 0), 0) * 100) / 100,
  }
}
