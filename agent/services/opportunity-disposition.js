// ---------------------------------------------------------------------------
// agent/services/opportunity-disposition.js — §70.8 / §69.4.3. Give every
// approved opportunity a terminal end state, written down rather than inferred.
//
// WHY. decision-audit.js's header records the original symptom: "96 approved,
// 79 orders, 17 went nowhere". That module has since learned to discount
// placement receipts and post-approval refusals, which removed the false
// alarms — but it still reasons in AGGREGATE. It can tell you a count is off;
// it cannot tell you WHICH approval went quiet, because absence is not a value
// and subtraction has no row to point at.
//
// THERE IS NO NEW OPPORTUNITY ID, and that is deliberate. §69.4.1 asks for a
// stable opportunity identity, and `risk_events.id` already is one: it is
// minted at the gate verdict and carried onto trades.risk_event_id and
// pending_orders.risk_event_id (db.js §70.9). Adding a second identifier
// beside it would mean two ids for one thing and an eventual disagreement
// about which is authoritative — the same class of bug as the six
// representations of "armed" that PR #624 had to collapse. What was missing
// was never the id. It was the END STATE.
//
// THE SWEEP DERIVES, IT DOES NOT GUESS. Every disposition below is read off
// evidence that already exists — a row referencing the event, a marker in
// checks_json, a clock. Where the evidence is absent the answer is `dropped`,
// which is a finding rather than a shrug: it means the gate said yes and
// nothing downstream acted, and that is exactly the silent gap §70.8 names.
//
// AND IT WAITS. An approval a few seconds old has not gone anywhere yet — it
// is in flight. `graceMin` keeps the sweep off decisions that are still
// resolving, because a controller that labelled a live order "dropped" would
// manufacture the alarm it exists to detect.
// ---------------------------------------------------------------------------

import { POST_APPROVAL_FLAG } from './risk.js'

/**
 * The closed set. A disposition outside this list is a bug, not a new
 * category — the point of a terminal state is that it is enumerable.
 */
export const DISPOSITIONS = Object.freeze([
  'vetoed',                 // the gate said no. Terminal on arrival.
  'ordered',                // a trade or pending order carries this event's id.
  'refused_post_approval',  // cleared the gate, refused downstream, with a reason.
  'receipt',                // not a decision — a placement confirmation row.
  'dropped',                // approved, nothing acted, grace elapsed. THE FINDING.
])

/** Minutes an approval is allowed to be in flight before it counts as dropped. */
export const DEFAULT_GRACE_MIN = 10

const isReceipt = (checksJson) => /_placed"?\s*:\s*true/.test(String(checksJson || ''))
const isPostApprovalRefusal = (checksJson) =>
  new RegExp(`"${POST_APPROVAL_FLAG}"\\s*:\\s*true`).test(String(checksJson || ''))

/**
 * The disposition for ONE row, from evidence.
 *
 * Pure so the decision table is testable without a database — the ordering
 * matters and is easy to get subtly wrong. Receipts are checked BEFORE
 * "ordered": a receipt is itself an approved row, and counting it as an
 * approval that landed would double-count every successful placement, which
 * is the mistake decision-audit.js already had to unwind once.
 */
export function dispositionFor({ approved, checksJson, landed = false, ageMin = 0, graceMin = DEFAULT_GRACE_MIN }) {
  if (approved !== 1) return 'vetoed'
  if (isReceipt(checksJson)) return 'receipt'
  if (isPostApprovalRefusal(checksJson)) return 'refused_post_approval'
  if (landed) return 'ordered'
  if (ageMin < graceMin) return null      // still in flight — not yet terminal
  return 'dropped'
}

/**
 * Fill in every disposition that can be settled, and leave the rest alone.
 *
 * Idempotent: a row that already carries a disposition is skipped, so running
 * this every cycle costs one indexed scan and rewrites nothing. `redo` exists
 * for the backfill case where the derivation itself changed.
 */
export function sweepDispositions(db, { graceMin = DEFAULT_GRACE_MIN, limit = 5000, redo = false, nowMs = Date.now() } = {}) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT r.id, r.approved, r.checks_json, r.created_at, r.disposition,
             (SELECT COUNT(*) FROM trades t WHERE t.risk_event_id = r.id)
             + (SELECT COUNT(*) FROM pending_orders p WHERE p.risk_event_id = r.id) AS landed
        FROM risk_events r
       WHERE ${redo ? '1=1' : 'r.disposition IS NULL'}
       ORDER BY r.id DESC
       LIMIT ?
    `).all(limit)
  } catch { return { scanned: 0, written: 0, counts: {}, pending: 0 } }

  const write = db.prepare('UPDATE risk_events SET disposition = ?, disposition_at = ? WHERE id = ?')
  const counts = {}
  let written = 0
  let pending = 0
  const at = new Date(nowMs).toISOString()

  const apply = db.transaction(() => {
    for (const r of rows) {
      const ageMin = (nowMs - Date.parse(String(r.created_at).replace(' ', 'T') + 'Z')) / 60_000
      const d = dispositionFor({
        approved: r.approved,
        checksJson: r.checks_json,
        landed: (r.landed || 0) > 0,
        ageMin: Number.isFinite(ageMin) ? ageMin : Number.POSITIVE_INFINITY,
        graceMin,
      })
      if (d == null) { pending++; continue }
      if (d === r.disposition) continue
      write.run(d, at, r.id)
      counts[d] = (counts[d] || 0) + 1
      written++
    }
  })
  apply()

  return { scanned: rows.length, written, counts, pending }
}

/**
 * Sweep repeatedly until the backlog stops shrinking.
 *
 * ONE PASS IS NOT ENOUGH WHEN THERE IS A BACKLOG. `sweepDispositions` settles
 * at most `limit` rows, and housekeeping runs once every eight hours, so a
 * production backlog of 55,443 unsettled approvals would take four days to
 * drain at 5,000 a pass — during which `/state/dispositions` keeps answering
 * `counts {}` and the §70.8 finding stays invisible for the very rows it is
 * about. The work is one indexed scan and an UPDATE over rows that are already
 * written; there is no broker call and nothing to rate-limit.
 *
 * Bounded anyway. `maxBatches` caps the pass so a pathological table cannot
 * hold the loop, and the return says whether it stopped because the work was
 * done (`drained: true`) or because it hit the cap — a silent truncation would
 * read as "settled everything" when it settled a slice.
 */
export function drainDispositions(db, { maxBatches = 40, ...opts } = {}) {
  const counts = {}
  let scanned = 0, written = 0, pending = 0, batches = 0
  for (; batches < maxBatches; batches++) {
    const r = sweepDispositions(db, opts)
    scanned += r.scanned
    written += r.written
    pending = r.pending
    for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + v
    // Nothing settled this time: either the backlog is gone or everything left
    // is still inside its grace window. Either way another batch would repeat
    // the same query for the same answer.
    if (r.written === 0) { batches++; break }
  }
  return { scanned, written, counts, pending, batches, drained: batches < maxBatches }
}

/**
 * Approval → submit latency, the half §70.8 is actually named after.
 *
 * `trades.entry_latency_ms` times submit → execution event. Nothing timed the
 * gate's verdict → the order leaving, which is the interval an approval goes
 * quiet in. Recorded when the order is placed; read here.
 */
export function recordSubmitted(db, riskEventId, nowIso = new Date().toISOString()) {
  if (riskEventId == null) return false
  try {
    return db.prepare('UPDATE risk_events SET submitted_at = COALESCE(submitted_at, ?) WHERE id = ?')
      .run(nowIso, riskEventId).changes > 0
  } catch { return false }
}

/**
 * What happened to the approvals, over a window.
 *
 * @returns {{ window, counts, dropped: [], latency: {n, p50, p90, max}|null, pendingNow }}
 */
export function dispositionReport(db, { days = 7, account = null } = {}) {
  const d = Math.max(1, Math.min(90, Number(days) || 7))
  // `all` is the portfolio-wide read, not an account named "all". Without this
  // the filter became `account_id = 'all'`, matched nothing, and the route
  // answered `counts {}, pendingNow 0` — a confident, empty, WRONG report for
  // the one query an operator reaches for first. opportunityFunnel:44 already
  // spells it this way; this function did not, and the two are read side by
  // side on the same screen.
  const wanted = account == null || account === 'all' ? null : String(account)
  const acct = wanted != null ? 'AND (account_id = ? OR account_id IS NULL)' : ''
  const params = wanted != null ? [wanted] : []

  let rows = []
  try {
    rows = db.prepare(`
      SELECT id, symbol, side, approved, disposition, created_at, submitted_at, account_id
        FROM risk_events
       WHERE created_at >= datetime('now', '-${d} days') ${acct}
       ORDER BY id DESC
    `).all(...params)
  } catch { return { window: d, counts: {}, dropped: [], latency: null, pendingNow: 0 } }

  const counts = {}
  const dropped = []
  const lat = []
  let pendingNow = 0
  for (const r of rows) {
    // LATENCY FIRST, and outside the disposition branch. It used to sit after
    // the `pendingNow` continue below, which meant a row whose order had
    // demonstrably left the building contributed no timing until a sweep got
    // round to labelling it. How long the verdict took to reach the broker is
    // a fact about the row, not about whether its end state is settled yet —
    // and the in-flight rows are exactly the ones a latency question is
    // usually being asked about. Caught by the test on its first run.
    if (r.submitted_at && r.created_at) {
      const ms = Date.parse(String(r.submitted_at)) - Date.parse(String(r.created_at).replace(' ', 'T') + 'Z')
      if (Number.isFinite(ms) && ms >= 0) lat.push(ms)
    }
    if (r.disposition == null) { pendingNow++; continue }
    counts[r.disposition] = (counts[r.disposition] || 0) + 1
    if (r.disposition === 'dropped') dropped.push({ id: r.id, symbol: r.symbol, side: r.side, at: r.created_at, accountId: r.account_id })
  }
  lat.sort((a, b) => a - b)
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.max(0, Math.ceil(lat.length * p) - 1))] : null)

  return {
    window: d,
    account: account != null ? String(account) : null,
    counts,
    // Capped, and the cap announced — the same rule the veto breakdown learned.
    dropped: dropped.slice(0, 100),
    droppedTotal: dropped.length,
    droppedTruncated: dropped.length > 100 ? dropped.length - 100 : 0,
    latency: lat.length ? { n: lat.length, p50: pct(0.5), p90: pct(0.9), max: lat[lat.length - 1] } : null,
    // Not a failure: these are approvals still inside the grace window.
    pendingNow,
  }
}
