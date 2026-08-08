// ---------------------------------------------------------------------------
// agent/services/exit-price-suspects.js — the exit prices that are wrong in
// MAGNITUDE, which the sign check cannot see.
//
// Owner, 08-08-2026: "go" — on the exit-price provenance finding.
//
// THE GAP. `pnl_price_mismatch` (trade-consistency.js) asks whether the money
// and the prices agree on DIRECTION. It found 56 of 190 rows, and it is a good
// check. But direction is only half of a price, and the half it misses is the
// one that hides:
//
//   loud   long exits BELOW entry and the broker paid us  -> sign check catches it
//   quiet  long exits 2 points above entry, broker paid 9,171  -> INVISIBLE
//
// The quiet case is worse. `pnl-backfill.js` repairs exit prices ONLY where
// `pnl_price_mismatch = 1`, so a row pointing the right way but off by a factor
// is never flagged, never re-fetched, and never repaired. It stays in the
// record for ever, and everything computing R from prices — realised R, the
// Phase 7 exit counterfactual, the early-trim shadow — reads it as fact.
//
// WHY THIS NEEDS NO CURRENCY TABLE, AND WHY THAT MATTERS. Yesterday's
// sizing-parity.js needed contract sizes and FX rates to model P&L, and a wrong
// entry in that table was the very bug it was built to find — a check that
// depends on the thing under test can be defeated by it.
//
// This one derives the conversion from the trade itself:
//
//     unitValue = |net_pnl| / (|priceMove| x volume)
//
// i.e. money per price-unit per unit of volume. It is whatever it is; we never
// have to know. Then every trade on a symbol is compared against the MEDIAN of
// its own symbol's population. Physics is constant per symbol, so a row whose
// derived unitValue is 50x its neighbours' has a wrong price, a wrong volume or
// a wrong P&L — and since net_pnl is broker truth (see the provenance note in
// trade-consistency.js), the price is the suspect.
//
// WHAT IT CANNOT DO, stated plainly. The median is only a reference if MOST
// rows on a symbol are right. If a symbol is SYSTEMATICALLY wrong — every row
// off by the same factor, which is exactly what a bad quote currency does —
// the median moves with the error and everything looks consistent. That case
// belongs to sizing-parity.js, which compares against the declared contract
// table instead. The two checks are complementary by construction:
//
//   sizing-parity.js       absolute, needs the table   -> SYSTEMATIC error
//   exit-price-suspects.js relative, needs no table    -> PER-ROW error
//
// Neither is sufficient. Saying so here is cheaper than someone later trusting
// one of them to mean more than it does.
//
// IT NEVER WRITES. Callers decide what to do with a suspect.
// ---------------------------------------------------------------------------

import { priceMove } from './trade-consistency.js'

/** Rows whose derived unit value is beyond this factor of the symbol median. */
export const DEFAULT_TOLERANCE = 3
/** Below this many usable rows a symbol has no median worth comparing to. */
export const DEFAULT_MIN_TRADES = 4

const num = (v) => (v == null || v === '' ? NaN : Number(v))

/**
 * Money per price-unit per unit of volume, derived from the trade alone.
 *
 * Returns null when the row cannot supply it — a missing exit, a flat move, a
 * zero P&L or no volume. Those are not suspects; they are simply silent, and
 * conflating "cannot be checked" with "passed" is the failure mode this whole
 * area keeps producing.
 *
 * @param {{side:string, entry_price:number, exit_price:number, volume:number,
 *          net_pnl:number}} trade
 * @returns {number|null}
 */
export function impliedUnitValue(trade) {
  const move = priceMove(trade)
  const pnl = num(trade?.net_pnl)
  const vol = num(trade?.volume)
  if (move == null || !Number.isFinite(pnl) || !Number.isFinite(vol) || vol <= 0) return null
  const absMove = Math.abs(move)
  const entry = Math.abs(num(trade?.entry_price)) || 1
  // A move at float noise divides by ~0 and manufactures an enormous unit
  // value out of a scratch trade. Same epsilon convention as the sign check.
  if (!(absMove > entry * 1e-9) || pnl === 0) return null
  return Math.abs(pnl) / (absMove * vol)
}

/**
 * Per-symbol suspects. Pure.
 *
 * `ratio` is a row's unit value over its symbol's median: 1 is agreement, 50
 * means this row implies fifty times the money-per-point its neighbours do.
 * The bound is symmetric in log space, because a row 3x too SMALL is exactly
 * as wrong as one 3x too large and a bare `ratio > tolerance` would only ever
 * find half of them.
 *
 * @param {Array<object>} trades closed rows, any symbols
 * @param {{tolerance?:number, minTrades?:number, limit?:number}} opts
 */
export function exitPriceSuspects(trades, {
  tolerance = DEFAULT_TOLERANCE, minTrades = DEFAULT_MIN_TRADES, limit = 200,
} = {}) {
  const bySymbol = new Map()
  let usable = 0, silent = 0
  for (const t of Array.isArray(trades) ? trades : []) {
    const uv = impliedUnitValue(t)
    if (uv == null || !(uv > 0)) { silent++; continue }
    usable++
    const sym = String(t.symbol || '').toUpperCase()
    if (!bySymbol.has(sym)) bySymbol.set(sym, [])
    bySymbol.get(sym).push({ trade: t, unitValue: uv })
  }

  const suspects = []
  const symbols = []
  for (const [symbol, rows] of bySymbol) {
    const med = median(rows.map(r => r.unitValue).sort((a, b) => a - b))
    const enough = rows.length >= minTrades
    let flagged = 0
    for (const r of rows) {
      const ratio = r.unitValue / med
      const off = ratio > tolerance || ratio < 1 / tolerance
      if (enough && off) {
        flagged++
        suspects.push({
          id: r.trade.id,
          symbol,
          side: r.trade.side,
          closedAt: r.trade.closed_at ?? null,
          closeReason: r.trade.close_reason ?? null,
          entry: r.trade.entry_price,
          exit: r.trade.exit_price,
          volume: r.trade.volume,
          netPnl: r.trade.net_pnl,
          unitValue: round6(r.unitValue),
          symbolMedian: round6(med),
          ratio: round4(ratio),
          // What the exit price WOULD have to be for this row's money to make
          // sense at the symbol's own unit value. Offered as evidence for a
          // human, NOT written anywhere: it assumes the price is the wrong
          // field, and on some rows `side` or `volume` may be the liar
          // instead (see trade-consistency.js on id 702).
          impliedExit: impliedExitPrice(r.trade, med),
        })
      }
    }
    symbols.push({
      symbol,
      trades: rows.length,
      medianUnitValue: round6(med),
      flagged,
      verdict: !enough ? 'insufficient' : flagged ? 'suspects' : 'consistent',
    })
  }
  suspects.sort((a, b) => Math.abs(Math.log(b.ratio || 1)) - Math.abs(Math.log(a.ratio || 1)))
  symbols.sort((a, b) => b.flagged - a.flagged || b.trades - a.trades)
  return {
    suspects: suspects.slice(0, limit),
    symbols,
    usable,
    silent,
    totalSuspects: suspects.length,
    tolerance,
    minTrades,
  }
}

/**
 * The exit price implied by the symbol's own unit value — evidence, not a fix.
 * Returns null rather than a number whenever any input is missing, because a
 * plausible-looking price is worse here than no price at all.
 */
export function impliedExitPrice(trade, medianUnitValue) {
  const entry = num(trade?.entry_price)
  const pnl = num(trade?.net_pnl)
  const vol = num(trade?.volume)
  const side = String(trade?.side || '').toUpperCase()
  if (!Number.isFinite(entry) || !Number.isFinite(pnl) || !Number.isFinite(vol) || vol <= 0) return null
  if (!(medianUnitValue > 0) || (side !== 'BUY' && side !== 'SELL')) return null
  // Signed move that would produce this P&L at the symbol's unit value.
  const move = pnl / (medianUnitValue * vol)
  const exit = side === 'BUY' ? entry + move : entry - move
  return Number.isFinite(exit) ? Math.round(exit * 1e6) / 1e6 : null
}

/**
 * Read the closed rows, run the check, and stamp `exit_price_suspect` so the
 * backfill's repair can find them. The ONLY write in this module, and it writes
 * a FLAG, never a price — the repair itself stays with pnl-backfill.js, which
 * has the broker's execution price. Nothing here invents a number.
 *
 * Clears the flag on rows that now pass, so a repaired row stops being a
 * suspect rather than accumulating a permanent mark. That matters: a flag that
 * only ever turns on becomes a list of everything that was ever wrong, which is
 * not the same question and is far less useful.
 *
 * Fails OPEN on a schema gap. A missing column is not a reason to stop trading.
 *
 * @returns {{flagged:number, cleared:number, scanned:number, totalSuspects:number}}
 */
export function sweepExitPriceSuspects(db, { accountId = null, days = 90, ...opts } = {}) {
  const acct = accountId != null ? String(accountId) : null
  try {
    const rows = db.prepare(`
      SELECT id, symbol, side, entry_price, exit_price, volume, net_pnl, closed_at,
             close_reason, exit_price_suspect
        FROM trades
       WHERE status = 'closed' AND net_pnl IS NOT NULL
         AND entry_price IS NOT NULL AND exit_price IS NOT NULL
         AND closed_at >= datetime('now', ?)
         AND (account_id = ? OR ? IS NULL)
    `).all(`-${Math.max(1, Math.min(3650, Number(days) || 90))} days`, acct, acct)
    const out = exitPriceSuspects(rows, { ...opts, limit: rows.length || 1 })
    const suspectIds = new Set(out.suspects.map(s => s.id))
    const set = db.prepare(`UPDATE trades SET exit_price_suspect = ? WHERE id = ?`)
    let flagged = 0, cleared = 0
    const tx = db.transaction(() => {
      for (const r of rows) {
        const want = suspectIds.has(r.id) ? 1 : 0
        const have = r.exit_price_suspect === 1 ? 1 : 0
        if (want === have) continue
        set.run(want, r.id)
        if (want) flagged++; else cleared++
      }
    })
    tx()
    return { flagged, cleared, scanned: rows.length, totalSuspects: out.totalSuspects }
  } catch (e) {
    return { flagged: 0, cleared: 0, scanned: 0, totalSuspects: 0, error: e.message }
  }
}

function median(sorted) {
  if (!sorted.length) return NaN
  const m = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}
function round4(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 1e4) / 1e4 : null }
function round6(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 1e6) / 1e6 : null }
