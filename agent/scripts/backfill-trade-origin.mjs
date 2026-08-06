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

import { initDB } from '../db.js'
import { deriveOrigin } from '../lib/trade-origin.js'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const rollback = args.has('--rollback')
const dbPath = process.env.AGENT_DB || 'agent.db'

const db = initDB(dbPath)

if (rollback) {
  const before = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE origin_source = 'backfill'").get().n
  if (!apply) {
    console.log(`DRY RUN — would clear origin on ${before} backfilled row(s); rows stamped at write time are untouched.`)
    console.log('Re-run with --rollback --apply to perform it.')
    process.exit(0)
  }
  const r = db.prepare("UPDATE trades SET origin = NULL, origin_source = NULL WHERE origin_source = 'backfill'").run()
  console.log(`Rolled back ${r.changes} backfilled origin(s).`)
  process.exit(0)
}

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

console.log(`${rows.length} trade(s) without an origin.`)
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`)

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to write these, and')
  console.log('--rollback --apply to undo it afterwards (backfilled rows only).')
  process.exit(0)
}

const stmt = db.prepare("UPDATE trades SET origin = ?, origin_source = 'backfill' WHERE id = ? AND origin IS NULL")
const write = db.transaction(() => { for (const p of plan) stmt.run(p.origin, p.id) })
write()
console.log(`\nWrote ${plan.length} origin(s), all marked origin_source='backfill'.`)
