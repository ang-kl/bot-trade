// ---------------------------------------------------------------------------
// agent/services/arming-log.js — PR-S: who armed or disarmed this cell, and why.
//
// WHAT THIS EXISTS TO ANSWER. On 17-09-2026 the momentum book was reaching 2
// of 7 accounts; three accounts read `tsmom_long not armed`. The mechanism
// that would do that legitimately is `accountsWithOwnStreak`
// (adaptive-breaker.js), but it could not be CONFIRMED: the overlay cell is a
// bare boolean, the disarm line had rolled out of the log window, and the
// state routes answer 401. So the honest answer was "I cannot tell", and the
// question stayed open.
//
// That is this repo's recurring shape with the polarity reversed. Failure mode
// #3 is a guard that cannot fire; this is a guard that fired and left nothing
// behind. Either way the panel and the mechanism disagree, and the mechanism
// is the one that acted.
//
// WHAT IT RECORDS. `stage-matrix.js writeCell` is the single chokepoint for
// every per-account overlay write, and the global trade branch is the only
// other writer. Both now call `recordArmingChange`, which writes one row
// carrying the scope, the cell, the value it moved FROM and TO, the actor that
// moved it, and that actor's stated reason with its own figures.
//
// FOUR RULES, each of which a test pins:
//
//  1. ONLY REAL CHANGES ARE ROWS. The breaker and the boot seeds rewrite cells
//     they are not changing, every cycle and every boot. Recording those would
//     bury the four writes a year that matter under tens of thousands that do
//     not — the ledger would exist and be useless, which is worse than absent
//     because it looks like evidence. `from === to` writes nothing.
//
//  2. A HELD DECISION IS ALSO A REASON. "Why is this still armed" has the same
//     standing as "why is this off": an owner pin that blocked a disarm is
//     recorded as `held`, with the verdict it outvoted. Without it the ledger
//     answers only half the question, and the half it skips is the one that
//     keeps a losing strategy trading.
//
//  3. AN UNRECORDED CELL SAYS SO. Every cell written before this change has no
//     row, and `whyCell` returns `verdict: 'unrecorded'` for it — never a
//     guess, never the most plausible actor. CLAUDE.md §6: say which field is
//     wrong before saying anything about the data.
//
//  4. IT NEVER BLOCKS A WRITE. The same non-throwing contract as decision_log
//     and position_events: a ledger that can refuse an arming change is a
//     ledger that can stop the breaker from disarming a losing strategy. Every
//     write is wrapped; a failure is counted and reported through the view,
//     never raised.
// ---------------------------------------------------------------------------

/** Actors allowed to write a cell. An actor absent from this list is recorded verbatim and REPORTED — see `unknownActors` in the view. */
export const ARMING_ACTORS = Object.freeze([
  'adaptive_breaker',   // services/adaptive-breaker.js — pooled or own-scope loss verdict
  'edge_watchdog',      // services/edge-watchdog.js — alpha decay
  'strategy_autopilot', // services/strategy-autopilot.js — nightly backtest arming
  'boot_seed',          // seedStrategyPinsFromConfig and friends — the repo's declared pins
  'owner_route',        // POST /actions/stage-matrix, /actions/strategies — a human
  'migration',          // migrateTradeOverlay — a shape change, never an intent change
])

/** Cell values as the ledger stores them: a cell that was never written is 'unset', not 'false'. */
const asValue = (v) => (v === true ? 'true' : v === false ? 'false' : 'unset')

let writeFailures = 0

/**
 * Record one arming change. Returns the row id, `null` when the write was a
 * no-op (rule 1), or `null` when the insert failed (rule 4 — counted, not
 * thrown).
 *
 * `from` and `to` are the RAW cell values (true / false / undefined), not
 * strings: an absent cell and an explicitly-false cell are different facts and
 * the caller must not have to flatten them before the ledger sees them.
 */
export function recordArmingChange(db, { scope = null, kind, key, stage, from, to, actor, reason = null, evidence = null, decision = 'set' } = {}) {
  const fromV = asValue(from)
  const toV = asValue(to)
  // RULE 1. A rewrite that changes nothing is not a decision. `held` rows are
  // exempt: they record a decision NOT to change, which by definition has
  // from === to and is the whole point of rule 2.
  if (decision !== 'held' && fromV === toV) return null
  try {
    const r = db.prepare(`
      INSERT INTO arming_log (scope, kind, key, stage, from_value, to_value, decision, actor, reason, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope == null ? 'global' : String(scope),
      String(kind), String(key), String(stage),
      fromV, toV, String(decision),
      String(actor || 'unattributed'),
      reason == null ? null : String(reason),
      evidence == null ? null : JSON.stringify(evidence),
    )
    return Number(r.lastInsertRowid)
  } catch {
    // Rule 4: never let the ledger stop the arming change it is describing.
    writeFailures++
    return null
  }
}

/** Rows newest first, optionally narrowed. Pure read; never throws. */
export function armingHistory(db, { scope = undefined, kind = undefined, key = undefined, stage = undefined, limit = 200 } = {}) {
  const where = []
  const args = []
  if (scope !== undefined) { where.push('scope = ?'); args.push(scope == null ? 'global' : String(scope)) }
  if (kind !== undefined) { where.push('kind = ?'); args.push(String(kind)) }
  if (key !== undefined) { where.push('key = ?'); args.push(String(key)) }
  if (stage !== undefined) { where.push('stage = ?'); args.push(String(stage)) }
  const sql = `SELECT * FROM arming_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  try {
    return db.prepare(sql).all(...args, Math.max(1, Math.min(2000, Number(limit) || 200))).map(row)
  } catch { return [] }
}

function row(r) {
  let evidence = null
  try { evidence = r.evidence_json ? JSON.parse(r.evidence_json) : null } catch { evidence = { unparseable: r.evidence_json } }
  return {
    id: r.id, at: r.at, scope: r.scope, kind: r.kind, key: r.key, stage: r.stage,
    from: r.from_value, to: r.to_value, decision: r.decision, actor: r.actor,
    reason: r.reason, evidence,
  }
}

/**
 * Why is this cell in the state it is in?
 *
 * Returns the cell's CURRENT value as the caller reads it, the last row that
 * SET it (not the last row mentioning it — a `held` row explains why it did
 * not change, which is a different question and is returned separately), and a
 * verdict:
 *
 *   'recorded'   — a ledger row explains the current value
 *   'unrecorded' — no row does. Either the cell predates this ledger, or it
 *                  was written by a path that does not record. BOTH are
 *                  unknown, and the caller is told so rather than given the
 *                  nearest plausible row (rule 3).
 *   'disagrees'  — a row exists and its `to` does not match the value the
 *                  caller actually reads. That means something wrote the cell
 *                  without recording, and it is worth more than a shrug: it is
 *                  the ledger detecting its own blind spot.
 */
export function whyCell(db, { scope = null, kind = 'strategy', key, stage = 'trade', current = undefined } = {}) {
  const rows = armingHistory(db, { scope, kind, key, stage, limit: 50 })
  const lastSet = rows.find(r => r.decision !== 'held') || null
  const lastHeld = rows.find(r => r.decision === 'held') || null
  const cur = asValue(current)
  let verdict = 'unrecorded'
  if (lastSet) verdict = lastSet.to === cur || current === undefined ? 'recorded' : 'disagrees'
  return {
    scope: scope == null ? 'global' : String(scope), kind, key, stage,
    current: cur, verdict, lastSet, lastHeld,
    note: verdict === 'unrecorded'
      ? 'no ledger row explains this cell — it was written before the arming ledger existed, or by a path that does not record. This is not evidence that nobody changed it.'
      : verdict === 'disagrees'
        ? 'the cell does not hold the value the last recorded decision set — something wrote it without recording, and that writer is the defect to find'
        : null,
  }
}

/** GET /state/arming-log: the recent decisions, who made them, and the ledger's own health. */
export function armingLogView(db, { limit = 200, scope = undefined, key = undefined } = {}) {
  const recent = armingHistory(db, { limit, scope, key })
  const byActor = {}
  const unknownActors = []
  for (const r of recent) {
    byActor[r.actor] = (byActor[r.actor] || 0) + 1
    if (!ARMING_ACTORS.includes(r.actor) && !unknownActors.includes(r.actor)) unknownActors.push(r.actor)
  }
  let total = 0
  let oldest = null
  try {
    const agg = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM arming_log').get()
    total = Number(agg?.n || 0)
    oldest = agg?.oldest || null
  } catch { /* table absent — reported as 0 rows, never as "nothing happened" */ }
  return {
    recent, byActor, unknownActors, total, oldest, writeFailures,
    note: 'only writes that CHANGED a cell are rows, plus `held` rows where a pin blocked a disarm. A cell with no row is unexplained, not unchanged.',
  }
}

/** Test seam: the failure counter is process-wide, so a test that forces a failure must be able to reset it. */
export function _resetArmingWriteFailuresForTests() { writeFailures = 0 }
