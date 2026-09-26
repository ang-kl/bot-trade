// ---------------------------------------------------------------------------
// agent/services/named-corrections.js — B2b + UI-5 (docs/v3-integrated-plan-
// 2026-09-26.md §5 row 2.6, §6 OD-11/OD-12).
//
// OD-11 (write-off rule, owner yes 26-09-2026): "A history with no deals
// reads never_filled. An account is written onto a row only from broker
// evidence." This is the WRITE-OFF gate for a row this ledger still holds
// open/pending: if position-lifecycle-evidence.js has already returned a
// FINAL `never_filled` verdict for it (V3-SEQUENCE.md #13, B2: "the broker
// holds only rejected/internally-rejected/errored/missed deals for this
// position"), that is decidable NOW, from broker evidence, not after an age
// horizon and a backoff count (mark-unresolvable.js's 2026-07-30 "option 2"
// rule, which this reverses for exactly this case — see the module doc
// there). Rejecting the row (never deleting it) is B2b/B5's to do, on the
// owner's word (mark-unresolvable.js's own comment: "Rejecting such a row
// (status) is B2b/B5's, on the owner's word; this is the label only.").
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
// WHAT THIS NEVER DOES: compute or guess a P&L figure, delete a row, or
// write anything without an explicit `apply: true`. A correction whose
// current value no longer matches what it was named against is SKIPPED, not
// forced — the named list is evidence captured at one point in time, and a
// row that moved since (a fresh backfill, a race) must not be silently
// overwritten.
// ---------------------------------------------------------------------------

import { stampRealisedAudit } from './trade-consistency.js'

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
 * evidence (position-lifecycle-evidence.js) is a FINAL `never_filled` verdict
 * for the SAME account and position — "an account is written onto a row only
 * from broker evidence" (OD-11): the join is on both `account_id` and
 * `position_id`, never inferred.
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
     ORDER BY t.id
  `).all(...NEVER_FILLED_REJECT_STATUSES)
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
// OD-12's named money corrections (H-P5b-1, V3-SEQUENCE.md #13/#36).
//
// Each entry is EVIDENCE CAPTURED AT ONE POINT IN TIME, never a blind
// overwrite: `mode: 'delta'` adds `value` to whatever net_pnl holds now (the
// broker-lifecycle-net corrections #1253/#714/#471/#466/#309); `mode:
// 'absolute'` replaces net_pnl only if it still equals `expectedOld` (the
// duplicate-group pricing bug, trade-integrity.js:111 — USDCNH #47 priced at
// the DUPLICATE's -196.35 instead of its own -59.73).
//
// STILL NAMED, NOT YET VALUED. H-P5b-1 also names the pairs #1309/#1310 and
// #309/#310 as needing correction, and D5/§4 name 28 wrong-unit trade plans
// and 7 PRE rows mislabelled `external`, but no source read for this build
// gives their exact old/new values or row ids beyond the pair numbers
// themselves — inventing one would be exactly the failure CLAUDE.md's
// recurring-failure-mode #6 (say which field is wrong before saying the data
// is corrupt) warns against. `namedList` is the extension point: the owner's
// exact evidence for those, once named, runs through the same dry-run/apply
// path below unchanged.
// ---------------------------------------------------------------------------
export const NAMED_MONEY_CORRECTIONS = Object.freeze([
  { id: 1253, table: 'trades', field: 'net_pnl', mode: 'delta', value: 504.5, evidence: 'H-P5b-1: broker lifecycle net corrects #1253 by +504.5' },
  { id: 714, table: 'trades', field: 'net_pnl', mode: 'delta', value: 199.8, evidence: 'H-P5b-1: broker lifecycle net corrects #714 by +199.8' },
  { id: 471, table: 'trades', field: 'net_pnl', mode: 'delta', value: -32.5, evidence: 'H-P5b-1: broker lifecycle net corrects #471 by -32.5' },
  { id: 466, table: 'trades', field: 'net_pnl', mode: 'delta', value: -76.5, evidence: 'H-P5b-1: broker lifecycle net corrects #466 by -76.5' },
  { id: 309, table: 'trades', field: 'net_pnl', mode: 'delta', value: -84.5, evidence: 'H-P5b-1: broker lifecycle net corrects #309 by -84.5' },
  {
    id: 47, table: 'trades', field: 'net_pnl', mode: 'absolute', value: -59.73, expectedOld: -196.35,
    evidence: 'V3 B2 (P5b-2): duplicate group priced #47 at the OTHER row\'s net_pnl (-196.35); its own broker lifecycle net is -59.73 (USDCNH, trade-integrity.js:111)',
  },
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
  if (entry.mode === 'absolute') {
    const matches = current != null && Math.abs(current - Number(entry.expectedOld)) <= TOLERANCE
    return { id: entry.id, table: entry.table, field: entry.field, old: current, new: r2(entry.value), evidence: entry.evidence, stale: !matches,
      ...(matches ? {} : { reason: `current ${current} does not match the named expectedOld ${entry.expectedOld}` }) }
  }
  // delta
  if (current == null) return { id: entry.id, table: entry.table, field: entry.field, old: null, new: null, evidence: entry.evidence, stale: true, reason: 'net_pnl is NULL — nothing to correct a delta against' }
  return { id: entry.id, table: entry.table, field: entry.field, old: current, new: r2(current + Number(entry.value)), evidence: entry.evidence, stale: false }
}

/** Dry run: every named correction, its current value, what it would become,
 * and whether it is stale (and so would be skipped by apply). Writes nothing. */
export function planNamedCorrections(db, { namedList = NAMED_MONEY_CORRECTIONS } = {}) {
  return namedList.map(entry => planOne(db, entry))
}

/**
 * Apply the named money corrections. Re-checks each row against the SAME
 * rule planNamedCorrections used, inside the write itself (`WHERE ... AND
 * <field> = ?` on the value just read), so a row that changed between the
 * plan and the write is skipped, never overwritten out from under a race.
 * Re-stamps ONLY the corrected row (never the whole position — the re-stamp
 * fix, see the module doc) so a duplicate sibling is left untouched.
 */
export function applyNamedMoneyCorrections(db, { namedList = NAMED_MONEY_CORRECTIONS } = {}) {
  const plans = planNamedCorrections(db, { namedList })
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
 * `apply: true` is the only way past it.
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
