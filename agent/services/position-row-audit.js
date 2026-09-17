// ---------------------------------------------------------------------------
// agent/services/position-row-audit.js — PR-X: is one symbol on four accounts,
// or four rows on one account?
//
// WHY THIS EXISTS. The owner's 15-09 log showed, in a 23-minute window over 20
// cycles:
//
//     PM ABBV.US: FULL_EXIT FAILED — MARKET_CLOSED     x76   (~3.8 per cycle)
//     PM UNH.US:  FULL_EXIT FAILED — MARKET_CLOSED     x19   (~1.0 per cycle)
//     PM COST.US: FULL_EXIT FAILED — MARKET_CLOSED     x19   (~1.0 per cycle)
//
// I read that as four duplicate rows for one position and said so. THAT WAS AN
// INFERENCE FROM COUNTS ALONE AND IT MAY BE WRONG: the protection lines show
// momentum-book holdings on four accounts, so ABBV appearing four times is
// equally consistent with ABBV being held once on each of them, while UNH and
// COST are held on one account each. Both readings fit the evidence exactly.
//
// The reason neither I nor the owner can tell them apart is that the PM log
// line prints only the symbol — `monitored_positions` HAS an `account_id`, and
// the line drops it. That is the defect I am certain of, and it is the same
// shape as everything else this system keeps paying for: the mechanism knows,
// and the panel does not say.
//
// WHAT THIS MODULE DOES. It answers the question with a measurement instead of
// a guess: active rows grouped by (account, symbol), reporting only the groups
// with MORE THAN ONE row. Four accounts holding ABBV produce four groups of
// one and this reports nothing. Four rows on one account produce one group of
// four and this names it, with the row ids and trade ids.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not merge, close or dedupe
// anything. `monitored_positions` carries no broker position id (checked: the
// table has `trade_id` and `account_id` and no `ctrader_position_id`), so two
// rows on one account for one symbol MIGHT be two genuine positions the broker
// really holds — cTrader allows that — and silently collapsing them would drop
// a live position from management. Establish first, then decide.
// ---------------------------------------------------------------------------

/**
 * Active monitored rows that share an (account, symbol) pair.
 *
 * Empty means every active row is the only one for its symbol on its account —
 * which is the answer "one position per account", not "nothing to see".
 */
export function duplicateActivePositions(db, { limit = 50 } = {}) {
  try {
    const groups = db.prepare(`
      SELECT COALESCE(account_id, '(unscoped)') AS account,
             UPPER(symbol) AS symbol,
             COUNT(*)      AS rows,
             GROUP_CONCAT(id)       AS ids,
             GROUP_CONCAT(COALESCE(trade_id, '-')) AS tradeIds,
             GROUP_CONCAT(COALESCE(source, '-'))   AS sources
        FROM monitored_positions
       WHERE status = 'active' AND COALESCE(paused, 0) = 0
       GROUP BY COALESCE(account_id, '(unscoped)'), UPPER(symbol)
      HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC, symbol
       LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 50)))
    return groups.map(g => ({
      accountId: g.account,
      symbol: g.symbol,
      rows: Number(g.rows) || 0,
      ids: String(g.ids || '').split(',').filter(Boolean),
      // DISTINCT trade ids are the tell. Two rows pointing at the SAME trade
      // are a duplicate of one position. Two rows on two different trades are
      // two positions the broker may really hold, and merging them would lose
      // one — which is why this reports the difference instead of acting on it.
      tradeIds: String(g.tradeIds || '').split(',').filter(Boolean),
      distinctTradeIds: [...new Set(String(g.tradeIds || '').split(',').filter(t => t && t !== '-'))].length,
      sources: [...new Set(String(g.sources || '').split(',').filter(Boolean))],
    }))
  } catch { return [] }
}

/** How many active rows each account holds, so "four lines" can be read at a glance. */
export function activeRowsByAccount(db) {
  try {
    return db.prepare(`
      SELECT COALESCE(account_id, '(unscoped)') AS account, COUNT(*) AS rows
        FROM monitored_positions
       WHERE status = 'active' AND COALESCE(paused, 0) = 0
       GROUP BY COALESCE(account_id, '(unscoped)')
       ORDER BY COUNT(*) DESC
    `).all().map(r => ({ accountId: r.account, rows: Number(r.rows) || 0 }))
  } catch { return [] }
}

/**
 * One stdout line, and only when there is something to say.
 *
 * `null` when no (account, symbol) pair has more than one active row — the
 * answer "one position per account", which needs no line every cycle.
 */
export function duplicatePositionLine(db) {
  const dups = duplicateActivePositions(db)
  if (!dups.length) return null
  const parts = dups.map(d => {
    // The distinction that decides whether this is a defect at all.
    const verdict = d.distinctTradeIds <= 1
      ? 'SAME trade — duplicate rows for one position'
      : `${d.distinctTradeIds} distinct trades — may be genuinely separate positions, do not merge`
    return `…${String(d.accountId).slice(-4)} ${d.symbol}: ${d.rows} active row(s) [ids ${d.ids.join('/')}; trades ${d.tradeIds.join('/')}] — ${verdict}`
  })
  return `[positions] ${dups.length} (account, symbol) pair(s) with more than one active row — every one is evaluated and exited SEPARATELY by the position manager, which is why one symbol can log the same FULL_EXIT several times a cycle. ${parts.join('; ')}`
}
