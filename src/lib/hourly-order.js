// How the 24-hour table's rows are built and ordered.
//
// ROLLING WINDOW (owner, 2026-07-31): "now is 6:20 AM (trading in the block of
// 10 minutes) the next refresh is 6:30 AM." The table is a rolling past-24-
// hours timeline anchored on the wall clock, not on the FX day.
//
// WHAT CHANGED AND WHY IT MATTERS. Until now the 24 slots were the FX day
// (17:00 NY → 17:00 NY), hour-aligned, with the hours still to come rendered
// dashed. Row labels were therefore always on the hour. The owner asked for the
// live minute to survive into every row — 6:20, 5:20, 4:20 — which only tells
// the truth if the BUCKETS move with the labels. So the windows are now
// [t−1h, t) for t = now, now−1h, … now−23h, and a row's label is the END of its
// own window: the 6:20 row is the hour that finished at 6:20.
//
// The owner was asked directly whether the numbers or the labels should give,
// and chose the labels — the figures in every column are computed by the same
// formulas as before, over shifted inputs. Expect the per-row numbers to differ
// from the FX-day version; that is the point, not a regression.
//
// SCOPE, also the owner's call: the hourly table alone moves to the rolling
// window. The "Closed Trades" list under it and the card title stay on the FX
// day. The two therefore cover different spans and their totals will not
// reconcile. That was put to the owner as the cost of the smaller change and
// accepted.
//
// TWO RULES THAT SURVIVE FROM THE FX-DAY VERSION:
//
//   1. The BALANCE CARRY must run oldest → newest. It walks backwards from the
//      current stamped balance, so every row's openBal depends on the row after
//      it. Reversing the source array before the carry inverts every balance on
//      the page — a bug that looks like plausible numbers. rollingHourWindows
//      therefore returns OLDEST FIRST, and the reversal happens afterwards.
//
//   2. The DISPLAY leads with the newest row, because that is the row you look
//      at first. With a rolling window that is a plain reverse: there are no
//      future rows to sort below the history any more, and exactly one row is
//      live — the newest, always.

const H = 60 * 60 * 1000

/**
 * The rolling windows behind the 24 rows, OLDEST FIRST (what the carry needs).
 *
 * Every window is derived independently from the same captured `nowMs`; nothing
 * accumulates, so no row can drift from rounding.
 *
 * @param {number} nowMs  captured once per refresh — not re-read per row
 * @param {number} count  how many hourly rows (24)
 * @returns {Array<{from:number,to:number,at:number}>} `at` is the label instant
 *   and equals `to`: the 6:20 row is the hour that ENDED at 6:20.
 */
export function rollingHourWindows(nowMs, count = 24) {
  if (!Number.isFinite(nowMs) || !Number.isInteger(count) || count < 1) return []
  const out = []
  // i counts back from the newest; unshift builds oldest-first without ever
  // mutating nowMs.
  for (let i = 0; i < count; i++) {
    const at = nowMs - i * H
    out.unshift({ from: at - H, to: at, at })
  }
  return out
}

/**
 * The whole period the card covers: exactly the union of the 24 windows.
 *
 * Owner's acceptance test: "The hourly rows and Closed Trades section must
 * cover precisely the same period. Their closed-trade counts and totals must
 * reconcile." The only way to guarantee that is for both to read their bounds
 * from here rather than each computing its own — two expressions that agree
 * today drift the moment one is edited.
 */
export function rollingWindow(nowMs, count = 24) {
  const w = rollingHourWindows(nowMs, count)
  return w.length ? { from: w[0].from, to: w[w.length - 1].to } : { from: nowMs, to: nowMs }
}

/**
 * Newest first, with `isLive` on the row whose window ends now.
 *
 * @param {Array} rows  windows WITH balances already carried, oldest first
 */
export function displayOrder(rows) {
  if (!Array.isArray(rows) || !rows.length) return []
  return rows
    .map((r, i) => ({ ...r, isLive: i === rows.length - 1 }))
    .reverse()
}

/**
 * When the table's clock next ticks.
 *
 * Owner's cadence: "now is 6:20 AM … the next refresh is 6:30 AM" — every ten
 * minutes, aligned to the wall clock rather than to whenever the page happened
 * to load, so two tabs open side by side relabel together.
 *
 * A short timer was the wrong fix for the HOUR-aligned table (it churned rows
 * for no gain, because the order could only change on the hour). With rolling
 * minute-anchored windows the labels and the buckets genuinely move between
 * ticks, so the tick is what keeps the table honest rather than noise.
 *
 * @param {number} nowMs
 * @param {number} stepMs  tick cadence (default 10 minutes)
 * @returns {number} the next aligned instant, strictly after nowMs.
 */
export function nextTickBoundary(nowMs, stepMs = 10 * 60 * 1000) {
  const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : 10 * 60 * 1000
  return Math.floor(nowMs / step) * step + step
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
