// ---------------------------------------------------------------------------
// agent/services/management-reflection.js — what each management rule is
// actually WORTH, in R, on the exits it caused.
//
// §70.10: "Connect management history to reflection and controlled adaptation."
//
// THE FIRST VERSION OF THIS FILE WAS A REPORT THAT SAID NOTHING. It computed
// averages over managed and unmanaged trades, attached a sample size to each,
// and then disclaimed the comparison as "an association, not a cause". Owner,
// 04-08-2026: "why samples! make it real". They were right. Every sentence it
// produced was true and none of them told anyone what to do, because a mean
// over two populations nobody assigned is not evidence about a rule — it is
// evidence that winning trades run long enough to get trailed.
//
// WHAT IS ACTUALLY KNOWABLE, and it is a great deal more than that. When a
// management writer moves a stop and price later comes back and takes the
// position out AT THAT STOP, the exit is not correlated with the move — it is
// CAUSED by it. The position would still be open otherwise. That is an
// identification, not an association, and it is visible in the data we already
// keep: `sl_moved` carries from_value and to_value, `close` carries the price,
// and the trade carries entry, exit and side.
//
// So each exit is attributed to the rule that produced it, and priced in R:
//
//     R          = |entry − the stop the trade STARTED with|
//     realised   = (exit − entry) / R      (sign-flipped for a short)
//
// R is the trade's own unit of risk, so +0.4R from a trail on one symbol is
// directly comparable to +0.4R on another. Summed per writer, that is a
// scoreboard: which management rule banks money and which one gives it away.
//
// THE ONE HONEST LIMIT, stated once and not repeated as a hedge on every line:
// we cannot know what price would have done had the stop stayed where it was.
// A tightened stop that took +0.4R might have gone on to reach the target, or
// might have run to the original stop for −1R. What IS certain is what the move
// banked, because it happened. `vsOriginalStop` reports the difference between
// the realised outcome and −1R — the outcome the original bracket would have
// produced had price continued — and it is labelled as the conditional it is.
// ---------------------------------------------------------------------------

/** How close an exit must sit to a stop to count as having been taken at it. */
const STOP_TOUCH_TOLERANCE = 0.0015   // 0.15% of price

/** Stop-moving rules. A tp_moved does not close anything, so it cannot cause an exit. */
const STOP_MOVE = 'sl_moved'

const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null))

/**
 * The management story of ONE closed trade, priced.
 *
 * @returns {null|{
 *   tradeId, symbol, side, entry, exit, originalStop, finalStop,
 *   riskPerR, realisedR, exitCause: 'managed_stop'|'explicit_close'|'other',
 *   causedBy: string|null, stopMoves: number, sources: string[],
 *   vsOriginalStop: number|null,
 * }}
 */
export function tradeManagementOutcome(db, trade) {
  const entry = num(trade?.entry_price)
  const exit = num(trade?.exit_price)
  const long = String(trade?.side || '').toLowerCase().startsWith('b')
    || String(trade?.side || '').toLowerCase() === 'long'

  let events = []
  try {
    events = db.prepare(`
      SELECT kind, source, reason, from_value, to_value, price_at, at
        FROM position_events
       WHERE trade_id = ?
       ORDER BY id
    `).all(trade.id)
  } catch { return null }
  if (!events.length) return null

  const moves = events.filter(e => e.kind === STOP_MOVE)
  const closes = events.filter(e => e.kind === 'close')

  // The stop the trade STARTED with: the from_value of the first move, which is
  // what was in place before management touched it. `sl_price` on the trade is
  // the fallback, and it is second choice because several writers update it as
  // they go — reading it after the fact can return the LAST stop and silently
  // make R zero.
  const originalStop = num(moves[0]?.from_value) ?? num(trade?.sl_price)
  const finalStop = num(moves[moves.length - 1]?.to_value) ?? originalStop

  const riskPerR = entry != null && originalStop != null ? Math.abs(entry - originalStop) : null
  const realisedR = riskPerR > 0 && entry != null && exit != null
    ? ((long ? exit - entry : entry - exit) / riskPerR)
    : null

  // WHY DID IT EXIT? Three answers, and only the first two are attributable.
  //   managed_stop  — price returned to a stop a writer had MOVED. Without the
  //                   move the position would still be open, so the exit is
  //                   that writer's, not the market's.
  //   explicit_close— a writer closed it outright. Attribution is direct.
  //   other         — the original bracket, a target, the owner, the broker.
  let exitCause = 'other'
  let causedBy = null
  if (closes.length) {
    exitCause = 'explicit_close'
    causedBy = closes[closes.length - 1].source || null
  } else if (moves.length && exit != null && finalStop != null && finalStop !== originalStop) {
    const touched = Math.abs(exit - finalStop) <= Math.abs(finalStop) * STOP_TOUCH_TOLERANCE
    if (touched) {
      exitCause = 'managed_stop'
      causedBy = moves[moves.length - 1].source || null
    }
  }

  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    side: long ? 'long' : 'short',
    entry, exit, originalStop, finalStop,
    riskPerR,
    realisedR: realisedR == null ? null : Number(realisedR.toFixed(3)),
    exitCause,
    causedBy,
    stopMoves: moves.length,
    sources: [...new Set(events.map(e => e.source).filter(Boolean))],
    // What the move is worth AGAINST THE ALTERNATIVE THAT WAS RESTING: the
    // original stop, which would have produced −1R had price continued to it.
    // Conditional on that continuation, and named as such by the field's own
    // documentation rather than by a disclaimer on every reader.
    vsOriginalStop: realisedR == null ? null : Number((realisedR + 1).toFixed(3)),
  }
}

/**
 * The scoreboard: what each management writer's exits were worth.
 *
 * No averages over populations nobody assigned. Every row here is built from
 * exits that writer CAUSED — the position would still have been open without
 * its action.
 */
export function managementScoreboard(db, { days = 14, accountId = null, limit = 1000 } = {}) {
  const d = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 14
  const acct = accountId != null ? String(accountId) : null
  let trades = []
  try {
    trades = db.prepare(`
      SELECT id, symbol, side, entry_price, exit_price, sl_price, net_pnl, closed_at
        FROM trades
       WHERE status = 'closed'
         AND closed_at IS NOT NULL
         AND REPLACE(closed_at, 'T', ' ') >= datetime('now', ?)
         ${acct == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'}
       ORDER BY closed_at DESC
       LIMIT ?
    `).all(...(acct == null ? [`-${d} days`, limit] : [`-${d} days`, acct, limit]))
  } catch {
    // A failed read is reported as a failed read. An empty scoreboard would
    // say "no management rule earned anything", which is a claim.
    return { ok: false, error: 'query failed', days: d, writers: [], trades: [] }
  }

  const outcomes = []
  for (const t of trades) {
    const o = tradeManagementOutcome(db, t)
    if (o) outcomes.push({ ...o, netPnl: t.net_pnl == null ? null : Number(t.net_pnl) })
  }

  const byWriter = new Map()
  for (const o of outcomes) {
    if (o.exitCause === 'other' || !o.causedBy || o.realisedR == null) continue
    const w = byWriter.get(o.causedBy) || {
      writer: o.causedBy, exits: 0, positive: 0, negative: 0,
      totalR: 0, bestR: null, worstR: null, netPnl: 0, pnlKnown: 0,
      viaManagedStop: 0, viaExplicitClose: 0,
    }
    w.exits++
    if (o.realisedR > 0) w.positive++; else w.negative++
    w.totalR += o.realisedR
    w.bestR = w.bestR == null ? o.realisedR : Math.max(w.bestR, o.realisedR)
    w.worstR = w.worstR == null ? o.realisedR : Math.min(w.worstR, o.realisedR)
    if (o.netPnl != null) { w.netPnl += o.netPnl; w.pnlKnown++ }
    if (o.exitCause === 'managed_stop') w.viaManagedStop++
    else w.viaExplicitClose++
    byWriter.set(o.causedBy, w)
  }

  const writers = [...byWriter.values()]
    .map(w => ({
      ...w,
      totalR: Number(w.totalR.toFixed(2)),
      avgR: Number((w.totalR / w.exits).toFixed(3)),
      netPnl: Number(w.netPnl.toFixed(2)),
      // Money is reported only over the exits whose P&L is actually known.
      // Rolling unknowns in as zero is the defect that turned off the daily
      // brake; it would understate a writer's damage here.
      pnlCoverage: `${w.pnlKnown}/${w.exits}`,
    }))
    .sort((a, b) => b.totalR - a.totalR)

  const attributed = outcomes.filter(o => o.exitCause !== 'other').length
  return {
    ok: true,
    days: d,
    accountId: acct,
    closedTrades: trades.length,
    withManagementHistory: outcomes.length,
    attributedExits: attributed,
    // Which rules are making money and which are giving it away, in the trade's
    // own unit of risk so symbols are comparable.
    writers,
    // The per-trade rows behind every number above, so a figure that looks
    // wrong can be taken apart instead of argued with.
    trades: outcomes,
  }
}
