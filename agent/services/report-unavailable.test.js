// node --test agent/services/report-unavailable.test.js
//
// P1/P4 M2 at the worker boundary: every isolated-report rejection is typed
// as unavailable (with a reason and a retry hint, the message unchanged for
// heartbeats), and the storage walk has its own reserved slot so a 21-second
// dbstat never takes one of the two slots the loop's decision audit needs.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { storageReport } from './storage-report.js'
import {
  ReportUnavailableError, isReportUnavailable, readPerformancePopulations, readPerformanceAnalytics,
  readLatestPrices, readStorageReport,
} from './performance-populations.js'

function fileFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'report-unavailable-svc-'))
  const db = initDB(join(dir, 'agent.db'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  return db
}
function lockExclusive(t, db) {
  db.pragma('journal_mode=DELETE')
  const lock = new Database(db.name); lock.exec('BEGIN EXCLUSIVE')
  const release = () => { if (lock.inTransaction) lock.exec('ROLLBACK') }
  t.after(() => { release(); lock.close() })
  return release
}

test('failure codes keep their name, message and a retry hint; a raw driver message is one generic reason', () => {
  const cases = [
    ['performance_report_deadline', 'performance_report_deadline', 30],
    ['performance_report_worker_capacity', 'performance_report_worker_capacity', 5],
    ['watchdog_report_worker_capacity', 'watchdog_report_worker_capacity', 5],
    ['performance_report_worker_exit', 'performance_report_worker_exit', 15],
    ['performance_report_group_bound', 'performance_report_group_bound', 30],
    ['unable to open database file', 'performance_report_worker_error', 30],
    ['SQLITE_BUSY: database is locked', 'performance_report_worker_error', 30],
  ]
  for (const [message, reason, retryAfterSec] of cases) {
    const error = new ReportUnavailableError(new Error(message))
    assert.equal(error.message, message, 'heartbeats record err.message unchanged')
    assert.equal(error.reason, reason, message)
    assert.equal(error.retryAfterSec, retryAfterSec, message)
    assert.equal(isReportUnavailable(error), true)
  }
  assert.equal(isReportUnavailable(new Error('performance_report_deadline')), false, 'an untyped error is not a report failure')
})

test('a worker that cannot open its database rejects as unavailable, message intact', async t => {
  const db = fileFixture(t)
  const missing = new Proxy(db, { get(target, key) {
    if (key === 'name') return join(tmpdir(), 'report-unavailable-does-not-exist.db')
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const error = await readLatestPrices(missing).then(() => null, e => e)
  assert.ok(error, 'the read must fail')
  assert.equal(isReportUnavailable(error), true)
  assert.equal(error.reason, 'performance_report_worker_error')
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
  assert.equal(isolated.largestStateKeys[0].key, 'storage_fixture')
  assert.deepEqual(isolated.files.db, direct.files.db)
  assert.equal(isolated.dbstatAvailable, direct.dbstatAvailable)
})
