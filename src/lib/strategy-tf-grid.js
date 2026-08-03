// strategy-tf-grid — normalise the /state/strategy-tf-performance payload into
// a shape the table can render WITHOUT assuming anything about it.
//
// Owner crash, 03-08-2026, /tune?tab=pipeline&arm=fib_confluence:
//
//   TypeError: null is not an object (evaluating 'e.total.n')
//
// The cause was the client's own doing. To show the full 12-strategy roster,
// Tune.jsx appended a filler row for every strategy the server did not return:
//
//   { strategy: k, cells: {}, total: null }
//
// and the Total cell then read `s.total.n` unconditionally. So the moment ANY
// strategy had no closed trades in the window — the normal case once the grid
// is scoped to one account — the whole page unmounted. React's response to an
// uncaught render error is to tear down the tree, so a missing total blanked
// the entire application.
//
// The lesson is not "add a ?." at that one line. It is that the component was
// making shape assumptions in three places (total, cells, timeframes), each
// of which is the same crash. This module makes the shape a value that can be
// asserted about in a test, and leaves the JSX with exactly one decision:
// render the total, or render "—".
//
// NULL IS NOT ZERO. A strategy with no closed trades has an UNKNOWN total, not
// a zero one, and must not be drawn as "0·+0.00" — that reads as a measured
// flat result. It renders "—".

/**
 * @param {any} payload   whatever the route returned (may be an error object,
 *                        an older agent build's shape, or null)
 * @param {string[]} rosterKeys the full strategy roster to pad out to
 * @returns {{timeframes: string[], rows: Array<{strategy: string, cells: object, total: object|null}>, days: number|null, totalClosed: number|null}}
 */
export function strategyTfGrid(payload, rosterKeys = []) {
  const timeframes = Array.isArray(payload?.timeframes) ? payload.timeframes : []
  const served = Array.isArray(payload?.strategies) ? payload.strategies : []

  const rows = served.map(s => ({
    strategy: String(s?.strategy ?? ''),
    // cells is ALWAYS an object, so `cells[tf]` can never throw downstream.
    cells: s?.cells && typeof s.cells === 'object' ? s.cells : {},
    // total is EITHER a well-formed object or null. A partial total (no n, or
    // no net) is treated as absent rather than rendered half-blank.
    total: s?.total && typeof s.total === 'object'
      && Number.isFinite(Number(s.total.n)) && Number.isFinite(Number(s.total.net))
      ? s.total
      : null,
  }))

  // Pad the roster only when the server actually answered with a strategy
  // list. If it returned an error object, an empty table is the honest render
  // — twelve rows of "—" would look like twelve measured zeroes.
  if (Array.isArray(payload?.strategies)) {
    const have = new Set(rows.map(r => r.strategy))
    for (const k of rosterKeys) {
      if (!have.has(k)) rows.push({ strategy: k, cells: {}, total: null })
    }
  }

  return {
    timeframes,
    rows,
    days: Number.isFinite(Number(payload?.days)) ? Number(payload.days) : null,
    totalClosed: Number.isFinite(Number(payload?.total_closed)) ? Number(payload.total_closed) : null,
  }
}
