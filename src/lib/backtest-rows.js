// ---------------------------------------------------------------------------
// backtest-rows.js — ordering and visibility for the backtest results table.
//
// Owner (2026-07-30): "allow me to sort per column and fliter (Go, No-Go,
// Go(Thin))" on the Tune > Backtest table.
//
// These two operations decide what a trader READS before arming real money on a
// timeframe, so they live here with tests rather than inline in the page: a
// verdict ordered the wrong way round would put the weakest row at the top of
// the evidence, under a heading that says the opposite.
//
// Both functions take the verdict STATE as a plain string, so this module never
// needs Tune's verdictFor (which builds the whole criteria list for the badge).
// ---------------------------------------------------------------------------

/**
 * Verdict order, best first when sorted descending.
 *
 * go   — cleared the evidence bar (≥10 trades, PF ≥1.1, positive total)
 * thin — positive edge, sample too small to trust
 * nogo — failed the bar
 */
export const VERDICT_ORDER = { go: 3, thin: 2, nogo: 1 }

/**
 * Rank a verdict state for sorting. Returns null for anything unrecognised —
 * including an errored row, which has no verdict at all — so the caller can
 * sink it to the bottom the same way it sinks a missing metric. Never guesses a
 * rank: an unknown state ordered as "nogo" would be a claim the data does not
 * support.
 *
 * @param {string|null|undefined} state
 * @returns {number|null}
 */
export function rankVerdict(state) {
  if (typeof state !== 'string') return null
  return Object.prototype.hasOwnProperty.call(VERDICT_ORDER, state) ? VERDICT_ORDER[state] : null
}

/**
 * Which rows the verdict filter shows.
 *
 * An ERRORED row is ALWAYS shown. It has no verdict to match, and hiding a
 * failed run is worse than showing a row that does not fit the filter — silence
 * reads as "this timeframe was fine".
 *
 * This is a VIEW filter. It must never be used to decide what gets armed: a row
 * scrolled out of sight has to keep whatever arming state it had, or the table
 * becomes a way to change positions by accident.
 *
 * @param {Array<[string, object]>} entries [timeframe, result] pairs
 * @param {object} opts
 * @param {Set<string>|string[]} opts.allowed verdict states to show
 * @param {(r: object) => string} opts.stateOf verdict state for a result row
 * @returns {Array<[string, object]>}
 */
export function visibleRows(entries, { allowed, stateOf } = {}) {
  const set = allowed instanceof Set ? allowed : new Set(allowed || [])
  // An empty allow-list means "show everything", not "show nothing". A table
  // emptied by its own filter reads as a backtest that found no timeframes.
  if (set.size === 0) return [...(entries || [])]
  return (entries || []).filter(([, r]) => r?.error || set.has(stateOf(r)))
}

/**
 * Tally verdict states across EVERY row, filter included or not — the summary on
 * a collapsed symbol has to describe the backtest, not the current view.
 *
 * @param {Array<[string, object]>} entries
 * @param {(r: object) => string} stateOf
 * @returns {{go: number, thin: number, nogo: number, errored: number}}
 */
export function tallyVerdicts(entries, stateOf) {
  const out = { go: 0, thin: 0, nogo: 0, errored: 0 }
  for (const [, r] of entries || []) {
    if (r?.error) { out.errored++; continue }
    const s = stateOf(r)
    if (Object.prototype.hasOwnProperty.call(out, s)) out[s]++
  }
  return out
}
