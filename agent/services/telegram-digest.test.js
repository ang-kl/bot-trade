// node --test agent/services/telegram-digest.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  CONFIG_KEY, LAST_FLUSH_KEY, HOUR_MS, TG_TEXT_MAX,
  loadNotifyConfig, saveNotifyConfig, isHHMM, minutesOfDay, inQuietHours,
  classifyPriority, routeDecision, queueMessage, pendingMessages, summarise,
  markSent, flushDecision, flushDigest, attachNotifyDb, routeOutbound,
  describeConfig,
} from './telegram-digest.js'
import { handleNotifyCommand } from './telegram-control.js'

function freshDB() { return initDB(':memory:') }

// Fixed clocks, stated in SGT (UTC+8, no DST) and written as the UTC instant
// so the assertion does not depend on the machine's zone.
const SGT = (isoLocal) => Date.parse(`${isoLocal}+08:00`)
const AT_0300 = SGT('2026-08-16T03:00:00')
const AT_0700 = SGT('2026-08-16T07:00:00')
const AT_1400 = SGT('2026-08-16T14:00:00')
const AT_2330 = SGT('2026-08-16T23:30:00')

// ---------------------------------------------------------------------------
// Defaults: shipping this file must not change what the owner receives.
// ---------------------------------------------------------------------------

test('defaults are behave-exactly-as-before: enabled, live, no quiet hours', () => {
  const db = freshDB()
  const cfg = loadNotifyConfig(db)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.mode, 'live')
  assert.equal(cfg.quiet, null)
  assert.equal(routeDecision(cfg, { text: 'scan: EURUSD long', nowMs: AT_0300 }).action, 'send')
})

test('an unreadable config falls back to sending, not to silence', () => {
  const db = freshDB()
  setState(db, CONFIG_KEY, '{not json')
  const cfg = loadNotifyConfig(db)
  assert.equal(cfg.enabled, true)
  assert.equal(routeDecision(cfg, { text: 'anything', nowMs: AT_0300 }).action, 'send')
})

// ---------------------------------------------------------------------------
// Quiet hours — the wrap past midnight is the whole point.
// ---------------------------------------------------------------------------

test('minutesOfDay reads the hour in SGT regardless of the machine zone', () => {
  assert.equal(minutesOfDay(AT_0300), 180)
  assert.equal(minutesOfDay(AT_1400), 840)
  assert.equal(minutesOfDay(AT_2330), 1410)
})

test('a quiet window that wraps midnight covers both sides of it', () => {
  const q = { start: '23:00', end: '07:00' }
  assert.equal(inQuietHours(AT_2330, q), true, '23:30 is after the start')
  assert.equal(inQuietHours(AT_0300, q), true, '03:00 is before the end')
  assert.equal(inQuietHours(AT_1400, q), false, 'mid-afternoon is not quiet')
})

test('the window is half-open: it is over AT the end time, not after it', () => {
  // Matters because the wake-up flush fires at exactly the end minute. A
  // closed window would defer the very summary it is meant to release.
  assert.equal(inQuietHours(AT_0700, { start: '23:00', end: '07:00' }), false)
})

test('a same-day window (no wrap) still works', () => {
  const q = { start: '09:00', end: '17:00' }
  assert.equal(inQuietHours(AT_1400, q), true)
  assert.equal(inQuietHours(AT_2330, q), false)
})

test('start === end is refused as a window, not read as a 24h mute', () => {
  assert.equal(inQuietHours(AT_0300, { start: '08:00', end: '08:00' }), false)
  const db = freshDB()
  setState(db, CONFIG_KEY, JSON.stringify({ quiet: { start: '08:00', end: '08:00' } }))
  assert.equal(loadNotifyConfig(db).quiet, null, 'not stored as a window')
})

test('malformed HH:MM is rejected rather than half-applied', () => {
  assert.equal(isHHMM('23:00'), true)
  assert.equal(isHHMM('7:00'), false)
  assert.equal(isHHMM('24:00'), false)
  assert.equal(isHHMM('23:60'), false)
  assert.equal(inQuietHours(AT_0300, { start: '2300', end: '07:00' }), false)
})

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('quiet hours queue a normal alert and let an urgent one through', () => {
  const cfg = { ...loadNotifyConfig(freshDB()), quiet: { start: '23:00', end: '07:00' } }
  const normal = routeDecision(cfg, { text: 'EURUSD setup spotted', nowMs: AT_0300 })
  assert.equal(normal.action, 'queue')
  assert.equal(normal.reason, 'quiet_hours')

  const urgent = routeDecision(cfg, { text: '🔴 CIRCUIT BREAKER: loop halted', nowMs: AT_0300 })
  assert.equal(urgent.action, 'send')
  assert.equal(urgent.priority, 'urgent')
})

test('urgentBypass off means quiet hours hold everything, urgent included', () => {
  const cfg = { ...loadNotifyConfig(freshDB()), quiet: { start: '23:00', end: '07:00' }, urgentBypass: false }
  assert.equal(routeDecision(cfg, { text: '🔴 margin breach', nowMs: AT_0300 }).action, 'queue')
})

test('hourly mode queues outside quiet hours too — that is the point of it', () => {
  const cfg = { ...loadNotifyConfig(freshDB()), mode: 'hourly' }
  assert.equal(routeDecision(cfg, { text: 'scan result', nowMs: AT_1400 }).action, 'queue')
  assert.equal(routeDecision(cfg, { text: 'scan result', nowMs: AT_1400 }).reason, 'hourly_digest')
})

test('notify off holds URGENT too — a mute that leaks is not a mute', () => {
  const cfg = { ...loadNotifyConfig(freshDB()), enabled: false }
  const r = routeDecision(cfg, { text: '🔴 CIRCUIT BREAKER', nowMs: AT_1400 })
  assert.equal(r.action, 'queue')
  assert.equal(r.reason, 'notify_off')
})

test('priority is inferred generously, and an explicit one always wins', () => {
  assert.equal(classifyPriority('🛑 RISK VETO: EURUSD'), 'urgent')
  assert.equal(classifyPriority('margin level below floor'), 'urgent')
  assert.equal(classifyPriority('failed to place order'), 'urgent')
  assert.equal(classifyPriority('EURUSD long setup, 7/10'), 'normal')
  // Explicit beats inference in BOTH directions.
  assert.equal(classifyPriority('EURUSD long setup', 'urgent'), 'urgent')
  assert.equal(classifyPriority('🛑 RISK VETO', 'normal'), 'normal')
})

// ---------------------------------------------------------------------------
// The choke point
// ---------------------------------------------------------------------------

test('routeOutbound sends when no db is attached — missing wiring never mutes', () => {
  attachNotifyDb(null)
  const r = routeOutbound('anything at all')
  assert.equal(r.send, true)
  assert.equal(r.reason, 'no_db')
})

test('routeOutbound queues to the outbox and reports not-send', () => {
  const db = freshDB()
  saveNotifyConfig(db, { quiet: { start: '23:00', end: '07:00' } })
  attachNotifyDb(db)
  try {
    const r = routeOutbound('a quiet-hours scan', { kind: 'scan', nowMs: AT_0300 })
    assert.equal(r.send, false)
    assert.equal(r.reason, 'quiet_hours')
    const pend = pendingMessages(db)
    assert.equal(pend.length, 1)
    assert.equal(pend[0].kind, 'scan')
    assert.equal(pend[0].reason, 'quiet_hours')
  } finally { attachNotifyDb(null) }
})

test('a failed queue write falls back to sending rather than losing the alert', () => {
  const db = freshDB()
  saveNotifyConfig(db, { enabled: false })
  attachNotifyDb(db)
  try {
    db.exec('DROP TABLE telegram_outbox')
    const r = routeOutbound('an alert with nowhere to go')
    assert.equal(r.send, true)
    assert.equal(r.reason, 'queue_failed')
  } finally { attachNotifyDb(null) }
})

// ---------------------------------------------------------------------------
// Summarising
// ---------------------------------------------------------------------------

const q = (db, text, kind = 'alert', priority = 'normal', reason = 'hourly_digest') =>
  queueMessage(db, { text, kind, priority, reason })

test('the summary groups by kind, counts, and names the urgent ones', () => {
  const db = freshDB()
  q(db, 'EURUSD long 7/10', 'scan')
  q(db, 'GBPUSD short 6/10', 'scan')
  q(db, 'position opened USDJPY', 'trade')
  q(db, '🔴 margin level 120%', 'alert', 'urgent')
  const text = summarise(pendingMessages(db), { nowMs: AT_1400 })
  assert.match(text, /4 messages from the past hour/)
  assert.match(text, /1 urgent/)
  assert.match(text, /margin level 120%/)
  assert.match(text, /scan \(2\)/)
  assert.match(text, /trade \(1\)/)
})

test('an empty queue produces no message at all', () => {
  assert.equal(summarise([], { nowMs: AT_1400 }), null)
})

test('a huge backlog still fits inside the 4096-char Telegram limit', () => {
  // Telegram REJECTS an over-long message rather than truncating it, so an
  // unbounded digest would lose the whole hour, not just its tail.
  const db = freshDB()
  for (let i = 0; i < 400; i++) q(db, `symbol number ${i} produced a setup worth describing at length`, 'scan')
  const text = summarise(pendingMessages(db), { nowMs: AT_1400 })
  assert.ok(text.length <= TG_TEXT_MAX, `digest was ${text.length} chars`)
  assert.match(text, /and \d+ more/, 'says what it elided instead of silently dropping it')
})

// ---------------------------------------------------------------------------
// Flushing
// ---------------------------------------------------------------------------

test('quiet hours ending flushes the night — even in live mode', () => {
  // THE test for this feature. Live mode has no hourly timer, so without the
  // wake-up trigger a night of deferred alerts would sit in the outbox
  // forever: deferred by a promise to deliver later, and never delivered.
  const db = freshDB()
  const cfg = saveNotifyConfig(db, { quiet: { start: '23:00', end: '07:00' } })
  q(db, 'held overnight', 'scan', 'normal', 'quiet_hours')
  assert.equal(flushDecision(db, cfg, AT_0300).flush, false, 'still inside the window')
  assert.equal(flushDecision(db, cfg, AT_0300).reason, 'still_quiet')
  const out = flushDecision(db, cfg, AT_0700)
  assert.equal(out.flush, true)
  assert.equal(out.reason, 'quiet_hours_ended')
})

test('hourly mode waits an hour between flushes', () => {
  const db = freshDB()
  const cfg = saveNotifyConfig(db, { mode: 'hourly' })
  q(db, 'first')
  setState(db, LAST_FLUSH_KEY, String(AT_1400))
  assert.equal(flushDecision(db, cfg, AT_1400 + 59 * 60_000).flush, false)
  assert.equal(flushDecision(db, cfg, AT_1400 + 59 * 60_000).reason, 'within_hour')
  assert.equal(flushDecision(db, cfg, AT_1400 + HOUR_MS).flush, true)
})

test('the first flush does not wait an hour from a timestamp never written', () => {
  const db = freshDB()
  const cfg = saveNotifyConfig(db, { mode: 'hourly' })
  q(db, 'first ever')
  assert.equal(getState(db, LAST_FLUSH_KEY), null)
  const out = flushDecision(db, cfg, AT_1400)
  assert.equal(out.flush, true)
  assert.equal(out.reason, 'first_flush')
})

test('nothing queued means nothing sent', () => {
  const db = freshDB()
  assert.equal(flushDecision(db, loadNotifyConfig(db), AT_1400).flush, false)
})

test('notify off holds the queue closed — /notify on or /digest now releases it', async () => {
  const db = freshDB()
  const cfg = saveNotifyConfig(db, { enabled: false })
  q(db, 'held while muted', 'scan', 'normal', 'notify_off')
  assert.equal(flushDecision(db, cfg, AT_1400).flush, false)
  assert.equal(flushDecision(db, cfg, AT_1400).reason, 'notify_off')

  const sent = []
  const forced = await flushDigest(db, { nowMs: AT_1400, send: async (t) => sent.push(t), force: true })
  assert.equal(forced.sent, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /held while muted/)
})

test('flushDigest sends once, marks the rows, and stamps the clock', async () => {
  const db = freshDB()
  saveNotifyConfig(db, { mode: 'hourly' })
  q(db, 'one'); q(db, 'two')
  const sent = []
  const res = await flushDigest(db, { nowMs: AT_1400, send: async (t) => sent.push(t) })
  assert.equal(res.sent, true)
  assert.equal(res.count, 2)
  assert.equal(sent.length, 1, 'ONE message, not one per alert — the whole point')
  assert.equal(pendingMessages(db).length, 0)
  assert.equal(getState(db, LAST_FLUSH_KEY), String(AT_1400))
})

test('a Telegram failure leaves the hour pending instead of swallowing it', async () => {
  const db = freshDB()
  saveNotifyConfig(db, { mode: 'hourly' })
  q(db, 'must survive the outage')
  const res = await flushDigest(db, {
    nowMs: AT_1400,
    send: async () => { throw new Error('Bad Gateway') },
  })
  assert.equal(res.sent, false)
  assert.match(res.reason, /Bad Gateway/)
  assert.equal(pendingMessages(db).length, 1, 'still pending for the next pass')
  assert.equal(getState(db, LAST_FLUSH_KEY), null, 'clock not advanced on a failed send')
})

test('markSent is idempotent and only touches the ids given', () => {
  const db = freshDB()
  q(db, 'a'); q(db, 'b')
  const [first] = pendingMessages(db)
  assert.equal(markSent(db, [first.id]), 1)
  assert.equal(markSent(db, [first.id]), 1, 'UPDATE is a no-op-safe rewrite')
  assert.equal(pendingMessages(db).length, 1)
})

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

test('/quiet sets, shows and clears the window', () => {
  const db = freshDB()
  assert.match(handleNotifyCommand(db, '/quiet', '', AT_1400), /No quiet hours/)
  assert.match(handleNotifyCommand(db, '/quiet', '23:00 07:00', AT_1400), /23:00–07:00 SGT/)
  assert.deepEqual(loadNotifyConfig(db).quiet, { start: '23:00', end: '07:00' })
  assert.match(handleNotifyCommand(db, '/quiet', '', AT_0300), /INSIDE/)
  assert.match(handleNotifyCommand(db, '/quiet', '', AT_1400), /outside/)
  assert.match(handleNotifyCommand(db, '/quiet', 'off', AT_1400), /Quiet hours off/)
  assert.equal(loadNotifyConfig(db).quiet, null)
})

test('/quiet rejects bad input instead of storing half of it', () => {
  const db = freshDB()
  assert.match(handleNotifyCommand(db, '/quiet', '2300 0700', AT_1400), /Usage/)
  assert.equal(loadNotifyConfig(db).quiet, null)
  assert.match(handleNotifyCommand(db, '/quiet', '08:00 08:00', AT_1400), /24-hour mute/)
  assert.equal(loadNotifyConfig(db).quiet, null)
})

test('/notify and /digest flip exactly one knob each', () => {
  const db = freshDB()
  handleNotifyCommand(db, '/quiet', '23:00 07:00', AT_1400)
  handleNotifyCommand(db, '/digest', 'on', AT_1400)
  let cfg = loadNotifyConfig(db)
  assert.equal(cfg.mode, 'hourly')
  assert.deepEqual(cfg.quiet, { start: '23:00', end: '07:00' }, 'quiet untouched by /digest')
  assert.equal(cfg.enabled, true, 'enabled untouched by /digest')

  handleNotifyCommand(db, '/notify', 'off', AT_1400)
  cfg = loadNotifyConfig(db)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.mode, 'hourly', 'mode untouched by /notify')
})

test('/notify off says plainly that trading is unaffected', () => {
  // The one genuinely dangerous misreading of this feature is "the bot is
  // quiet, so the bot is stopped". The reply has to close it.
  const db = freshDB()
  const reply = handleNotifyCommand(db, '/notify', 'off', AT_1400)
  assert.match(reply, /QUEUED, not dropped/)
  assert.match(reply, /Trading is unaffected/)
  assert.match(reply, /\/pause/)
})

test('describeConfig states all three knobs in one line', () => {
  const db = freshDB()
  saveNotifyConfig(db, { mode: 'hourly', quiet: { start: '23:00', end: '07:00' } })
  const s = describeConfig(loadNotifyConfig(db))
  assert.match(s, /notify ON/)
  assert.match(s, /hourly digest/)
  assert.match(s, /quiet 23:00–07:00 SGT/)
})
