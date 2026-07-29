// UI-2 — how the 24-hour table is ordered, and which row is "now".
//
// Extracted from Performance.jsx so it can be tested exactly rather than
// eyeballed. The two rules it encodes are easy to get subtly wrong:
//
//   1. The BALANCE CARRY must run oldest → newest. It walks backwards from
//      the current stamped balance, so every row's openBal depends on the row
//      after it. Reversing the source array before the carry inverts every
//      balance on the page — a bug that looks like plausible numbers.
//
//   2. The DISPLAY reads newest → oldest, because the live hour is the one
//      you look at first. So the reverse happens after the carry, and only
//      for display.
//
// Keeping those two facts in one tested function is the point.

/**
 * Mark the in-progress hour and return the rows newest-first.
 *
 * @param {Array<{from:number,to:number}>} rows  slots WITH balances already
 *   carried, oldest first — the order the carry requires.
 * @param {number} nowMs
 * @returns {Array} same rows, newest first, with `isLive` on the current hour.
 */
export function orderHourlyForDisplay(rows, nowMs) {
  if (!Array.isArray(rows) || !rows.length) return []
  const out = rows.map(r => ({ ...r, isLive: false }))
  // Exactly one row can be live: slots are contiguous and half-open [from,to).
  const i = out.findIndex(r => nowMs >= r.from && nowMs < r.to)
  if (i >= 0) out[i].isLive = true
  return out.reverse()
}

/**
 * Total floating (unrealized) P&L across every open position, whatever
 * sub-table it renders in.
 *
 * Returns null when NO bucket reported a figure, so the caller can render a
 * dash instead of a confident $0.00 — "no open positions" and "positions
 * whose P&L we could not read" must not look identical.
 */
export function totalFloating(...buckets) {
  const known = buckets.filter(v => v != null && Number.isFinite(Number(v)))
  return known.length ? known.reduce((s, v) => s + Number(v), 0) : null
}
