// node --test agent/services/minute-review.test.js
//
// §70.4's per-minute review, and the owner-stop override notice it carries.
//
// The detector is pure and gets exhaustive treatment; runMinuteReview gets a
// real in-memory SQLite database, because the parts most likely to be wrong are
// the cursor and the dedupe — and neither can be tested without the table.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  detectOwnerStopOverrides, overrideMessage, runMinuteReview, CURSOR_KEY, BATCH,
} from './minute-review.js'
import { CONTROLLERS } from './heartbeat.js'

// ---------------------------------------------------------------------------
// the detector
// ---------------------------------------------------------------------------

let seq = 0
const ev = (o) => ({
  id: ++seq, kind: 'sl_moved', position_id: 'P1', symbol: 'EURUSD',
  account_id: '5203012', at: '2026-08-04T02:00:00Z', from_value: null, to_value: null,
  reason: null, ...o,
})

test('a manager moving a stop the owner placed is reported', () => {
  const out = detectOwnerStopOverrides([
    ev({ source: 'manual', to_value: 1.0800 }),
    ev({ source: 'profit_keeper', from_value: 1.0800, to_value: 1.0850 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].by, 'profit_keeper')
  assert.equal(out[0].authority, 'fast_manager')
  assert.equal(out[0].ownerSl, 1.0800)
  assert.equal(out[0].newSl, 1.0850)
  assert.equal(out[0].capitalSafety, false)
})

test('the Telegram button counts as the owner, same as the route', () => {
  const out = detectOwnerStopOverrides([
    ev({ source: 'telegram', to_value: 1.08 }),
    ev({ source: 'fast_monitor', from_value: 1.08, to_value: 1.09 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].ownerSource, 'telegram')
})

test('capital safety is flagged separately — both readings of §41 allow it', () => {
  // §41.2's carve-out and §41.1's numbered list agree on levels 1-2 only. The
  // notice says which kind of override happened because the owner's response
  // differs: an emergency control firing means an ACCOUNT limit was hit.
  for (const src of ['loss_cap', 'profit_ratchet', 'equity_stop']) {
    const out = detectOwnerStopOverrides([
      ev({ source: 'manual', to_value: 1.08 }),
      ev({ source: src, from_value: 1.08, to_value: 1.07 }),
    ])
    assert.equal(out.length, 1, src)
    assert.equal(out[0].capitalSafety, true, src)
  }
  for (const src of ['profit_keeper', 'cpp_trail_engine', 'position_manager', 'llm_monitor']) {
    const out = detectOwnerStopOverrides([
      ev({ source: 'manual', to_value: 1.08 }),
      ev({ source: src, from_value: 1.08, to_value: 1.09 }),
    ])
    assert.equal(out[0].capitalSafety, false, src)
  }
})

test('a bot stop moved by another bot is not an override — nobody was overruled', () => {
  const out = detectOwnerStopOverrides([
    ev({ source: 'position_manager', to_value: 1.08 }),
    ev({ source: 'profit_keeper', from_value: 1.08, to_value: 1.085 }),
  ])
  assert.deepEqual(out, [])
})

test('a re-asserted stop is not an override — writers repeat themselves routinely', () => {
  const same = detectOwnerStopOverrides([
    ev({ source: 'manual', to_value: 1.08 }),
    ev({ source: 'profit_keeper', from_value: 1.08, to_value: 1.08 }),
  ])
  assert.deepEqual(same, [], 'from === to is a no-op amend')
  const agrees = detectOwnerStopOverrides([
    ev({ source: 'manual', to_value: 1.08 }),
    ev({ source: 'profit_keeper', from_value: 1.07, to_value: 1.08 }),
  ])
  assert.deepEqual(agrees, [], 'landing on the owner’s own number took nothing away')
})

test('ONE notice per owner instruction, not one per trailing step', () => {
  // A profit keeper trailing a stop every minute would otherwise alert every
  // minute, and an alert that arrives every minute is one nobody reads.
  const out = detectOwnerStopOverrides([
    ev({ source: 'manual', to_value: 1.08 }),
    ev({ source: 'profit_keeper', from_value: 1.08, to_value: 1.085 }),
    ev({ source: 'profit_keeper', from_value: 1.085, to_value: 1.090 }),
    ev({ source: 'profit_keeper', from_value: 1.090, to_value: 1.095 }),
  ])
  assert.equal(out.length, 1)
})

test('the owner placing a new stop re-arms the notice', () => {
  const out = detectOwnerStopOverrides([
    ev({ source: 'manual', to_value: 1.08 }),
    ev({ source: 'profit_keeper', from_value: 1.08, to_value: 1.085 }),
    ev({ source: 'manual', from_value: 1.085, to_value: 1.070 }),
    ev({ source: 'profit_keeper', from_value: 1.070, to_value: 1.090 }),
  ])
  assert.equal(out.length, 2)
  assert.deepEqual(out.map(o => o.ownerSl), [1.08, 1.070])
})

test('positions are tracked independently', () => {
  const out = detectOwnerStopOverrides([
    ev({ position_id: 'P1', source: 'manual', to_value: 1.08 }),
    ev({ position_id: 'P2', source: 'profit_keeper', from_value: 2.0, to_value: 2.1 }),
    ev({ position_id: 'P1', source: 'profit_keeper', from_value: 1.08, to_value: 1.09 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].positionId, 'P1')
})

test('non-sl_moved kinds are ignored — a TP move is not a stop', () => {
  const out = detectOwnerStopOverrides([
    ev({ source: 'manual', kind: 'tp_moved', to_value: 1.2 }),
    ev({ source: 'profit_keeper', kind: 'tp_moved', from_value: 1.2, to_value: 1.3 }),
    ev({ source: 'profit_keeper', kind: 'close' }),
  ])
  assert.deepEqual(out, [])
})

test('an unknown writer is reported with a null authority, not silently dropped', () => {
  // A new service that starts moving stops without being added to the registry
  // is exactly the case worth hearing about.
  const out = detectOwnerStopOverrides([
    ev({ source: 'manual', to_value: 1.08 }),
    ev({ source: 'brand_new_thing', from_value: 1.08, to_value: 1.09 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].authority, null)
  assert.equal(out[0].capitalSafety, false)
  assert.match(overrideMessage(out[0]), /unknown authority/)
})

test('rows with no position id are skipped rather than grouped together', () => {
  assert.deepEqual(detectOwnerStopOverrides([
    ev({ position_id: null, source: 'manual', to_value: 1.08 }),
    ev({ position_id: null, source: 'profit_keeper', from_value: 1.08, to_value: 1.09 }),
  ]), [])
})

test('empty and missing input do not throw', () => {
  assert.deepEqual(detectOwnerStopOverrides([]), [])
  assert.deepEqual(detectOwnerStopOverrides(undefined), [])
})

test('the message names the position, both stops, and who moved it', () => {
  const [o] = detectOwnerStopOverrides([
    ev({ source: 'manual', to_value: 1.08 }),
    ev({ source: 'profit_keeper', from_value: 1.08, to_value: 1.085, reason: 'lock 1R' }),
  ])
  const msg = overrideMessage(o)
  assert.match(msg, /EURUSD/)
  assert.match(msg, /1\.08/)
  assert.match(msg, /1\.085/)
  assert.match(msg, /profit_keeper/)
  assert.match(msg, /lock 1R/)
  assert.match(msg, /hand/)
})

// ---------------------------------------------------------------------------
// runMinuteReview — the cursor and the dedupe, against a real table
// ---------------------------------------------------------------------------

function freshDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE position_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT DEFAULT CURRENT_TIMESTAMP,
      account_id TEXT, position_id TEXT, trade_id INTEGER, symbol TEXT,
      kind TEXT, from_value REAL, to_value REAL, r_at REAL, price_at REAL,
      reason TEXT, source TEXT, detail_json TEXT
    );
  `)
  return db
}
const insert = (db, { positionId = 'P1', symbol = 'EURUSD', kind = 'sl_moved', from = null, to = null, source }) =>
  db.prepare(
    `INSERT INTO position_events (account_id, position_id, symbol, kind, from_value, to_value, source)
     VALUES ('5203012', ?, ?, ?, ?, ?, ?)`
  ).run(positionId, symbol, kind, from, to, source).lastInsertRowid

test('the first pass ARMS and does not fire — ninety days of journal is not an alert', () => {
  const db = freshDb()
  insert(db, { source: 'manual', to: 1.08 })
  insert(db, { source: 'profit_keeper', from: 1.08, to: 1.09 })
  const sent = []
  const r = runMinuteReview(db, { notify: (t) => sent.push(t) })
  assert.equal(r.armed, true)
  assert.deepEqual(sent, [], 'nothing is reported on the arming pass')
  assert.equal(db.prepare('SELECT value FROM agent_state WHERE key = ?').get(CURSOR_KEY).value, '2')
})

test('an override after arming is reported exactly once, then never again', () => {
  const db = freshDb()
  const ownerId = insert(db, { source: 'manual', to: 1.08 })
  runMinuteReview(db, {})                       // arms at the owner's stop

  insert(db, { source: 'profit_keeper', from: 1.08, to: 1.09 })
  const sent = []
  const first = runMinuteReview(db, { notify: (t) => sent.push(t) })
  assert.equal(first.overrides.length, 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /moved a stop you placed by hand/)

  // The journal now carries the notice, which is what makes the dedupe
  // survive a restart — no in-memory set, no extra state key.
  const rec = db.prepare("SELECT * FROM position_events WHERE kind = 'authority_override'").get()
  assert.equal(rec.source, 'minute_review')
  assert.equal(rec.from_value, 1.08)
  assert.equal(rec.to_value, 1.09)
  assert.equal(JSON.parse(rec.detail_json).ownerEventId, ownerId)

  // Re-arm the cursor as if the process restarted mid-journal and re-read the
  // same rows: the notice must not repeat.
  db.prepare('UPDATE agent_state SET value = ? WHERE key = ?').run(String(ownerId), CURSOR_KEY)
  const again = runMinuteReview(db, { notify: (t) => sent.push(t) })
  assert.equal(again.overrides.length, 0, 'the authority_override row is the dedupe')
  assert.equal(sent.length, 1)
})

test('the owner instruction is found even when it predates the batch', () => {
  // The failure this guards: an owner stop set on Monday, overridden on Friday.
  // A detector that only looked at the new rows would see the override with no
  // owner context and report nothing at all.
  const db = freshDb()
  insert(db, { source: 'manual', to: 1.08 })
  runMinuteReview(db, {})
  for (let i = 0; i < 40; i++) insert(db, { positionId: 'OTHER', source: 'profit_keeper', from: 2, to: 2.1 })
  insert(db, { source: 'profit_keeper', from: 1.08, to: 1.09 })

  const r = runMinuteReview(db, {})
  assert.equal(r.overrides.length, 1)
  assert.equal(r.overrides[0].ownerSl, 1.08)
})

test('a notify that throws does not lose the pass or repeat the notice', () => {
  const db = freshDb()
  insert(db, { source: 'manual', to: 1.08 })
  runMinuteReview(db, {})
  insert(db, { source: 'profit_keeper', from: 1.08, to: 1.09 })

  const r = runMinuteReview(db, { notify: () => { throw new Error('telegram down') } })
  assert.equal(r.overrides.length, 1)
  assert.equal(r.error, undefined)
  // Recorded BEFORE notifying, on purpose: a Telegram outage must not be able
  // to turn one notice into an endless one.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM position_events WHERE kind = 'authority_override'").get().c, 1)
  assert.equal(runMinuteReview(db, {}).overrides.length, 0)
})

test('the cursor never advances past rows the batch did not read', () => {
  const db = freshDb()
  runMinuteReview(db, {})
  for (let i = 0; i < BATCH + 10; i++) insert(db, { source: 'profit_keeper', from: 1, to: 1.1 })
  const r = runMinuteReview(db, {})
  assert.equal(r.reviewed, BATCH)
  assert.equal(r.cursor, BATCH, 'stopped at the last row it actually looked at')
  assert.equal(runMinuteReview(db, {}).reviewed, 10, 'the remainder drains next pass')
})

test('a pass with nothing new is cheap and still advances nothing', () => {
  const db = freshDb()
  insert(db, { source: 'manual', to: 1.08 })
  runMinuteReview(db, {})
  const r = runMinuteReview(db, {})
  assert.equal(r.reviewed, 0)
  assert.deepEqual(r.overrides, [])
})

test('a broken database is reported, never thrown — the ticker must survive', () => {
  const db = freshDb()
  db.exec('DROP TABLE position_events')
  const r = runMinuteReview(db, {})
  assert.ok(r.error, 'the failure is returned')
  assert.deepEqual(r.overrides, [])
})

test('the review is registered as a controller with a fixed expectation', () => {
  // Same reasoning as trade_guards and the protection audit: a threshold
  // derived from loop cadence stretches as the loop degrades.
  const def = CONTROLLERS.minute_review
  assert.ok(def, 'minute_review must be in the registry or the panel cannot show it')
  assert.equal(def.tiedToLoop, undefined)
  assert.equal(def.expectedSec, 60)
})
