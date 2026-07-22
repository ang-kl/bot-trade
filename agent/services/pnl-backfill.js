// ---------------------------------------------------------------------------
// agent/services/pnl-backfill.js — fill broker-true realized P&L onto CLOSED
// trades that the reconciler could only mark closed.
//
// Why this exists (the single most damaging bug the audit found): when the BOT
// closes a position it stamps net_pnl from the close deal (loop.js). But when
// a position is closed by the BROKER's own resting SL/TP — the normal exit for
// a stop-out — the reconciler marks the trade 'closed' with net_pnl LEFT NULL
// (reconciler.js). Until now the ONLY thing that filled those NULLs was the
// on-demand POST /actions/broker-history route, called ONLY from the Desk page.
//
// So every automated brake that keys on realized P&L was blind to broker
// stop-outs unless a human had the dashboard open:
//   · daily-loss veto / equity stop   — SUM(net_pnl) skips NULLs → under-count
//   · consecutive-loss cooldown        — (net_pnl||0)<0 → a stop-out reads as 0
//   · performance breaker / auto-disarm — WHERE net_pnl IS NOT NULL → excluded
//   · Kelly negative-expectancy veto    — censored sample
// The exact trades most likely to close at the broker (losers hitting the
// resting SL) were exactly the ones the safety system could not see. For an
// autonomous agent, its own risk gates must not depend on a browser being open.
//
// This module does the same deal-history backfill the route does, but as a
// plain server-side function the loop calls right after reconcile — so the
// brakes see reality every cycle. It fills ONLY rows still NULL (never
// overwrites a bot-computed net_pnl, which is already broker-true).
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 3_600_000

/**
 * Should this loop cycle run the P&L backfill? Any reconcile path that can
 * close a trade with net_pnl left NULL must be able to trigger it — not just
 * closedDetected (the broker-detected-close loop). The orphan sweep and
 * dedup sweep (reconciler.js) also close trades with net_pnl left NULL but
 * used to never populate closedDetected, so a trade closed ONLY via those
 * two paths could never trigger this backfill and sat permanently excluded
 * from Edge Health (alpha-decay.js's `net_pnl IS NOT NULL` read) — a silent
 * gap, not a transient one. Pure/testable; backfillClosedPnl itself still
 * self-gates on its own COUNT(*) check, so this only widens WHEN it's
 * called, never what it does once called.
 * @param {{closedDetected?:Array, orphansClosed?:Array, dupsClosed?:Array}} result
 */
export function shouldRunPnlBackfill(result) {
  return (result?.closedDetected || []).length > 0
    || (result?.orphansClosed || []).length > 0
    || (result?.dupsClosed || []).length > 0
}

/**
 * Backfill net_pnl / gross_pnl for closed trades that have none, from the
 * broker's deal history. Realised money fields live on each closing deal's
 * closePositionDetail, scaled by moneyDigits — identical maths to
 * POST /actions/broker-history so the loop and the dashboard agree.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{host,clientId,clientSecret,accessToken,accountId}} creds
 * @param {{ days?: number, now?: number, getDeals?: Function }} [opts]
 *   getDeals is injectable for tests; defaults to the real ws client.
 * @returns {Promise<{ backfilled: number, closingDeals: number, scanned: number }>}
 */
export async function backfillClosedPnl(db, creds, opts = {}) {
  // Nothing to do unless some closed trade is actually missing its P&L. This
  // cheap check gates the broker round-trip so we don't hit the deal API when
  // every closed trade is already accounted for.
  const gap = db.prepare(
    `SELECT COUNT(*) AS n FROM trades WHERE status = 'closed' AND net_pnl IS NULL`
  ).get()
  if (!gap || gap.n === 0) return { backfilled: 0, closingDeals: 0, scanned: 0 }

  const days = Math.min(190, Math.max(1, Number(opts.days) || 14))
  const now = opts.now ?? Date.now()
  const from = now - days * 24 * 3_600_000

  let getDeals = opts.getDeals
  if (!getDeals) {
    const { wsGetDeals } = await import('../lib/ctrader-ws.js')
    const { host, clientId, clientSecret, accessToken, accountId } = creds
    getDeals = (t0, t1) => wsGetDeals(host, clientId, clientSecret, accessToken, accountId, t0, t1)
  }

  const deals = []
  for (let t0 = from; t0 < now; t0 += WEEK_MS) {
    const chunk = await getDeals(t0, Math.min(t0 + WEEK_MS, now))
    deals.push(...((chunk && chunk.deal) || []))
  }

  // Only deals that CLOSE (part of) a position carry realised P&L. Aggregate
  // per position so a scaled-out close (several partial deals) sums to one
  // net figure, exactly as the route does.
  const byPosition = new Map()
  let closingDeals = 0
  for (const d of deals) {
    const cpd = d.closePositionDetail
    if (!cpd) continue
    const positionId = d.positionId != null ? String(d.positionId) : null
    if (!positionId) continue
    closingDeals++
    const scale = Math.pow(10, cpd.moneyDigits ?? 2)
    const m = (v) => (v == null ? 0 : v / scale)
    const gross = m(cpd.grossProfit)
    const net = gross + m(cpd.swap) + m(cpd.commission)
    const agg = byPosition.get(positionId) || { net: 0, gross: 0 }
    agg.net += net
    agg.gross += gross
    byPosition.set(positionId, agg)
  }

  // Fill ONLY the gaps: a closed trade whose net_pnl is still NULL. Never
  // touch a row the bot already stamped — that value is already broker-true,
  // and overwriting it with an aggregate could double-count partial closes.
  const upd = db.prepare(
    `UPDATE trades
        SET net_pnl = ?, gross_pnl = COALESCE(gross_pnl, ?)
      WHERE ctrader_position_id = ? AND status = 'closed' AND net_pnl IS NULL`
  )
  let backfilled = 0
  const tx = db.transaction((entries) => {
    for (const [positionId, agg] of entries) {
      const r = upd.run(
        Math.round(agg.net * 100) / 100,
        Math.round(agg.gross * 100) / 100,
        positionId,
      )
      backfilled += r.changes
    }
  })
  tx([...byPosition])

  return { backfilled, closingDeals, scanned: deals.length }
}
