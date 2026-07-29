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
import {
  auditProtection, dueForAlert, runProtectionAudit,
  lastProtectionAudit, recordAuditUnavailable,
} from './naked-position-guard.js'

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

test('a fully protected position — stop AND target — is not reported at all', () => {
  const a = auditProtection([row({ current_sl: 1723.26 })], [{ positionId: '555', stopLoss: 1723.26, takeProfit: 1600 }])
  assert.equal(a.naked.length, 0)
  assert.equal(a.phantom.length, 0)
  assert.equal(a.targetless.length, 0)
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
  assert.deepEqual(a, { naked: [], targetless: [], phantom: [], checked: 0, unmatched: 0 })
})

// ---------------------------------------------------------------------------
// D4 — the take-profit requirement, applied to positions we did not open.
//
// exec-engine.js refuses to SUBMIT a market order with no target
// (guard_no_target). An adopted position never passes through that guard, so
// the rule the owner asked for most explicitly was the one rule adopted
// positions were exempt from. The 0003.HK pair found on 2026-07-29 had stops
// and no targets.
// ---------------------------------------------------------------------------

test('THE 0003.HK CASE: a stop but no take profit is reported', () => {
  const a = auditProtection(
    [row({ symbol: '0003.HK', current_sl: 6.994, source: 'autopilot' })],
    [{ positionId: '555', stopLoss: 6.994, takeProfit: null }],
  )
  assert.equal(a.naked.length, 0, 'it has a stop — this is not an emergency')
  assert.equal(a.targetless.length, 1)
  assert.equal(a.targetless[0].symbol, '0003.HK')
  assert.equal(a.targetless[0].brokerSl, 6.994)
  // The detail must name the guard, so the owner can see this is the same
  // rule the order path already enforces — not a new opinion.
  assert.match(a.targetless[0].detail, /guard_no_target/)
})

test('a take profit of ZERO is no take profit — the same null-becomes-0 trap', () => {
  const a = auditProtection([row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: 0 }])
  assert.equal(a.targetless.length, 1)
})

test('a NAKED position is not also reported as targetless', () => {
  // It has neither. Reporting "and no target either" underneath the no-stop
  // siren is noise on top of an emergency: the stop is what it needs first.
  const a = auditProtection([row()], [{ positionId: '555', stopLoss: null, takeProfit: null }])
  assert.equal(a.naked.length, 1)
  assert.equal(a.targetless.length, 0)
})

test('a hand-opened position says so, because the rule never applied to it', () => {
  const a = auditProtection(
    [row({ current_sl: 1700, source: 'external' })],
    [{ positionId: '555', stopLoss: 1700, takeProfit: null }],
  )
  assert.equal(a.targetless[0].source, 'external')
  assert.match(a.targetless[0].detail, /opened outside the bot/)
})

test('a take profit the broker holds but we never recorded is NOT a fault', () => {
  const a = auditProtection([row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: 1600 }])
  assert.equal(a.targetless.length, 0, 'the broker holds a target — that is what closes the trade')
})

test('a MOVED take profit is deliberately not reported', () => {
  // The profit keeper ratchets targets and partial ladders move them, so a
  // "we show X, broker holds Y" check on the target would fire during normal
  // operation. A check that cries wolf in normal operation gets ignored,
  // which is the same outcome as not having it. Missing is unambiguous.
  const a = auditProtection(
    [row({ current_sl: 1700, current_tp: 1600 })],
    [{ positionId: '555', stopLoss: 1700, takeProfit: 1450 }],
  )
  assert.equal(a.targetless.length, 0)
  assert.equal(a.phantom.length, 0, 'target disagreement is not in scope — see the module header')
})

test('the targetless alert is separate, quieter, and separately muted', async () => {
  const db = tmpDb()
  const sent = []
  const res = await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: null }], {
    nowMs: 1_000_000, sendMessage: async (m) => { sent.push(m) },
  })
  assert.equal(res.alerted, 0, 'nothing is unprotected — the siren must not fire')
  assert.equal(res.targetAlerted, 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /NO TAKE PROFIT/)
  assert.ok(!sent[0].includes('\u{1F6A8}'), 'a managed position with no target is not an emergency')
  assert.match(sent[0], /position-protect/, 'the message must say how to fix it')

  assert.deepEqual(
    db.prepare("SELECT method FROM action_log WHERE path='/protection-audit'").all().map(r => r.method),
    ['POSITION_NO_TARGET'],
  )
  assert.match(getState(db, 'targetless_position_alerts_json') || '', /555/)
  assert.equal(getState(db, 'naked_position_alerts_json'), '{}', 'the two mute maps are independent')
})

test('the targetless mute window is longer than the naked one by default', async () => {
  const db = tmpDb()
  const pos = [{ positionId: '555', stopLoss: 1700, takeProfit: null }]
  const sent = []
  const send = async (m) => { sent.push(m) }
  const t0 = 1_700_000_000_000
  await runProtectionAudit(db, [row({ current_sl: 1700 })], pos, { nowMs: t0, sendMessage: send })
  // Two hours on: past the 1h naked window, still inside the 6h target one.
  const again = await runProtectionAudit(db, [row({ current_sl: 1700 })], pos, { nowMs: t0 + 2 * 3600_000, sendMessage: send })
  assert.equal(again.targetAlerted, 0, 'a target gap does not repeat hourly')
  assert.equal(sent.length, 1)
  // Past the window it is due again — still open seven hours later is worth saying.
  const later = await runProtectionAudit(db, [row({ current_sl: 1700 })], pos, { nowMs: t0 + 7 * 3600_000, sendMessage: send })
  assert.equal(later.targetAlerted, 1)
})

test('the targetless mute map also forgets positions that are no longer open', async () => {
  const db = tmpDb()
  await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700 }], { nowMs: 1000, sendMessage: async () => {} })
  assert.match(getState(db, 'targetless_position_alerts_json'), /555/)
  await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: 1600 }], { nowMs: 2000, sendMessage: async () => {} })
  assert.equal(getState(db, 'targetless_position_alerts_json'), '{}')
})

// ---------------------------------------------------------------------------
// ¶D·2 — "Position protection audit — idle."
//
// What the owner saw during the 2026-07-29 broker outage. The audit runs
// inside the reconcile phase on broker truth; with the broker unreachable it
// did not run, so it said nothing — which on screen is indistinguishable from
// "checked everything, all clear". These tests pin the rule that it must never
// go blank: the last known state is always reported, with its age, and with
// the fact that it is no longer being confirmed.
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-07-29T00:00:00Z')

test('a completed audit is remembered with its numbers', async () => {
  const db = tmpDb()
  await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: 1600 }], {
    nowMs: T0, sendMessage: async () => {},
  })
  const last = lastProtectionAudit(db, { nowMs: T0 + 60_000 })
  assert.equal(last.hasRun, true)
  assert.equal(last.ok, true)
  assert.equal(last.checked, 1)
  assert.equal(last.naked, 0)
  assert.equal(last.ageSec, 60)
  assert.equal(last.stale, false)
  assert.match(last.summary, /1 position\(s\) checked, all protected \(1 min ago\)/)
})

test('THE OUTAGE: a blocked audit keeps the last known state and says it is unconfirmed', async () => {
  const db = tmpDb()
  // A good audit at T0 …
  await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: 1600 }], {
    nowMs: T0, sendMessage: async () => {},
  })
  // … then the broker goes away for 40 minutes.
  recordAuditUnavailable(db, 'reconcile failed: fetch failed', { nowMs: T0 + 40 * 60_000 })

  const last = lastProtectionAudit(db, { nowMs: T0 + 40 * 60_000 })
  // The numbers from the last real check MUST survive — they are the only
  // thing worth reporting during an outage.
  assert.equal(last.checked, 1)
  assert.equal(last.naked, 0)
  assert.equal(last.ageSec, 2400)
  assert.equal(last.lastAttemptOk, false)
  assert.match(last.lastAttemptError, /fetch failed/)
  // One line that carries BOTH the known state and the fact it is stale.
  assert.match(last.summary, /all protected \(as of 40 min ago\)/)
  assert.match(last.summary, /NOT CONFIRMED SINCE/)
})

test('an outage does not overwrite the findings with zeros', async () => {
  const db = tmpDb()
  await runProtectionAudit(db, [row()], [{ positionId: '555', stopLoss: null }], { nowMs: T0, sendMessage: async () => {} })
  recordAuditUnavailable(db, 'broker unreachable', { nowMs: T0 + 60_000 })
  const last = lastProtectionAudit(db, { nowMs: T0 + 60_000 })
  assert.equal(last.naked, 1, 'a position was unprotected and still is — that must not be erased by an outage')
  assert.match(last.summary, /1 with NO stop/)
})

test('NEVER RUN does not read as idle', () => {
  // "idle" sounds like a resting state. It means no open position has ever
  // been verified as protected, which is the most alarming state there is.
  const last = lastProtectionAudit(tmpDb(), { nowMs: T0 })
  assert.equal(last.hasRun, false)
  assert.equal(last.stale, true, 'never having run is the stalest possible state')
  assert.equal(last.ageSec, null)
  assert.match(last.summary, /never run/)
  assert.ok(!/idle/i.test(last.summary))
})

test('never run AND the attempt failed says so', () => {
  const db = tmpDb()
  recordAuditUnavailable(db, 'broker credentials not configured', { nowMs: T0 })
  const last = lastProtectionAudit(db, { nowMs: T0 })
  assert.equal(last.hasRun, false)
  assert.match(last.summary, /never completed/)
  assert.match(last.summary, /credentials not configured/)
})

test('staleness follows the cadence the audit is expected to run at', () => {
  const db = tmpDb()
  runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: 1600 }], {
    nowMs: T0, sendMessage: async () => {},
  })
  // Reconcile is every 3rd loop: 15 min at a 5-min loop, stale after 3× that.
  const opts = { expectedSec: 900 }
  assert.equal(lastProtectionAudit(db, { ...opts, nowMs: T0 + 40 * 60_000 }).stale, false)
  assert.equal(lastProtectionAudit(db, { ...opts, nowMs: T0 + 50 * 60_000 }).stale, true)
})

test('a recovered audit clears the unconfirmed marker', async () => {
  const db = tmpDb()
  recordAuditUnavailable(db, 'broker unreachable', { nowMs: T0 })
  await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: 1600 }], {
    nowMs: T0 + 60_000, sendMessage: async () => {},
  })
  const last = lastProtectionAudit(db, { nowMs: T0 + 60_000 })
  assert.equal(last.lastAttemptOk, null, 'the outage marker is gone once a real check succeeds')
  assert.ok(!/NOT CONFIRMED/.test(last.summary))
})

test('corrupt stored state degrades to "never run", not a crash', () => {
  const db = tmpDb()
  db.prepare("INSERT INTO agent_state (key, value) VALUES ('protection_audit_last_json', '{not json')").run()
  const last = lastProtectionAudit(db, { nowMs: T0 })
  assert.equal(last.hasRun, false)
  assert.match(last.summary, /never run/)
})

test('the audit never attaches a target itself', () => {
  // Choosing a take-profit price is a strategy judgement. A guessed one closes
  // trades where nothing supports it, which is worse than no target at all.
  const src = fs.readFileSync(new URL('./naked-position-guard.js', import.meta.url), 'utf8')
  assert.ok(!/wsAmend|amendPosition|placeOrder|closePosition/.test(src),
    'the protection audit must report, never act')
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
