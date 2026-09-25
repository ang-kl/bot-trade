// node --test agent/services/daily-report.test.js
//
// Wave 5 (first-principles audit 19-09-2026 §K item 16): the daily Telegram
// report — built from the DB, bounded for Telegram, posted once a day on a
// persisted cursor stamped BEFORE the work, and served on /state/daily-report.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import { CONTROLLERS, heartbeatView } from './heartbeat.js'
import {
  buildDailyReport, postDailyReport, dailyReportDue, dailyReportView, fitSections,
  DAILY_REPORT_LAST_KEY, DAILY_REPORT_TEXT_KEY, DAILY_REPORT_MAX_CHARS, DAILY_REPORT_INTERVAL_MS, TRUNCATED_MARK,
} from './daily-report.js'

const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
const NOW = Date.parse('2026-09-19T21:30:00Z')

test('the builder on an EMPTY db: every section present, no throw, under the Telegram bound', async () => {
  const db = initDB(':memory:')
  const r = await buildDailyReport(db, { now: NOW })
  assert.deepEqual(r.sections.map(s => s.id), ['header', 'goals', 'lifecycle', 'momentum', 'equity', 'family', 'vetoes', 'arming', 'positions'])
  assert.ok(r.chars <= DAILY_REPORT_MAX_CHARS, `${r.chars} chars`)
  assert.equal(r.truncated, false)
  assert.match(r.text, /^Daily report — 2026-09-19 21:30 UTC/)
  assert.match(r.text, /Goals: \d+ on track, \d+ off track, \d+ not measurable \(of 24\)/)
  assert.match(r.text, /Lifecycle: no snapshot \(order_lifecycle_last_json\)/)
  assert.match(r.text, /Checkpoint 2026-12-19: not_measurable/)
  assert.match(r.text, /Equity: no nightly snapshot yet/)
  assert.match(r.text, /Family momentum: no closes in 90 d/)
  assert.match(r.text, /Vetoes: n\/a \(not_measurable\)/)
  assert.match(r.text, /Arming: no changes in 24 h/)
  assert.match(r.text, /Open positions: 0/)
  for (const s of r.sections) assert.ok(!s.lines.some(l => /unreadable/.test(l)), `${s.id} read cleanly: ${s.lines.join(' | ')}`)
})

test('the family section prints a Tick basis line once a tick close exists, and none before (plan P1: tick is in no family)', async () => {
  const db = initDB(':memory:')
  const none = await buildDailyReport(db, { now: NOW })
  assert.doesNotMatch(none.text, /Tick basis:/)
  const at = NOW - 86_400_000
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, exit_price, sl_price, net_pnl, realised_rr, label_raw, source, account_id, closed_at, closed_at_ms)
                          VALUES ('EURUSD', 'BUY', 'closed', 1.1, 1.12, 1.09, ?, ?, ?, 'autopilot', '47790949', ?, ?)`)
  ins.run(40, 2, 'tick:abc', new Date(at).toISOString(), at)
  ins.run(-20, -1, 'tick:abc', new Date(at + 1000).toISOString(), at + 1000)
  const r = await buildDailyReport(db, { now: NOW })
  const fam = r.sections.find(s => s.id === 'family').lines
  const line = fam.find(l => l.startsWith('Tick basis:'))
  assert.ok(line, fam.join(' | '))
  assert.match(line, /^Tick basis: 2 close\(s\), PF 2(\.0+)?, /)
  assert.ok(!fam.some(l => /unattributed/.test(l)), 'the tick closes are not counted as unattributed')
})

test('the builder reads real rows: an off_track goal is named with its current, equity shows the night change, open positions are counted per account', async () => {
  const db = initDB(':memory:')
  // Two nights of equity for one account.
  const ins = db.prepare(`INSERT INTO equity_snapshots (at, account_id, balance_usd, open_pnl_usd, equity_usd, open_positions, error) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
  ins.run('2026-09-17T21:05:00.000Z', '47790949', 1000, 0, 1000, 0)
  ins.run('2026-09-18T21:05:00.000Z', '47790949', 1010, 15.5, 1025.5, 2)
  db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, account_id, opened_at) VALUES ('EURUSD', 'BUY', 'open', 1.1, 1.09, '47790949', datetime('now'))`).run()
  db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, account_id, opened_at) VALUES ('GBPUSD', 'BUY', 'open', 1.3, 1.29, '47790949', datetime('now'))`).run()
  // A stale fast-monitor record older than 5 min is not_measurable; a fresh
  // one over the ceiling is off_track — that row must be named.
  setState(db, 'fast_monitor_pass_json', JSON.stringify({ at: new Date(NOW - 60_000).toISOString(), tick: { everyMs: 3000, skipShare10m: 0.4 } }))
  const r = await buildDailyReport(db, { now: NOW })
  assert.match(r.text, /off track: monitor_cadence — 40% \(target ≤ 10%\)/)
  assert.match(r.text, /Equity …0949: 1025\.50 \(currency unrecorded\) on 2026-09-18 \(comparison unavailable without matching currency\)/)
  assert.match(r.text, /Open positions: 2 \(…0949 2\)/)
})

test('fitSections cuts from the LAST section back, keeps each head line, marks the cut, and never exceeds the bound', () => {
  const big = (id, n) => ({ id, lines: [`${id} head`, ...Array.from({ length: n }, (_, i) => `${id} line ${i} ${'x'.repeat(60)}`)] })
  const sections = [{ id: 'header', lines: ['Daily report'] }, big('goals', 20), big('momentum', 20), big('arming', 40)]
  const full = sections.map(s => s.lines.join('\n')).join('\n\n').length
  assert.ok(full > 3_800, `fixture is over the bound (${full})`)
  const { text, truncated } = fitSections(sections, 3_800)
  assert.equal(truncated, true)
  assert.ok(text.length <= 3_800, `${text.length}`)
  assert.match(text, /arming head[\s\S]*…truncated/, 'the lowest-priority section is the one cut, and says so')
  assert.ok(text.includes('goals line 19'), 'the highest-priority sections are intact')
  assert.ok(text.includes('momentum line 19'))
  assert.equal(text.split(TRUNCATED_MARK).length - 1, 1, 'one mark for one cut section')
  // Under the bound: untouched.
  const small = fitSections([{ id: 'a', lines: ['one', 'two'] }], 3_800)
  assert.equal(small.truncated, false); assert.equal(small.text, 'one\ntwo'); assert.deepEqual(small.dropped, [])
})

test('fitSections DROPS a section whose head line cannot fit instead of leaving a one-word stub (checker note 5)', () => {
  const sections = [
    { id: 'header', lines: ['Daily report'] },
    { id: 'goals', lines: ['Goals: 1 on track', 'off track: a'] },
    { id: 'arming', lines: ['Arming head ' + 'y'.repeat(200), 'line 1', 'line 2'] },
  ]
  const { text, truncated, dropped } = fitSections(sections, 80)
  assert.equal(truncated, true)
  assert.deepEqual(dropped, ['arming'])
  assert.ok(text.length <= 80, `${text.length}`)
  assert.ok(!/Arming/.test(text), 'no stub of the dropped section: ' + text)
  assert.ok(!/\n.\n…truncated/.test(text), 'no one-character stub')
  assert.match(text, /^Daily report\n\nGoals: 1 on track/)
  assert.match(text, /…truncated \(arming dropped\)$/, 'the drop is named')
  // Two oversize tails: both dropped, both named, the head sections intact.
  const two = fitSections([...sections, { id: 'positions', lines: ['P'.repeat(200)] }], 80)
  assert.deepEqual(two.dropped, ['arming', 'positions'])
  assert.match(two.text, /^Daily report\n\nGoals: 1 on track/)
})

test('a FAILED post keeps the last SUCCESSFUL record\'s `at` and text and stamps failedAt + error beside them, so the heartbeat effect does not read a failure as fresh (checker should-fix 3)', async () => {
  const { effectRecord } = await import('./heartbeat.js')
  const db = initDB(':memory:')
  const T1 = NOW, T2 = NOW + 24 * 3600_000
  const ok = await postDailyReport(db, { now: T1, queue: () => true })
  assert.equal(ok.ok, true)
  const bad = await postDailyReport(db, { now: T2, queue: () => { throw new Error('outbox gone') }, send: async () => { throw new Error('telegram down') } })
  assert.equal(bad.ok, false)
  const rec = JSON.parse(getState(db, DAILY_REPORT_TEXT_KEY))
  assert.equal(rec.at, new Date(T1).toISOString(), 'the successful at is kept')
  assert.match(rec.text, /^Daily report — /, 'the successful text is kept')
  assert.equal(rec.failedAt, new Date(T2).toISOString())
  assert.match(rec.error, /telegram down/)
  const eff = effectRecord(db, 'daily_report', { nowMs: T2 + 60_000 })
  assert.equal(eff.at, new Date(T1).toISOString(), 'the effect is dated by the last SUCCESS')
  assert.equal(eff.fresh, true, 'still inside the 30 h limit from the success…')
  assert.equal(effectRecord(db, 'daily_report', { nowMs: T1 + 31 * 3600_000 }).fresh, false, '…and stale past it, whatever the failure stamped')
  // With no success ever: no `at` at all, so the effect reads "no record".
  const db2 = initDB(':memory:')
  await postDailyReport(db2, { now: T1, queue: () => { throw new Error('x') }, send: async () => { throw new Error('y') } })
  const rec2 = JSON.parse(getState(db2, DAILY_REPORT_TEXT_KEY))
  assert.equal(rec2.at, undefined); assert.equal(rec2.failedAt, new Date(T1).toISOString())
  assert.equal(effectRecord(db2, 'daily_report', { nowMs: T1 + 1000 }).hasRecord, false)
  assert.equal(dailyReportView(db2).last.failedAt, rec2.failedAt)
})

test('the due rule: never run → due; stamped now → not due; 24 h later → due; the interval is 24 h', () => {
  const db = initDB(':memory:')
  assert.equal(dailyReportDue(db, NOW), true, 'a never-run db runs immediately')
  setState(db, DAILY_REPORT_LAST_KEY, new Date(NOW).toISOString())
  assert.equal(dailyReportDue(db, NOW + 60_000), false)
  assert.equal(dailyReportDue(db, NOW + DAILY_REPORT_INTERVAL_MS - 1), false)
  assert.equal(dailyReportDue(db, NOW + DAILY_REPORT_INTERVAL_MS), true)
  assert.equal(DAILY_REPORT_INTERVAL_MS, 24 * 3600_000)
})

test('postDailyReport STAMPS BEFORE THE WORK, queues through the outbox with kind daily_report, and stores the last text', async () => {
  const db = initDB(':memory:')
  const queued = []
  let stampAtQueue = null
  const r = await postDailyReport(db, {
    now: NOW,
    queue: (_db, msg) => { queued.push(msg); stampAtQueue = getState(db, DAILY_REPORT_LAST_KEY); return true },
    send: async () => { throw new Error('direct send must not be used when the outbox took it') },
  })
  assert.equal(r.ok, true); assert.equal(r.delivery, 'queued')
  assert.equal(stampAtQueue, new Date(NOW).toISOString(), 'the cursor was already stamped when the work ran')
  assert.equal(queued.length, 1)
  assert.equal(queued[0].kind, 'daily_report'); assert.equal(queued[0].priority, 'normal'); assert.equal(queued[0].reason, 'daily report')
  assert.match(queued[0].text, /^Daily report — /)
  const last = JSON.parse(getState(db, DAILY_REPORT_TEXT_KEY))
  assert.equal(last.text, queued[0].text); assert.equal(last.chars, queued[0].text.length); assert.equal(last.delivery, 'queued')
  assert.equal(dailyReportDue(db, NOW + 60_000), false, 'not due again for 24 h')
})

test('postDailyReport falls back to the direct send when the outbox write fails, and a failing build still leaves the stamp (retried tomorrow, not every cycle)', async () => {
  const db = initDB(':memory:')
  const sent = []
  const r = await postDailyReport(db, { now: NOW, queue: () => false, send: async (text, opts) => { sent.push({ text, opts }) } })
  assert.equal(r.ok, true); assert.equal(r.delivery, 'sent_direct')
  assert.equal(sent.length, 1); assert.equal(sent[0].opts.plain, true, 'plain text: no markdown parse that rejects on one underscore')

  const db2 = initDB(':memory:')
  const r2 = await postDailyReport(db2, { now: NOW, queue: () => { throw new Error('outbox gone') }, send: async () => { throw new Error('telegram down') } })
  assert.equal(r2.ok, false); assert.match(r2.error, /telegram down/)
  assert.equal(getState(db2, DAILY_REPORT_LAST_KEY), new Date(NOW).toISOString(), 'stamped before the work')
  assert.equal(dailyReportDue(db2, NOW + 60_000), false)
  assert.match(JSON.parse(getState(db2, DAILY_REPORT_TEXT_KEY)).error, /telegram down/)
  assert.equal(JSON.parse(getState(db2, DAILY_REPORT_TEXT_KEY)).at, undefined, 'a failure never mints an `at`')
})

test('GET /state/daily-report serves the last report and whether the next is due', async () => {
  const db = initDB(':memory:')
  const { default: stateRouter } = await import('../routes/state.js')
  const app = express()
  app.use('/state', stateRouter(db))
  const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)) })
  try {
    const url = `http://127.0.0.1:${s.address().port}/state/daily-report`
    let v = await fetch(url).then(x => x.json())
    assert.equal(v.last, null); assert.equal(v.due, true); assert.equal(v.maxChars, DAILY_REPORT_MAX_CHARS)
    await postDailyReport(db, { now: Date.now(), queue: () => true })
    v = await fetch(url).then(x => x.json())
    assert.match(v.last.text, /^Daily report — /); assert.equal(v.due, false); assert.ok(v.lastAt)
    assert.deepEqual(dailyReportView(db).last.chars, v.last.chars)
  } finally { s.close() }
})

test('wiring pins: the loop posts on the due rule after the equity snapshot and beats daily_report; the heartbeat row reads the record; the route exists', () => {
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const i = loop.indexOf('equitySnapshotDue(db)')
  const j = loop.indexOf('dailyReportDue(db)')
  assert.ok(i > 0 && j > i, 'the daily report follows the equity snapshot block')
  assert.match(loop, /if \(dailyReportDue\(db\)\) \{\s*const dr = await postDailyReport\(db\)/)
  assert.match(loop, /hbeat\(db, 'daily_report', dr\.ok/)
  assert.match(loop, /catch \(err\) \{ await hbeat\(db, 'daily_report', false, err\?\.message\) \}/)
  assert.equal(CONTROLLERS.daily_report.expectedSec, 24 * 3600)
  assert.equal(CONTROLLERS.daily_report.effect.key, DAILY_REPORT_TEXT_KEY)
  const state = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(state, /router\.get\('\/daily-report'/)
  const db = initDB(':memory:')
  assert.ok(heartbeatView(db).some(v => v.name === 'daily_report'))
})
