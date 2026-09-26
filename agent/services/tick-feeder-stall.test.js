// node --test agent/services/tick-feeder-stall.test.js
//
// V3 F4 (#1099 fix-round nit 2): a stalled tick permit feeder raises an alarm
// in the heartbeats and in the log inspector instead of going quiet — and
// sends nothing (Telegram delivery waits on OD-10). Driven through
// probeCppExec, checkHeartbeats, heartbeatView and runLogInspector, with the
// feeder's own receipt writer (recordTickEntryWork) as the evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { probeCppExec, checkHeartbeats, heartbeatView, CONTROLLERS, _resetBootStateForTests } from './heartbeat.js'
import { judgeTickFeed, STALL_AFTER_MS, TICK_FEEDER_CHECK_KEY } from './tick-feeder-stall.js'
import { recordTickEntryWork } from './tick-entry-work.js'
import { runLogInspector, evalFalsifierMetric } from './log-inspector.js'

const T0 = new Date('2026-09-26T06:00:00Z')
const at = (sec) => new Date(T0.getTime() + sec * 1000)
// The sidecar answers, with no tick block: the feeder itself never runs —
// exactly the shape of a stall (the recorder stopped reporting).
const EXEC = { execEngineMode: () => 'cpp', pingSidecar: async () => ({ ok: true, mode: 'cpp', connected: true, lastReconcileAt: T0.getTime() - 30_000 }) }
const probe = (db, when, accounts) => probeCppExec(db, { exec: EXEC, now: when, runTickFireLedger: () => ({}), tickEntryAccountsFor: () => accounts })
const hb = (db) => db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'tick_feeder'`).get()
const receipt = (db, completedAt, { pushed = true } = {}) => recordTickEntryWork(db, {
  side: { name: 'cpp_exec' }, creds: { ready: true }, accounts: ['46130058'], completedAt,
  result: { pushed, carried: ['EURUSD'], work: [{ accountId: '46130058', permits: 2 }] },
})

test('judgeTickFeed: idle with no tick account; ok on a complete pass inside two cadences, stalled at two; stalled without one; incomplete on a failed push', () => {
  const now = T0.getTime()
  const good = { completedAt: now - 1_000, complete: true }
  assert.equal(judgeTickFeed({ sides: [{ name: 'a', accounts: [] }], receipts: {}, nowMs: now }).state, 'idle')
  const ok = judgeTickFeed({ sides: [{ name: 'a', accounts: ['1'] }], receipts: { a: good }, nowMs: now })
  assert.deepEqual([ok.state, ok.ok, ok.error], ['ok', true, null])
  const none = judgeTickFeed({ sides: [{ name: 'a', accounts: ['1', '2'] }], receipts: {}, nowMs: now })
  assert.deepEqual([none.state, none.ok], ['stalled', false])
  assert.match(none.error, /^a: no feeder pass on record while 2 account\(s\) admit tick$/)
  const under = judgeTickFeed({ sides: [{ name: 'a', accounts: ['1'] }], receipts: { a: { completedAt: now - STALL_AFTER_MS + 1, complete: true } }, nowMs: now })
  assert.equal(under.state, 'ok', 'just inside two cadences is not yet a stall')
  const edge = judgeTickFeed({ sides: [{ name: 'a', accounts: ['1'] }], receipts: { a: { completedAt: now - STALL_AFTER_MS, complete: true } }, nowMs: now })
  assert.equal(edge.state, 'stalled', 'exactly two cadences IS the stall: probes 120 s apart read 240 s on the second missed pass')
  const old = judgeTickFeed({ sides: [{ name: 'a', accounts: ['1'] }], receipts: { a: { completedAt: now - STALL_AFTER_MS - 1, complete: true } }, nowMs: now })
  assert.equal(old.state, 'stalled')
  assert.match(old.error, /last feeder pass 240 s ago \(one every 120 s expected\)/)
  const failed = judgeTickFeed({ sides: [{ name: 'a', accounts: ['1'] }], receipts: { a: { completedAt: now, complete: false, error: 'push refused' } }, nowMs: now })
  assert.deepEqual([failed.state, failed.error], ['incomplete', 'a: latest feeder pass incomplete: push refused'])
  const mixed = judgeTickFeed({ sides: [{ name: 'a', accounts: ['1'] }, { name: 'b', accounts: [] }], receipts: { a: good }, nowMs: now })
  assert.equal(mixed.state, 'ok', 'an idle side beside a working one')
})

test('F4: an account admits tick and no feeder pass comes — the tick_feeder beat fails with the reason, and turns ERROR after three probes', async () => {
  _resetBootStateForTests(T0.getTime() - 3_600_000)
  const db = initDB(':memory:')
  await probe(db, T0, ['46130058'])
  let row = hb(db)
  assert.equal(row.consecutive_failures, 1)
  assert.match(row.last_error, /^cpp_exec: no feeder pass on record while 1 account\(s\) admit tick$/)
  const detail = JSON.parse(row.last_detail_json)
  assert.deepEqual(detail.sides.map(s => [s.side, s.state, s.accounts]), [['cpp_exec', 'stalled', 1]])
  assert.equal(JSON.parse(db.prepare('SELECT value FROM agent_state WHERE key = ?').get(TICK_FEEDER_CHECK_KEY).value).state, 'stalled')
  let view = heartbeatView(db, { now: T0 }).find(v => v.name === 'tick_feeder')
  assert.deepEqual([view.status, view.error_is_current], ['warn', true], 'visible in the heartbeats')
  await probe(db, at(120), ['46130058'])
  await probe(db, at(240), ['46130058'])
  view = heartbeatView(db, { now: at(240) }).find(v => v.name === 'tick_feeder')
  assert.equal(view.status, 'error')
  assert.equal(view.verdict, 'error', 'a stalled feeder is never labelled dormant')
})

test('F4: a feeder receipt older than two cadences is a stall; a fresh complete one clears it (control)', async () => {
  const db = initDB(':memory:')
  receipt(db, T0.getTime() - STALL_AFTER_MS - 5_000)
  await probe(db, T0, ['46130058'])
  assert.match(hb(db).last_error, /last feeder pass 245 s ago/)
  receipt(db, at(119).getTime())
  await probe(db, at(120), ['46130058'])
  const row = hb(db)
  assert.deepEqual([row.consecutive_failures, JSON.parse(row.last_detail_json).state], [0, 'ok'])
  assert.equal(heartbeatView(db, { now: at(120) }).find(v => v.name === 'tick_feeder').status, 'ok')
})

test('F4: no account admits tick — the beat is ok and the row reads dormant with its reason, not a bare ok', async () => {
  const db = initDB(':memory:')
  await probe(db, T0, [])
  const view = heartbeatView(db, { now: at(5) }).find(v => v.name === 'tick_feeder')
  assert.equal(view.verdict, 'dormant')
  assert.match(view.dormant_reason, /no enabled account admits tick/)
  // A dormant verdict needs a CURRENT idle check: an old one is not dormancy.
  const later = heartbeatView(db, { now: at(STALL_AFTER_MS / 1000 + 121) }).find(v => v.name === 'tick_feeder')
  assert.notEqual(later.verdict, 'dormant')
})

test('F4: QUIET — the stall and the failure streak are recorded in action_log and nothing is sent', async () => {
  assert.equal(CONTROLLERS.tick_feeder.quiet, true)
  _resetBootStateForTests(T0.getTime() - 3_600_000) // outside the deploy grace
  const db = initDB(':memory:')
  for (const s of [0, 120, 240]) await probe(db, at(s), ['46130058'])
  const sent = []
  const events = checkHeartbeats(db, { now: at(900), notify: (t) => sent.push(t) })
  assert.deepEqual(events.filter(e => e.name === 'tick_feeder').map(e => e.event).sort(), ['failing', 'stalled'])
  assert.deepEqual(sent.filter(t => /Tick permit feeder/.test(t)), [], 'no message for the quiet controller')
  const audit = db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE body LIKE '%tick_feeder%'`).get().n
  assert.ok(audit >= 2, `the durable trail carries both events (${audit})`)
  // Control: the same streak on a non-quiet controller IS sent.
  const db2 = initDB(':memory:')
  for (let i = 0; i < 3; i++) db2.prepare(`INSERT INTO controller_heartbeats (name, last_run_at, last_ok_at, last_error, consecutive_failures, runs, updated_at)
      VALUES ('trade_guards', ?, NULL, 'boom', 3, 3, ?) ON CONFLICT(name) DO NOTHING`).run(at(890).toISOString(), at(890).toISOString())
  const sent2 = []
  checkHeartbeats(db2, { now: at(900), notify: (t) => sent2.push(t) })
  assert.equal(sent2.filter(t => /Trade guards/.test(t)).length, 1)
})

test('F4: the inspector raises one finding per stalled side; none while the feeder is healthy; the falsifier reads the receipt', async () => {
  const db = initDB(':memory:')
  await probe(db, T0, ['46130058'])
  runLogInspector(db, { now: at(30).getTime() })
  const f = db.prepare(`SELECT subject_key, finding, falsifier FROM inspection_findings WHERE subject_key LIKE 'tick_feeder_stall:%'`).all()
  assert.deepEqual(f.map(x => x.subject_key), ['tick_feeder_stall:cpp_exec'])
  assert.match(f[0].finding, /stalled while 1 account\(s\) admit tick/)
  const metric = JSON.parse(f[0].falsifier).metric
  assert.equal(evalFalsifierMetric(db, metric), null, 'no receipt at all → unevaluable, never confirmed')
  receipt(db, at(10).getTime(), { pushed: false })
  assert.equal(evalFalsifierMetric(db, metric), true, 'an incomplete pass is not a resumed feeder')
  receipt(db, at(3_000).getTime())
  assert.equal(evalFalsifierMetric(db, metric), false, 'a complete pass after the finding falsifies the stuck reading')

  const healthy = initDB(':memory:')
  receipt(healthy, T0.getTime() - 1_000)
  await probe(healthy, T0, ['46130058'])
  runLogInspector(healthy, { now: at(30).getTime() })
  assert.equal(healthy.prepare(`SELECT COUNT(*) AS n FROM inspection_findings WHERE subject_key LIKE 'tick_feeder_stall:%'`).get().n, 0)
})

test('F4: probes exactly one cadence apart — a feeder that stops after a pass reads stalled on the second missed probe (240 s), not the third', async () => {
  const db = initDB(':memory:')
  receipt(db, T0.getTime())
  await probe(db, T0, ['46130058'])
  assert.equal(hb(db).consecutive_failures, 0, 'the pass itself: ok')
  await probe(db, at(120), ['46130058'])
  assert.equal(hb(db).consecutive_failures, 0, 'one missed pass is not a stall')
  await probe(db, at(240), ['46130058'])
  assert.equal(hb(db).consecutive_failures, 1, 'the second missed pass is')
  assert.match(hb(db).last_error, /last feeder pass 240 s ago/)
})

test('F4: "no feeder pass on record" can be confirmed — a later check that still finds the side admitting tick, with no receipt, holds the stall', async () => {
  const db = initDB(':memory:')
  await probe(db, T0, ['46130058'])
  runLogInspector(db, { now: at(30).getTime() })
  const metric = JSON.parse(db.prepare(`SELECT falsifier FROM inspection_findings WHERE subject_key = 'tick_feeder_stall:cpp_exec'`).get().falsifier).metric
  assert.equal(evalFalsifierMetric(db, metric), null, 'no check since the finding → unevaluable')
  await probe(db, at(150), ['46130058'])
  assert.equal(evalFalsifierMetric(db, metric), true, 'checked after the finding, still an account admitting tick, still no pass → confirmed')
  // Control: the side stopped admitting tick → nothing left to feed → unevaluable, not confirmed.
  await probe(db, at(270), [])
  assert.equal(evalFalsifierMetric(db, metric), null)
})
