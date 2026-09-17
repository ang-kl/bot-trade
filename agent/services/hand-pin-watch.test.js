// PR-AA: what a hand pin is costing, while it costs it. The first test
// reproduces the state the owner created on 17-09-2026 — three accounts
// pinned to a strategy the watchdog had just scored exp -$108.48 / PF 0.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDB, getState, setState } from '../db.js'
import { setStage } from './stage-matrix.js'
import { handPinnedCells, handPinReport, handPinLine } from './hand-pin-watch.js'

const io = { getState, setState }
const PINNED = ['47790949', '46130058', '43097342']

function freshDb() {
  const db = initDB(join(mkdtempSync(join(tmpdir(), 'handpin-')), 'test.db'))
  setState(db, 'enabled_strategies_json', JSON.stringify(['tsmom_long', 'rsi2_reversion', 'vwap_trend']))
  return db
}
const addAccount = (db, id) => db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?, 0, 1)').run(id)

/** Closed trades on ONE account, newest last. */
function closes(db, accountId, strategy, pnls) {
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at, account_id)
     VALUES ('EURUSD','BUY','closed',?,?,?,?)`
  )
  pnls.forEach((p, i) => ins.run(strategy, p, `2026-09-1${Math.floor(i / 24) % 10} ${String(i % 24).padStart(2, '0')}:00:00`, accountId))
}

const pin = (db, id, key) =>
  setStage(db, { kind: 'strategy', key, stage: 'trade', on: true, accountId: id, actor: 'owner', reason: 'deliberate override of the watchdog verdict' }, io)

test('the measured 17-09 case: three accounts pinned, no own closes yet — reported as NOT YET JUDGEABLE', () => {
  const db = freshDb()
  for (const id of [...PINNED, '46979908']) addAccount(db, id)
  for (const id of PINNED) pin(db, id, 'tsmom_long')

  const cells = handPinnedCells(db)
  assert.deepEqual(cells.map(c => c.accountId).sort(), [...PINNED].sort())

  const r = handPinReport(db)
  assert.equal(r.total, 3)
  assert.equal(r.evidenceThin, 3, 'no own closes means no verdict is possible yet')
  assert.equal(r.wouldDisarmToday, 0)
  assert.equal(r.rows[0].distance.closesToJudgeable, 15, 'the full window still to go')

  const line = handPinLine(db)
  assert.match(line, /3 across 3 account\(s\)/)
  assert.match(line, /3 owner override\(s\)/, 'and says WHO pinned them, not just how many cells are true')
  assert.match(line, /not yet judgeable on edge/)
  assert.match(line, /exempt from the POOLED verdict, never from the account's own/,
    'the line states WHY the pin holds, so nobody reads silence as approval')
})

test('a pinned cell whose OWN record already satisfies the no-edge verdict says so', () => {
  const db = freshDb()
  addAccount(db, '47790949')
  pin(db, '47790949', 'tsmom_long')
  // 16 own closes, clearly losing: 4 small wins, 12 larger losses.
  closes(db, '47790949', 'tsmom_long', [5, 5, 5, 5, -20, -20, -20, -20, -20, -20, -20, -20, -20, -20, -20, -20])

  const r = handPinReport(db)
  assert.equal(r.total, 1)
  assert.equal(r.evidenceThin, 0)
  assert.equal(r.wouldDisarmToday, 1)
  assert.equal(r.rows[0].noEdge, true)
  assert.ok(r.rows[0].expectancy < 0)
  assert.ok(r.rows[0].profitFactor < 0.95)
  assert.match(handPinLine(db), /WOULD BE DISARMED NOW on its own no-edge verdict/)
})

test('a loss streak ends a pin even when the window is too short to judge an edge', () => {
  // The two predicates are independent: the breaker needs no minimum sample.
  // A module that reported only the edge side would call this cell healthy.
  const db = freshDb()
  addAccount(db, '46130058')
  pin(db, '46130058', 'tsmom_long')
  closes(db, '46130058', 'tsmom_long', [10, -5, -5, -5])

  const r = handPinReport(db)
  assert.equal(r.rows[0].judgeable, false, 'four closes cannot judge an edge')
  assert.equal(r.rows[0].streak, 3)
  assert.equal(r.rows[0].streakHit, true)
  assert.equal(r.rows[0].wouldDisarmToday, true, 'but the streak predicate is already met')
})

test('a pinned cell that is winning reports as holding, with the distance to the streak', () => {
  const db = freshDb()
  addAccount(db, '43097342')
  pin(db, '43097342', 'rsi2_reversion')
  closes(db, '43097342', 'rsi2_reversion', Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? -10 : 12)))

  const r = handPinReport(db)
  assert.equal(r.wouldDisarmToday, 0)
  assert.equal(r.losing, 0)
  assert.ok(r.rows[0].expectancy > 0)
  assert.match(handPinLine(db), /holding, 3 more loss\(es\) would end it on streak/)
})

test('an ABSENT cell is not a hand pin — it inherits the global list', () => {
  // Reporting inherited cells would bury the handful of real overrides under
  // every strategy on every account, which is how a report stops being read.
  const db = freshDb()
  addAccount(db, '47790949')
  assert.deepEqual(handPinnedCells(db), [])
  assert.equal(handPinLine(db), null, 'and silence is the answer "nothing is being held open"')
})

test('a cell explicitly turned OFF is not a hand pin either', () => {
  const db = freshDb()
  addAccount(db, '47790949')
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: '47790949', actor: 'edge_watchdog', reason: 'no edge' }, io)
  assert.deepEqual(handPinnedCells(db), [])
})

test('a pin on a DISABLED account is not reported — it cannot cost anything', () => {
  const db = freshDb()
  db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?, 0, 0)').run('47790949')
  pin(db, '47790949', 'tsmom_long')
  assert.equal(handPinnedCells(db).length, 1, 'the cell exists')
  assert.equal(handPinReport(db).total, 0, 'but a disabled account trades nothing')
})

test('the verdict uses the SAME windows as the actors that would disarm the pin', () => {
  // If these drifted apart, the line would report a distance to a threshold
  // nobody enforces — a guard measuring something other than what it guards.
  const db = freshDb()
  addAccount(db, '47790949')
  pin(db, '47790949', 'tsmom_long')
  const r = handPinReport(db)
  assert.equal(r.cfg.edge.minTrades, 15)
  assert.equal(r.cfg.edge.pfFloor, 0.95)
  assert.equal(r.cfg.edge.window, 20)
  assert.equal(r.cfg.breaker.streak, 3)
})

test('the loop reports hand pins on a per-cycle phase, not the 8-hourly housekeeping band', () => {
  // The PR-Y lesson, applied on the way in rather than after a read-back.
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const call = stripped.indexOf('handPinLine(db)')
  const band = stripped.indexOf('housekeepingDue(')
  assert.ok(call > 0, 'the loop calls handPinLine')
  assert.ok(call < band, 'and calls it BEFORE the housekeeping gate, so the hourly throttle is the real cadence')
})

test('THE INVARIANT: no cell counted as would-be-disarmed may print as not-yet-judgeable', () => {
  // THIS IS THE TEST THE FIRST VERSION NEEDED AND DID NOT HAVE.
  //
  // Shipped 17-09 and measured in production the same hour: five cells with
  // 5-7 loss streaks printed "NOT YET JUDGEABLE" while the same line counted
  // them among the six that would be disarmed right now. The summary was
  // right; the detail contradicted it. Every per-cell assertion in this file
  // stayed green, because each one checked a single cell in a shape where the
  // two branches could not collide.
  //
  // The collision needs a cell that is BOTH un-judgeable on edge (too few
  // closes) AND already past a disarm predicate (the streak, which has no
  // minimum sample). That is not an edge case — it is what a freshly pinned
  // losing strategy looks like.
  const db = freshDb()
  addAccount(db, '47790949')
  pin(db, '47790949', 'tsmom_long')
  closes(db, '47790949', 'tsmom_long', [-10, -10, -10, -10, -10, -10])

  const r = handPinReport(db)
  assert.equal(r.rows[0].judgeable, false, '6 closes cannot judge an edge')
  assert.equal(r.rows[0].wouldDisarmToday, true, 'but a 6-loss streak is already past the predicate')
  assert.equal(r.wouldDisarmToday, 1)

  const line = handPinLine(db)
  assert.match(line, /WOULD BE DISARMED NOW on its own 6-loss streak/)
  assert.doesNotMatch(line, /not yet judgeable/i,
    'a cell whose verdict has already arrived must never read as one that cannot be judged')
})

test('provenance is reported, and unrecorded is never folded into seeded', () => {
  // The first version counted every explicitly-true cell as a hand pin and
  // reported 70 where the owner had made 3 decisions. It fetched the ledger
  // row and then never read the actor.
  const db = freshDb()
  addAccount(db, '47790949')
  pin(db, '47790949', 'tsmom_long')                       // actor: owner
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: true, accountId: '47790949', actor: 'boot_seed' }, io)

  const r = handPinReport(db)
  assert.equal(r.total, 2)
  assert.equal(r.ownerPins, 1, 'one deliberate override')
  assert.equal(r.seededPins, 1, 'one seeded by the boot config')
  assert.equal(r.unrecordedPins, 0)
  assert.match(handPinLine(db), /1 owner override\(s\), 1 seeded, 0 of unrecorded provenance/)
  assert.match(handPinLine(db), /\[owner\]/, 'and the owner\'s own pin is marked in the detail')
})
