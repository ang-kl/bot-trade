import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { nodeWatchdogContract } from './watchdog-contract.js'
import { calendarIntervals, projectCalendar } from '../lib/calendar-intervals.js'
import { recordMarketCalendar, readMarketCalendar } from './market-calendar.js'
import stateRouter from '../routes/state.js'
import { beat, checkHeartbeats } from './heartbeat.js'
import { runProtectionAudit } from './naked-position-guard.js'
const D = 86400, H = 3600, DAY = D * 1000
const now = Date.parse('2026-09-22T06:00:00Z'), host = 'demo.ctraderapi.com'
const ms = s => Date.parse(s)
const calendar = (schedule, zone = 'UTC', holiday = []) => ({ schedule, scheduleTimeZone: zone, holiday })
const spans = (cal, from, to) => calendarIntervals(cal, ms(from), ms(to)).map(x => [new Date(x.fromMs).toISOString(), new Date(x.toMs).toISOString()])

test('UTC projection retains both DST fold openings and spring-gap closure', () => {
  const c = calendar([{ startSecond: 1.5 * H, endSecond: 2.5 * H }], 'America/New_York')
  assert.deepEqual(spans(c, '2026-11-01T00:00Z', '2026-11-02T00:00Z'), [
    ['2026-11-01T05:30:00.000Z', '2026-11-01T06:00:00.000Z'],
    ['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z'],
  ])
  assert.deepEqual(spans(c, '2026-03-08T00:00Z', '2026-03-09T00:00Z'), [['2026-03-08T06:30:00.000Z', '2026-03-08T07:00:00.000Z']])
})
test('Friday close, Sunday open, holiday early close and intraday maintenance use broker intervals', () => {
  const fx = calendar([{ startSecond: 21 * H, endSecond: 5 * D + 21 * H }])
  assert.deepEqual(spans(fx, '2026-09-25T20:00Z', '2026-09-28T00:00Z'), [
    ['2026-09-25T20:00:00.000Z', '2026-09-25T21:00:00.000Z'], ['2026-09-27T21:00:00.000Z', '2026-09-28T00:00:00.000Z'],
  ])
  const holiday = { holidayDate: Math.floor(ms('2026-09-22T00:00Z') / DAY), isRecurring: false, startSecond: 12 * H, endSecond: D, scheduleTimeZone: 'UTC' }
  const crypto = calendar([{ startSecond: 0, endSecond: 7 * D }], 'UTC', [holiday])
  assert.deepEqual(spans(crypto, '2026-09-22T00:00Z', '2026-09-23T00:00Z'), [['2026-09-22T00:00:00.000Z', '2026-09-22T12:00:00.000Z']])
  const breakTime = calendar([{ startSecond: 2 * D, endSecond: 2 * D + 12 * H + 15 }, { startSecond: 2 * D + 12 * H + 45, endSecond: 3 * D }])
  assert.deepEqual(spans(breakTime, '2026-09-22T12:00Z', '2026-09-22T12:01Z'), [
    ['2026-09-22T12:00:00.000Z', '2026-09-22T12:00:15.000Z'], ['2026-09-22T12:00:45.000Z', '2026-09-22T12:01:00.000Z'],
  ])
})
test('projection carries identity and original expiry, and never invents the opening of an already-open continuous market', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const id = { host, accountId: '11', symbolId: '7' }
  recordMarketCalendar(db, id, { symbolId: 7, ...calendar([{ startSecond: 0, endSecond: 7 * D }]) }, { nowMs: now })
  const first = projectCalendar(readMarketCalendar(db, id, { nowMs: now }), now)
  const later = projectCalendar(readMarketCalendar(db, id, { nowMs: now + 1000 }), now + 1000)
  assert.equal(first.sessionOpenedAtMs, null)
  assert.equal(first.expiresAtMs, later.expiresAtMs)
  assert.equal(first.observedAtMs, now)
  assert.equal(projectCalendar(readMarketCalendar(db, { ...id, accountId: '22' }, { nowMs: now }), now), null)
  assert.equal(projectCalendar(readMarketCalendar(db, id, { nowMs: now + DAY }), now + DAY), null)
})
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (?,?)').run('11', 0)
  db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (?,?)').run('22', 1)
  setState(db, 'symbol_id_map:11', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 7 } }))
  recordMarketCalendar(db, { host, accountId: '11', symbolId: '7' }, { symbolId: 7, ...calendar([{ startSecond: 21 * H, endSecond: 5 * D + 21 * H }]) }, { nowMs: now })
  const insert = db.prepare("INSERT INTO monitored_positions (symbol,account_id,source,created_at,paused) VALUES ('EURUSD',?,?,?,?)")
  insert.run('11', 'autopilot', new Date(now - 120000).toISOString(), 0)
  insert.run('22', 'autopilot', new Date(now - 120000).toISOString(), 0)
  insert.run('11', 'external', new Date(now - 120000).toISOString(), 0)
  insert.run('11', 'autopilot', new Date(now - 120000).toISOString(), 1)
  return db
}
test('work receipts retain their own account and completion time; master OFF and manual/paused ownership survive', t => {
  const db = fixture(t)
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: false }))
  setState(db, 'fast_monitor_position_work_json', JSON.stringify({ at: new Date(now).toISOString(), complete: true, positions: [
    { accountId: '11', positionId: 1, lastCompletedAt: new Date(now - 1000).toISOString(), nextDueAt: new Date(now + 2000).toISOString(), state: 'evaluated' },
  ] }))
  const out = nodeWatchdogContract(db, { now })
  assert.equal(out.work.length, 2)
  assert.equal(out.work[0].lastCompletedAtMs, now - 1000)
  assert.equal(out.work[0].nextDueMs, now + 2000)
  // V3 K1: the position's calendar is carried once, in `calendars`; cpp-verify
  // gives it to the item by exact accountId/host/symbolId (watchdog_state.cpp:148-152).
  assert.equal(out.work[0].calendar, undefined)
  assert.equal(out.work[0].calendarIn, 'calendars')
  const own = out.calendars.find(c => c.identity.accountId === out.work[0].accountId && c.identity.host === out.work[0].host && c.identity.symbolId === out.work[0].symbolId)
  assert.equal(own.calendar.identity.accountId, '11')
  assert.equal(out.work[1].calendar, null)
  assert.equal(out.work[1].lastCompletedAtMs, null)
  assert.equal(out.notificationPolicy.enabled, false)
  assert.equal(out.notificationPolicy.owner, 'node')
  setState(db, 'telegram_notify_json', '{broken')
  assert.equal(nodeWatchdogContract(db, { now }).notificationPolicy.enabled, false)
})
test('intent timeout is the existing acknowledgement deadline, never permit expiry; acknowledged resting orders are excluded', t => {
  const db = fixture(t)
  const put = db.prepare(`INSERT INTO entry_intents (id,account_id,environment,side,producer_id,basis,mode_epoch,permit_id,permit_expires_at,state,updated_at)
    VALUES (?,'11','demo','BUY','test','fixture',1,?,'2099-01-01T00:00Z',?,?)`)
  put.run('sent', 'p1', 'SENT', new Date(now - 30000).toISOString())
  put.run('limit', 'p2', 'ACCEPTED', new Date(now - 120000).toISOString())
  const work = nodeWatchdogContract(db, { now }).work.filter(w => w.role === 'intent')
  assert.equal(work.length, 1); assert.equal(work[0].deadlineMs, now + 30000)
})
test('quiet hours are independently usable after Node loss and preserve urgent bypass policy', t => {
  const db = fixture(t)
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: true, quiet: { start: '13:00', end: '15:00' }, tz: 'Asia/Singapore', urgentBypass: false }))
  const p = nodeWatchdogContract(db, { now }).notificationPolicy
  assert.equal(p.enabled, true); assert.equal(p.urgentBypass, false)
  assert.ok(p.quietIntervals.some(iv => iv.fromMs <= now && iv.toMs > now))
  assert.equal(p.expiresAtMs, now + DAY)
})
test('HTTP contract bypasses response cache without refreshing completed-work timestamps', async t => {
  const db = fixture(t), app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const r = await fetch(`http://127.0.0.1:${server.address().port}/state/watchdog`)
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store')
  const body = await r.json(); assert.equal(body.service, 'node'); assert.equal(body.work[0].lastCompletedAtMs, null)
})

test('explicit incident handoff keeps observations and approval controls, with one generic incident sender', async t => {
  const db = fixture(t), sent = []
  setState(db, 'watchdog_incident_owner', 'cpp-verify')
  beat(db, 'fast_monitor', { now: new Date(now - 3600_000) })
  const events = checkHeartbeats(db, { now: new Date(now), bootMs: now - DAY, notify: message => sent.push(message) })
  assert.ok(events.some(e => e.name === 'fast_monitor' && e.event === 'stalled'))
  assert.equal(sent.some(m => /CONTROLLER STALLED/.test(m)), false)
  const row = { id: 1, symbol: 'ETHUSD', ctrader_position_id: '555', account_id: '11', current_sl: null }
  await runProtectionAudit(db, [row], [{ positionId: '555', stopLoss: null, takeProfit: null }], {
    nowMs: now, accountId: '11', sendMessage: async message => sent.push(message),
  })
  assert.equal(sent.some(m => /NO STOP LOSS|NO TAKE PROFIT/.test(m)), false)
  const approvals = []
  await runProtectionAudit(db, [{ ...row, current_sl: 1700 }], [{ positionId: '555', stopLoss: 1700, takeProfit: null }], {
    nowMs: now + 1000, accountId: '11', sendMessage: async (message, opts) => approvals.push({ message, opts }),
    suggestTarget: async () => ({ tp: 1885.5, basis: 'fixture' }),
  })
  assert.equal(approvals.length, 1)
  assert.match(approvals[0].opts.buttons[0][0].callback_data, /^prottp\|11\|555\|1885.5$/)
})
