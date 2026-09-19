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
  lastProtectionAudit, recordAuditUnavailable, bookHeldPositionIds, bookHeldTradeIds,
  MAX_APPLY_PER_PASS,
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
  assert.deepEqual(a, { naked: [], targetless: [], phantom: [], tpDrift: [], checked: 0, unmatched: 0 })
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

test('a MOVED take profit is reported as tpDrift — never as phantom, never alerted', () => {
  // The profit keeper ratchets targets and partial ladders move them, so a
  // "we show X, broker holds Y" check on the target would cry wolf if it
  // ALERTED. It stays out of the siren and out of the phantom list — but it is
  // no longer invisible: the book and the broker disagreeing on the target is
  // a fact the audit record now carries, report-only.
  const a = auditProtection(
    [row({ current_sl: 1700, current_tp: 1600 })],
    [{ positionId: '555', stopLoss: 1700, takeProfit: 1450 }],
  )
  assert.equal(a.targetless.length, 0)
  assert.equal(a.phantom.length, 0, 'target disagreement is not a stop disagreement')
  assert.equal(a.tpDrift.length, 1)
  assert.equal(a.tpDrift[0].ourTp, 1600)
  assert.equal(a.tpDrift[0].brokerTp, 1450)
  assert.equal(a.tpDrift[0].positionId, '555')
})

test('tpDrift needs BOTH targets present and a gap beyond 0.1% of price', () => {
  const both = (ourTp, brokerTp) => auditProtection(
    [row({ current_sl: 1700, current_tp: ourTp })],
    [{ positionId: '555', stopLoss: 1700, takeProfit: brokerTp }],
  ).tpDrift.length
  assert.equal(both(1600, 1600.5), 0, 'within 0.1% — rounding, not drift')
  assert.equal(both(1600, 1598), 1, 'beyond 0.1% — drift')
  assert.equal(both(null, 1450), 0, 'no book target: that is the "never recorded" case, not drift')
  assert.equal(both(1600, null), 0, 'no broker target: that is targetless, already reported')
  assert.equal(both(1600, 0), 0, 'a zero broker target is absent, not a drift to zero')
})

test('runProtectionAudit counts tpDrift in the record and does not alert or log it', async () => {
  const db = tmpDb()
  const sent = []
  const r = await runProtectionAudit(db,
    [row({ current_sl: 1700, current_tp: 1600 })],
    [{ positionId: '555', stopLoss: 1700, takeProfit: 1450 }],
    { sendMessage: async (t) => sent.push(t), nowMs: Date.now() },
  )
  assert.equal(r.tpDrift.length, 1)
  assert.equal(sent.length, 0, 'report only — no Telegram')
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM action_log WHERE path = '/protection-audit'`).get().c, 0, 'report only — no action_log row')
  const rec = JSON.parse(getState(db, 'protection_audit_last_json'))
  assert.equal(rec.tpDrift, 1, 'the audit record carries the count alongside phantom')
  assert.equal(rec.phantom, 0)
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

// ---------------------------------------------------------------------------
// THE GAP THAT LET A DEAD AUDIT SHIP.
//
// Every test above hands auditProtection a hand-built row object, so all 23 of
// them passed while the query the LOOP actually runs threw
// `no such column: ctrader_position_id` on every pass — that column is on
// `trades`, not `monitored_positions`. The audit never ran once between #476
// and 2026-07-29, and the panel's "idle" was the crash.
//
// Unit tests of a pure function cannot catch a broken SELECT. This one runs
// the real statement, lifted from loop.js, against a real schema.
// ---------------------------------------------------------------------------
test('THE LOOP QUERY runs against the real schema', () => {
  const db = tmpDb()
  const src = fs.readFileSync(new URL('../loop.js', import.meta.url), 'utf8')

  // Lift the statement out of loop.js rather than restating it here — a copy
  // would drift and re-open exactly the hole this test exists to close.
  const m = src.match(/SELECT mp\.id[\s\S]*?t\.ctrader_position_id IS NOT NULL/)
  assert.ok(m, 'could not find the protection-audit query in loop.js — re-point this test')

  // Throws on any column that does not exist. That is the whole assertion.
  const rows = db.prepare(m[0]).all()
  assert.ok(Array.isArray(rows))
})

test('the loop query returns the fields auditProtection reads', () => {
  const db = tmpDb()
  db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, volume, opened_at, ctrader_position_id, account_id)
              VALUES ('ETHUSD','SELL','open',1700,1723.26,1,'2026-07-29 01:00:00','555','43097342')`).run()
  const tradeId = db.prepare('SELECT last_insert_rowid() AS id').get().id
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, source, account_id, status)
              VALUES ('ETHUSD', ?, 'short', 1700, 1723.26, 'autopilot', '43097342', 'active')`).run(tradeId)

  const src = fs.readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const q = src.match(/SELECT mp\.id[\s\S]*?t\.ctrader_position_id IS NOT NULL/)[0]
  const rows = db.prepare(q).all()

  assert.equal(rows.length, 1)
  // A row that came back without the position id would be counted `unmatched`
  // and silently excluded — the audit would report "nothing to check" on a
  // book full of positions.
  assert.equal(String(rows[0].ctrader_position_id), '555')
  assert.equal(rows[0].current_sl, 1723.26)
  assert.equal(rows[0].source, 'autopilot')

  // And end-to-end: those rows must actually produce a finding.
  const a = auditProtection(rows, [{ positionId: '555', stopLoss: null, takeProfit: null }])
  assert.equal(a.naked.length, 1, 'the real query feeding the real audit must still detect a naked position')
  assert.equal(a.unmatched, 0)
})

// ---------------------------------------------------------------------------
// UNMATCHED IS NOT "FINE", AND ONE ACCOUNT IS NOT THE BOOK.
//
// Staging, 2026-07-29 03:19, first successful run after the wrong-table fix:
//   { checked: 4, unmatched: 4, summary: "4 position(s) checked, all protected" }
// All four positions were on account 46130058 and were compared against the
// PRIMARY account's broker snapshot, so none matched. The audit verified
// nothing and said everything was fine — the exact false reassurance this
// module exists to prevent, reproduced one level up.
// ---------------------------------------------------------------------------

test('THE STAGING CASE: nothing verified must not read as "all protected"', async () => {
  const db = tmpDb()
  // Four open rows, and a broker snapshot that mentions none of them.
  const rows = [1, 2, 3, 4].map(i => row({ id: i, ctrader_position_id: String(900 + i), current_sl: 1.5 }))
  await runProtectionAudit(db, rows, [{ positionId: '555', stopLoss: 1.5, takeProfit: 1.4 }], {
    nowMs: T0, sendMessage: async () => {},
  })
  const last = lastProtectionAudit(db, { nowMs: T0 })
  assert.equal(last.checked, 4)
  assert.equal(last.unmatched, 4)
  assert.match(last.summary, /NONE could be checked against broker truth/)
  assert.ok(!/all protected/.test(last.summary), 'claiming "all protected" here is the bug')
})

test('a PARTIAL match says how many were actually verified', () => {
  const a = auditProtection(
    [row({ id: 1, ctrader_position_id: '555', current_sl: 1.5 }),
      row({ id: 2, ctrader_position_id: '777', current_sl: 1.5 })],
    [{ positionId: '555', stopLoss: 1.5, takeProfit: 1.4 }],
  )
  assert.equal(a.checked, 2)
  assert.equal(a.unmatched, 1)
})

test('a partially-verified book names the gap instead of rounding it away', async () => {
  const db = tmpDb()
  await runProtectionAudit(db,
    [row({ id: 1, ctrader_position_id: '555', current_sl: 1.5 }),
      row({ id: 2, ctrader_position_id: '777', current_sl: 1.5 })],
    [{ positionId: '555', stopLoss: 1.5, takeProfit: 1.4 }],
    { nowMs: T0, sendMessage: async () => {} })
  const s = lastProtectionAudit(db, { nowMs: T0 }).summary
  assert.match(s, /1 of 2 position\(s\) verified, all protected/)
  assert.match(s, /1 could not be matched to broker truth/)
})

test('each account keeps its OWN record — the last one to run must not clobber the rest', async () => {
  const db = tmpDb()
  // Account A: one position, protected. Account B: one position, NAKED.
  await runProtectionAudit(db, [row({ id: 1, ctrader_position_id: '111', current_sl: 1.5, account_id: 'A' })],
    [{ positionId: '111', stopLoss: 1.5, takeProfit: 1.4 }],
    { nowMs: T0, accountId: 'A', sendMessage: async () => {} })
  await runProtectionAudit(db, [row({ id: 2, ctrader_position_id: '222', current_sl: null, account_id: 'B' })],
    [{ positionId: '222', stopLoss: null }],
    { nowMs: T0 + 1000, accountId: 'B', sendMessage: async () => {} })

  // Per-account reads stay separate.
  assert.equal(lastProtectionAudit(db, { nowMs: T0 + 1000, accountId: 'A' }).naked, 0)
  assert.equal(lastProtectionAudit(db, { nowMs: T0 + 1000, accountId: 'B' }).naked, 1)

  // The whole-book read SUMS them — B's naked position must not vanish
  // because A ran first and A was clean.
  const all = lastProtectionAudit(db, { nowMs: T0 + 1000 })
  assert.equal(all.checked, 2)
  assert.equal(all.naked, 1, 'the unprotected position on B must survive into the portfolio view')
  assert.equal(all.accounts, 2)
})

test('the whole-book age comes from the STALEST account, not the freshest', async () => {
  const db = tmpDb()
  await runProtectionAudit(db, [row({ id: 1, ctrader_position_id: '111', current_sl: 1.5 })],
    [{ positionId: '111', stopLoss: 1.5, takeProfit: 1.4 }],
    { nowMs: T0, accountId: 'A', sendMessage: async () => {} })
  await runProtectionAudit(db, [row({ id: 2, ctrader_position_id: '222', current_sl: 1.5 })],
    [{ positionId: '222', stopLoss: 1.5, takeProfit: 1.4 }],
    { nowMs: T0 + 20 * 60_000, accountId: 'B', sendMessage: async () => {} })

  // A portfolio is only as freshly verified as its stalest account. Reporting
  // the newest would let one healthy account mask five unchecked ones. (Both
  // records are inside the freshness window here — default 900 s × 3.)
  const all = lastProtectionAudit(db, { nowMs: T0 + 20 * 60_000 })
  assert.equal(all.ageSec, 1200, 'age must come from account A, the older check')
  assert.equal(all.accountsStale, 0)
})

test('THE PINNED PANEL (02-09-2026): a month-old record on an account nobody can audit any more is NAMED, not averaged in', async () => {
  // Production shape: four demo accounts audited every 60 s, two live accounts
  // last audited 04-08 (demo credentials cannot reach them), and the loop's
  // GLOBAL failure key from a 22-08 reconcile error that no per-account
  // success ever overwrites. The merge read "as of 41,315 min ago — NOT
  // CONFIRMED SINCE 22-08" while the heartbeat beat every minute.
  const db = tmpDb()
  const DAY = 86_400_000
  const now = T0 + 30 * DAY
  const good = (acct, at, extra = {}) => runProtectionAudit(db, [row({ id: 1, ctrader_position_id: '111', current_sl: 1.5, account_id: acct })],
    [{ positionId: '111', stopLoss: 1.5, takeProfit: 1.4 }], { nowMs: at, accountId: acct, sendMessage: async () => {}, ...extra })
  await good('LIVE-A', now - 28 * DAY)                          // stale: 28 days
  await good('DEMO-A', now - 60_000)
  await good('DEMO-B', now - 45_000)
  recordAuditUnavailable(db, 'reconcile failed: CH_CLIENT_AUTH_FAILURE', { nowMs: now - 10 * DAY }) // global key
  await good('DEMO-C', now - 30_000)

  const all = lastProtectionAudit(db, { nowMs: now })
  assert.equal(all.ageSec, 60, 'age is the stalest FRESH account, not the unauditable one')
  assert.equal(all.stale, false)
  assert.equal(all.accounts, 3)
  assert.equal(all.accountsStale, 1)
  assert.equal(all.staleAccounts[0].accountId, 'LIVE-A')
  assert.equal(all.staleAccounts[0].ageSec, 28 * 86_400)
  assert.equal(all.checked, 3, 'counts come from the fresh records only')
  assert.equal(all.lastAttemptOk, null, 'a global failure older than a later success is superseded')
  assert.doesNotMatch(all.summary, /NOT CONFIRMED SINCE/)
  assert.match(all.summary, /1 account\(s\) NOT audited for up to 40320 min: LIVE-A/)

  // A per-account failure is still a failure — its own success is the only
  // thing that clears it — and a global failure NEWER than every success counts.
  recordAuditUnavailable(db, 'broker unreachable for DEMO-C', { nowMs: now, accountId: 'DEMO-C' })
  const withFail = lastProtectionAudit(db, { nowMs: now })
  assert.equal(withFail.lastAttemptOk, false)
  assert.match(withFail.lastAttemptError, /DEMO-C/)
  recordAuditUnavailable(db, 'reconcile failed: fresh outage', { nowMs: now + 1000 })
  assert.match(lastProtectionAudit(db, { nowMs: now + 1000 }).lastAttemptError, /fresh outage/)

  // With NOTHING fresh the old rule stands: stalest of all, so the panel
  // never reads younger than the book really is.
  const later = lastProtectionAudit(db, { nowMs: now + 3 * DAY })
  assert.equal(later.stale, true)
  assert.equal(later.accountsStale, 0)
  assert.equal(later.ageSec, 31 * 86_400)
})

test('with every account failing, the whole-book read surfaces a real reason', () => {
  const db = tmpDb()
  recordAuditUnavailable(db, 'broker unreachable', { nowMs: T0, accountId: 'A' })
  recordAuditUnavailable(db, 'reconcile failed: boom', { nowMs: T0 + 5000, accountId: 'B' })
  const all = lastProtectionAudit(db, { nowMs: T0 + 5000 })
  assert.equal(all.hasRun, false)
  assert.match(all.summary, /never completed/)
  assert.match(all.summary, /boom|unreachable/, 'a bare "never run" hides why')
})

// ---------------------------------------------------------------------------
// Owner 01-08: the targetless alert proposes a TP and carries a one-tap
// Set-TP button, instead of only pointing at the curl.
// ---------------------------------------------------------------------------

test('targetless alert includes the suggested TP and a prottp button', async () => {
  const db = tmpDb()
  const sent = []
  await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700 }], {
    nowMs: 1_000_000,
    sendMessage: async (m, opts) => { sent.push({ m, opts }) },
    suggestTarget: async () => ({ tp: 1885.5, basis: 'HVN volume node, 2.1R' }),
  })
  assert.equal(sent.length, 1)
  assert.match(sent[0].m, /suggested TP 1885.5 \(HVN volume node, 2.1R\)/)
  const btn = sent[0].opts.buttons[0][0]
  assert.equal(btn.callback_data, 'prottp|555|1885.5')
  assert.match(btn.text, /Set TP 1885.5 on ETHUSD/)
})

test('a null/failed suggestion degrades to the original alert, no button', async () => {
  const db = tmpDb()
  const sent = []
  await runProtectionAudit(db, [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700 }], {
    nowMs: 1_000_000,
    sendMessage: async (m, opts) => { sent.push({ m, opts }) },
    suggestTarget: async () => { throw new Error('bars unavailable') },
  })
  assert.equal(sent.length, 1, 'the alert itself must never wait on structure')
  assert.match(sent[0].m, /NO TAKE PROFIT/)
  assert.ok(!sent[0].m.includes('suggested TP'))
  assert.equal(sent[0].opts, undefined, 'no buttons when nothing was suggested')
})

// ---------------------------------------------------------------------------
// THE DURABLE TRAIL IS RATE-LIMITED. It was not: the mute windows gated
// Telegram only, so action_log got a row per finding per pass. protection_audit
// is loop-tied, so one standing POSITION_STOP_MISMATCH wrote a row every few
// minutes indefinitely — and until the reconciler learned to converge a
// standing disagreement, nothing could ever clear it.
// ---------------------------------------------------------------------------

const logRows = (db, method) => db.prepare(
  `SELECT COUNT(*) n FROM action_log WHERE method = ? AND path = '/protection-audit'`).get(method).n

test('action_log: a standing mismatch logs ONCE per mute window, not once per pass', async () => {
  const db = tmpDb()
  const t0 = Date.parse('2026-08-02T00:00:00Z')
  const mismatch = [{ positionId: '555', stopLoss: 1700, takeProfit: 1900 }]
  const ours = () => [row({ current_sl: 1650 })]   // 1650 vs 1700 → phantom

  await runProtectionAudit(db, ours(), mismatch, { nowMs: t0 })
  assert.equal(logRows(db, 'POSITION_STOP_MISMATCH'), 1, 'first sighting is recorded')

  // Nineteen more loop cycles, all inside the hour (57 min) — the condition
  // has not changed, and neither should the log.
  for (let i = 1; i <= 19; i++) {
    await runProtectionAudit(db, ours(), mismatch, { nowMs: t0 + i * 3 * 60_000 })
  }
  assert.equal(logRows(db, 'POSITION_STOP_MISMATCH'), 1, 'still one row 57 minutes later')

  // Past the window it logs again, so duration stays reconstructable.
  await runProtectionAudit(db, ours(), mismatch, { nowMs: t0 + 3700_000 })
  assert.equal(logRows(db, 'POSITION_STOP_MISMATCH'), 2)
})

test('action_log: the mute is per position AND per kind', async () => {
  const db = tmpDb()
  const t0 = Date.parse('2026-08-02T00:00:00Z')
  // One naked position and one targetless position, both live at once.
  const rows = [
    row({ id: 1, trade_id: 10, ctrader_position_id: '555', current_sl: 1650 }),
    row({ id: 2, trade_id: 11, symbol: 'BTCUSD', ctrader_position_id: '666', current_sl: 90000 }),
  ]
  const broker = [
    { positionId: '555', stopLoss: null, takeProfit: null },      // naked
    { positionId: '666', stopLoss: 89000, takeProfit: null },     // targetless
  ]
  await runProtectionAudit(db, rows, broker, { nowMs: t0 })
  assert.equal(logRows(db, 'POSITION_UNPROTECTED'), 1)
  assert.equal(logRows(db, 'POSITION_NO_TARGET'), 1)
  await runProtectionAudit(db, rows, broker, { nowMs: t0 + 3 * 60_000 })
  assert.equal(logRows(db, 'POSITION_UNPROTECTED'), 1, 'muted independently')
  assert.equal(logRows(db, 'POSITION_NO_TARGET'), 1)
})

test('action_log: a condition that CLEARS and returns logs again immediately', async () => {
  const db = tmpDb()
  const t0 = Date.parse('2026-08-02T00:00:00Z')
  const naked = [{ positionId: '555', stopLoss: null, takeProfit: null }]
  const fixed = [{ positionId: '555', stopLoss: 1700, takeProfit: 1900 }]

  await runProtectionAudit(db, [row()], naked, { nowMs: t0 })
  assert.equal(logRows(db, 'POSITION_UNPROTECTED'), 1)
  // A stop gets set — the finding disappears and the mute must not outlive it.
  await runProtectionAudit(db, [row({ current_sl: 1700 })], fixed, { nowMs: t0 + 60_000 })
  // It goes naked again five minutes later. That is NEW information and must
  // be recorded now, not an hour from now.
  await runProtectionAudit(db, [row()], naked, { nowMs: t0 + 300_000 })
  assert.equal(logRows(db, 'POSITION_UNPROTECTED'), 2, 'a re-occurrence is not muted')
})

// ---------------------------------------------------------------------------
// THE MUTE MAPS ARE PER ACCOUNT (owner, 04-08-2026)
//
// The owner pasted three targetless alerts, two of them the identical USDBRL
// position. The mute maps were global while this pass runs once per account,
// and the prune step deletes every entry whose position is not in THIS pass's
// findings — so account A alerted and stamped its ids, account B's pass pruned
// them as "no longer open", and A re-alerted on the next cycle. Between two
// accounts the mute window was not leaky, it was cancelled.
// ---------------------------------------------------------------------------

test('one account\'s pass does not un-mute another account\'s alert', async () => {
  const db = initDB(':memory:')
  const sent = []
  const send = async (m) => { sent.push(m) }

  const posA = { positionId: 'A1', symbol: 'USDBRL', stopLoss: 5.09, takeProfit: null }
  const posB = { positionId: 'B1', symbol: 'EURNOK', stopLoss: 10.9, takeProfit: null }
  const rowA = [{ id: 1, ctrader_position_id: 'A1', symbol: 'USDBRL', current_sl: 5.09, account_id: 'A' }]
  const rowB = [{ id: 2, ctrader_position_id: 'B1', symbol: 'EURNOK', current_sl: 10.9, account_id: 'B' }]

  // Account A alerts once…
  await runProtectionAudit(db, rowA, [posA], { sendMessage: send, accountId: 'A' })
  const afterA = sent.length
  assert.ok(afterA > 0, 'A must alert the first time')

  // …account B runs its own pass on its own book…
  await runProtectionAudit(db, rowB, [posB], { sendMessage: send, accountId: 'B' })

  // …and A, still inside its mute window, must stay silent.
  const before = sent.length
  await runProtectionAudit(db, rowA, [posA], { sendMessage: send, accountId: 'A' })
  assert.equal(sent.length, before, 'A was muted; B\'s pass must not have cleared that')
})

test('the prune still works WITHIN an account — a closed position stops being remembered', async () => {
  // Scoping the map must not cost the bound it was there for.
  const db = initDB(':memory:')
  const send = async () => {}
  const pos = { positionId: 'A1', symbol: 'USDBRL', stopLoss: 5.09, takeProfit: null }
  await runProtectionAudit(db, [{ id: 1, ctrader_position_id: 'A1', symbol: 'USDBRL', current_sl: 5.09, account_id: 'A' }], [pos], { sendMessage: send, accountId: 'A' })
  assert.match(getState(db, 'acct:A:targetless_position_alerts_json') || '', /A1/)
  await runProtectionAudit(db, [], [], { sendMessage: send, accountId: 'A' })
  const after = JSON.parse(getState(db, 'acct:A:targetless_position_alerts_json') || '{}')
  assert.deepEqual(Object.keys(after), [], 'nothing open, nothing remembered')
})

// ---------------------------------------------------------------------------
// APPLYING THE TARGET (owner, 04-08-2026: "SO MANY POSITIONS WITH NO TARGET SET")
//
// The suggestion had been computed and printed for days while nothing acted on
// it. §43: protection must have its own functioning path — a target that only
// appears if someone taps a phone is not one.
// ---------------------------------------------------------------------------

const targetlessPos = (id = 'P1', sym = 'USDBRL') =>
  ({ positionId: id, symbol: sym, stopLoss: 5.09, takeProfit: null })
const targetlessRow = (id = 'P1', sym = 'USDBRL', extra = {}) =>
  ({ id: 1, ctrader_position_id: id, symbol: sym, current_sl: 5.09, account_id: 'A', ...extra })

test('a bot-adopted targetless position gets its suggested target SET', async () => {
  const db = initDB(':memory:')
  const sent = []
  const applied = []
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    sendMessage: async (m) => { sent.push(m) },
    accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f, s) => { applied.push([f.positionId, s.tp]); return { ok: true } },
  })
  assert.deepEqual(applied, [['P1', 5.4]])
  assert.match(sent[0], /TP SET to 5\.4/)
  assert.match(sent[0], /SET AUTOMATICALLY/)
})

test('a position opened OUTSIDE the bot is never touched', async () => {
  // The owner's own trade and the owner's own exit.
  const db = initDB(':memory:')
  const sent = []
  const applied = []
  await runProtectionAudit(db, [targetlessRow('P2', 'GBPAUD', { source: 'external' })], [targetlessPos('P2', 'GBPAUD')], {
    sendMessage: async (m) => { sent.push(m) },
    accountId: 'A',
    suggestTarget: async () => ({ tp: 2.1, basis: 'HVN' }),
    applyTarget: async () => { applied.push('should not happen'); return { ok: true } },
  })
  assert.deepEqual(applied, [])
  assert.match(sent[0], /opened outside the bot, left alone/)
})

test('no suggestion means no target — an invented one is worse than none', async () => {
  const db = initDB(':memory:')
  const applied = []
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    sendMessage: async () => {},
    accountId: 'A',
    suggestTarget: async () => null,
    applyTarget: async () => { applied.push('should not happen'); return { ok: true } },
  })
  assert.deepEqual(applied, [])
})

test('a FAILED amend still alerts, and still offers the button', async () => {
  // The alert is the fallback. Losing it because the amend failed would leave
  // the position targetless AND silent, which is worse than before.
  const db = initDB(':memory:')
  const sent = []
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    sendMessage: async (m) => { sent.push(m) },
    accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => ({ ok: false, error: 'broker said no' }),
  })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /suggested TP 5\.4/)
  assert.ok(!/TP SET to/.test(sent[0]))
})

test('an amend that THROWS does not lose the alert either', async () => {
  const db = initDB(':memory:')
  const sent = []
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    sendMessage: async (m) => { sent.push(m) },
    accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => { throw new Error('network') },
  })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /suggested TP 5\.4/)
})

test('with no applyTarget wired the behaviour is exactly what it was', async () => {
  const db = initDB(':memory:')
  const sent = []
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    sendMessage: async (m) => { sent.push(m) },
    accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
  })
  assert.match(sent[0], /suggested TP 5\.4/)
  assert.ok(!/SET AUTOMATICALLY/.test(sent[0]))
})

test('the pre-per-account GLOBAL success record is a fossil once any account has its own — not a stale account called "?"', async () => {
  // Production 02-09-2026 after #812: staleAccounts listed "null@29d" — the
  // 04-08 global record from before the M2 per-account split.
  const db = tmpDb()
  const DAY = 86_400_000
  const now = T0 + 30 * DAY
  await runProtectionAudit(db, [row({ id: 1, ctrader_position_id: '111', current_sl: 1.5 })],
    [{ positionId: '111', stopLoss: 1.5, takeProfit: 1.4 }], { nowMs: now - 29 * DAY, sendMessage: async () => {} }) // global key, no accountId
  await runProtectionAudit(db, [row({ id: 1, ctrader_position_id: '111', current_sl: 1.5, account_id: 'DEMO-A' })],
    [{ positionId: '111', stopLoss: 1.5, takeProfit: 1.4 }], { nowMs: now - 60_000, accountId: 'DEMO-A', sendMessage: async () => {} })
  const all = lastProtectionAudit(db, { nowMs: now })
  assert.equal(all.accounts, 1)
  assert.equal(all.accountsStale, 0, 'the global fossil is not an account')
  assert.equal(all.ageSec, 60)
  // With ONLY the global record (a pre-M2 database) it still reads as the book.
  const db2 = tmpDb()
  await runProtectionAudit(db2, [row({ id: 1, ctrader_position_id: '111', current_sl: 1.5 })],
    [{ positionId: '111', stopLoss: 1.5, takeProfit: 1.4 }], { nowMs: now - 60_000, sendMessage: async () => {} })
  assert.equal(lastProtectionAudit(db2, { nowMs: now }).ageSec, 60)
})

// ---------------------------------------------------------------------------
// THE MOMENTUM BOOK'S ROWS ARE NEVER GIVEN A TARGET (09-09-2026)
//
// A book row exits by the trail; a 1.5R floor on a position meant to run for
// weeks caps the right tail the system is built on. Measured: three 0005.HK
// rows were amended at 09:36 SGT, six minutes after the HK open put hourly
// bars under the suggester, with nothing on stdout to say so.
// ---------------------------------------------------------------------------

const bookRow = (db, positionId, accountId = 'A', symbol = '0005.HK', status = 'open') =>
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
              VALUES (1, ?, ?, ?, 'long', 160, 159.642, '2026-09-08T01:33:00Z', ?)`).run(accountId, symbol, positionId, status)

test('a momentum-book row is reported but NEVER amended, and the alert says why', async () => {
  const db = initDB(':memory:')
  bookRow(db, 'P7')
  const sent = []
  const applied = []
  await runProtectionAudit(db, [targetlessRow('P7', '0005.HK')], [targetlessPos('P7', '0005.HK')], {
    sendMessage: async (m, opts) => { sent.push([m, opts]) },
    accountId: 'A',
    suggestTarget: async () => ({ tp: 175, basis: '1.5R floor from entry' }),
    applyTarget: async () => { applied.push('should not happen'); return { ok: true } },
  })
  assert.deepEqual(applied, [], 'the book row must not be amended')
  assert.match(sent[0][0], /0005\.HK .*momentum-book row, exits by trail, left alone/)
  assert.ok(!/TP SET to/.test(sent[0][0]))
  assert.ok(!/SET AUTOMATICALLY/.test(sent[0][0]))
  // No one-tap button either — the button is the same amend by another door.
  assert.equal(sent[0][1], undefined, 'no Set-TP button for a book row')
})

test('an exit_sent book row counts as held; a closed one does not', async () => {
  const db = initDB(':memory:')
  bookRow(db, 'P8', 'A', 'MSFT.US', 'exit_sent')
  bookRow(db, 'P9', 'A', 'AAPL.US', 'closed')
  const applied = []
  await runProtectionAudit(db, [targetlessRow('P8', 'MSFT.US'), { ...targetlessRow('P9', 'AAPL.US'), id: 2 }],
    [targetlessPos('P8', 'MSFT.US'), targetlessPos('P9', 'AAPL.US')], {
      sendMessage: async () => {},
      accountId: 'A',
      suggestTarget: async () => ({ tp: 999, basis: 'HVN' }),
      applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
    })
  assert.deepEqual(applied, ['P9'], 'only the row the book has let go is fair game')
})

test('a book row on ANOTHER account does not shield this one', async () => {
  // The exemption is per account, like the book itself: the same position id
  // on a different account is a different position.
  const db = initDB(':memory:')
  bookRow(db, 'P10', 'B')
  const applied = []
  await runProtectionAudit(db, [targetlessRow('P10', '0005.HK')], [targetlessPos('P10', '0005.HK')], {
    sendMessage: async () => {},
    accountId: 'A',
    suggestTarget: async () => ({ tp: 175, basis: 'HVN' }),
    applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
  })
  assert.deepEqual(applied, ['P10'])
})

test('bookHeldPositionIds: scoped by account when given, all accounts otherwise', () => {
  const db = initDB(':memory:')
  bookRow(db, 'X1', 'A')
  bookRow(db, 'X2', 'B')
  assert.deepEqual([...bookHeldPositionIds(db, 'A')], ['X1'])
  assert.deepEqual([...bookHeldPositionIds(db)].sort(), ['X1', 'X2'])
})

test('an applied target is written to stdout, not only to Telegram', async () => {
  // The Telegram line was the only record; the count moved in the Railway log
  // with no line saying why. A target that appears on a position must be
  // attributable from the log.
  const db = initDB(':memory:')
  const lines = []
  const orig = console.log
  console.log = (...a) => { lines.push(a.join(' ')) }
  try {
    await runProtectionAudit(db, [targetlessRow('P11', 'USDBRL')], [targetlessPos('P11', 'USDBRL')], {
      sendMessage: async () => {},
      accountId: 'A',
      suggestTarget: async () => ({ tp: 5.4, basis: 'HVN volume node, 2.1R' }),
      applyTarget: async () => ({ ok: true }),
    })
  } finally { console.log = orig }
  assert.ok(lines.some(l => /\[protection\] A: target SET on USDBRL \(position P11\) — TP 5\.4 \(HVN volume node, 2\.1R\)/.test(l)), lines.join('\n'))
})

// ---------------------------------------------------------------------------
// THE APPLIER COULD NOT REACH THE POSITIONS IT WAS BUILT FOR (16-09-2026)
//
// Measured in production: `17 targetless` on every pass, stable for 4.5 days,
// and exactly ONE `target SET` line across 12-09 → 16-09. The applier worked.
// It almost never got to run, for two independent reasons:
//
//  1. ONE MUTE MAP, TWO CALLERS AT DIFFERENT RATES. `lastTargetAlerts` gated
//     both alerting and applying. runProtectionAuditAllAccounts (fast monitor,
//     ~60s, no applier — no production caller set deps.auditOpts) consumed the
//     6-hour window before the loop pass (~3–5 min, WITH the applier) could.
//  2. THE APPLY LOOP WAS INSIDE THE TELEGRAM BRANCH, so with no bot token it
//     did not exist. Setting protection is not a notification.
//
// The invariant these pin: A FINDING ELIGIBLE FOR A TARGET CANNOT BE MUTED BY
// A PASS THAT COULD NOT HAVE APPLIED ONE.
// ---------------------------------------------------------------------------

test('THE PRODUCTION DEFECT: the fast pass running first no longer starves the applier', async () => {
  // End to end, in the order production ran it. Pass 1 is the fast monitor's
  // sweep before this fix reached it: it alerts and mutes, it cannot apply.
  // Pass 2, three minutes later, is the loop pass that CAN. Before the split
  // it found the window consumed and applied nothing for six hours.
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const applied = []
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs: t0, accountId: 'A', sendMessage: async () => {},
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    // no applyTarget — the fast path as it was
  })
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs: t0 + 3 * 60_000, accountId: 'A', sendMessage: async () => {},
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f, s) => { applied.push([f.positionId, s.tp]); return { ok: true } },
  })
  assert.deepEqual(applied, [['P1', 5.4]], 'the pass that CAN apply is not muted by the pass that cannot')
})

test('a pass with no applier leaves the apply window untouched', async () => {
  // The invariant, read straight off the state. The alert map is stamped (it
  // did alert); the apply map must not be, because nothing could be applied.
  const db = initDB(':memory:')
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs: 1000, accountId: 'A', sendMessage: async () => {},
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
  })
  assert.deepEqual(
    JSON.parse(getState(db, 'acct:A:targetless_position_alerts_json') || '{}'),
    { P1: 1000 }, 'the ALERT window was consumed — an alert did go out')
  assert.deepEqual(
    JSON.parse(getState(db, 'acct:A:targetless_apply_attempts_json') || '{}'),
    {}, 'the APPLY window was not')
})

test('a pass WITH an applier stamps the apply window, and the next one waits', async () => {
  // The other half: the window has to bound something, or a refused amend
  // becomes a sixty-second retry storm against the broker.
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const applied = []
  const run = (nowMs) => runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs, accountId: 'A', sendMessage: async () => {},
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { applied.push(f.positionId); return { ok: false, error: 'broker said no' } },
  })
  await run(t0)
  await run(t0 + 60_000)
  await run(t0 + 3 * 3600_000)
  assert.deepEqual(applied, ['P1'], 'one attempt inside the window')
  await run(t0 + 7 * 3600_000)
  assert.deepEqual(applied, ['P1', 'P1'], 'and it is retried once the window expires')
})

test('the applier runs with NO sendMessage at all — protection is not a notification', async () => {
  // TELEGRAM_BOT_TOKEN unset is the production configuration this has to
  // survive: the apply loop used to be nested inside the sendMessage branch,
  // so a missing chat token meant no target was ever set.
  const db = initDB(':memory:')
  const applied = []
  const r = await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f, s) => { applied.push([f.positionId, s.tp]); return { ok: true } },
  })
  assert.deepEqual(applied, [['P1', 5.4]])
  assert.equal(r.targetsApplied, 1)
})

test('a sendMessage that THROWS does not cost the target either', async () => {
  const db = initDB(':memory:')
  const applied = []
  const r = await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A',
    sendMessage: async () => { throw new Error('telegram 502') },
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
  })
  assert.deepEqual(applied, ['P1'], 'the amend already happened before the alert was attempted')
  assert.equal(r.targetsApplied, 1)
})

test('WITHOUT TELEGRAM the exemptions still hold: external and book rows are untouched', async () => {
  // Hoisting the apply loop out of the alert branch is exactly the change that
  // could have dropped the guards that lived beside it.
  const db = initDB(':memory:')
  bookRow(db, 'PB1')
  const applied = []
  await runProtectionAudit(db,
    [targetlessRow('PB1', '0005.HK'), { ...targetlessRow('PX1', 'GBPAUD', { source: 'external' }), id: 2 }],
    [targetlessPos('PB1', '0005.HK'), targetlessPos('PX1', 'GBPAUD')], {
      accountId: 'A', // no sendMessage
      suggestTarget: async () => ({ tp: 999, basis: 'HVN' }),
      applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
    })
  assert.deepEqual(applied, [], 'neither exemption may be reached by the hoisted loop')
})

test('an exempt position is never even asked for a suggestion', async () => {
  // The bar fetch is the expensive half and the amend is the dangerous half.
  // A book row must reach neither.
  const db = initDB(':memory:')
  bookRow(db, 'PB2')
  const asked = []
  await runProtectionAudit(db, [targetlessRow('PB2', '0005.HK')], [targetlessPos('PB2', '0005.HK')], {
    accountId: 'A',
    sendMessage: async () => {},
    suggestTarget: async (f) => { asked.push(f.positionId); return { tp: 175, basis: 'HVN' } },
    applyTarget: async () => ({ ok: true }),
  })
  assert.deepEqual(asked, [], 'no structure fetched for a position that can never be amended')
})

test('applyExcludeIds hands the position to target-restore instead of amending it twice', async () => {
  const db = initDB(':memory:')
  const applied = []
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A',
    sendMessage: async () => {},
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
    applyExcludeIds: new Set(['P1']),
  })
  assert.deepEqual(applied, [], 'the recorded target is the more faithful repair; one amend per pass')
})

test('the suggestion is fetched ONCE for a position that is both applied and alerted', async () => {
  const db = initDB(':memory:')
  let calls = 0
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A',
    sendMessage: async () => {},
    suggestTarget: async () => { calls++; return { tp: 5.4, basis: 'HVN' } },
    applyTarget: async () => ({ ok: true }),
  })
  assert.equal(calls, 1)
})

test('a suggester that returns nothing mints no button and reads no .tp off null', async () => {
  // The memo now stores MISSES as null too, so a `.has()` test would offer a
  // Set-TP button for a position that has no suggested price.
  const db = initDB(':memory:')
  const sent = []
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A',
    sendMessage: async (m, opts) => { sent.push([m, opts]) },
    suggestTarget: async () => null,
    applyTarget: async () => ({ ok: true }),
  })
  assert.equal(sent[0][1], undefined, 'no button without a price')
  assert.ok(!/suggested TP/.test(sent[0][0]))
})

// ---------------------------------------------------------------------------
// THE CLASS BREAKDOWN ON STDOUT
//
// Production logged `17 targetless` every pass and nothing else. That number
// cannot tell a momentum-book row holding no target BY DESIGN from a position
// that lost its target and should get one back — which is how it sat for days.
// ---------------------------------------------------------------------------

const captureLog = async (fn) => {
  const lines = []
  const orig = console.log
  console.log = (...a) => { lines.push(a.join(' ')) }
  try { await fn() } finally { console.log = orig }
  return lines
}

test('the class breakdown reports the REAL counts, beside the bare total', async () => {
  const db = initDB(':memory:')
  bookRow(db, 'C1')
  bookRow(db, 'C2', 'A', 'MSFT.US')
  const rows = [
    { ...targetlessRow('C1', '0005.HK'), id: 1 },
    { ...targetlessRow('C2', 'MSFT.US'), id: 2 },
    { ...targetlessRow('C3', 'GBPAUD', { source: 'external' }), id: 3 },
    { ...targetlessRow('C4', 'USDBRL'), id: 4 },
  ]
  const pos = rows.map(r => targetlessPos(r.ctrader_position_id, r.symbol))
  const lines = await captureLog(() => runProtectionAudit(db, rows, pos, {
    accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => ({ ok: true }),
  }))
  const line = lines.find(l => /targetless —/.test(l))
  assert.ok(line, lines.join('\n'))
  assert.match(line, /^\[protection\] A: 4 targetless — /)
  assert.match(line, /2 momentum-book \(trail only\)/)
  assert.match(line, /1 external \(left alone — the human's own\)/)
  assert.match(line, /1 bot-owned \(target applied\)/)
})

test('the breakdown names a pass that has NO APPLIER WIRED — the defect, visible in the log', async () => {
  // The whole reason this line exists. 17 targetless with no applier reachable
  // is a standing fault; 17 targetless that are all book rows is a standing
  // fact. The log could not tell them apart.
  const db = initDB(':memory:')
  const lines = await captureLog(() => runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A', sendMessage: async () => {},
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
  }))
  assert.ok(lines.some(l => /1 targetless — 1 bot-owned \(NO APPLIER WIRED\)/.test(l)), lines.join('\n'))
})

test('the breakdown separates a refused amend from an uncomputable target', async () => {
  const db = initDB(':memory:')
  const lines = await captureLog(() => runProtectionAudit(db,
    [targetlessRow('D1', 'USDBRL'), { ...targetlessRow('D2', 'EURUSD'), id: 2 }],
    [targetlessPos('D1', 'USDBRL'), targetlessPos('D2', 'EURUSD')], {
      accountId: 'A',
      // The default cap is 1; this test is about classification, not the cap.
      maxApplyPerPass: 2,
      suggestTarget: async (f) => (f.positionId === 'D1' ? { tp: 5.4, basis: 'HVN' } : null),
      applyTarget: async () => ({ ok: false, error: 'broker said no' }),
    }))
  const line = lines.find(l => /targetless —/.test(l))
  assert.match(line, /1 bot-owned \(apply refused\)/)
  assert.match(line, /1 bot-owned \(no target computable\)/)
})

test('no targetless positions, no breakdown line', async () => {
  const db = initDB(':memory:')
  const lines = await captureLog(() => runProtectionAudit(db,
    [row({ current_sl: 1700 })], [{ positionId: '555', stopLoss: 1700, takeProfit: 1600 }],
    { accountId: 'A', sendMessage: async () => {} }))
  assert.ok(!lines.some(l => /targetless —/.test(l)), lines.join('\n'))
})

test('the apply window is pruned when the position stops being targetless', async () => {
  // A position that loses its target TWICE is a fault to act on, not one to
  // sit out a six-hour window left over from the first time.
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const applied = []
  const opts = (nowMs) => ({
    nowMs, accountId: 'A', sendMessage: async () => {},
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
  })
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], opts(t0))
  // Target now present at the broker — the finding is gone.
  await runProtectionAudit(db, [targetlessRow()], [{ ...targetlessPos(), takeProfit: 5.4 }], opts(t0 + 60_000))
  assert.deepEqual(JSON.parse(getState(db, 'acct:A:targetless_apply_attempts_json') || '{}'), {})
  // It goes missing again a minute later: acted on at once, not in six hours.
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], opts(t0 + 120_000))
  assert.deepEqual(applied, ['P1', 'P1'])
})

// ---------------------------------------------------------------------------
// THE REVIEW ROUND (16-09-2026). Every one of these is a defect the first draft
// of this change shipped, each reproduced before it was fixed.
// ---------------------------------------------------------------------------

test('BLOCKER: a book row whose position_id is still NULL is STILL exempt', async () => {
  // `momentum_book.position_id` is written once at insert and is NULL whenever
  // the trade had no broker position id yet — the resting-limit path the book
  // uses at closed markets. Nothing backfills it. The exemption keyed only off
  // position_id therefore failed OPEN, and `momentum-account.js` clears
  // `current_tp` on exactly these rows so target-restore does not cover them
  // either: a momentum runner capped at a 1.5R floor, by the fix meant to help.
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
              VALUES (77, 'A', '0005.HK', NULL, 'long', 160, 159.642, '2026-09-08T01:33:00Z', 'open')`).run()
  const applied = []
  const lines = await captureLog(() => runProtectionAudit(db,
    [{ ...targetlessRow('PN1', '0005.HK'), trade_id: 77 }], [targetlessPos('PN1', '0005.HK')], {
      accountId: 'A',
      suggestTarget: async () => ({ tp: 175, basis: '1.5R floor from entry' }),
      applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
    }))
  assert.deepEqual(applied, [], 'the trade_id key must catch what the position_id key misses')
  assert.ok(lines.some(l => /1 momentum-book \(trail only\)/.test(l)), lines.join('\n'))
})

test('the trade_id key is scoped by account, like the position_id key', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
              VALUES (77, 'B', '0005.HK', NULL, 'long', 160, 159.642, '2026-09-08T01:33:00Z', 'open')`).run()
  const applied = []
  await runProtectionAudit(db, [{ ...targetlessRow('PN2', '0005.HK'), trade_id: 77 }], [targetlessPos('PN2', '0005.HK')], {
    accountId: 'A',
    suggestTarget: async () => ({ tp: 175, basis: 'HVN' }),
    applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
  })
  assert.deepEqual(applied, ['PN2'], "another account's book row is another position")
})

test('a closed book row with a NULL position_id does not shield anything', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
              VALUES (77, 'A', '0005.HK', NULL, 'long', 160, 159.642, '2026-09-08T01:33:00Z', 'closed')`).run()
  const applied = []
  await runProtectionAudit(db, [{ ...targetlessRow('PN3', '0005.HK'), trade_id: 77 }], [targetlessPos('PN3', '0005.HK')], {
    accountId: 'A',
    suggestTarget: async () => ({ tp: 175, basis: 'HVN' }),
    applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
  })
  assert.deepEqual(applied, ['PN3'], 'the book has let this one go')
})

test('bookHeldTradeIds: only open/exit_sent rows, scoped when asked', () => {
  const db = initDB(':memory:')
  const ins = (tid, acct, status) => db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
              VALUES (?, ?, 'X', NULL, 'long', 1, 0.9, 'now', ?)`).run(tid, acct, status)
  ins(1, 'A', 'open'); ins(2, 'A', 'exit_sent'); ins(3, 'A', 'closed'); ins(4, 'B', 'open')
  assert.deepEqual([...bookHeldTradeIds(db, 'A')].sort(), ['1', '2'])
  assert.deepEqual([...bookHeldTradeIds(db)].sort(), ['1', '2', '4'])
})

test("BLOCKER: two passes racing on the same position amend it ONCE", async () => {
  // Door 1. The ~60s sweep and the loop's pass interleave on the await inside
  // getSuggestion; before the claim was made durable-before-amend, both read an
  // empty window and both amended. This PR is what opened that door — before
  // it, the sweep had no applier to race with.
  const db = initDB(':memory:')
  const amends = []
  const slowSuggest = (tag) => async () => {
    await new Promise(r => setTimeout(r, tag === 'loop' ? 20 : 5))
    return { tp: 5.4, basis: 'HVN' }
  }
  const pass = (tag) => runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A',
    suggestTarget: slowSuggest(tag),
    applyTarget: async (f) => { amends.push(`${tag}:${f.positionId}`); return { ok: true } },
  })
  await Promise.all([pass('loop'), pass('sweep')])
  assert.equal(amends.length, 1, `one position, one amend — got ${JSON.stringify(amends)}`)
})

test('BLOCKER: two monitored rows with the SAME position id amend it once', async () => {
  // Door 2. `findOpenDuplicates` and `duplicate-watch` exist because duplicate
  // open rows happen; the due list was computed against the pre-pass map, so
  // both rows passed the window test.
  const db = initDB(':memory:')
  const amends = []
  const r = await runProtectionAudit(db,
    [{ ...targetlessRow(), id: 1 }, { ...targetlessRow(), id: 2 }],
    [targetlessPos()], {
      accountId: 'A',
      suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
      applyTarget: async (f) => { amends.push(f.positionId); return { ok: true } },
    })
  assert.deepEqual(amends, ['P1'])
  assert.equal(r.targetsApplied, 1)
})

test('the duplicate guard does not depend on the mute window being non-zero', async () => {
  // The claim alone would reject the second row only because 0 < applyMuteMs.
  // With the window at zero that argument disappears; the explicit set does not.
  const db = initDB(':memory:')
  const amends = []
  await runProtectionAudit(db,
    [{ ...targetlessRow(), id: 1 }, { ...targetlessRow(), id: 2 }],
    [targetlessPos()], {
      accountId: 'A', applyMuteMs: 0,
      suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
      applyTarget: async (f) => { amends.push(f.positionId); return { ok: true } },
    })
  assert.deepEqual(amends, ['P1'])
})

test('the claim is persisted BEFORE the amend, not after the pass', async () => {
  const db = initDB(':memory:')
  let stampAtAmendTime = null
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs: 5000, accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => {
      stampAtAmendTime = JSON.parse(getState(db, 'acct:A:targetless_apply_attempts_json') || '{}')
      return { ok: true }
    },
  })
  assert.deepEqual(stampAtAmendTime, { P1: 5000 }, 'a claim that lands after the amend excludes nobody')
})

test('a claim that cannot be written means no amend at all', async () => {
  const db = initDB(':memory:')
  const amends = []
  const realPrepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    if (/INSERT INTO agent_state|REPLACE INTO agent_state|UPDATE agent_state/i.test(sql)) throw new Error('disk full')
    return realPrepare(sql)
  }
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { amends.push(f.positionId); return { ok: true } },
  })
  assert.deepEqual(amends, [], 'no claim, no amend')
})

test('MAJOR: an empty/partial broker snapshot does NOT hand back the apply window', async () => {
  // A position absent from the snapshot is `unmatched` — checked against
  // nothing, repaired by nobody. Pruning its stamp handed back the whole
  // six-hour window; measured, a snapshot flickering every other pass turned
  // 17 fetches and 17 amends an hour into 510 of each.
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const amends = []
  const run = (nowMs, broker) => runProtectionAudit(db, [targetlessRow()], broker, {
    nowMs, accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { amends.push(f.positionId); return { ok: false, error: 'broker said no' } },
  })
  await run(t0, [targetlessPos()])
  await run(t0 + 60_000, [])                 // snapshot flickers out
  await run(t0 + 120_000, [targetlessPos()]) // and back
  assert.deepEqual(amends, ['P1'], 'the refused amend is not retried a minute later')
  assert.deepEqual(
    JSON.parse(getState(db, 'acct:A:targetless_apply_attempts_json') || '{}'), { P1: t0 })
})

test('the window IS handed back when the snapshot proves the target landed', async () => {
  // The other side of the same rule: evidence, not absence.
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const amends = []
  const run = (nowMs, broker) => runProtectionAudit(db, [targetlessRow()], broker, {
    nowMs, accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { amends.push(f.positionId); return { ok: true } },
  })
  await run(t0, [targetlessPos()])
  await run(t0 + 60_000, [{ ...targetlessPos(), takeProfit: 5.4 }]) // verified repaired
  assert.deepEqual(JSON.parse(getState(db, 'acct:A:targetless_apply_attempts_json') || '{}'), {})
  await run(t0 + 120_000, [targetlessPos()]) // lost again
  assert.deepEqual(amends, ['P1', 'P1'], 'losing a target twice is acted on at once')
})

test('a long-expired stamp is swept on age, so the map cannot grow without bound', async () => {
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  await runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs: t0, accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => ({ ok: false }),
  })
  // The position vanishes from the book and the broker entirely.
  await runProtectionAudit(db, [], [], { nowMs: t0 + 40 * 3600_000, accountId: 'A' })
  assert.deepEqual(JSON.parse(getState(db, 'acct:A:targetless_apply_attempts_json') || '{}'), {})
})

test('MINOR: a manual position is the human’s own and is never amended', async () => {
  // profit-keeper.js and loss-guardian.js both pair manual with external. This
  // guard did not, so a position the owner placed through the bot was amended
  // while the identical one placed at the broker was not.
  const db = initDB(':memory:')
  const applied = []
  const lines = await captureLog(() => runProtectionAudit(db,
    [targetlessRow('PM1', 'GBPAUD', { source: 'manual' })], [targetlessPos('PM1', 'GBPAUD')], {
      accountId: 'A',
      suggestTarget: async () => ({ tp: 2.1, basis: 'HVN' }),
      applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
    }))
  assert.deepEqual(applied, [])
  assert.ok(lines.some(l => /1 manual \(left alone — the human's own\)/.test(l)), lines.join('\n'))
})

test('source matching is case- and whitespace-insensitive', async () => {
  const db = initDB(':memory:')
  const applied = []
  for (const src of ['External', ' EXTERNAL ', 'Manual']) {
    await runProtectionAudit(db, [targetlessRow('PC' + src.length, 'GBPAUD', { source: src })],
      [targetlessPos('PC' + src.length, 'GBPAUD')], {
        accountId: 'A',
        suggestTarget: async () => ({ tp: 2.1, basis: 'HVN' }),
        applyTarget: async (f) => { applied.push(f.positionId); return { ok: true } },
      })
  }
  assert.deepEqual(applied, [], 'an exemption must not turn on the casing of a text column')
})

test('a pass works at most maxApplyPerPass positions, and the rest are named', async () => {
  // At 2–4s a round trip, an unbounded first pass over 17 positions overruns
  // the fast monitor's 60s band and parks protection_band at ok:false.
  const db = initDB(':memory:')
  const rows = [], pos = []
  for (let i = 0; i < 7; i++) {
    rows.push({ ...targetlessRow('Q' + i, 'SYM' + i), id: i + 1 })
    pos.push(targetlessPos('Q' + i, 'SYM' + i))
  }
  const amends = []
  const lines = await captureLog(() => runProtectionAudit(db, rows, pos, {
    accountId: 'A', maxApplyPerPass: 2,
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { amends.push(f.positionId); return { ok: true } },
  }))
  assert.deepEqual(amends, ['Q0', 'Q1'])
  const line = lines.find(l => /targetless —/.test(l))
  assert.match(line, /5 bot-owned \(over this pass’s work cap\)/)
})

test('the cap spreads the work across passes rather than dropping it', async () => {
  const db = initDB(':memory:')
  const rows = [], pos = []
  for (let i = 0; i < 4; i++) {
    rows.push({ ...targetlessRow('S' + i, 'SYM' + i), id: i + 1 })
    pos.push(targetlessPos('S' + i, 'SYM' + i))
  }
  const amends = []
  const opts = { accountId: 'A', maxApplyPerPass: 2,
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { amends.push(f.positionId); return { ok: true } } }
  await runProtectionAudit(db, rows, pos, { ...opts, nowMs: 1000 })
  await runProtectionAudit(db, rows, pos, { ...opts, nowMs: 2000 })
  assert.deepEqual(amends, ['S0', 'S1', 'S2', 'S3'])
})

test('the deferred class never claims an outcome target-restore did not deliver', async () => {
  const db = initDB(':memory:')
  const lines = await captureLog(() => runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => ({ ok: true }),
    applyExcludeIds: new Set(['P1']),
  }))
  const line = lines.find(l => /targetless —/.test(l))
  assert.match(line, /1 bot-owned \(deferred to target-restore\)/)
  assert.ok(!/restored/.test(line), 'the audit cannot observe what restore will do')
})

// ---------------------------------------------------------------------------
// A SIXTY-SECOND BLIP IS NOT A SIX-HOUR SILENCE (17-09-2026, third review).
//
// The claim is stamped BEFORE the amend — that is what closes the two-pass race
// — but it meant a transient WS failure muted a position for the full window.
// Measured in the review's cost run: three positions refused on a read failure,
// all three unreachable for six hours, because the prune only clears a stamp
// once the position stops being targetless and a refused position stays
// targetless. So the window is now reason-dependent.
// ---------------------------------------------------------------------------

test('a RETRYABLE refusal shortens the window instead of burning it', async () => {
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const tries = []
  const run = (nowMs, result) => runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs, accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => { tries.push(nowMs); return result },
  })
  await run(t0, { ok: false, retryable: true, error: 'could not re-read the position' })
  await run(t0 + 60_000, { ok: true })            // still inside the short window
  assert.deepEqual(tries, [t0], 'not retried a minute later — that would be the storm')
  await run(t0 + 6 * 60_000, { ok: true })        // past the 5-minute retry window
  assert.deepEqual(tries, [t0, t0 + 6 * 60_000], 'and retried once it expires, not in six hours')
})

test('a NON-retryable refusal keeps the full window', async () => {
  // "It already holds a target", "the read says another position", "the target
  // is on the wrong side" — the broker gives the same answer tomorrow.
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const tries = []
  const run = (nowMs) => runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs, accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => { tries.push(nowMs); return { ok: false, error: 'already holds a take profit at 5.9' } },
  })
  await run(t0)
  await run(t0 + 6 * 60_000)
  await run(t0 + 3 * 3600_000)
  assert.deepEqual(tries, [t0])
  await run(t0 + 7 * 3600_000)
  assert.equal(tries.length, 2, 'the full window still applies where the answer is settled')
})

test('an applyTarget that THROWS is transient — nothing was established', async () => {
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const tries = []
  const run = (nowMs, throwIt) => runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs, accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => { tries.push(nowMs); if (throwIt) throw new Error('network'); return { ok: true } },
  })
  await run(t0, true)
  await run(t0 + 6 * 60_000, false)
  assert.deepEqual(tries, [t0, t0 + 6 * 60_000])
})

test('the backed-off window is still a WINDOW — the race stays closed inside it', async () => {
  // Rewinding the stamp must not be the same as deleting it.
  const db = initDB(':memory:')
  const t0 = 1_800_000_000_000
  const tries = []
  const pass = (nowMs) => runProtectionAudit(db, [targetlessRow()], [targetlessPos()], {
    nowMs, accountId: 'A',
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async () => { tries.push(nowMs); return { ok: false, retryable: true, error: 'ws timeout' } },
  })
  await pass(t0)
  await Promise.all([pass(t0 + 30_000), pass(t0 + 30_000)])
  assert.deepEqual(tries, [t0], 'two concurrent passes inside the short window still amend nothing')
})

test('the default work cap is ONE per pass', async () => {
  // Lowered from 3 until the band cost is measured: each apply now opens a
  // live WS read, serially, inside a 60-second band.
  const db = initDB(':memory:')
  const rows = [], pos = []
  for (let i = 0; i < 4; i++) {
    rows.push({ ...targetlessRow('Z' + i, 'SYM' + i), id: i + 1 })
    pos.push(targetlessPos('Z' + i, 'SYM' + i))
  }
  const amends = []
  await runProtectionAudit(db, rows, pos, {
    accountId: 'A', // maxApplyPerPass not passed — the default is the subject
    suggestTarget: async () => ({ tp: 5.4, basis: 'HVN' }),
    applyTarget: async (f) => { amends.push(f.positionId); return { ok: true } },
  })
  assert.deepEqual(amends, ['Z0'])
  assert.equal(MAX_APPLY_PER_PASS, 1)
})

// ---------------------------------------------------------------------------
// Wave 5 (first-principles audit 19-09-2026 §K item 15): the protection
// breakdown prints once per CHANGE, with a 30-minute heartbeat repeat — not
// once per pass.
// ---------------------------------------------------------------------------
test('printOnChange: the same text twice prints once; a change prints; after 30 minutes the unchanged text repeats with a suffix', async () => {
  const { printOnChange, PROTECTION_LINE_REPEAT_MS, _resetProtectionLineMemoryForTests } = await import('./naked-position-guard.js')
  _resetProtectionLineMemoryForTests()
  const out = []
  const print = (l) => out.push(l)
  const t0 = 1_800_000_000_000
  assert.equal(printOnChange('A', 'targetless', '[protection] A: 2 targetless — 2 momentum-book (trail only)', t0, print), 'printed')
  assert.equal(printOnChange('A', 'targetless', '[protection] A: 2 targetless — 2 momentum-book (trail only)', t0 + 60_000, print), 'unchanged')
  assert.equal(out.length, 1, 'same breakdown twice → one line')
  assert.equal(printOnChange('A', 'targetless', '[protection] A: 3 targetless — 2 momentum-book (trail only), 1 bot-owned (target applied)', t0 + 120_000, print), 'printed')
  assert.equal(out.length, 2, 'a change → a new line')
  // Another account, another kind: their own memory.
  assert.equal(printOnChange('B', 'targetless', '[protection] B: 1 targetless — 1 external (left alone — the human\'s own)', t0 + 120_000, print), 'printed')
  assert.equal(printOnChange('A', 'deferred_restore', '[protection] A: 1 deferred to target-restore — 0 restored, 1 still without a target', t0 + 120_000, print), 'printed')
  assert.equal(out.length, 4)
  // The 30-minute repeat.
  assert.equal(printOnChange('A', 'targetless', '[protection] A: 3 targetless — 2 momentum-book (trail only), 1 bot-owned (target applied)', t0 + 120_000 + PROTECTION_LINE_REPEAT_MS - 1, print), 'unchanged')
  assert.equal(printOnChange('A', 'targetless', '[protection] A: 3 targetless — 2 momentum-book (trail only), 1 bot-owned (target applied)', t0 + 120_000 + PROTECTION_LINE_REPEAT_MS, print), 'repeated')
  assert.equal(out[4], '[protection] A: 3 targetless — 2 momentum-book (trail only), 1 bot-owned (target applied) (unchanged 30m)')
  assert.equal(PROTECTION_LINE_REPEAT_MS, 30 * 60_000)
  _resetProtectionLineMemoryForTests()
})

test('END TO END: two passes with the same targetless breakdown print the line ONCE; the Telegram mute is untouched', async () => {
  const { _resetProtectionLineMemoryForTests } = await import('./naked-position-guard.js')
  _resetProtectionLineMemoryForTests()
  const db = initDB(':memory:')
  bookRow(db, 'C1')
  const rows = [{ ...targetlessRow('C1', '0005.HK'), id: 1 }]
  const pos = rows.map(r => targetlessPos(r.ctrader_position_id, r.symbol))
  const t0 = 1_800_000_000_000
  const sent = []
  const run = (nowMs) => runProtectionAudit(db, rows, pos, { accountId: 'A', nowMs, sendMessage: async (m) => { sent.push(m) } })
  const first = await captureLog(() => run(t0))
  const second = await captureLog(() => run(t0 + 60_000))
  assert.equal(first.filter(l => /targetless —/.test(l)).length, 1, first.join('\n'))
  assert.equal(second.filter(l => /targetless —/.test(l)).length, 0, 'unchanged breakdown one minute later: no second line\n' + second.join('\n'))
  const third = await captureLog(() => run(t0 + 31 * 60_000))
  assert.equal(third.filter(l => /targetless — .*\(unchanged 30m\)$/.test(l)).length, 1, third.join('\n'))
  _resetProtectionLineMemoryForTests()
})
