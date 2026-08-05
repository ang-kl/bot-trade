// THE FUNNEL, in one unit: opportunities.
//
// Every previous attempt to answer "how many approvals went nowhere" compared
// an EVALUATION count to a POSITION count and got a frightening number. Twice:
// "96 approved, 79 orders, 17 went nowhere", then "276 approved, 59 opened,
// 217 went nowhere". Both were unit errors, not findings.
//
// With risk_events.opportunity_key stamped (services/opportunity-identity.js)
// the funnel can be counted in ONE unit end to end:
//
//     opportunities                 distinct setups the gate looked at
//       └ approved                  ... that cleared the gate at least once
//           └ ordered               ... that produced an order row
//               └ filled            ... that became a position
//
// Each level is a SUBSET of the one above, derived from the same key, so a
// drop between two levels is a real drop and the rows are nameable — not a
// subtraction between two different populations.
//
// THE HONESTY RULE THIS MODULE KEEPS. A row with no `opportunity_key` predates
// the migration. It is reported as `unkeyed`, never silently folded into
// either the numerator or the denominator, because an unknown must not be
// allowed to move a rate. Until the backfill runs, `unkeyed` will dominate the
// history and the rates below apply only to the keyed remainder — which the
// payload says explicitly rather than leaving to the reader.

const NUM = (v) => (v == null || v === '' ? null : Number(v))

/** Window bound as an ISO string; `days` may be fractional (0.5 = 12h). */
export function sinceIso(days, now = Date.now()) {
  const d = Number(days)
  const span = Number.isFinite(d) && d > 0 ? d : 1
  return new Date(now - span * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Fold the window into the four levels.
 *
 * `db` needs risk_events (with opportunity_key), trades and pending_orders
 * carrying risk_event_id — all of which exist as of §70.9.
 */
export function opportunityFunnel(db, { days = 1, account = null, now = Date.now() } = {}) {
  const since = sinceIso(days, now)
  const acct = account == null || account === 'all' ? null : String(account)
  const scope = acct ? 'AND (r.account_id = ?)' : ''
  const args = acct ? [since, acct] : [since]

  const rows = db.prepare(
    `SELECT r.opportunity_key AS key,
            r.id              AS risk_event_id,
            r.approved        AS approved,
            r.account_id      AS account_id,
            r.symbol          AS symbol
       FROM risk_events r
      WHERE r.created_at >= ? ${scope}`
  ).all(...args)

  // Which risk_events produced an order, and which produced a position. Read
  // once into sets rather than per-row EXISTS — the audit table is the big
  // one here and this keeps it to three scans regardless of window size.
  const ordered = new Set()
  const filled = new Set()
  for (const t of db.prepare(
    `SELECT risk_event_id FROM pending_orders WHERE risk_event_id IS NOT NULL`
  ).all()) ordered.add(t.risk_event_id)
  for (const t of db.prepare(
    `SELECT risk_event_id FROM trades WHERE risk_event_id IS NOT NULL`
  ).all()) { ordered.add(t.risk_event_id); filled.add(t.risk_event_id) }

  const byKey = new Map()
  let unkeyed = 0
  for (const r of rows) {
    if (!r.key) { unkeyed += 1; continue }
    let o = byKey.get(r.key)
    if (!o) {
      o = { key: r.key, account: r.account_id, symbol: r.symbol, evaluations: 0, approvals: 0, ordered: false, filled: false }
      byKey.set(r.key, o)
    }
    o.evaluations += 1
    if (r.approved === 1) o.approvals += 1
    if (ordered.has(r.risk_event_id)) o.ordered = true
    if (filled.has(r.risk_event_id)) o.filled = true
  }

  const all = [...byKey.values()]
  const approved = all.filter(o => o.approvals > 0)
  const orderedOpps = approved.filter(o => o.ordered)
  const filledOpps = approved.filter(o => o.filled)
  const evaluations = all.reduce((n, o) => n + o.evaluations, 0)

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null)

  return {
    ok: true,
    windowDays: Number(days) || 1,
    since,
    account: acct,
    // The number this whole exercise exists to produce.
    reevaluationRatio: all.length > 0 ? Math.round((evaluations / all.length) * 10) / 10 : null,
    funnel: {
      opportunities: all.length,
      approved: approved.length,
      ordered: orderedOpps.length,
      filled: filledOpps.length,
    },
    rates: {
      approvedPct: pct(approved.length, all.length),
      // Of the approvals, how many reached the broker and how many landed.
      // THIS is the §70.8 question, finally in one unit.
      orderedPctOfApproved: pct(orderedOpps.length, approved.length),
      filledPctOfApproved: pct(filledOpps.length, approved.length),
    },
    evaluations,
    // Never folded into the rates above. See the honesty rule in the header.
    unkeyed,
    unkeyedNote: unkeyed > 0
      ? `${unkeyed} evaluation(s) in this window predate opportunity_key and are excluded from every count above — the rates describe the keyed rows only.`
      : null,
  }
}

/**
 * The approvals that reached nothing, named. This is the list §70.8 could
 * never produce: not a count arrived at by subtraction, but rows.
 */
export function silentOpportunities(db, opts = {}) {
  const f = opportunityFunnel(db, opts)
  const since = f.since
  const acct = f.account
  const scope = acct ? 'AND (r.account_id = ?)' : ''
  const args = acct ? [since, acct] : [since]

  const rows = db.prepare(
    `SELECT r.opportunity_key AS key, r.id AS risk_event_id, r.symbol, r.side,
            r.account_id, r.created_at, r.disposition
       FROM risk_events r
      WHERE r.created_at >= ? AND r.approved = 1 AND r.opportunity_key IS NOT NULL ${scope}
      ORDER BY r.created_at DESC`
  ).all(...args)

  const landed = new Set()
  for (const t of db.prepare(`SELECT risk_event_id FROM trades WHERE risk_event_id IS NOT NULL`).all()) landed.add(t.risk_event_id)
  for (const t of db.prepare(`SELECT risk_event_id FROM pending_orders WHERE risk_event_id IS NOT NULL`).all()) landed.add(t.risk_event_id)

  // Group first: one opportunity approved eight times and landed once is NOT
  // seven silent approvals. That collapse is the entire point.
  const byKey = new Map()
  for (const r of rows) {
    let o = byKey.get(r.key)
    if (!o) { o = { key: r.key, symbol: r.symbol, side: r.side, account: r.account_id, firstAt: r.created_at, lastAt: r.created_at, approvals: 0, landed: false, disposition: r.disposition || null }; byKey.set(r.key, o) }
    o.approvals += 1
    if (r.created_at < o.firstAt) o.firstAt = r.created_at
    if (r.created_at > o.lastAt) o.lastAt = r.created_at
    if (landed.has(r.risk_event_id)) o.landed = true
    if (!o.disposition && r.disposition) o.disposition = r.disposition
  }

  return [...byKey.values()].filter(o => !o.landed)
}

/** One-line summary for the heartbeat log. */
export function funnelLine(f) {
  if (!f || !f.funnel) return null
  const { opportunities, approved, ordered, filled } = f.funnel
  return `opportunities ${opportunities} → approved ${approved} → ordered ${ordered} → filled ${filled}`
    + ` (${f.reevaluationRatio ?? '—'}x re-evaluated${f.unkeyed ? `, ${f.unkeyed} unkeyed excluded` : ''})`
}

export { NUM as _num }
