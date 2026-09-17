// agent/services/position-history-partial.js — analysis over the records that
// DID NOT pass the completeness gate (owner, 18-09-2026).
//
// WHY THIS EXISTS AND WHY IT IS DANGEROUS. Measured on production at
// 17-09-2026 17:18 UTC: of 1,288 closed positions in 90 days, 60 were complete
// and 1,225 were not. The 1,225 are not worthless — most carry symbol,
// direction, strategy, entry, exit and net P&L — but they cannot say WHY a
// direction was taken, because `direction_reason` did not exist in this
// codebase before 8eb4e75 (11-09-2026) and is not recoverable from the broker
// or from any other table.
//
// So this module answers what those rows CAN support. The danger is obvious:
// a number computed here looks exactly like a number computed from complete
// records, and six months from now nobody will remember which was which.
//
// THE OWNER'S RULE, 18-09-2026: "Remember the date and time that partial
// analysis is done and the details so that future will not confuse with
// incomplete records for analysis. So when proper analysis is done it is with
// complete records."
//
// HOW THAT IS ENFORCED HERE, rather than promised:
//
//   1. Every result carries a `provenance` block — generated at (UTC and
//      SGT), the basis (`INCOMPLETE_RECORDS`), the record count, the fields
//      that were absent and on how many rows, and the clean-data cutoff.
//      It is built in ONE place and attached by the same function that
//      computes the numbers, so a caller cannot obtain figures without it.
//   2. Every aggregate states its OWN denominator: how many rows contributed
//      and how many were skipped for lacking the field being grouped on. An
//      average over 900 of 1,225 rows is a different fact from an average
//      over 1,225, and printing only the first would repeat the mistake this
//      whole programme exists to stop.
//   3. Nothing here reads `position_history`. The clean table and this one
//      never mix, in either direction.

const SGT_OFFSET_MS = 8 * 3_600_000

/** The commit that introduced `direction_reason` — the clean-data boundary. */
export const CLEAN_DATA_CUTOFF = Object.freeze({
  commit: '8eb4e75',
  date: '2026-09-11',
  field: 'direction_reason',
  why: 'the field did not exist in this codebase before this commit, so no position closed earlier can carry one, and it cannot be recovered from the broker',
})

const sgt = (ms) => new Date(ms + SGT_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19) + ' SGT'

/**
 * One aggregate, with its own denominator attached.
 *
 * `skipped` is the count of rows that had no value for `keyField` — never
 * folded into an "unknown" bucket that would then be compared against real
 * strategies as though it were one.
 */
function groupBy(rows, keyField, valueField) {
  const buckets = new Map()
  let skipped = 0, used = 0
  for (const r of rows) {
    const key = r[keyField]
    const val = r[valueField]
    if (key == null || key === '' || val == null || !Number.isFinite(Number(val))) { skipped++; continue }
    used++
    const b = buckets.get(key) || { key, n: 0, total: 0, wins: 0, losses: 0 }
    b.n++
    b.total += Number(val)
    if (Number(val) > 0) b.wins++
    else if (Number(val) < 0) b.losses++
    buckets.set(key, b)
  }
  const out = [...buckets.values()].map(b => ({
    ...b,
    total: Math.round(b.total * 100) / 100,
    avg: Math.round((b.total / b.n) * 100) / 100,
    winRatePct: b.wins + b.losses > 0 ? Math.round((b.wins / (b.wins + b.losses)) * 1000) / 10 : null,
  })).sort((a, b) => b.total - a.total)
  return {
    rows: out,
    // THE DENOMINATOR TRAVELS WITH THE NUMBERS. Without it "vwap_trend lost
    // $2,100" reads as a fact about vwap_trend rather than a fact about the
    // subset of vwap_trend trades that happened to record both fields.
    basedOn: used,
    skippedForMissingField: skipped,
    coveragePct: used + skipped > 0 ? Math.round((used / (used + skipped)) * 1000) / 10 : null,
  }
}

/** Show the top N groups without changing what the denominators say. */
function capped(g, limit) {
  return { ...g, rows: g.rows.slice(0, limit), groupsShown: Math.min(g.rows.length, limit), groupsTotal: g.rows.length }
}

/**
 * Analyse the refused stream.
 *
 * Returns `{ provenance, totals, byStrategy, bySymbol, byDirection, byCloseReason }`.
 * The provenance block is NOT optional and NOT separable: it is attached here,
 * beside the figures, for the reason the header gives.
 */
export function partialAnalysis(db, { now = Date.now(), limit = 20 } = {}) {
  const raw = db.prepare(`
    SELECT account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json
      FROM position_history_incomplete
     ORDER BY closed_at_ms DESC
  `).all()

  const rows = []
  const missingCounts = {}
  let unparseable = 0
  for (const r of raw) {
    let rec = null, missing = []
    try { rec = JSON.parse(r.partial_json) } catch { unparseable++; continue }
    try { missing = JSON.parse(r.missing_json) || [] } catch { missing = [] }
    for (const f of missing) missingCounts[f] = (missingCounts[f] || 0) + 1
    rows.push(rec)
  }

  const closed = rows.map(r => Number(r.closed_at_ms)).filter(Number.isFinite).sort((a, b) => a - b)
  const withPnl = rows.filter(r => r.net_pnl != null && Number.isFinite(Number(r.net_pnl)))
  const netTotal = withPnl.reduce((s, r) => s + Number(r.net_pnl), 0)

  const provenance = {
    // THE STAMP THE OWNER ASKED FOR. Both clocks, because the ledger and the
    // Railway log are in different ones and a reader six months from now
    // should not have to work out which.
    generatedAtUtc: new Date(now).toISOString(),
    generatedAtSgt: sgt(now),
    basis: 'INCOMPLETE_RECORDS',
    warning: 'PARTIAL ANALYSIS — computed from position_history_incomplete, i.e. records that FAILED the completeness gate. These figures are NOT the proper analysis. The proper analysis runs over position_history (complete records only) and will disagree with this. Do not merge, compare or quote these together without this block.',
    records: rows.length,
    unparseableRows: unparseable,
    // Ranked, so the first entry is what most often prevented completeness.
    missingFields: Object.entries(missingCounts).sort((a, b) => b[1] - a[1]).map(([field, n]) => ({ field, n })),
    coveredPeriod: closed.length
      ? { earliest: new Date(closed[0]).toISOString(), latest: new Date(closed[closed.length - 1]).toISOString() }
      : null,
    cleanDataCutoff: CLEAN_DATA_CUTOFF,
  }

  return {
    provenance,
    totals: {
      positions: rows.length,
      withNetPnl: withPnl.length,
      // Stated as a subset, never as "the" P&L of the period.
      netPnlOverRowsThatHaveIt: Math.round(netTotal * 100) / 100,
      withoutNetPnl: rows.length - withPnl.length,
    },
    // Truncated for display, but `basedOn` and `skippedForMissingField` are
    // the FULL counts — a reader must not infer the denominator from the
    // number of rows they can see.
    byStrategy: capped(groupBy(rows, 'strategy', 'net_pnl'), limit),
    bySymbol: capped(groupBy(rows, 'symbol', 'net_pnl'), limit),
    byDirection: groupBy(rows, 'direction', 'net_pnl'),
    byCloseReason: groupBy(rows, 'close_reason', 'net_pnl'),
  }
}

/**
 * A one-line summary for the boot log, so the figures can be read back
 * WITHOUT the bearer token — which has been unavailable since 07-09 and is
 * the reason several measurements this month could not be taken at all.
 *
 * The line leads with the warning, not with the money. A summary that opened
 * with a P&L figure would be quoted without the caveat within a day.
 */
export function partialAnalysisLine(result) {
  const p = result.provenance
  const top = result.byStrategy.rows.slice(0, 3)
    .map(r => `${r.key} ${r.total >= 0 ? '+' : ''}${r.total} (${r.n})`)
    .join(', ')
  return `[partial-analysis] INCOMPLETE RECORDS ONLY — not the proper analysis · ${p.records} position(s), ` +
    `${result.totals.withNetPnl} with P&L, net ${result.totals.netPnlOverRowsThatHaveIt} over those only · ` +
    `strategy coverage ${result.byStrategy.coveragePct}% (${result.byStrategy.basedOn} of ${result.byStrategy.basedOn + result.byStrategy.skippedForMissingField})` +
    (top ? ` · top by net: ${top}` : '') +
    ` · generated ${p.generatedAtSgt} · clean data begins ${p.cleanDataCutoff.date} (${p.cleanDataCutoff.field})`
}
