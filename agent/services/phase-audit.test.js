// Owner, 2026-07-31, second unexplained "autotrade off on every account":
// the flags had half a dozen writers and no durable record of who flipped
// what. These tests pin the contract of the audit trail that closes that gap.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, getState } from '../db.js'
import { setPhaseFlag, auditControllerEvent, recentPhaseAudit } from './phase-audit.js'
import { setAccountPhases } from './account-phases.js'
import { disarmAccount } from './equity-stop.js'

let db
beforeEach(() => { db = initDB(':memory:') })

const auditRows = () => db.prepare("SELECT * FROM action_log WHERE method = 'AUDIT' ORDER BY id").all()

test('a real flip writes the flag AND one audit row with from/to/actor/via/reason', () => {
  const r = setPhaseFlag(db, 'autotrade_enabled', 'true', { actor: 'owner-ui', via: '/actions/autotrade-toggle' })
  assert.equal(r.changed, true)
  assert.equal(getState(db, 'autotrade_enabled'), 'true')
  const rows = auditRows()
  assert.equal(rows.length, 1)
  const body = JSON.parse(rows[0].body)
  assert.equal(rows[0].path, '/phase/autotrade_enabled')
  assert.equal(body.from, 'false')       // seeded default
  assert.equal(body.to, 'true')
  assert.equal(body.actor, 'owner-ui')
  assert.equal(body.via, '/actions/autotrade-toggle')
})

test('an idempotent write leaves NO audit row — the trail records changes, not chatter', () => {
  setPhaseFlag(db, 'scan_enabled', 'true', { actor: 'owner-ui' }) // already 'true' by seed
  assert.equal(auditRows().length, 0)
})

test('per-account flips carry the accountId, and clearing to inherit is itself audited', () => {
  setAccountPhases(db, '46130058', { autotrade: false }, { actor: 'owner-ui', via: '/actions/account-phases' })
  setAccountPhases(db, '46130058', { autotrade: null }, { actor: 'owner-ui', via: '/actions/account-phases' })
  const rows = auditRows().map(r => JSON.parse(r.body))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].key, 'acct:46130058:autotrade_enabled')
  assert.equal(rows[0].to, 'false')
  assert.equal(rows[0].accountId, '46130058')
  assert.equal(rows[1].to, null)         // cleared back to inherit — visible, not silent
})

test('the equity stop disarm is attributed — never an anonymous flip again', () => {
  disarmAccount(db, '46130058')
  const rows = auditRows().map(r => JSON.parse(r.body))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, 'acct:46130058:autotrade_enabled')
  assert.equal(rows[0].actor, 'equity_stop')
  assert.match(rows[0].reason, /equity stop/)
})

test('controller events land in the same trail and recentPhaseAudit reads it all back, newest first', () => {
  setPhaseFlag(db, 'autotrade_enabled', 'true', { actor: 'telegram', via: '/resume' })
  auditControllerEvent(db, { controller: 'fast_monitor', event: 'stalled', detail: 'last ran 12m ago' })
  const out = recentPhaseAudit(db)
  assert.equal(out.length, 2)
  assert.equal(out[0].path, '/controller/fast_monitor/stalled')
  assert.equal(out[0].controller, 'fast_monitor')
  assert.equal(out[1].actor, 'telegram')
})
