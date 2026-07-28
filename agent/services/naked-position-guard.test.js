// The controller that answers "is every open position actually protected?"
//
// Provoked by a real incident: an ETHUSD short closed while carrying the
// reason "stopped beyond the SL", with no stop loss on record at all. These
// tests pin both halves of the failure — a position with no broker stop must
// be found, and a position whose stop we merely BELIEVE in must be found too,
// because that is the state where the screen actively reassures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB, getState } from '../db.js'
import { auditProtection, dueForAlert, runProtectionAudit } from './naked-position-guard.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'naked-')), 'agent.db'))
const row = (o) => ({ id: 1, trade_id: 10, symbol: 'ETHUSD', ctrader_position_id: '555', current_sl: null, account_id: '43097342', ...o })

test('THE INCIDENT: a position with no broker stop is reported unprotected', () => {
  const a = auditProtection([row()], [{ positionId: '555', stopLoss: null, takeProfit: null }])
  assert.equal(a.naked.length, 1)
  assert.equal(a.naked[0].symbol, 'ETHUSD')
  assert.match(a.naked[0].detail, /unprotected/)
})

test('a stop of ZERO is no stop — the exact null-becomes-0 trap that caused this', () => {
  // reconciler.js read Number(null) as 0 and concluded a stop existed. A
  // broker reporting 0 must not be read as "protected at zero" here either.
  const a = auditProtection([row()], [{ positionId: '555', stopLoss: 0 }])
  assert.equal(a.naked.length, 1)
})

test('THE WORSE CASE: we show a stop, the broker holds none', () => {
  const a = auditProtection([row({ current_sl: 1723.26 })], [{ positionId: '555', stopLoss: null }])
  assert.equal(a.naked.length, 1)
  // The detail must say the UI is wrong, not just that a stop is missing —
  // this is the state where someone reads the screen and stands down.
  assert.match(a.naked[0].detail, /we show a stop at 1723.26 but the broker holds NONE/)
})

test('a protected position is not reported', () => {
  const a = auditProtection([row({ current_sl: 1723.26 })], [{ positionId: '555', stopLoss: 1723.26 }])
  assert.equal(a.naked.length, 0)
  assert.equal(a.phantom.length, 0)
})

test('a stop the broker holds but we never recorded is protection, not a fault', () => {
  const a = auditProtection([row({ current_sl: null })], [{ positionId: '555', stopLoss: 1700 }])
  assert.equal(a.naked.length, 0, 'the money is protected — that is what matters')
  assert.equal(a.phantom.length, 0, 'a missing local record is not a stop DISAGREEMENT')
})

test('a materially different stop is flagged as a disagreement', () => {
  const a = auditProtection([row({ current_sl: 1723.26 })], [{ positionId: '555', stopLoss: 1650 }])
  assert.equal(a.phantom.length, 1)
  assert.match(a.phantom[0].detail, /we show 1723.26, the broker holds 1650/)
  // Rounding noise is not a disagreement.
  const b = auditProtection([row({ current_sl: 1723.26 })], [{ positionId: '555', stopLoss: 1723.3 }])
  assert.equal(b.phantom.length, 0)
})

test('a position absent at the broker is NOT called unprotected', () => {
  // "Open here, gone there" is the reconciler's fault to report. Claiming it
  // here would double-report a different problem as this one, and the alert
  // would stop meaning what it says.
  const a = auditProtection([row()], [])
  assert.equal(a.naked.length, 0)
  assert.equal(a.unmatched, 1)
})

test('empty inputs are a clean no-op', () => {
  const a = auditProtection([], [])
  assert.deepEqual(a, { naked: [], phantom: [], checked: 0, unmatched: 0 })
})

test('alerts are muted per position, so a persistent gap does not spam hourly', () => {
  const f = [{ positionId: '555' }, { positionId: '777' }]
  const now = 1_000_000
  const due = dueForAlert(f, { 555: now - 60_000 }, now, 3_600_000)
  assert.deepEqual(due.map(x => x.positionId), ['777'], 'the recently-alerted one is muted')
  // Past the window it becomes due again — a gap that is still open an hour
  // later is worth saying again.
  assert.equal(dueForAlert(f, { 555: now - 4_000_000 }, now, 3_600_000).length, 2)
})

test('the audit alerts, records to action_log, and remembers the mute', async () => {
  const db = tmpDb()
  const sent = []
  const res = await runProtectionAudit(db, [row()], [{ positionId: '555', stopLoss: null }], {
    nowMs: 1_000_000, sendMessage: async (m) => { sent.push(m) },
  })
  assert.equal(res.naked.length, 1)
  assert.equal(res.alerted, 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /NO STOP LOSS/)
  assert.match(sent[0], /ETHUSD/)

  const logged = db.prepare("SELECT method FROM action_log WHERE path = '/protection-audit'").all()
  assert.deepEqual(logged.map(r => r.method), ['POSITION_UNPROTECTED'])
  assert.match(getState(db, 'naked_position_alerts_json') || '', /555/)
})

test('the mute map forgets positions that are no longer open', async () => {
  const db = tmpDb()
  await runProtectionAudit(db, [row()], [{ positionId: '555', stopLoss: null }], { nowMs: 1000, sendMessage: async () => {} })
  assert.match(getState(db, 'naked_position_alerts_json'), /555/)
  // Position now protected — its mute entry must not linger forever.
  await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700 }], { nowMs: 2000, sendMessage: async () => {} })
  assert.equal(getState(db, 'naked_position_alerts_json'), '{}')
})

test('a failing alert channel does not lose the audit', async () => {
  const db = tmpDb()
  const res = await runProtectionAudit(db, [row()], [{ positionId: '555', stopLoss: null }], {
    nowMs: 1000, sendMessage: async () => { throw new Error('telegram down') },
  })
  assert.equal(res.naked.length, 1, 'the finding stands even if nobody could be told')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM action_log WHERE path='/protection-audit'").get().c, 1)
})

test('it never throws — a protection audit that can crash the loop removes safety', async () => {
  const db = tmpDb()
  const res = await runProtectionAudit(db, null, null, { nowMs: 1000 })
  assert.ok(res)
  assert.equal(res.naked.length, 0)
})
