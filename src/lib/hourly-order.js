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
//   2. The DISPLAY leads with the CURRENT hour, because that is the row you
//      look at first. So the reordering happens after the carry, and only
//      for display.
//
// Keeping those two facts in one tested function is the point.
//
// UI-2 SECOND PASS (owner, 2026-07-30): "you should always show the current
// time as the top row and the past hour below it, currently is static."
//
// A plain reverse was not enough, and the reason is the FX day. The 24 slots
// span one FX day (17:00 NY → 17:00 NY), so reversing puts the LAST hour of
// that day on top — and for most of the day that hour has not happened yet.
// Mid-afternoon the top rows were dashed future hours and the live hour sat
// seven rows down. Reversed is not the same as "now first".
//
// The order is therefore: the live hour, then the past descending, then the
// hours still to come. Future rows are kept rather than dropped — the owner
// asked for all 24 ("where are the 24 hours") — but they belong below the
// history, not above it.

/**
 * Mark the in-progress hour and order the rows for reading: NOW first.
 *
 * @param {Array<{from:number,to:number}>} rows  slots WITH balances already
 *   carried, oldest first — the order the carry requires.
 * @param {number} nowMs
 * @returns {Array} live hour first, then past hours newest→oldest, then the
 *   hours still to come soonest-first; `isLive` set on the current hour.
 */
export function orderHourlyForDisplay(rows, nowMs) {
  if (!Array.isArray(rows) || !rows.length) return []
  const out = rows.map(r => ({ ...r, isLive: false }))
  // Exactly one row can be live: slots are contiguous and half-open [from,to).
  const i = out.findIndex(r => nowMs >= r.from && nowMs < r.to)
  // No live hour at all — a COMPLETED FX day, which is what the weekend view
  // shows. Every row is history, so plain newest-first is the whole answer and
  // there is no "now" to lead with.
  if (i < 0) return out.reverse()
  out[i].isLive = true
  return [
    out[i],
    ...out.slice(0, i).reverse(),   // the past, most recent first
    ...out.slice(i + 1),            // still to come, soonest first
  ]
}

/**
 * When the hour on the wall clock next changes.
 *
 * Split out and tested because the whole point of the owner's complaint was
 * that the table did not track the clock, and a UI that re-sorts on a short
 * timer is the wrong fix — it churns rows and drifts text between hours. This
 * gives a caller the ONE instant at which the ordering above can change.
 *
 * @param {number} nowMs
 * @returns {number} ms timestamp of the next exact hour, strictly after nowMs.
 */
export function nextHourBoundary(nowMs) {
  const H = 60 * 60 * 1000
  return Math.floor(nowMs / H) * H + H
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
