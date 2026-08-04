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
    { nowMs: T0 + 3600_000, accountId: 'B', sendMessage: async () => {} })

  // A portfolio is only as freshly verified as its stalest account. Reporting
  // the newest would let one healthy account mask five unchecked ones.
  const all = lastProtectionAudit(db, { nowMs: T0 + 3600_000 })
  assert.equal(all.ageSec, 3600, 'age must come from account A, the older check')
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
