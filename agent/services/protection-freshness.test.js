// node --test agent/services/protection-freshness.test.js
//
// THE READING THIS PINS (2026-08-06, same running system, same minute):
//   /state/heartbeats        protection_audit status "ok"
//   /state/protection-audit  at 2026-08-04T08:55Z  ageSec 174,009  lastAttemptAt null
// A green light beside a two-day-old answer. Both numbers correct; together a lie.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  protectionFreshness, protectionFreshnessFrom, checkProtectionFreshness,
  maxAgeSecFrom, minutes, DEFAULT_MAX_AGE_SEC, MAX_AGE_STATE_KEY, ALERTED_STATE_KEY,
} from './protection-freshness.js'
import { heartbeatView, checkHeartbeats, beat } from './heartbeat.js'

const NOW = Date.parse('2026-08-06T09:15:00Z')
const ago = (sec) => new Date(NOW - sec * 1000).toISOString()

test('the observed 48-hour gap is NOT fresh, and says how old it is', () => {
  const f = protectionFreshness({ at: '2026-08-04T08:55:00Z', nowMs: NOW, maxAgeSec: 900 })
  assert.equal(f.hasReading, true)
  assert.equal(f.ageSec, 174_000)
  assert.equal(f.fresh, false)
  assert.match(f.summary, /LAST VERIFIED 48h 20m AGO/)
  assert.match(f.summary, /past the 15m freshness limit/)
  assert.match(f.summary, /may still be beating; its answer is not current/)
})

test('a reading inside the window is fresh and quiet', () => {
  const f = protectionFreshness({ at: ago(120), nowMs: NOW, maxAgeSec: 900 })
  assert.equal(f.fresh, true)
  assert.equal(f.summary, 'verified 2m ago')
})

test('exactly at the limit still counts as an answer', () => {
  assert.equal(protectionFreshness({ at: ago(900), nowMs: NOW, maxAgeSec: 900 }).fresh, true)
  assert.equal(protectionFreshness({ at: ago(901), nowMs: NOW, maxAgeSec: 900 }).fresh, false)
})

test('NEVER RUN is not fresh — "no answer" and "an old answer" are the same fact', () => {
  const f = protectionFreshness({ at: null, nowMs: NOW })
  assert.equal(f.hasReading, false)
  assert.equal(f.ageSec, null)
  assert.equal(f.fresh, false)
  assert.match(f.summary, /nothing has verified that open positions are protected/)
})

test('a failed attempt is named in the summary, not swallowed', () => {
  const f = protectionFreshness({
    at: '2026-08-04T08:55:00Z', lastAttemptAt: ago(60),
    lastAttemptError: 'broker snapshot unavailable', nowMs: NOW, maxAgeSec: 900,
  })
  assert.match(f.summary, /Last attempt failed: broker snapshot unavailable/)
})

test('an unparseable timestamp is no reading, not a fresh one', () => {
  assert.equal(protectionFreshness({ at: 'idle', nowMs: NOW }).fresh, false)
})

test('the check can be switched off, and then never warns', () => {
  const f = protectionFreshness({ at: '2026-08-04T08:55:00Z', nowMs: NOW, maxAgeSec: 0 })
  assert.equal(f.enabled, false)
  assert.equal(f.fresh, true, 'disabled must not read as a standing warning')
  assert.match(f.summary, /disabled by configuration/)
})

test('minutes reads in hours once the gap stops being minutes', () => {
  assert.equal(minutes(900), '15m')
  assert.equal(minutes(3600), '1h')
  assert.equal(minutes(174_009), '48h 20m')
  assert.equal(minutes(0), '0m')
})

// ---------------------------------------------------------------------------
// Reading it out of the database
// ---------------------------------------------------------------------------

test('maxAgeSecFrom honours an owner override and falls back cleanly', () => {
  const db = initDB(':memory:')
  assert.equal(maxAgeSecFrom(db), DEFAULT_MAX_AGE_SEC)
  setState(db, MAX_AGE_STATE_KEY, '3600')
  assert.equal(maxAgeSecFrom(db), 3600)
  setState(db, MAX_AGE_STATE_KEY, 'nonsense')
  assert.equal(maxAgeSecFrom(db), DEFAULT_MAX_AGE_SEC, 'a malformed override is not a threshold of NaN')
})

test('a missing audit record reads as never-run rather than throwing', () => {
  const db = initDB(':memory:')
  const f = protectionFreshnessFrom(db, { nowMs: NOW })
  assert.equal(f.hasReading, false)
  assert.equal(f.fresh, false)
})

test('malformed JSON in the audit key is survived', () => {
  const db = initDB(':memory:')
  setState(db, 'protection_audit_last_json', '{not json')
  assert.equal(protectionFreshnessFrom(db, { nowMs: NOW }).fresh, false)
})

// ---------------------------------------------------------------------------
// The alert fires ONCE per transition
// ---------------------------------------------------------------------------

function dbWithAudit(at) {
  const db = initDB(':memory:')
  setState(db, 'protection_audit_last_json', JSON.stringify({ at, ok: true, checked: 4 }))
  return db
}

test('going stale alerts exactly once, then stays quiet', () => {
  const db = dbWithAudit('2026-08-04T08:55:00Z')
  const said = []
  const notify = (t) => said.push(t)

  const first = checkProtectionFreshness(db, { nowMs: NOW, notify })
  assert.equal(first.event, 'stale')
  assert.equal(said.length, 1)
  assert.match(said[0], /PROTECTION AUDIT NOT CURRENT/)
  assert.match(said[0], /that means the controller ticked, not that any position was checked/)
  assert.equal(getState(db, ALERTED_STATE_KEY), '1')

  // Every subsequent sweep over the SAME standing condition. A level-triggered
  // alert would have sent this ~2,880 times over the observed two days.
  for (let i = 0; i < 5; i++) {
    assert.equal(checkProtectionFreshness(db, { nowMs: NOW, notify }).event, null)
  }
  assert.equal(said.length, 1)
})

test('recovery alerts once and re-arms the warning', () => {
  const db = dbWithAudit('2026-08-04T08:55:00Z')
  const said = []
  const notify = (t) => said.push(t)
  checkProtectionFreshness(db, { nowMs: NOW, notify })

  setState(db, 'protection_audit_last_json', JSON.stringify({ at: ago(30), ok: true }))
  const rec = checkProtectionFreshness(db, { nowMs: NOW, notify })
  assert.equal(rec.event, 'recovered')
  assert.match(said[1], /PROTECTION AUDIT CURRENT AGAIN/)
  assert.equal(getState(db, ALERTED_STATE_KEY), '0')

  // And it can go stale again — the flag is a latch, not a one-shot mute.
  setState(db, 'protection_audit_last_json', JSON.stringify({ at: '2026-08-04T08:55:00Z' }))
  assert.equal(checkProtectionFreshness(db, { nowMs: NOW, notify }).event, 'stale')
  assert.equal(said.length, 3)
})

test('a notifier that throws cannot break the sweep', () => {
  const db = dbWithAudit('2026-08-04T08:55:00Z')
  const r = checkProtectionFreshness(db, { nowMs: NOW, notify: () => { throw new Error('telegram down') } })
  assert.equal(r.event, 'stale', 'the transition is still recorded')
})

test('a database that has NEVER run the audit does not alert on every boot', () => {
  // Deliberate scope line. Never-run is still visible — status is not `ok`,
  // work_product.fresh is false, and the route says "never run" — but this
  // function runs on every heartbeat sweep including the first after a deploy,
  // and a watchdog that is red on every boot is one nobody reads.
  const db = initDB(':memory:')
  const said = []
  const r = checkProtectionFreshness(db, { nowMs: NOW, notify: (t) => said.push(t) })
  assert.equal(r.event, null)
  assert.equal(said.length, 0)
  assert.equal(r.freshness.fresh, false, 'and it is still NOT reported as fresh')
})

test('with the check disabled nothing is ever emitted', () => {
  const db = dbWithAudit('2026-08-04T08:55:00Z')
  setState(db, MAX_AGE_STATE_KEY, '0')
  const said = []
  assert.equal(checkProtectionFreshness(db, { nowMs: NOW, notify: (t) => said.push(t) }).event, null)
  assert.equal(said.length, 0)
})

// ---------------------------------------------------------------------------
// The panel can no longer print `ok` over a stale answer
// ---------------------------------------------------------------------------

test('a BEATING protection audit with a stale answer reads warn, not ok', () => {
  const db = dbWithAudit('2026-08-04T08:55:00Z')
  beat(db, 'protection_audit', { now: new Date(NOW - 5_000) })   // ticking normally

  const row = heartbeatView(db, { now: new Date(NOW) }).find(r => r.name === 'protection_audit')
  assert.equal(row.status, 'warn', 'this was "ok" on 2026-08-06 beside a 48-hour-old reading')
  assert.equal(row.work_product.fresh, false)
  assert.equal(row.work_product.ageSec, 174_000)
  assert.match(row.work_product.summary, /LAST VERIFIED 48h 20m AGO/)
})

test('a beating audit with a CURRENT answer still reads ok', () => {
  const db = dbWithAudit(ago(45))
  beat(db, 'protection_audit', { now: new Date(NOW - 5_000) })
  const row = heartbeatView(db, { now: new Date(NOW) }).find(r => r.name === 'protection_audit')
  assert.equal(row.status, 'ok')
  assert.equal(row.work_product.fresh, true)
})

test('a genuine ticker stall still reports stalled, not downgraded to warn', () => {
  // Overstating a running process as stalled would misdirect whoever acts on
  // it; understating a stall as a warning would be worse. Stall wins.
  const db = dbWithAudit('2026-08-04T08:55:00Z')
  beat(db, 'protection_audit', { now: new Date(NOW - 3_600_000) })
  const row = heartbeatView(db, { now: new Date(NOW) }).find(r => r.name === 'protection_audit')
  assert.equal(row.status, 'stalled')
})

test('no other controller grows a work_product field', () => {
  const db = dbWithAudit('2026-08-04T08:55:00Z')
  beat(db, 'main_loop', { now: new Date(NOW) })
  for (const row of heartbeatView(db, { now: new Date(NOW) })) {
    if (row.name !== 'protection_audit') assert.equal(row.work_product, undefined, row.name)
  }
})

test('checkHeartbeats emits the product event alongside its ticker events', () => {
  const db = dbWithAudit('2026-08-04T08:55:00Z')
  beat(db, 'protection_audit', { now: new Date(NOW - 5_000) })
  const said = []
  const events = checkHeartbeats(db, {
    now: new Date(NOW), notify: (t) => said.push(t), bootMs: NOW - 3_600_000,
  })
  const ev = events.find(e => e.event === 'product_stale')
  assert.ok(ev, 'the stale product must surface as an event')
  assert.equal(ev.name, 'protection_audit')
  assert.equal(ev.ageSec, 174_000)
  assert.ok(said.some(t => /PROTECTION AUDIT NOT CURRENT/.test(t)))
})
