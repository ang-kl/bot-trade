// agent/routes/blocker-report-isolation.test.js — V3 C4 (SEQUENCE PR-4,
// WP-C PR-C1): GET /state/blocker-report runs in the isolated report worker,
// never on the event loop the protection sweeps share. Patterns from
// watchdog-isolation.test.js and watchdog-report-isolation.test.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB } from '../db.js'
import stateRouter from './state.js'

async function fixture(t) {
  const db = initDB(join(tempDir('blocker-report-http-'), 'fixture.db'))
  db.prepare('INSERT INTO accounts(account_id,is_live,enabled) VALUES (?,?,1)').run('11', 0)
  db.prepare("INSERT INTO decision_log(account_id,stage,decision,reason,created_at) VALUES ('11','stage_matrix','skip','strategy off',?)").run(new Date(Date.now() - 60_000).toISOString())
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    db.close()
  })
  const to = Date.now(), from = to - 3600_000
  const get = (query = `account=11&from=${from}&to=${to}`) => fetch(`http://127.0.0.1:${server.address().port}/state/blocker-report?${query}`)
  return { db, get, from, to }
}

test('the disk-backed blocker report executes no SQL on the management connection', async t => {
  const { db, get, from } = await fixture(t)
  // V3 WEB-1: a roster-wide stop (no account) rides the worker's answer
  // beside the account's own counts, not in them.
  db.prepare("INSERT INTO decision_log(account_id,stage,decision,reason,created_at) VALUES (NULL,'armed_scope_prefilter','skip','no armed timeframe',?)").run(new Date(Date.now() - 60_000).toISOString())
  const prepare = db.prepare
  let managementReads = 0
  db.prepare = () => { managementReads++; throw new Error('the blocker report ran on the management connection') }
  let response
  try { response = await get() } finally { db.prepare = prepare }
  assert.equal(response.status, 200)
  assert.equal(managementReads, 0, 'RED if the route runs blockerReport on the main connection')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.status, 'complete'); assert.equal(body.accountId, '11'); assert.equal(body.from, from)
  assert.equal(body.summary.upstream_stop.records, 1)
  assert.equal(body.byStage[0].stage, 'stage_matrix')
  assert.equal(body.rosterWide.records, 1); assert.equal(body.rosterWide.includedInTotals, false)
  assert.equal(body.rosterWide.byStage[0].stage, 'armed_scope_prefilter')
  assert.equal(body.unattributedRecordsInWindow, 0)
  assert.equal(body.tick.accounts[0].status, 'not_evaluated', 'the tick evaluation rides the same worker read')
})

test('request refusals stay 400 — the malformed ones on the main thread, the unregistered account from the worker', async t => {
  const { get, from, to } = await fixture(t)
  assert.equal((await get(`from=${from}&to=${to}`)).status, 400)
  assert.equal((await get(`account=11&from=${to}&to=${to}`)).status, 400)
  const unregistered = await get(`account=22&from=${from}&to=${to}`)
  assert.equal(unregistered.status, 400)
  assert.equal((await unregistered.json()).error, 'account not registered')
})

test('a locked database leaves the event loop responsive; a full report pool answers 503 with a retry hint, never an empty report', async t => {
  const { db, get, from, to } = await fixture(t)
  db.pragma('journal_mode = DELETE')
  const lock = new Database(db.name)
  t.after(() => { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() })
  lock.exec('BEGIN EXCLUSIVE')
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  t.after(() => clearInterval(timer))
  // two distinct requests take the two shared report slots and wait on the lock
  const waiting = [get(`account=11&from=${from}&to=${to}&offset=0`), get(`account=11&from=${from}&to=${to}&offset=1`)]
  await new Promise(resolve => setTimeout(resolve, 100))
  const full = await get(`account=11&from=${from}&to=${to}&offset=2`)
  assert.equal(full.status, 503)
  assert.ok(Number(full.headers.get('retry-after')) > 0)
  const body = await full.json()
  assert.equal(body.code, 'blocker_report_unavailable'); assert.equal(body.reason, 'performance_report_worker_capacity')
  assert.ok(ticks > 0, 'management timers progress while SQLite waits in the worker')
  // V3 M2b (M2 check nit 5): a worker read that gave up on the lock is the
  // same typed 503 as every other report failure — its words kept — not a
  // 500, and still not an empty report.
  for (const response of await Promise.all(waiting)) {
    assert.equal(response.status, 503, 'a failed worker read is unavailable, not an empty report')
    const failed = await response.json()
    assert.equal(failed.code, 'blocker_report_unavailable')
    assert.equal(failed.reason, 'performance_report_worker_error')
    assert.equal(failed.detail, 'database is locked')
    assert.equal('summary' in failed, false)
  }
  lock.exec('ROLLBACK')
})
