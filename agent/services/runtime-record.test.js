// node --test agent/services/runtime-record.test.js
//
// V3 M1 (P1/P4-1): the boot record and the latency windows. These are the
// instruments every later V3 merge's startup window is graded with, so each
// property here is one a grader would otherwise have to take on trust: rings
// that stay bounded, percentiles that are right on known data, a record
// written once per boot that keeps the previous boot's, a first stamp a later
// good pass cannot overwrite, and nothing credential-shaped in any of it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  percentile, summarize, createRing, sanitizeRecordValue,
  stampFirst, noteLoopEnd, noteListening, noteDbStartup, noteBudgetOverrun, noteHttpStatus,
  runtimeRecordSnapshot, latencyWindows, persistRuntimeRecord, readBootRecords, budgetOverrunSummary,
  startupHttpSummary, _resetRuntimeRecordForTests,
  RECORD_KEY, PREV_RECORD_KEY, PERSIST_MIN_MS, LOOP_RING_SIZE, FIRST_STAMPS, OVERRUN_WINDOW_MS,
} from './runtime-record.js'
import { BOOT_ORIGIN_MS, STARTUP_WINDOW_MS, inStartupWindow, sinceBootMs } from './boot-clock.js'

test('percentile / summarize on known arrays: nearest rank, nulls when empty', () => {
  const tens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  assert.deepEqual(summarize(tens), { n: 10, p50: 50, p95: 100, p99: 100, max: 100 })
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.deepEqual(summarize(hundred.slice().reverse()), { n: 100, p50: 50, p95: 95, p99: 99, max: 100 }, 'order of arrival does not matter')
  assert.deepEqual(summarize([]), { n: 0, p50: null, p95: null, p99: null, max: null })
  assert.deepEqual(summarize([NaN, 'x', 7]), { n: 1, p50: 7, p95: 7, p99: 7, max: 7 }, 'junk is not a sample')
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([5], 0.99), 5)
})

test('a ring keeps exactly its capacity, newest last, and can be read from a time', () => {
  const r = createRing(360)
  for (let i = 0; i < 1000; i++) r.push(i, 1_000 + i)
  assert.equal(r.size, 360)
  const e = r.entries()
  assert.equal(e.length, 360)
  assert.equal(e[0].v, 640, 'the oldest 640 were overwritten')
  assert.equal(e[359].v, 999)
  assert.equal(r.entries(1_000 + 990).length, 10)
  const small = createRing(3)
  small.push(1, 1); small.push(2, 2)
  assert.deepEqual(small.entries().map(x => x.v), [1, 2], 'a ring that has not wrapped reads what it holds')
})

test('BOOT is one origin: process start, and "since boot" is measured from it', () => {
  assert.equal(typeof BOOT_ORIGIN_MS, 'number')
  assert.ok(BOOT_ORIGIN_MS <= Date.now() && BOOT_ORIGIN_MS > Date.now() - 24 * 3600_000, 'performance.timeOrigin is this process\'s start')
  assert.equal(sinceBootMs(BOOT_ORIGIN_MS + 7_500), 7_500)
  assert.equal(inStartupWindow(BOOT_ORIGIN_MS + STARTUP_WINDOW_MS), true)
  assert.equal(inStartupWindow(BOOT_ORIGIN_MS + STARTUP_WINDOW_MS + 1), false)
  assert.equal(inStartupWindow(BOOT_ORIGIN_MS - 1), false)
  _resetRuntimeRecordForTests()
  const snap = runtimeRecordSnapshot()
  assert.equal(snap.bootAt, new Date(BOOT_ORIGIN_MS).toISOString())
  assert.match(snap.origin, /performance\.timeOrigin/)
})

test('first stamps are WRITE-ONCE per boot: a later good pass never overwrites a failed first one; unknown names are refused', () => {
  _resetRuntimeRecordForTests()
  assert.equal(stampFirst('equityStop', { ok: false, error: 'db locked' }), true)
  assert.equal(stampFirst('equityStop', { ok: true }), false)
  const s = runtimeRecordSnapshot().first.equityStop
  assert.equal(s.ok, false)
  assert.equal(s.error, 'db locked')
  assert.match(s.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(typeof s.sinceBootMs, 'number')
  assert.equal(stampFirst('somethingElse', { ok: true }), false)
  assert.equal('somethingElse' in runtimeRecordSnapshot().first, false, 'the record carries a closed list of stamps')
  assert.deepEqual(Object.keys(runtimeRecordSnapshot().first).sort(), [...FIRST_STAMPS].sort())
  // every protection-relevant first event the spec names has a slot
  for (const k of ['loop', 'fastTick', 'band', 'protectionAudit', 'slowMonitor', 'equityStop', 'adaptiveBreaker', 'performanceBreaker']) {
    assert.ok(FIRST_STAMPS.includes(k), k)
  }
})

test('the FIRST LOOP is stamped with its ms and per-phase breakdown; every loop feeds the ring; later loops never replace the first', () => {
  _resetRuntimeRecordForTests()
  noteLoopEnd({ startedAtMs: Date.now() - 125_069, ms: 125_069, phaseMs: { scan: 47_000, 'decision audit': 40_500, 'fx legs refresh': 900 }, ok: true })
  for (const ms of [21_427, 30_000, 19_000]) noteLoopEnd({ startedAtMs: Date.now(), ms, phaseMs: { scan: 1 }, ok: true })
  const first = runtimeRecordSnapshot().first.loop
  assert.equal(first.ms, 125_069)
  assert.equal(first.phaseMs['decision audit'], 40_500)
  assert.equal(first.ok, true)
  const lw = latencyWindows()
  assert.equal(lw.mainLoop.n, 4)
  assert.equal(lw.mainLoop.max, 125_069)
  assert.equal(lw.mainLoop.lastMs, 19_000)
  assert.equal(lw.mainLoop.capacity, LOOP_RING_SIZE)
  for (let i = 0; i < LOOP_RING_SIZE + 40; i++) noteLoopEnd({ ms: 1_000 })
  assert.equal(latencyWindows().mainLoop.n, LOOP_RING_SIZE, 'the ring is bounded')
  assert.equal(runtimeRecordSnapshot().first.loop.ms, 125_069, 'the first loop is still the first loop')
})

test('listening and the database timing are stamped once, measured from BOOT', () => {
  _resetRuntimeRecordForTests()
  noteDbStartup({ totalMs: 512, phases: { open: 20, final_migrations_and_seed: 300 } })
  assert.equal(noteListening(), true)
  assert.equal(noteListening(), false)
  const s = runtimeRecordSnapshot()
  assert.equal(s.db.init.totalMs, 512)
  assert.equal(typeof s.db.openedSinceBootMs, 'number')
  assert.equal(typeof s.listening.sinceBootMs, 'number')
  assert.ok(s.listening.sinceBootMs >= 0)
})

test('THE BOOT RECORD is written once per boot and the PREVIOUS boot\'s record is kept — a second boot moves it aside exactly once', () => {
  const db = initDB(':memory:')
  let now = 1_900_000_000_000
  // boot 1
  _resetRuntimeRecordForTests({ bootId: 'boot-1' })
  noteLoopEnd({ ms: 133_787, phaseMs: { scan: 47_000 } })
  assert.equal(persistRuntimeRecord(db, { nowMs: now }).written, true)
  assert.equal(readBootRecords(db).stored.bootId, 'boot-1')
  assert.equal(readBootRecords(db).previous, null, 'no earlier boot on a fresh database')
  // boot 2 (a restart)
  _resetRuntimeRecordForTests({ bootId: 'boot-2' })
  now += 60_000
  assert.equal(persistRuntimeRecord(db, { nowMs: now }).written, true)
  let r = readBootRecords(db)
  assert.equal(r.stored.bootId, 'boot-2')
  assert.equal(r.previous.bootId, 'boot-1', 'the restart kept the evidence of the process it replaced')
  assert.equal(r.previous.first.loop.ms, 133_787)
  // boot 2 keeps writing — throttled, and never rotating again
  assert.deepEqual(persistRuntimeRecord(db, { nowMs: now + 1_000 }), { written: false, reason: 'throttled' })
  noteLoopEnd({ ms: 85_657 })
  assert.equal(persistRuntimeRecord(db, { nowMs: now + PERSIST_MIN_MS }).written, true)
  r = readBootRecords(db)
  assert.equal(r.stored.bootId, 'boot-2')
  assert.equal(r.stored.first.loop.ms, 85_657)
  assert.equal(r.previous.bootId, 'boot-1', 'a second write of the SAME boot must not overwrite the previous boot with itself')
})

test('a stored record from THIS boot is not rotated into "previous" (a re-armed writer in the same process)', () => {
  const db = initDB(':memory:')
  _resetRuntimeRecordForTests({ bootId: 'same' })
  persistRuntimeRecord(db, { nowMs: 1_900_000_000_000 })
  _resetRuntimeRecordForTests({ bootId: 'same' })
  persistRuntimeRecord(db, { nowMs: 1_900_000_100_000 })
  assert.equal(readBootRecords(db).previous, null)
})

test('persistence never throws, even when the database write does', () => {
  _resetRuntimeRecordForTests({ bootId: 'x' })
  const broken = { prepare() { throw new Error('SQLITE_BUSY') } }
  const out = persistRuntimeRecord(broken, { nowMs: 1 })
  assert.equal(out.written, false)
  assert.match(out.error, /SQLITE_BUSY/)
})

test('NO SECRET-SHAPED FIELDS: credential-named keys are dropped and token-shaped values redacted, even when a caller plants them', () => {
  const db = initDB(':memory:')
  _resetRuntimeRecordForTests({ bootId: 'secrets' })
  const longToken = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2'
  stampFirst('band', {
    ms: 1_613, ok: false,
    accessToken: 'tok-123', clientSecret: 'shh', authorization: 'Bearer abc', sessionId: 'sess_0123456789abcdef',
    error: `refresh failed: Bearer ${longToken} and sess_0123456789abcdef0123 rejected`,
    nested: { password: 'p', note: longToken },
  })
  noteBudgetOverrun('loss_guardian', 5_000, 6_100)
  persistRuntimeRecord(db, { nowMs: 1_900_000_000_000 })
  const raw = getState(db, RECORD_KEY)
  for (const leak of ['tok-123', 'shh', 'Bearer abc', 'sess_0123456789abcdef', longToken, 'accessToken', 'clientSecret', 'authorization', 'sessionId', 'password']) {
    assert.ok(!raw.includes(leak), `the stored boot record carries "${leak}"`)
  }
  const band = JSON.parse(raw).first.band
  assert.equal(band.ms, 1_613, 'the measurement itself survives')
  assert.match(band.error, /refresh failed: \[redacted\]/)
  assert.deepEqual(sanitizeRecordValue({ a: NaN, b: Infinity, c: () => 1, d: 'ab '.repeat(500) }), { a: null, b: null, c: null, d: 'ab '.repeat(500).slice(0, 200) })
  assert.equal(sanitizeRecordValue('x'.repeat(64)), '[redacted]', 'an unbroken 40+ character run reads as a token and is redacted')
})

test('the stored record stays bounded under load: many overrun names, many failing routes, a full loop ring', () => {
  const db = initDB(':memory:')
  _resetRuntimeRecordForTests({ bootId: 'big' })
  for (let i = 0; i < 2_000; i++) noteBudgetOverrun(`step_${i % 100}`, 5_000, 6_000)
  for (let i = 0; i < 500; i++) noteHttpStatus(`/state/report_${i}`, 503)
  for (let i = 0; i < LOOP_RING_SIZE * 2; i++) noteLoopEnd({ ms: 20_000 + i, phaseMs: Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`phase ${k}`, k])) })
  persistRuntimeRecord(db, { nowMs: Date.now() })
  const raw = getState(db, RECORD_KEY)
  assert.ok(raw.length < 16_384, `boot record is ${raw.length} bytes`)
  const summary = budgetOverrunSummary()
  assert.ok(Object.keys(summary.sinceBoot).length <= 33, 'overrun names are capped, with an (other) bucket')
  assert.ok('(other)' in summary.sinceBoot)
})

test('startup-window HTTP statuses: counted by route inside the window, ignored outside it, first 5xx named', () => {
  _resetRuntimeRecordForTests()
  const inside = BOOT_ORIGIN_MS + 98_000        // /decisions-daily's deadline, 98 s after boot
  const outside = BOOT_ORIGIN_MS + STARTUP_WINDOW_MS + 60_000
  noteHttpStatus('/state/decisions-daily', 503, inside)
  noteHttpStatus('/state/decisions-daily', 200, inside + 1_000)
  noteHttpStatus('/health', 200, inside)
  noteHttpStatus('/state/prices', 'aborted', inside)
  noteHttpStatus('/state/decisions-daily', 503, outside)
  const h = startupHttpSummary(outside)
  assert.equal(h.complete, true)
  assert.equal(h.total['5xx'], 1, 'the 503 after the window is not a startup failure')
  assert.equal(h.total['2xx'], 2)
  assert.equal(h.total.aborted, 1)
  assert.equal(h.first5xx.route, '/state/decisions-daily')
  assert.equal(h.first5xx.status, 503)
  assert.deepEqual(h.routes.map(r => r.route), ['/state/decisions-daily', '/state/prices'], 'only routes with a failure are listed, worst first')
  assert.equal(startupHttpSummary(inside).complete, false, 'inside the window the counts are a partial reading')
})

test('budget overruns are counted per 10-minute window and since boot', () => {
  _resetRuntimeRecordForTests()
  const t0 = BOOT_ORIGIN_MS + 30_000
  noteBudgetOverrun('loss_guardian', 5_000, 6_000, t0)
  noteBudgetOverrun('protection_audit_account', 4_000, 4_000, t0 + 1_000)
  noteBudgetOverrun('protection_audit_account', 4_000, 4_000, t0 + OVERRUN_WINDOW_MS + 5_000)
  const s = budgetOverrunSummary(t0 + OVERRUN_WINDOW_MS + 10_000)
  assert.equal(s.total10m, 1, 'the two early overruns aged out of the 10-minute window')
  assert.deepEqual(s.byName10m, { protection_audit_account: 1 })
  assert.equal(s.sinceBoot.protection_audit_account.n, 2)
  assert.equal(s.sinceBoot.loss_guardian.n, 1)
  assert.equal(s.sinceBoot.loss_guardian.budgetMs, 5_000)
  assert.equal(s.sinceBoot.loss_guardian.startup, 1, 'inside the startup window')
})

test('latencyWindows serves the tap, not the 30-second ALIVE sampler', () => {
  _resetRuntimeRecordForTests()
  const lw = latencyWindows()
  assert.match(lw.eventLoopLag.source, /100 ms probe tap/)
  assert.ok('last10m' in lw.eventLoopLag && 'last2h' in lw.eventLoopLag && 'sinceStart' in lw.eventLoopLag)
})

test('readBootRecords tolerates junk in the stored keys', () => {
  const db = initDB(':memory:')
  setState(db, RECORD_KEY, '{not json')
  setState(db, PREV_RECORD_KEY, null)
  assert.deepEqual(readBootRecords(db), { stored: null, previous: null })
})
