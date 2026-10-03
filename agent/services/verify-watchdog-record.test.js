// cpp-verify's watchdog is a RECORD, not a channel (owner, 03-10-2026:
// "remove all three"). Its Telegram delivery — the transport, the 24 h muted
// soak, the mute route and the 512-item outbox — never delivered a message
// (no credentials were ever set on the service; the mute could not be lifted
// over a backlog nobody could dispose of) and was removed. The C++ record is
// exercised by cpp-verify/src/tests/test_watchdog.cpp; this file pins the
// Node half: the removed channel reaches the verify_watchdog heartbeat (GET
// /state/heartbeats → controllers[].detail) and independent_watchdog_json
// (→ runtime.watchdog) as `channel: 'none'`, a verifier that reports no
// block is said to, the beat is QUIET, and supervision off reads dormant.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { makeIndependentProtectionPoll, watchdogDeliveryDetail, verifyWatchdogBeat } from './independent-protection.js'
import { CONTROLLERS, heartbeatView, checkHeartbeats, verifyWatchdogDormantReason } from './heartbeat.js'

const T = 1_800_000_000_000
const DELIVERY = { channel: 'none', removedOn: '2026-10-03', note: 'incidents are a record; nothing is sent' }
// What the CV-2 builds reported, and what the build before CV-2 did not.
const CV2_DELIVERY = { muted: true, open: false, reason: 'soak_active', soakActive: true, soakEndsAtMs: T + 86_400_000 }

function fixture(t, watchdogReply) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const key of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET']) {
    const old = process.env[key]; process.env[key] = 'fixture'
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
  }
  setState(db, 'ctrader_access_token', 'fixture-token')
  upsertAccount(db, { accountId: '11', isLive: false })
  const sessions = [{ host: 'demo.ctraderapi.com', open: true, accounts: ['11'] }]
  const poll = makeIndependentProtectionPoll(db, { env: { VERIFY_URL: 'https://verifier.test', EXEC_SECRET: 'fixture' }, log: () => {},
    fetchImpl: async url => {
      if (url.endsWith('/watchdog-status')) return watchdogReply()
      if (url.endsWith('/connect')) return { ok: true, json: async () => ({ accounts: [{ accountId: '11', authorized: true }] }) }
      return { ok: true, json: async () => ({ source: 'cpp-verify', sessions,
        accounts: [{ accountId: '11', host: 'demo.ctraderapi.com', ok: true, source: 'broker_reconcile', checkedAtMs: Date.now(), openCount: 0, missingSl: 0, missingTp: 0 }] }) }
    } })
  return { db, poll }
}
const row = db => db.prepare("SELECT * FROM controller_heartbeats WHERE name = 'verify_watchdog'").get()

test('the removed channel reaches the verify_watchdog beat and the relayed status as channel none', async t => {
  const { db, poll } = fixture(t, () => ({ ok: true, json: async () => ({ schemaVersion: 1, enabled: true, durable: true, error: '', stateBytes: 4096, delivery: DELIVERY }) }))
  await poll()
  const beat = row(db)
  assert.ok(beat, 'verify_watchdog beaten')
  assert.equal(beat.consecutive_failures, 0)
  const detail = JSON.parse(beat.last_detail_json)
  assert.deepEqual(detail, { channel: 'none', removedOn: '2026-10-03', note: 'incidents are a record; nothing is sent', stateBytes: 4096, enabled: true, durable: true, error: null })
  for (const gone of ['muted', 'open', 'soakActive', 'wouldSend', 'wouldDeliver', 'staleBacklog', 'unmuteRefusal', 'muteNotDurable', 'outboxPending']) assert.equal(gone in detail, false, gone)
  const view = heartbeatView(db).find(v => v.name === 'verify_watchdog')
  assert.equal(view.detail.channel, 'none')
  assert.equal(CONTROLLERS.verify_watchdog.label, 'Independent watchdog (cpp-verify) incident record')
  const relayed = JSON.parse(getState(db, 'independent_watchdog_json'))
  assert.equal(relayed.status.delivery.channel, 'none')
})

test('a verifier that reports no delivery block, or the CV-2 shape, is reported — never read as the removed channel', async t => {
  let reply = { schemaVersion: 1, enabled: true }
  const { db, poll } = fixture(t, () => ({ ok: true, json: async () => reply }))
  await poll()
  assert.equal(row(db).consecutive_failures, 1)
  assert.match(row(db).last_error, /incident record unreported .*before the delivery channel was removed on 03-10-2026/)
  assert.equal(watchdogDeliveryDetail(reply), null)
  assert.equal(watchdogDeliveryDetail({ delivery: CV2_DELIVERY }), null)
  assert.equal(watchdogDeliveryDetail({ delivery: { channel: 'telegram' } }), null)
  assert.equal(watchdogDeliveryDetail({ delivery: 'none' }), null)
  reply = { schemaVersion: 1, enabled: true, error: '', delivery: DELIVERY }
  await poll()
  assert.equal(row(db).consecutive_failures, 0)
})

test('the record on a failing verifier fails the beat, with the detail kept', async t => {
  let reply = { schemaVersion: 1, enabled: true, error: 'watchdog_state_already_owned_or_lock_unavailable', durable: false, delivery: DELIVERY }
  const { db, poll } = fixture(t, () => ({ ok: true, json: async () => reply }))
  await poll()
  assert.equal(row(db).consecutive_failures, 1)
  assert.match(row(db).last_error, /already_owned/)
  const detail = JSON.parse(row(db).last_detail_json)
  assert.equal(detail.error, 'watchdog_state_already_owned_or_lock_unavailable')
  assert.equal(detail.enabled, true); assert.equal(detail.durable, false); assert.equal(detail.channel, 'none')
  // Switched off WITH an error is a fault too, not the switch alone.
  reply = { schemaVersion: 1, enabled: false, error: 'watchdog_status_busy' }
  await poll()
  assert.equal(row(db).consecutive_failures, 2)
  assert.equal(verifyWatchdogBeat({ enabled: true, error: '', delivery: DELIVERY }).ok, true)
  assert.equal(verifyWatchdogBeat({ enabled: true, error: '', delivery: CV2_DELIVERY }).ok, false)
})

// WATCHDOG_ENABLED unset on cpp-verify is a switch, not a fault — the row
// reads dormant with the reason, never error.
test('supervision switched off on cpp-verify reads dormant, not error', async t => {
  const env = { VERIFY_URL: 'https://verifier.test', EXEC_SECRET: 'fixture' }
  for (const key of Object.keys(env)) {
    const old = process.env[key]; process.env[key] = env[key]
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
  }
  let reply = { schemaVersion: 1, enabled: false, error: '', durable: false, delivery: DELIVERY }
  const { db, poll } = fixture(t, () => ({ ok: true, json: async () => reply }))
  await poll()
  assert.equal(row(db).consecutive_failures, 0)
  assert.equal(JSON.parse(row(db).last_detail_json).supervision, 'off')
  assert.match(verifyWatchdogDormantReason(db, { env }), /WATCHDOG_ENABLED unset on cpp-verify/)
  const view = heartbeatView(db).find(v => v.name === 'verify_watchdog')
  assert.equal(view.verdict, 'dormant')
  assert.equal(view.dormant, true)
  assert.match(view.dormant_reason, /supervision is switched off .* records no incident/)
  assert.doesNotMatch(view.dormant_reason, /soak|deliver/)
  // An older verifier with supervision off (no block in the reply) reads the same.
  reply = { schemaVersion: 1, enabled: false, error: '' }
  await poll()
  assert.equal(row(db).consecutive_failures, 0)
  assert.equal(heartbeatView(db).find(v => v.name === 'verify_watchdog').verdict, 'dormant')
  // Switched back on: no longer dormant, judged again.
  reply = { schemaVersion: 1, enabled: true, error: '', delivery: DELIVERY }
  await poll()
  assert.equal(verifyWatchdogDormantReason(db, { env }), null)
  assert.equal(heartbeatView(db).find(v => v.name === 'verify_watchdog').verdict, 'ok')
  // An unreadable relay (the read failed) is not dormancy.
  reply = null
  await poll()
  assert.equal(verifyWatchdogDormantReason(db, { env }), null)
  assert.notEqual(heartbeatView(db).find(v => v.name === 'verify_watchdog').verdict, 'dormant')
})

test('verify_watchdog is dormant while the relay is unconfigured', () => {
  assert.equal(CONTROLLERS.verify_watchdog.dormantWhen, verifyWatchdogDormantReason)
  assert.match(verifyWatchdogDormantReason(null, { env: {} }), /VERIFY_URL, EXEC_SECRET unset/)
  assert.match(verifyWatchdogDormantReason(null, { env: { VERIFY_URL: 'https://v.test' } }), /EXEC_SECRET unset/)
  assert.equal(verifyWatchdogDormantReason(null, { env: { VERIFY_URL: 'https://v.test', EXEC_SECRET: 'x' } }), null)
})

test('an unreachable watchdog status fails the beat, not the protection relay', async t => {
  const { db, poll } = fixture(t, () => ({ ok: false, status: 503 }))
  await poll()
  assert.equal(row(db).consecutive_failures, 1)
  assert.match(row(db).last_error, /unavailable/)
  assert.equal(JSON.parse(getState(db, 'independent_protection_json')).error, null)
})

test('verify_watchdog is quiet — its stall is recorded, never sent', () => {
  assert.equal(CONTROLLERS.verify_watchdog.quiet, true)
  const db = initDB(':memory:')
  try {
    const then = new Date(T)
    db.prepare(`INSERT INTO controller_heartbeats (name, last_run_at, last_ok_at, consecutive_failures, runs, updated_at)
      VALUES ('verify_watchdog', ?, ?, 0, 1, ?)`).run(then.toISOString(), then.toISOString(), then.toISOString())
    const sent = []
    const events = checkHeartbeats(db, { now: new Date(T + 3_600_000), notify: text => sent.push(text), bootMs: T - 86_400_000 })
    assert.ok(events.some(e => e.name === 'verify_watchdog' && e.event === 'stalled'))
    assert.equal(sent.filter(s => /Independent watchdog/.test(s)).length, 0)
  } finally { db.close() }
})
