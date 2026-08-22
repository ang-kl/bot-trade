#!/usr/bin/env node
// ---------------------------------------------------------------------------
// agent/scripts/backfill-trade-origin.mjs — give historical trades an origin,
// derived from evidence they already carry, reversibly.
//
//   node agent/scripts/backfill-trade-origin.mjs                 # DRY RUN
//   node agent/scripts/backfill-trade-origin.mjs --apply
//   node agent/scripts/backfill-trade-origin.mjs --rollback
//
// DRY RUN IS THE DEFAULT and `--apply` is the only way past it, because this
// writes to every historical trade row and a wrong derivation would launder
// adopted positions into the numbers that measure strategy edge.
//
// ROLLBACK IS TARGETED. Rows this script wrote carry `origin_source =
// 'backfill'`; rows the write paths stamped carry `'write'`. `--rollback`
// clears only the former, so undoing a backfill can never erase an origin that
// was recorded at the moment the trade was created.
//
// It never promotes a row into a clean bot origin on thin evidence — see
// deriveOrigin in lib/trade-origin.js. Rows it cannot establish become
// `legacy_unattributed`, which is a statement about the record, not a guess
// about the trade.
// ---------------------------------------------------------------------------

// The logic lives in services/origin-backfill.js so this script and
// POST /actions/backfill-trade-origin can never drift apart — two copies of a
// derivation that decides what counts as strategy edge is the defect this
// whole column exists to prevent.
import { initDB } from '../db.js'
import { runOriginBackfill } from '../services/origin-backfill.js'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const rollback = args.has('--rollback')
const dbPath = process.env.AGENT_DB || 'agent.db'

const db = initDB(dbPath)

const out = runOriginBackfill(db, { apply, rollback })

if (out.mode === 'rollback') {
  console.log(out.dryRun
    ? `DRY RUN — would clear origin on ${out.wouldClear} backfilled row(s); rows stamped at write time are untouched.\nRe-run with --rollback --apply to perform it.`
    : `Rolled back ${out.cleared} backfilled origin(s).`)
  process.exit(0)
}

console.log(`${out.rows} trade(s) without an origin.`)
for (const [k, v] of Object.entries(out.counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`)

if (out.dryRun) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to write these, and')
  console.log('--rollback --apply to undo it afterwards (backfilled rows only).')
  process.exit(0)
}

console.log(`\nWrote ${out.written} origin(s), all marked origin_source='backfill'.`)
