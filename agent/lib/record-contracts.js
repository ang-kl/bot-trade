// agent/lib/record-contracts.js — WHEN EACH RECORD FIELD'S WRITER BEGAN, and
// what the completeness goals may say about a record that can never be whole
// (V3 B4, P5b-3).
//
// THE PROBLEM. The completeness goals (close_completeness, trade_reasons) and
// the position-history refused stream counted every gap the same way: a close
// the broker proved it cannot price, a row opened before the field it lacks
// had a writer, and a live writer that is still dropping a field today all
// read as one number. The number is right; what it hides is which part of it
// can still move. Owner principle 4 (every trade has a reason) and principle 6
// (no fake result) both need the parts NAMED — never recovered, never zero.
//
// WHAT THIS MODULE CLAIMS, and only this: a field's writer began at a dated
// commit on main. A row whose entry precedes that date COULD NOT carry the
// field — `pre_contract`. A pre-contract class is claimed ONLY for a field
// listed here; a field with no dated contract is never excused by a date, and
// its gap stays a writer gap (principle 3: codebase-built blockages are
// addressed, not carried).
//
// Dates are the merge commits' committer times on main, read with
// `git show -s --format=%cI` (UTC below): e455ca8 2026-09-08T15:48:28+08:00,
// 8eb4e75 2026-09-11T23:03:46+08:00, fffa7bd 2026-09-18T03:22:19+08:00.
// ---------------------------------------------------------------------------

export const RECORD_CONTRACTS = Object.freeze({
  // Plan-at-entry: trade_plans written at the fill and scored at the close.
  plan: Object.freeze({
    since: '2026-09-08T07:48:28Z', commit: 'e455ca8', pr: '#857',
    what: 'plan-at-entry (trade_plans written at the fill, scored at the close)',
  }),
  // PR-D: direction_reason stated on every entry. PR-AL then found three
  // entry paths that computed a reason and threw it away; a row opened
  // between the two was lost to a defect of this codebase, not to history,
  // so it gets its own class (post_contract_pre_fix), never pre_contract.
  direction_reason: Object.freeze({
    since: '2026-09-11T15:03:46Z', commit: '8eb4e75', pr: '#899',
    what: 'PR-D: direction_reason on every entry',
    fixedAt: '2026-09-17T19:22:19Z', fixCommit: 'fffa7bd', fixPr: '#934',
    fix: 'PR-AL: three entry paths computed a direction reason and threw it away',
  }),
})

/** The position-history fields whose writer is the plan contract (#857). */
export const PLAN_FIELDS = Object.freeze(['planned_entry', 'planned_sl', 'risk_dist'])

/**
 * The broker's own figures on a position record. A gap here is filled only
 * from broker evidence: it is pending while that evidence can still come, and
 * labelled unrecoverable once a write-off or a final broker verdict says it
 * cannot.
 */
export const BROKER_FIELDS = Object.freeze([
  'entry_price', 'exit_price', 'volume', 'opened_at_ms', 'closed_at_ms', 'hold_ms',
  'gross_pnl', 'commission', 'swap', 'net_pnl',
])

/**
 * Final broker verdicts (services/position-lifecycle-evidence.js VERDICTS)
 * under which a position can never be priced: the broker holds nothing, only
 * refused deals, a lifecycle without its opening, or an answer no rule here
 * can settle. `unreadable` is not among them — it says nothing is known.
 */
export const UNPRICEABLE_VERDICTS = Object.freeze(['empty_at_broker', 'never_filled', 'opening_not_retained', 'permanently_unsupported'])

/**
 * The owner question these classes wait on (V3-SEQUENCE H-P5b-3). Until it is
 * answered every row is COUNTED toward the target, and the split is shown
 * beside the unchanged raw total.
 */
export const GOAL_SEMANTICS = Object.freeze({
  id: 'H-P5b-3',
  question: 'Do rows labelled unrecoverable (a write-off or a final broker verdict) and rows whose missing field predates its writer count as meeting the close_completeness and trade_reasons targets?',
  status: 'pending the owner — every row is counted until answered',
})

/**
 * A ledger or broker timestamp as epoch ms, read as UTC. Accepts epoch ms,
 * 'YYYY-MM-DD HH:MM:SS' (SQLite datetime('now'), UTC) and ISO with or
 * without a zone. null when absent or unparseable — never "now", never 0.
 */
export function utcMs(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const raw = String(v).trim().replace(' ', 'T')
  if (raw === '') return null
  const t = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(raw) || !raw.includes('T') ? raw : `${raw}Z`)
  return Number.isFinite(t) ? t : null
}

const sinceMs = (c) => Date.parse(c.since)

/**
 * The plan contract for a row entered at `entryMs`: 'pre_contract' before
 * #857, 'post_contract' at or after it, null when the entry time is unknown
 * (an unknown time is never excused by a date).
 */
export function planContractClass(entryMs) {
  if (entryMs == null || !Number.isFinite(Number(entryMs))) return null
  return Number(entryMs) < sinceMs(RECORD_CONTRACTS.plan) ? 'pre_contract' : 'post_contract'
}

/**
 * The direction_reason contract for a row entered at `entryMs`:
 * 'pre_contract' before PR-D, 'post_contract_pre_fix' from PR-D until PR-AL's
 * fix, 'post_contract' from the fix on (a gap there is a live writer gap),
 * null when the entry time is unknown.
 */
export function directionReasonContractClass(entryMs) {
  if (entryMs == null || !Number.isFinite(Number(entryMs))) return null
  const c = RECORD_CONTRACTS.direction_reason
  const t = Number(entryMs)
  if (t < sinceMs(c)) return 'pre_contract'
  if (t < Date.parse(c.fixedAt)) return 'post_contract_pre_fix'
  return 'post_contract'
}
