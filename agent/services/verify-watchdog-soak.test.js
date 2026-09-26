// V3 CV-2 (OD-10): cpp-verify's watchdog delivery is MUTED through a 24 h
// soak by default. The C++ gate itself is exercised by
// cpp-verify/src/tests/test_watchdog.cpp; this file pins the Node half:
// the soak state reaches the verify_watchdog heartbeat (GET /state/heartbeats
// → controllers[].detail) and independent_watchdog_json (GET
// /state/heartbeats → runtime.watchdog), the beat is QUIET, and the verifier's
// run loop asks the gated releasable(), never the raw nextDelivery().
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { makeIndependentProtectionPoll, watchdogDeliveryDetail } from './independent-protection.js'
import { CONTROLLERS, heartbeatView, checkHeartbeats } from './heartbeat.js'

const T = 1_800_000_000_000
const DELIVERY = { muted: true, open: false, reason: 'soak_active', soakActive: true, soakMs: 86_400_000,
  soakStartedAtMs: T, soakEndsAtMs: T + 86_400_000, soakRemainingMs: 86_000_000, mutedAtMs: T, unmutedAtMs: null,
  wouldSend: { urgent: 3, warning: 5, info: 1, total: 9, sinceMs: T, urgentPerHour: 27, totalPerHour: 81 }, outboxPending: 9 }

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

test('CV-2: the muted soak reaches the verify_watchdog beat and the relayed status', async t => {
  const { db, poll } = fixture(t, () => ({ ok: true, json: async () => ({ schemaVersion: 1, enabled: true, stateBytes: 4096, delivery: DELIVERY }) }))
  await poll()
  const beat = row(db)
  assert.ok(beat, 'verify_watchdog beaten')
  assert.equal(beat.consecutive_failures, 0)
  const detail = JSON.parse(beat.last_detail_json)
  assert.equal(detail.muted, true)
  assert.equal(detail.open, false)
  assert.equal(detail.soakActive, true)
  assert.equal(detail.soakEndsAtMs, T + 86_400_000)
  assert.deepEqual(detail.wouldSend, DELIVERY.wouldSend)
  assert.equal(detail.stateBytes, 4096)
  const view = heartbeatView(db).find(v => v.name === 'verify_watchdog')
  assert.equal(view.detail.muted, true)
  assert.equal(view.detail.soakEndsAtMs, T + 86_400_000)
  const relayed = JSON.parse(getState(db, 'independent_watchdog_json'))
  assert.equal(relayed.status.delivery.muted, true)
})

test('CV-2: a verifier without the delivery gate is reported, never read as muted', async t => {
  let reply = { schemaVersion: 1, enabled: true }
  const { db, poll } = fixture(t, () => ({ ok: true, json: async () => reply }))
  await poll()
  assert.equal(row(db).consecutive_failures, 1)
  assert.match(row(db).last_error, /delivery gate unreported/)
  assert.equal(watchdogDeliveryDetail(reply), null)
  assert.equal(watchdogDeliveryDetail({ delivery: { muted: 'yes' } }), null)
  reply = { schemaVersion: 1, delivery: DELIVERY }
  await poll()
  assert.equal(row(db).consecutive_failures, 0)
})

test('CV-2: an unreachable watchdog status fails the beat, not the protection relay', async t => {
  const { db, poll } = fixture(t, () => ({ ok: false, status: 503 }))
  await poll()
  assert.equal(row(db).consecutive_failures, 1)
  assert.match(row(db).last_error, /unavailable/)
  assert.equal(JSON.parse(getState(db, 'independent_protection_json')).error, null)
})

test('CV-2: verify_watchdog is quiet — its stall is recorded, never sent', () => {
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

test('CV-2 wiring: the verifier run loop sends only what releasable() returns', () => {
  const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const source = strip(readFileSync(new URL('../../cpp-verify/src/watchdog.cpp', import.meta.url), 'utf8'))
  const run = source.slice(source.indexOf('void Watchdog::run('), source.indexOf('jsn::Value Watchdog::status('))
  assert.ok(run.length > 100, 'run() located')
  assert.match(run, /state_\.releasable\(now\)/)
  assert.doesNotMatch(run, /state_\.nextDelivery\(/)
  const gate = strip(readFileSync(new URL('../../cpp-verify/src/watchdog_state.cpp', import.meta.url), 'utf8'))
  assert.match(gate, /jsn::Value WatchState::releasable\(long long now\) const \{\s*if \(!deliveryOpen\(now\)\) return jsn::Value\(\);/)
})
