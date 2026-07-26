// FLEET, computed — not a hardcoded list.
//
// Owner (2026-07-26): "what is the computation for the FLEET to shows 5
// related or opposite related symbols". Two things were true and worth
// separating:
//
//   1. The handoff (BUILD-ORDER §5.4) does NOT define FLEET as correlated
//      symbols. It is "other open positions, max 5, labelled `top 5 of N`",
//      each showing its own R on a ±2R calibrated bar. Relatedness is the
//      MFD's TCAS traffic pane, which is a separate display.
//   2. The shipped FLEET was a literal array with invented R values. That is
//      what this module replaces.
//
// R here is the same formula the rest of the app uses (see
// TradeGaugeWall.rMultiple): distance travelled from entry in units of the
// trade's own stop distance, signed by direction. A position with no usable
// entry/stop yields null R rather than a fabricated 0 — it still lists, so
// the count stays honest, but its bar reads empty.
//
// Ordering is by |R| descending: the positions furthest from entry in either
// direction are the ones worth a glance, which is what "top 5" should mean.

const LONG = new Set(['BUY', 'LONG', 'Long', 'long', 'buy'])

export function rMultipleOf({ side, entry, sl, price }) {
  const e = Number(entry), s = Number(sl), p = Number(price)
  if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(p)) return null
  const risk = Math.abs(e - s)
  if (!(risk > 0)) return null
  return ((p - e) * (LONG.has(side) ? 1 : -1)) / risk
}

/**
 * Build the FLEET strip from the open positions the calling surface already
 * holds. `rows` items need { id, sym, side, entry, sl, price }; `currentId`
 * is excluded (the cockpit is already showing it).
 *
 * Returns { list, total } — list is at most `max` entries, total is every
 * other open position, so the caller can render a truthful "top 5 of N".
 */
export function fleetFrom(rows, currentId, max = 5) {
  const others = (rows || []).filter(r => String(r.id) !== String(currentId))
  const scored = others.map(r => ({ sym: r.sym, r: rMultipleOf(r) }))
  scored.sort((a, b) => {
    if (a.r == null && b.r == null) return 0
    if (a.r == null) return 1
    if (b.r == null) return -1
    return Math.abs(b.r) - Math.abs(a.r)
  })
  return { list: scored.slice(0, max), total: others.length }
}
