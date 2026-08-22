// ---------------------------------------------------------------------------
// agent/services/origin-backfill.js — the origin backfill, reachable.
//
// WHY THIS FILE EXISTS AND WHAT IT IS NOT. The derivation, the reversibility
// and the dry-run default are all `scripts/backfill-trade-origin.mjs`'s work
// and are unchanged here. What was missing is the only thing that mattered:
// A WAY TO RUN IT. The script needs a shell on the Railway container, so in
// practice nobody ever has — and the column has therefore stayed null on 93%
// of trades since the day it was added.
//
// MEASURED, 22-08-2026. `GET /state/exit-counterfactual` returns
// `INSUFFICIENT`: 81 trades considered, **5 eligible**, `not_clean_origin: 76`.
// That endpoint is the instrument for "would a different exit rule have done
// better" — the one question left open once the broker's own deal history
// confirmed that 73 of 74 broker-side closes landed nowhere near their stop or
// their target. It is starved by a single unpopulated column, and the repair
// for that column has existed the whole time behind a shell nobody opens.
//
// Same shape as CLAUDE.md's failure mode #4, and the same sentence applies:
// a repair nobody can reach is not a cautious repair, it is a dead one.
//
// THE WRITE PATHS ARE FINE — this is history only. Every one of the five
// INSERT sites stamps `origin` at creation, and trades from 17-08 onward all
// carry it. The nulls are rows that predate the column, which is exactly the
// case a backfill is for and exactly the case a write path can never fix.
// ---------------------------------------------------------------------------

import { deriveOrigin } from '../lib/trade-origin.js'

/**
 * What would a backfill write? Pure read — no mutation, ever.
 *
 * @returns {{rows:number, counts:Record<string,number>, plan:Array<{id:number, origin:string}>}}
 */
export function planOriginBackfill(db) {
  const rows = db.prepare(`
    SELECT t.id, t.source, t.risk_event_id, mp.thesis
      FROM trades t
      LEFT JOIN monitored_positions mp ON mp.trade_id = t.id
     WHERE t.origin IS NULL
  `).all()
  const counts = {}
  const plan = rows.map(r => {
    const origin = deriveOrigin(r)
    counts[origin] = (counts[origin] || 0) + 1
    return { id: r.id, origin }
  })
  return { rows: rows.length, counts, plan }
}

/**
 * Apply the plan. Every row written is stamped `origin_source = 'backfill'`,
 * which is what makes the rollback targeted.
 *
 * `AND origin IS NULL` is repeated in the UPDATE on purpose: the plan is built
 * outside the transaction, so a write path stamping a row in between must win.
 * A backfill overwriting an origin recorded at creation is the one outcome
 * this must never produce.
 */
export function applyOriginBackfill(db, plan) {
  const stmt = db.prepare("UPDATE trades SET origin = ?, origin_source = 'backfill' WHERE id = ? AND origin IS NULL")
  let written = 0
  db.transaction(() => {
    for (const p of plan) written += stmt.run(p.origin, p.id).changes
  })()
  return written
}

/**
 * Undo a backfill. Clears ONLY rows this wrote (`origin_source = 'backfill'`);
 * an origin stamped at write time is never touched.
 */
export function rollbackOriginBackfill(db, { apply = false } = {}) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE origin_source = 'backfill'").get().n
  if (!apply) return { dryRun: true, wouldClear: n, cleared: 0 }
  const r = db.prepare("UPDATE trades SET origin = NULL, origin_source = NULL WHERE origin_source = 'backfill'").run()
  return { dryRun: false, wouldClear: n, cleared: r.changes }
}

/**
 * One entry point for the route and the script.
 *
 * DRY RUN IS THE DEFAULT and `apply: true` is the only way past it — this
 * writes to every historical trade row, and a wrong derivation would launder
 * adopted positions into the numbers that measure strategy edge.
 */
export function runOriginBackfill(db, { apply = false, rollback = false } = {}) {
  if (rollback) return { mode: 'rollback', ...rollbackOriginBackfill(db, { apply }) }
  const { rows, counts, plan } = planOriginBackfill(db)
  if (!apply) return { mode: 'plan', dryRun: true, rows, counts, written: 0 }
  return { mode: 'apply', dryRun: false, rows, counts, written: applyOriginBackfill(db, plan) }
}
