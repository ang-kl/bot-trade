// node --test agent/services/report-unavailable.test.js
//
// P1/P4 M2 at the worker boundary: every isolated-report rejection is typed
// as unavailable (with a reason and a retry hint, the message unchanged for
// heartbeats), and the storage walk has its own reserved slot so a 21-second
// dbstat never takes one of the two slots the loop's decision audit needs.
//
// V3 M2b: a raw worker error keeps its words (`detail`); a fixed bound is not
// retryable; the storage walk answers inside its deadline with a truthful
// partial or a labelled cached measurement, keeps a result that arrives
// late, and does not walk again inside its cooldown.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB } from '../db.js'
import { storageReport } from './storage-report.js'
import {
  ReportUnavailableError, isReportUnavailable, readPerformancePopulations, readPerformanceAnalytics,
  readLatestPrices, readStorageReport, stopStorageWalk, overrideReportTimingForTest,
} from './performance-populations.js'

function fileFixture(t) {
  const db = initDB(join(tempDir('report-unavailable-svc-'), 'agent.db'))
  t.after(() => db.close())
  return db
}
function lockExclusive(t, db) {
  db.pragma('journal_mode=DELETE')
  const lock = new Database(db.name); lock.exec('BEGIN EXCLUSIVE')
  const release = () => { if (lock.inTransaction) lock.exec('ROLLBACK') }
  t.after(() => { release(); lock.close() })
  return release
}
/** The same connection, with the file name the report worker opens switchable. */
function switchableName(db) {
  const missing = join(tempDir('report-unavailable-missing-'), 'missing.db')
  const handle = { useMissing: false }
  handle.db = new Proxy(db, { get(target, key) {
    if (key === 'name') return handle.useMissing ? missing : target.name
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return handle
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('failure codes keep their name, message and a retry hint; a raw driver message is one generic reason with its words kept', () => {
  const cases = [
    ['performance_report_deadline', 'performance_report_deadline', 30],
    ['performance_report_worker_capacity', 'performance_report_worker_capacity', 5],
    ['watchdog_report_worker_capacity', 'watchdog_report_worker_capacity', 5],
    ['performance_report_worker_exit', 'performance_report_worker_exit', 15],
    ['unable to open database file', 'performance_report_worker_error', 30],
    ['SQLITE_BUSY: database is locked', 'performance_report_worker_error', 30],
  ]
  for (const [message, reason, retryAfterSec] of cases) {
    const error = new ReportUnavailableError(new Error(message))
    assert.equal(error.message, message, 'heartbeats record err.message unchanged')
    assert.equal(error.reason, reason, message)
    assert.equal(error.retryAfterSec, retryAfterSec, message)
    assert.equal(error.retryable, true, message)
    assert.equal(isReportUnavailable(error), true)
    // Only a failure without a named code carries the driver's words.
    assert.equal(error.detail, reason === 'performance_report_worker_error' ? message : null, message)
  }
  assert.equal(isReportUnavailable(new Error('performance_report_deadline')), false, 'an untyped error is not a report failure')
  assert.equal(new ReportUnavailableError(new Error('x'.repeat(5000))).detail.length, 300, 'the kept words are bounded')
})

test('a fixed bound is unavailable but never retryable: no retry hint, no detail', () => {
  for (const code of ['performance_report_group_bound', 'performance_report_median_bound', 'performance_report_response_bound',
    'order_lifecycle_response_bound', 'report_session_window_bound']) {
    const error = new ReportUnavailableError(new Error(code))
    assert.equal(error.reason, code)
    assert.equal(error.retryable, false, code)
    assert.equal(error.retryAfterSec, null, code)
    assert.equal(error.detail, null, code)
  }
})

test('a worker that cannot open its database rejects as unavailable, message intact and its words kept', async t => {
  const db = fileFixture(t)
  const handle = switchableName(db); handle.useMissing = true
  const error = await readLatestPrices(handle.db).then(() => null, e => e)
  assert.ok(error, 'the read must fail')
  assert.equal(isReportUnavailable(error), true)
  assert.equal(error.reason, 'performance_report_worker_error')
  assert.equal(error.detail, 'unable to open database file')
})

test('the shared pool rejects a third report as capacity, typed as unavailable', async t => {
  const db = fileFixture(t)
  const release = lockExclusive(t, db)
  const held = [readPerformancePopulations(db), readPerformanceAnalytics(db, { accountId: '11' })]
  const error = await readLatestPrices(db).then(() => null, e => e)
  release(); await Promise.allSettled(held)
  assert.equal(isReportUnavailable(error), true)
  assert.equal(error.message, 'performance_report_worker_capacity')
  assert.equal(error.retryAfterSec, 5)
})

test('a running storage walk leaves both shared report slots free', async t => {
  const db = fileFixture(t)
  const release = lockExclusive(t, db)
  const storage = readStorageReport(db)
  const a = readPerformancePopulations(db), b = readPerformanceAnalytics(db, { accountId: '11' })
  // Both shared slots were granted: a third shared report is the one refused.
  const third = await readLatestPrices(db).then(() => null, e => e)
  release()
  await Promise.allSettled([storage, a, b])
  assert.equal(third?.message, 'performance_report_worker_capacity')
  for (const job of [a, b]) {
    const outcome = await job.then(() => 'ok', e => e.message)
    assert.notEqual(outcome, 'performance_report_worker_capacity', 'storage must not consume a shared slot')
  }
})

test('the storage report from the worker matches the synchronous walk it replaces', async t => {
  const db = fileFixture(t)
  db.prepare("INSERT INTO agent_state(key,value) VALUES('storage_fixture', ?)").run('x'.repeat(4096))
  const first = readStorageReport(db)
  assert.equal(readStorageReport(db), first, 'a second read coalesces onto the running walk')
  const direct = storageReport(db), isolated = await first
  assert.deepEqual(isolated.tables.map(r => [r.name, r.rows]).sort(), direct.tables.map(r => [r.name, r.rows]).sort())
  assert.deepEqual(isolated.tables.map(r => [r.name, r.bytes]).sort(), direct.tables.map(r => [r.name, r.bytes]).sort())
  assert.equal(isolated.largestStateKeys[0].key, 'storage_fixture')
  assert.deepEqual(isolated.files.db, direct.files.db)
  assert.equal(isolated.dbstatAvailable, direct.dbstatAvailable)
  assert.equal(isolated.status, 'complete')
  assert.deepEqual(isolated.served && [isolated.served.source, isolated.served.walkRunning], ['walk', false])
})

test('storage walk past its answer deadline: a truthful partial inside the deadline, the late result kept, then served from cache', async t => {
  // A 10 s busy wait: the walk waits on the lock (it does not fail) until the
  // test releases it, after the 2 s answer deadline.
  const restore = overrideReportTimingForTest({ storage: { answerMs: 2000, busyTimeoutMs: 10_000 } }); t.after(restore)
  const db = fileFixture(t)
  db.prepare('INSERT INTO scans(symbol,bias,confidence,timeframe,price,scanned_at) VALUES (?,?,?,?,?,?)').run('EURUSD', 'long', 7, '1h', 1.1, new Date().toISOString())
  const release = lockExclusive(t, db)
  const started = Date.now()
  const partial = await readStorageReport(db)
  const answeredIn = Date.now() - started
  assert.ok(answeredIn >= 1900 && answeredIn < 6000, `answered at the deadline while the walk was held (${answeredIn} ms)`)
  assert.equal(partial.status, 'partial')
  assert.equal(partial.partialReason, 'answer_deadline')
  assert.deepEqual([partial.served.source, partial.served.walkRunning], ['walk', true])
  assert.ok(partial.files.db.bytes > 0, 'what was measured is there')
  // Nothing unmeasured is dressed as a number or as "none".
  assert.equal(partial.pageSize, null)
  assert.deepEqual(partial.unmeasured.pragmas, ['page_size', 'page_count', 'freelist_count'])
  assert.equal(partial.unmeasured.tableList, true, 'an empty table list is named as not read, not as "no tables"')
  assert.deepEqual(partial.tables, [])
  assert.equal(partial.dbstatAvailable, null, 'not claimed unavailable before it was tried')
  release()
  // The walk is not killed at the answer deadline: its late result is kept
  // and served, not walked again.
  let cached
  const deadline = Date.now() + 8000
  do {
    await sleep(50)
    cached = await readStorageReport(db)
  } while (cached.served.source !== 'cache' && Date.now() < deadline)
  assert.equal(cached.served.source, 'cache', 'the late result is served')
  assert.equal(cached.status, 'complete')
  assert.equal(cached.walk.startedAt, partial.walk.startedAt, 'the same walk that answered partially')
  assert.equal(cached.tables.find(r => r.name === 'scans').rows, 1)
  assert.deepEqual(cached.unmeasured, { pragmas: [], tableList: false, largestStateKeys: false, bytes: [], rows: [] })
  assert.deepEqual(cached.errors, [])
  assert.ok(cached.served.ageMs >= 0)
})

test('storage cooldown: a second read serves the measurement without a new walk; fresh walks again', async t => {
  const db = fileFixture(t)
  const first = await readStorageReport(db)
  assert.equal(first.served.source, 'walk')
  const again = await readStorageReport(db)
  assert.equal(again.served.source, 'cache')
  assert.equal(again.walk.startedAt, first.walk.startedAt, 'no second walk inside the cooldown')
  assert.equal(again.at, first.at)
  await sleep(5)
  const fresh = await readStorageReport(db, { fresh: true })
  assert.equal(fresh.served.source, 'walk')
  assert.ok(Date.parse(fresh.walk.startedAt) > Date.parse(first.walk.startedAt), 'fresh is a new walk')
})

test('a storage walk that fails serves the last measurement, labelled with the failure — never a 503 over a measurement it has', async t => {
  const db = fileFixture(t)
  const handle = switchableName(db)
  const good = await readStorageReport(handle.db)
  assert.equal(good.status, 'complete')
  handle.useMissing = true
  const served = await readStorageReport(handle.db, { fresh: true })
  assert.equal(served.served.source, 'cache')
  assert.equal(served.at, good.at, 'the earlier measurement, not a new number')
  assert.equal(served.served.lastWalkFailed.reason, 'performance_report_worker_error')
  assert.equal(served.served.lastWalkFailed.detail, 'unable to open database file')
  // With nothing measured before, the same failure is an explicit unavailable.
  const other = switchableName(fileFixture(t)); other.useMissing = true
  const error = await readStorageReport(other.db).then(() => null, e => e)
  assert.equal(isReportUnavailable(error), true)
  assert.equal(error.detail, 'unable to open database file')
})

test('a storage walk stopped at its hard bound keeps what it measured as a partial, named so', async t => {
  // Held on the lock (each statement waits 1 s and fails) past a 2.5 s hard
  // bound; the answer deadline comes first.
  const restore = overrideReportTimingForTest({ storage: { answerMs: 2000, hardMs: 2500 } }); t.after(restore)
  const db = fileFixture(t)
  const release = lockExclusive(t, db)
  const answer = await readStorageReport(db)
  assert.equal(answer.partialReason, 'answer_deadline')
  await sleep(700) // past the hard bound
  // Asked to stop, it stops before its next statement: its current busy
  // wait returns (≤ 1 s) and it exits on its own.
  assert.equal(await stopStorageWalk(db), true)
  release()
  const kept = await readStorageReport(db)
  assert.equal(kept.served.source, 'cache')
  assert.equal(kept.status, 'partial')
  assert.equal(kept.partialReason, 'hard_bound', 'the hard bound, not the later stop call, is why it ended')
  assert.equal(kept.walk.startedAt, answer.walk.startedAt)
  assert.equal(kept.unmeasured.tableList, true, 'what it never reached is named')
  assert.ok(kept.errors.some(e => e.step === 'pragma' && /locked/.test(e.message)), 'the lock it met is named')
})

test('stopStorageWalk: a running walk stops before its next statement and its answer is the partial, named "stopped"', async t => {
  const restore = overrideReportTimingForTest({ storage: { busyTimeoutMs: 10_000 } }); t.after(restore)
  const db = fileFixture(t)
  const release = lockExclusive(t, db)
  const pending = readStorageReport(db)
  await sleep(1500) // the worker is up and waiting on the lock
  const stopped = stopStorageWalk(db)
  release() // its current statement completes; the next one is not run
  assert.equal(await stopped, true)
  const answer = await pending
  assert.equal(answer.status, 'partial')
  assert.equal(answer.partialReason, 'stopped')
  assert.ok(answer.unmeasured.rows.length > 0 || answer.unmeasured.tableList, 'it did not finish the walk')
})
