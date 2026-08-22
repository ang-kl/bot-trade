// node --test agent/services/origin-backfill.test.js
//
// MEASURED IN PRODUCTION, 22-08-2026, and this file exists because of the
// measurement rather than the code. `GET /state/exit-counterfactual`:
//
//   verdict INSUFFICIENT · considered 81 · eligible 5 · not_clean_origin 76
//
// The endpoint built to answer "would a different exit rule have done better"
// — the only question left open once the broker's own deal history confirmed
// that 73 of 74 broker-side closes landed nowhere near their stop or target —
// is starved by ONE null column. The repair for that column has existed since
// the column did, in a script that needs a shell nobody opens.
//
// So the tests below are mostly about the SAFETY of running it, not about the
// derivation (which lib/trade-origin.js already tests): dry-run must be the
// default, a write path's origin must survive, and the rollback must not reach
// past what the backfill wrote.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { planOriginBackfill, runOriginBackfill } from './origin-backfill.js'

function db0() {
  const db = initDB(':memory:')
  const ins = db.prepare(
    "INSERT INTO trades (id, symbol, side, status, source, risk_event_id, origin, origin_source) VALUES (?,?,?,?,?,?,?,?)")
  // id, source, risk_event_id, origin, origin_source
  ins.run(1, 'EURUSD', 'long', 'closed', 'autotrade', 11, null, null)        // → bot_market_dispatch
  ins.run(2, 'GBPUSD', 'long', 'closed', 'autotrade', null, null, null)      // → legacy_unattributed
  ins.run(3, 'USDJPY', 'long', 'closed', 'reconciler', null, null, null)     // → reconciler_adopted
  ins.run(4, 'AUDUSD', 'long', 'closed', 'manual', null, null, null)         // → manual_broker
  ins.run(5, 'NZDUSD', 'long', 'closed', 'pending', null, null, null)        // → bot_pending_fill
  ins.run(6, 'USDCAD', 'long', 'closed', 'autotrade', 12, 'bot_market_dispatch', 'write') // already stamped
  return db
}
const originOf = (db, id) => db.prepare('SELECT origin, origin_source FROM trades WHERE id = ?').get(id)

test('DRY RUN IS THE DEFAULT — the plan is returned and NOTHING is written', () => {
  const db = db0()
  const out = runOriginBackfill(db)
  assert.equal(out.dryRun, true)
  assert.equal(out.written, 0)
  assert.equal(out.rows, 5, 'the already-stamped row is not in the plan')
  for (const id of [1, 2, 3, 4, 5]) assert.equal(originOf(db, id).origin, null, `row ${id} was written on a dry run`)
})

test('the plan names what each row would become', () => {
  const p = planOriginBackfill(db0())
  const byId = new Map(p.plan.map(x => [x.id, x.origin]))
  assert.equal(byId.get(1), 'bot_market_dispatch')
  assert.equal(byId.get(2), 'legacy_unattributed', 'autotrade with no decision record is NOT promoted to clean')
  assert.equal(byId.get(3), 'reconciler_adopted')
  assert.equal(byId.get(4), 'manual_broker')
  assert.equal(byId.get(5), 'bot_pending_fill')
})

test('apply writes, and stamps every row it wrote as backfill', () => {
  const db = db0()
  const out = runOriginBackfill(db, { apply: true })
  assert.equal(out.written, 5, JSON.stringify(out))
  assert.equal(originOf(db, 1).origin, 'bot_market_dispatch')
  assert.equal(originOf(db, 1).origin_source, 'backfill')
})

test('AN ORIGIN STAMPED AT WRITE TIME IS NEVER TOUCHED', () => {
  // The one outcome this must never produce. A backfill overwriting a
  // creation-time origin would launder an adopted position into the numbers
  // that measure strategy edge — the exact defect the column exists to stop.
  const db = db0()
  runOriginBackfill(db, { apply: true })
  assert.deepEqual(originOf(db, 6), { origin: 'bot_market_dispatch', origin_source: 'write' })
})

test('rollback clears ONLY backfilled rows, and dry-runs by default', () => {
  const db = db0()
  runOriginBackfill(db, { apply: true })

  const dry = runOriginBackfill(db, { rollback: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.wouldClear, 5)
  assert.equal(originOf(db, 1).origin, 'bot_market_dispatch', 'a dry-run rollback cleared a row')

  const out = runOriginBackfill(db, { rollback: true, apply: true })
  assert.equal(out.cleared, 5)
  assert.equal(originOf(db, 1).origin, null)
  assert.deepEqual(originOf(db, 6), { origin: 'bot_market_dispatch', origin_source: 'write' },
    'rollback reached past what the backfill wrote')
})

test('a second apply is a no-op — it is safe to run twice', () => {
  const db = db0()
  runOriginBackfill(db, { apply: true })
  assert.equal(runOriginBackfill(db, { apply: true }).written, 0)
})

test('an already-complete table plans nothing', () => {
  const db = db0()
  runOriginBackfill(db, { apply: true })
  assert.equal(planOriginBackfill(db).rows, 0)
})

test('THE UNBLOCK, end to end: clean origins become countable', () => {
  // exit-counterfactual keeps only CLEAN_BOT_ORIGINS. Before the backfill it
  // can see one row here; after, three. That ratio is the whole point — in
  // production it is 5 of 81 becoming most of ~800.
  const db = db0()
  const clean = () => db.prepare(
    "SELECT COUNT(*) AS n FROM trades WHERE origin IN ('bot_market_dispatch','bot_pending_fill')").get().n
  assert.equal(clean(), 1)
  runOriginBackfill(db, { apply: true })
  assert.equal(clean(), 3)
})
