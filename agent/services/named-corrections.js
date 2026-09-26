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
// NAMED, NOT RECOMPUTED (checker N-b). The rejection half's apply does not
// call `neverFilledRejectionCandidates` and act on whatever it finds live —
// that could reject a row the dry run never showed the operator, if evidence
// for it landed in the gap between the dry run and the apply call. Apply
// takes the exact `id`s the dry run reported (`neverFilledIds`) and acts on
// their intersection with the current candidates; it REFUSES outright if no
// ids are passed. See `applyNeverFilledRejections`.
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
 * Reject the rows OD-11's rule covers — but ONLY the ones NAMED by `ids`
 * (checker N-b). `neverFilledRejectionCandidates` re-reads live, so calling
 * it fresh inside apply could reject a row the dry run never showed the
 * operator — a row that became a candidate in the gap between the dry run
 * and the apply call. `ids` is the plan the operator actually saw (the
 * `id`s from `planNeverFilledRejections`'s dry-run output); apply acts on
 * the INTERSECTION of that list and the current candidates, so a row that
 * appeared after the dry run — even a genuine never_filled one — is left
 * alone until it is named in its own dry run.
 *
 * REFUSED, not silently a no-op, when `ids` is missing or empty: an apply
 * that names nothing is not a named apply (OD-12's own rule).
 *
 * Re-reads each named candidate's current status at write time and only
 * rejects if it still matches what the plan saw (a race — the row closing
 * or filling in the meantime — must win over this write). Never deletes;
 * the row, its close reason and any postmortems stay, same as
 * pnl-backfill.js's own false-close rejection.
 *
 * @param {number[]} opts.ids the exact trade ids the caller's dry run named
 */
export function applyNeverFilledRejections(db, { ids } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { applied: [], skipped: [], refused: true, reason: 'no ids passed — the apply must name the exact rows its dry run showed' }
  }
  const named = new Set(ids.map(Number))
  const candidates = neverFilledRejectionCandidates(db).filter(c => named.has(Number(c.id)))
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
// EVIDENCE IS THE DEAL BREAKDOWN, WHERE IT EXISTS (checker N-a) — the same
// shape deal-money.js's own comment uses for #714: "local 2.91 against three
// broker deals 100.27 + 99.53 + 2.91 = 202.71". Not invented — read from the
// broker's own deal history for the position each row is on, one
// account-scoped read per account (N7, checker fix round — durable
// description in place of a scratchpad path, which names a file this build
// wrote to and later cleaned up, not a source anyone else can re-open):
//   - account 46130058, read 25-09-2026 (positions 237140621 for #1253,
//     234867098 for #714, 234697676 for #471, 234697562 for #466)
//   - account 47790949, read 25-09-2026; its deals were imported 11-08-2026
//     (position 233866238, matched to
//     both #309 and #310)
// The account and read date are also in each entry's `evidence` string below
// (item 3, checker fix round #2 — not only up here); the per-deal figures
// are there too, but NOT the deal ids themselves (corrected from an earlier,
// false claim in this comment that they were — they are not, only the
// position id and the deals' money figures are).
//
// #309/#310 (checker N-c, reworded): #309's own broker lifecycle sums to
// 351 (its −84.5 deal plus #310's 435.5 deal — both matched_trade_id 310 in
// the deal dump, i.e. the broker holds ONE position that this ledger split
// across two rows). #309 is the correction target (435.5 -> 351); #310
// itself is NOT corrected here — it stays rejected as the duplicate.
// ---------------------------------------------------------------------------
export const NAMED_MONEY_CORRECTIONS = Object.freeze([
  { id: 1253, table: 'trades', field: 'net_pnl', expectedOld: 864, value: 1368.5, evidence: 'H-P5b-1: local 864 against two broker deals (account 46130058, position 237140621, read 25-09-2026) 504.5 + 864 = 1368.5' },
  { id: 714, table: 'trades', field: 'net_pnl', expectedOld: 2.91, value: 202.71, evidence: 'H-P5b-1: local 2.91 against three broker deals (account 46130058, position 234867098, read 25-09-2026) 100.27 + 99.53 + 2.91 = 202.71 (deal-money.js)' },
  { id: 471, table: 'trades', field: 'net_pnl', expectedOld: 70, value: 37.5, evidence: 'H-P5b-1: local 70 against two broker deals (account 46130058, position 234697676, read 25-09-2026) 70 + -32.5 = 37.5' },
  { id: 466, table: 'trades', field: 'net_pnl', expectedOld: 115.8, value: 39.3, evidence: 'H-P5b-1: local 115.8 against three broker deals (account 46130058, position 234697562, read 25-09-2026) 75 + 40.8 + -76.5 = 39.3' },
  { id: 309, table: 'trades', field: 'net_pnl', expectedOld: 435.5, value: 351, evidence: 'H-P5b-1: local 435.5 against two broker deals (account 47790949, position 233866238, read 25-09-2026, deals imported 11-08-2026, both matched to trade #310) -84.5 + 435.5 = 351. #309 is the corrected row; #310 on the same position stays rejected, not corrected' },
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
 * @param {number[]} opts.neverFilledIds REQUIRED to apply the never-filled
 *   rejections (checker N-b): the exact `id`s a prior dry run's
 *   `neverFilled.rows` showed. Apply acts on the intersection of these ids
 *   and the current candidates; a row that became a candidate after that
 *   dry run is left alone. Ignored on a dry run.
 */
export function runNamedCorrections(db, { apply = false, includeNeverFilled = true, includeMoney = true, namedList = NAMED_MONEY_CORRECTIONS, neverFilledIds } = {}) {
  const neverFilledPlan = includeNeverFilled ? planNeverFilledRejections(db) : []
  const moneyPlan = includeMoney ? planNamedCorrections(db, { namedList }) : []
  if (!apply) {
    return {
      mode: 'plan', dryRun: true,
      neverFilled: { found: neverFilledPlan.length, rows: neverFilledPlan },
      money: { found: moneyPlan.length, stale: moneyPlan.filter(p => p.stale).length, rows: moneyPlan },
    }
  }
  const neverFilledResult = includeNeverFilled ? applyNeverFilledRejections(db, { ids: neverFilledIds }) : { applied: [], skipped: [] }
  const moneyResult = includeMoney ? applyNamedMoneyCorrections(db, { namedList }) : { applied: [], skipped: [] }
  return {
    mode: 'apply', dryRun: false,
    neverFilled: { applied: neverFilledResult.applied.length, skipped: neverFilledResult.skipped.length, rows: neverFilledResult.applied, skippedRows: neverFilledResult.skipped, ...(neverFilledResult.refused ? { refused: true, reason: neverFilledResult.reason } : {}) },
    money: { applied: moneyResult.applied.length, skipped: moneyResult.skipped.length, rows: moneyResult.applied, skippedRows: moneyResult.skipped },
  }
}
