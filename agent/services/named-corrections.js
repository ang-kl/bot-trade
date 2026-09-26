// ---------------------------------------------------------------------------
// agent/services/named-corrections.js — B2b + UI-5 (docs/v3-integrated-plan-
// 2026-09-26.md §5 row 2.6, §6 OD-11/OD-12).
//
// OD-11 SCOPE, NARROWED (checker fix round, N4). OD-11's owner-approved text
// is "A history with no deals reads never_filled. An account is written onto
// a row only from broker evidence." This module implements only the SECOND
// half: a non-terminal trade row whose broker-lifecycle evidence
// (position-lifecycle-evidence.js) is ALREADY a FINAL `never_filled` verdict
// is rejected — status only, never deleted, only from evidence joined on the
// row's OWN account and position, never inferred. It does NOT implement the
// first half (changing `classifyPositionHistory`'s zero-deal answer from
// `empty_at_broker` to `never_filled` — position-lifecycle-evidence.js:128,
// pinned by its own tests at :83, :247, :364). That is a change to an
// existing, separately-tested verdict and needs its own review; it is named
// here as a FOLLOW-UP, not claimed done. OD-11 is therefore NOT complete
// after this PR — only the rejection half is.
//
// OD-12 (named corrections, owner yes 26-09-2026): "dry run first, then a
// named apply, with nothing deleted." Covers the money fixes named in
// H-P5b-1, the never-filled rejections above, the 28 wrong-unit trade plans
// and the 7 mislabelled PRE rows (D5, §4's PRE/PO-7 note). This module is
// the ONE dry-run/apply engine both use, in the same shape as the repo's
// existing origin-backfill.js: DRY RUN IS THE DEFAULT and `apply: true` is
// the only way past it.
//
// THE RE-STAMP FIX (UI-5, tied to B2b — docs/v3-integrated-plan-2026-09-26.md
// §3: "UI-5's re-stamp fix edits the same path (pnl-backfill.js:1013-1017)").
// pnl-backfill.js's own restampPosition() re-stamps EVERY closed row sharing
// a position id — right for a fresh money landing (there is normally one),
// wrong for a NAMED correction to one specific row, which must not restamp a
// duplicate sibling that was not the one corrected (the same single-row
// principle pnl-backfill.js:1013-1017 already applies to `noteTradeAttempts`:
// "a position the ledger holds twice must not stamp the sibling that was not
// the one asked about", V3 I1). So every correction here re-stamps by TRADE
// ID only (stampRealisedAudit(db, id)), never by position.
//
// ABSOLUTE ONLY (checker fix round, BLOCKER 1). A `delta` mode was tried and
// removed: it always read net_pnl FRESH and added to it, so applying the same
// named list twice moved the money twice (reproduced: a second apply on #1253
// moved it to 1873). A named correction is evidence of what a row's value WAS
// at one point — the broker lifecycle net measured once — so every entry
// carries BOTH `expectedOld` and `value`, and a write only ever happens when
// the row's current value still equals `expectedOld`. Applying the same list
// any number of times writes the row once and skips it as stale every time
// after — see the idempotence test.
//
// THE AUDIT TRAIL. A dry-run call still reaches `POST /actions/named-
// corrections`, and index.js's `/actions` middleware logs EVERY POST there —
// one `action_log` row (method, path, redacted body) per call, unconditionally,
// before this module runs at all. That row is the only thing a dry run writes;
// this module itself writes nothing until `apply: true`, and even then writes
// only the `NAMED_CORRECTION_APPLY` row below when something was actually
// applied.
//
// WHAT THIS NEVER DOES: compute or guess a P&L figure, delete a row, or
// write anything without an explicit `apply: true`. A correction whose
// current value no longer matches what it was named against is SKIPPED, not
// forced.
// ---------------------------------------------------------------------------

import { stampRealisedAudit } from './trade-consistency.js'
import { EVIDENCE_RULES } from './position-lifecycle-evidence.js'

const r2 = v => Math.round(Number(v) * 100) / 100

/**
 * OD-11: which statuses are still "not yet done" and therefore eligible to be
 * rejected on never_filled evidence. Never `closed` (money already landed —
 * a closed-and-priced row is B5's money-correction territory, not a write-off)
 * and never `rejected`/`cancelled` (already terminal).
 */
export const NEVER_FILLED_REJECT_STATUSES = Object.freeze(['open', 'submitting', 'unconfirmed'])

/**
 * PURE READ. Rows this ledger still holds non-terminal whose broker lifecycle
 * evidence (position-lifecycle-evidence.js) is a FINAL `never_filled` verdict,
 * UNDER THE CURRENT RULES (`e.rules = EVIDENCE_RULES` — checker N5, the same
 * finality principle position-lifecycle-evidence.js's own B2 checker N3
 * applies: a verdict stored under an OLDER rules version is due a re-read, not
 * trusted as final), for the SAME account and position — "an account is
 * written onto a row only from broker evidence" (OD-11): the join is on both
 * `account_id` and `position_id`, never inferred.
 */
export function neverFilledRejectionCandidates(db) {
  const placeholders = NEVER_FILLED_REJECT_STATUSES.map(() => '?').join(',')
  return db.prepare(`
    SELECT t.id, t.account_id AS accountId, t.symbol, t.status AS oldStatus,
           CAST(CAST(t.ctrader_position_id AS INTEGER) AS TEXT) AS positionId,
           e.reason AS evidence, e.read_at AS evidenceAt
      FROM trades t
      JOIN position_lifecycle_evidence e
        ON e.account_id = t.account_id
       AND e.position_id = CAST(CAST(t.ctrader_position_id AS INTEGER) AS TEXT)
     WHERE t.status IN (${placeholders})
       AND t.ctrader_position_id IS NOT NULL
       AND CAST(t.ctrader_position_id AS INTEGER) > 0
       AND e.verdict = 'never_filled'
       AND e.final = 1
       AND e.rules = ?
     ORDER BY t.id
  `).all(...NEVER_FILLED_REJECT_STATUSES, EVIDENCE_RULES)
}

/** The dry-run rows for the never-filled rejections, in the one common shape
 * every named correction reports in: id, field, old -> new, evidence. */
export function planNeverFilledRejections(db) {
  return neverFilledRejectionCandidates(db).map(c => ({
    id: c.id,
    table: 'trades',
    field: 'status',
    old: c.oldStatus,
    new: 'rejected',
    evidence: `position ${c.positionId} on account ${c.accountId}: broker verdict never_filled — ${c.evidence}`,
  }))
}

/**
 * Reject the rows OD-11's rule covers. Re-reads each candidate's current
 * status at write time and only rejects if it still matches what the plan
 * saw (a race — the row closing or filling in the meantime — must win over
 * this write). Never deletes; the row, its close reason and any postmortems
 * stay, same as pnl-backfill.js's own false-close rejection.
 */
export function applyNeverFilledRejections(db) {
  const candidates = neverFilledRejectionCandidates(db)
  const stmt = db.prepare(
    `UPDATE trades SET status = 'rejected', close_reason = COALESCE(close_reason, '') || ?
      WHERE id = ? AND status = ?`
  )
  const applied = [], skipped = []
  db.transaction(() => {
    for (const c of candidates) {
      const note = ` | OD-11 write-off: broker evidence never_filled (position ${c.positionId}, account ${c.accountId}): ${c.evidence}`.slice(0, 900)
      const res = stmt.run(note, c.id, c.oldStatus)
      if (res.changes) applied.push({ id: c.id, accountId: c.accountId, positionId: c.positionId })
      else skipped.push({ id: c.id, reason: 'status changed since the plan was read' })
    }
  })()
  return { applied, skipped }
}

// ---------------------------------------------------------------------------
// OD-12's named money corrections (H-P5b-1, checker-confirmed against
// production — every `expectedOld` below is the value the checker read live,
// all five rows `closed`).
//
// ABSOLUTE ONLY (see the module doc — BLOCKER 1). Each entry writes `value`
// ONLY when net_pnl still equals `expectedOld`; applying twice writes once,
// then skips (idempotence test below).
//
// #47's entry was REMOVED (checker BLOCKER 2): the −196.35 named against it
// was a REPORT bug in trade-integrity.js's duplicate-group display (already
// fixed in B2, not a ledger-row defect) — production holds #47 at its own
// −59.73 and #46 at −196.35, so #47 needed no correction at all.
//
// STILL NAMED, NOT YET VALUED. H-P5b-1 also names the pairs #1309/#1310 and
// #309/#310 as needing correction (#310, on #309's position, is rejected —
// not corrected — at 351 per the checker, so it is not a money-correction
// target here); #1309/#1310 has no concrete old/new values in anything read
// for this build. D5/§4 name 28 wrong-unit trade plans and 7 PRE rows
// mislabelled `external`, likewise with counts but no row-level values.
// Inventing any of these would be exactly the failure CLAUDE.md's
// recurring-failure-mode #6 (say which field is wrong before saying the data
// is corrupt) warns against. `namedList` is the extension point: the owner's
// exact evidence for those, once named, runs through the same dry-run/apply
// path below unchanged.
// ---------------------------------------------------------------------------
export const NAMED_MONEY_CORRECTIONS = Object.freeze([
  { id: 1253, table: 'trades', field: 'net_pnl', expectedOld: 864, value: 1368.5, evidence: 'H-P5b-1: checker-confirmed broker lifecycle net for #1253 (closed)' },
  { id: 714, table: 'trades', field: 'net_pnl', expectedOld: 2.91, value: 202.71, evidence: 'H-P5b-1: checker-confirmed broker lifecycle net for #714 (closed)' },
  { id: 471, table: 'trades', field: 'net_pnl', expectedOld: 70, value: 37.5, evidence: 'H-P5b-1: checker-confirmed broker lifecycle net for #471 (closed)' },
  { id: 466, table: 'trades', field: 'net_pnl', expectedOld: 115.8, value: 39.3, evidence: 'H-P5b-1: checker-confirmed broker lifecycle net for #466 (closed)' },
  { id: 309, table: 'trades', field: 'net_pnl', expectedOld: 435.5, value: 351, evidence: 'H-P5b-1: checker-confirmed broker lifecycle net for #309 (closed); #310 on the same position is rejected, not corrected' },
])

const FIELD_ALLOWLIST = Object.freeze(['net_pnl'])
const TOLERANCE = 0.01

/**
 * PURE READ for one correction entry against the row's CURRENT value.
 * `stale: true` means the row no longer matches what the evidence was
 * captured against (already applied, or moved since) — reported, never
 * silently applied.
 */
function planOne(db, entry) {
  if (entry.table !== 'trades' || !FIELD_ALLOWLIST.includes(entry.field)) {
    return { id: entry.id, table: entry.table, field: entry.field, old: null, new: null, evidence: entry.evidence, stale: true, reason: 'field not in the named-correction allowlist' }
  }
  const row = db.prepare(`SELECT id, status, ${entry.field} AS current FROM trades WHERE id = ?`).get(entry.id)
  if (!row) return { id: entry.id, table: entry.table, field: entry.field, old: null, new: null, evidence: entry.evidence, stale: true, reason: 'row not found' }
  if (row.status !== 'closed') {
    return { id: entry.id, table: entry.table, field: entry.field, old: row.current, new: null, evidence: entry.evidence, stale: true, reason: `row status is ${row.status}, not closed` }
  }
  const current = row.current == null ? null : Number(row.current)
  const matches = current != null && Math.abs(current - Number(entry.expectedOld)) <= TOLERANCE
  return { id: entry.id, table: entry.table, field: entry.field, old: current, new: r2(entry.value), evidence: entry.evidence, stale: !matches,
    ...(matches ? {} : { reason: `current ${current} does not match the named expectedOld ${entry.expectedOld}` }) }
}

/** Dry run: every named correction, its current value, what it would become,
 * and whether it is stale (and so would be skipped by apply). Writes nothing. */
export function planNamedCorrections(db, { namedList = NAMED_MONEY_CORRECTIONS } = {}) {
  return namedList.map(entry => planOne(db, entry))
}

/**
 * Apply the named money corrections. `plan`, if given, is used AS-IS instead
 * of being recomputed — the extension point for testing (and for any caller
 * that wants to read the plan, let time pass, then apply exactly what it
 * read) — the WRITE-TIME check below is what makes that safe: the UPDATE's
 * `AND net_pnl = ?` guard re-reads the row inside the write itself, so a row
 * that changed after `plan` was computed (whether recomputed fresh a moment
 * ago, or read long before and handed in stale) is skipped, never
 * overwritten out from under a race. Re-stamps ONLY the corrected row (never
 * the whole position — the re-stamp fix, see the module doc) so a duplicate
 * sibling is left untouched.
 */
export function applyNamedMoneyCorrections(db, { namedList = NAMED_MONEY_CORRECTIONS, plan = null } = {}) {
  const plans = plan ?? planNamedCorrections(db, { namedList })
  const applied = [], skipped = []
  const stmt = db.prepare(`UPDATE trades SET net_pnl = ? WHERE id = ? AND status = 'closed' AND net_pnl = ?`)
  db.transaction(() => {
    for (const p of plans) {
      if (p.stale) { skipped.push({ id: p.id, field: p.field, reason: p.reason }); continue }
      const res = stmt.run(p.new, p.id, p.old)
      if (res.changes) {
        applied.push({ id: p.id, field: p.field, old: p.old, new: p.new, evidence: p.evidence })
        stampRealisedAudit(db, p.id)
      } else {
        skipped.push({ id: p.id, field: p.field, reason: 'row changed between the plan read and the write' })
      }
    }
  })()
  try {
    if (applied.length) {
      db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run('NAMED_CORRECTION_APPLY', '/named-corrections', JSON.stringify({
        applied: applied.length, skipped: skipped.length, ids: applied.map(a => a.id),
        note: 'OD-12 named apply (owner 26-09-2026): dry run first, named list only, nothing deleted',
      }).slice(0, 2000))
    }
  } catch { /* audit best-effort, never blocks the write it is logging */ }
  return { applied, skipped }
}

/**
 * ONE entry point for the route and any script, same shape as
 * origin-backfill.js's runOriginBackfill: DRY RUN IS THE DEFAULT and
 * `apply: true` is the only way past it. Every call — dry run included —
 * still lands ONE `action_log` row through index.js's `/actions` request
 * middleware (see the module doc); this function itself writes nothing on a
 * dry run.
 *
 * @param {boolean} opts.apply
 * @param {boolean} opts.includeNeverFilled OD-11's write-off rejections
 * @param {boolean} opts.includeMoney OD-12's named money corrections
 * @param {Array} opts.namedList override the built-in money-correction list
 *   (the extension point for the 28 plans / 7 PRE labels once the owner
 *   names their exact values)
 */
export function runNamedCorrections(db, { apply = false, includeNeverFilled = true, includeMoney = true, namedList = NAMED_MONEY_CORRECTIONS } = {}) {
  const neverFilledPlan = includeNeverFilled ? planNeverFilledRejections(db) : []
  const moneyPlan = includeMoney ? planNamedCorrections(db, { namedList }) : []
  if (!apply) {
    return {
      mode: 'plan', dryRun: true,
      neverFilled: { found: neverFilledPlan.length, rows: neverFilledPlan },
      money: { found: moneyPlan.length, stale: moneyPlan.filter(p => p.stale).length, rows: moneyPlan },
    }
  }
  const neverFilledResult = includeNeverFilled ? applyNeverFilledRejections(db) : { applied: [], skipped: [] }
  const moneyResult = includeMoney ? applyNamedMoneyCorrections(db, { namedList }) : { applied: [], skipped: [] }
  return {
    mode: 'apply', dryRun: false,
    neverFilled: { applied: neverFilledResult.applied.length, skipped: neverFilledResult.skipped.length, rows: neverFilledResult.applied, skippedRows: neverFilledResult.skipped },
    money: { applied: moneyResult.applied.length, skipped: moneyResult.skipped.length, rows: moneyResult.applied, skippedRows: moneyResult.skipped },
  }
}
