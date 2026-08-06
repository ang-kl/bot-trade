// ---------------------------------------------------------------------------
// agent/lib/trade-origin.js — HOW did this trade come to exist?
//
// THE FINDING (audit Part 2). Postmortems were missing thesis, confluence and
// strategy attribution, and the reason turned out not to be a broken writer:
// the positions had been ADOPTED by reconciliation from broker truth rather
// than opened through the normal dispatch path. Nothing had computed a thesis
// because nothing had made a decision.
//
// The audit's first reading of that was "entry_quality is populated by
// nothing", which was wrong and is withdrawn — `loss-postmortem.js:528` writes
// it, and there is a test. The real defect is narrower and worse: there was no
// field saying WHERE A TRADE CAME FROM, so a reconciler-adopted position and a
// strategy's own entry were indistinguishable in every table that measures
// edge. Win rate, profit factor and expectancy were computed over a mixture,
// and the mixture was invisible.
//
// THE RULE. One enum, one column, written where the trade is created — never
// inferred later from what a row happens to contain. `source` and
// `label_strategy` already exist and are close, but they answer "who wrote the
// label" and "which strategy was named", not "did this system decide to take
// this trade". A trade adopted from the broker carries a label because
// reconciliation PARSED one off the position comment; that is provenance of a
// string, not of a decision.
//
// AND RECONCILIATION MUST NOT INVENT A STRATEGY. It may record the label it
// found and mark the origin `reconciler_adopted`; it may not present that as a
// strategy's own trade. The distinction is the whole point of the column.
// ---------------------------------------------------------------------------

/**
 * The closed set. An origin outside this list is a bug, not a new category.
 *
 * Ordered from most to least evidence about the decision behind the trade —
 * the first two are the only ones that carry a full decision record, and
 * `cleanBotOrigin` below draws its line exactly there.
 */
export const ORIGINS = Object.freeze([
  'bot_market_dispatch',   // the loop decided, sized and submitted a market order
  'bot_pending_fill',      // a resting order this system placed was filled
  'reconciler_adopted',    // found on the broker, no local row — adopted after the fact
  'manual_broker',         // opened by a human in the broker's own UI
  'external_system',       // another system's position on the same account
  'legacy_unattributed',   // predates this column; origin genuinely unknown
  'unknown',               // written when nothing can be established. NOT a default.
])

/** Origins whose trades carry a real decision record, and may be used to measure edge. */
export const CLEAN_BOT_ORIGINS = Object.freeze(['bot_market_dispatch', 'bot_pending_fill'])

export function isOrigin(value) {
  return ORIGINS.includes(String(value || ''))
}

/**
 * Coerce to a declared origin.
 *
 * Anything unrecognised becomes `unknown` rather than being passed through:
 * an origin column that can hold arbitrary strings is a label field, and this
 * is meant to be an enum a query can trust.
 */
export function normaliseOrigin(value) {
  const s = String(value || '').trim()
  return isOrigin(s) ? s : 'unknown'
}

/**
 * May this trade be counted as evidence of a strategy's edge?
 *
 * The audit's instruction, made mechanical: "Do not use adopted or manual
 * trades as clean evidence of strategy expectancy."
 */
export function cleanBotOrigin(origin) {
  return CLEAN_BOT_ORIGINS.includes(normaliseOrigin(origin))
}

/**
 * Best-effort origin for a row written BEFORE this column existed.
 *
 * DERIVED, NEVER GUESSED. Each branch below reads a fact the old write paths
 * actually recorded:
 *
 *   - `source = 'reconciled'` / a thesis naming adoption → reconciler_adopted
 *   - `source = 'autotrade'` with a risk_event_id        → bot_market_dispatch
 *   - `source = 'fib_618_fade'` (pending-orders.js's literal) → bot_pending_fill
 *   - `source = 'manual'` / 'execute_analysis'           → manual_broker
 *
 * Everything else is `legacy_unattributed` — which is a statement ("this row
 * predates attribution"), not a shrug. The one thing this function must never
 * do is promote a row into a clean bot origin on thin evidence, because that
 * would launder adopted trades into the edge numbers the column exists to
 * protect.
 *
 * @param {{source?: string, thesis?: string, risk_event_id?: number|null,
 *          strategy?: string, label_raw?: string}} row
 * @returns {string} one of ORIGINS
 */
export function deriveOrigin(row) {
  const source = String(row?.source || '').toLowerCase()
  const thesis = String(row?.thesis || '').toLowerCase()

  if (source.includes('reconcil') || thesis.includes('adopted')) return 'reconciler_adopted'
  if (source === 'autotrade') {
    // A risk_event_id is the decision record. Without one, an 'autotrade' row
    // is this system's order with no verdict attached — real, but not clean
    // evidence, and saying so is the point.
    return row?.risk_event_id != null ? 'bot_market_dispatch' : 'legacy_unattributed'
  }
  if (source === 'fib_618_fade' || source === 'pending' || source === 'pending_fill') return 'bot_pending_fill'
  if (source === 'manual' || source === 'execute_analysis' || source === 'llm') return 'manual_broker'
  return 'legacy_unattributed'
}

/**
 * Attribution coverage for a set of rows: what fraction of this answer comes
 * from trades whose origin is actually known, and how much of it is clean.
 *
 * Returned BESIDE metrics, never instead of them. The Go-Live Gate card on
 * 2026-08-03 showed six panels of identical numbers because every row was
 * unattributed and every scoped read matched all of them; a coverage figure
 * printed next to the win rate is what would have caught it.
 *
 * @param {Array<{origin?: string}>} rows
 */
export function originCoverage(rows) {
  const list = Array.isArray(rows) ? rows : []
  const byOrigin = {}
  let known = 0
  let clean = 0
  for (const r of list) {
    const o = normaliseOrigin(r?.origin)
    byOrigin[o] = (byOrigin[o] || 0) + 1
    if (o !== 'unknown' && o !== 'legacy_unattributed') known++
    if (cleanBotOrigin(o)) clean++
  }
  const pct = (n) => (list.length ? Math.round((n / list.length) * 1000) / 10 : 0)
  return {
    n: list.length,
    byOrigin,
    known,
    knownPct: pct(known),
    clean,
    cleanPct: pct(clean),
    // The sentence a caller should print. Spelling it here keeps every panel
    // saying the same thing in the same words.
    note: list.length === 0
      ? 'No trades in this window.'
      : `${clean} of ${list.length} trades (${pct(clean)}%) come from this system's own dispatch; the rest are adopted, manual or unattributed and are NOT evidence of strategy edge.`,
  }
}
