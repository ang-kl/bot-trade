// node --test agent/routes/report-unavailable.test.js
//
// P1/P4 M2 — "report failures stay honest". A report worker that could not
// produce its report is an explicit 503 with a reason and a retry hint:
//   - /decisions-daily answered its 30,002 ms deadline (23:39:29Z) as a 500;
//   - /perf-ledger, /account-analytics, /cup-handle-funnel and /stage-matrix
//     answered worker failures as 500s;
//   - /prices answered 200 {prices:{}, error}: an empty map that looked like
//     success and that no status-class counter could see;
//   - /storage ran its dbstat walk on the event loop (20.99 s at 08:39Z).
//
// The failing worker is injected at the real boundary: the connection's
// `name` points at a file that does not exist, so the read-only report worker
// fails to open it while the management connection stays usable.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { storageReport } from '../services/storage-report.js'
import { buildLatestPrices, readPerformancePopulations, readPerformanceAnalytics } from '../services/performance-populations.js'
import stateRouter from './state.js'

async function fixture(t, { missingWorkerFile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'report-unavailable-'))
  const db = initDB(join(dir, 'agent.db'))
  db.prepare('INSERT INTO accounts(account_id,is_live,mode) VALUES (?,?,?)').run('11', 0, 'active')
  const at = new Date().toISOString()
  const scan = db.prepare('INSERT INTO scans(symbol,bias,confidence,timeframe,price,scanned_at) VALUES(?,?,?,?,?,?)')
  scan.run('EURUSD', 'long', 7, '1h', 1.1, at)
  scan.run('USDJPY', 'short', 6, '1h', 150.25, at)
  const connection = missingWorkerFile ? new Proxy(db, { get(target, key) {
    if (key === 'name') return join(dir, 'missing.db')
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) : db
  const app = express(); app.use('/state', stateRouter(connection))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    db.close(); rmSync(dir, { recursive: true, force: true })
  })
  return { db, connection, url: path => `http://127.0.0.1:${server.address().port}/state${path}` }
}

const ROUTES = [
  { path: '/decisions-daily?days=7', code: 'decisions_daily_unavailable', message: 'Daily decision counts are temporarily unavailable. Please retry.' },
  { path: '/perf-ledger?account=11', code: 'perf_ledger_unavailable', message: 'The performance ledger is temporarily unavailable. Please retry.' },
  { path: '/account-analytics?account=11', code: 'account_analytics_unavailable', message: 'Account analytics are temporarily unavailable. Please retry.' },
  { path: '/cup-handle-funnel?days=7', code: 'cup_handle_funnel_unavailable', message: 'The Cup & Handle funnel is temporarily unavailable. Please retry.' },
  { path: '/stage-matrix', code: 'stage_matrix_unavailable', message: 'Stage usage counts are temporarily unavailable. Please retry.' },
  { path: '/prices', code: 'latest_prices_unavailable', message: 'Latest prices are temporarily unavailable. Please retry.' },
  { path: '/storage', code: 'storage_report_unavailable', message: 'The storage report is temporarily unavailable. Please retry.' },
]

for (const route of ROUTES) {
  test(`GET ${route.path}: a failed report worker is an explicit 503 with a reason and retryAfter, never a 500 or an empty 200`, async t => {
    const { url } = await fixture(t, { missingWorkerFile: true })
    const res = await fetch(url(route.path))
    assert.equal(res.status, 503, `${route.path} status`)
    assert.equal(res.headers.get('retry-after'), '30')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const body = await res.json()
    assert.deepEqual(body, { status: 'unavailable', error: route.message, code: route.code, reason: 'performance_report_worker_error', retryAfter: 30 })
    assert.equal('prices' in body, false, 'an unavailable read carries no empty result')
  })
}

test('GET /prices with both shared report slots busy is a 503 naming capacity, with its shorter retry hint', async t => {
  const { db, url } = await fixture(t)
  // Hold both shared slots: an exclusive lock keeps the two workers waiting
  // on SQLite's busy timeout while /prices asks for a third.
  db.pragma('journal_mode=DELETE')
  const lock = new Database(db.name); lock.exec('BEGIN EXCLUSIVE')
  t.after(() => { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() })
  const held = [readPerformancePopulations(db), readPerformanceAnalytics(db, { accountId: '11' })]
  const res = await fetch(url('/prices'))
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('retry-after'), '5')
  assert.deepEqual(await res.json(), { status: 'unavailable', error: 'Latest prices are temporarily unavailable. Please retry.',
    code: 'latest_prices_unavailable', reason: 'performance_report_worker_capacity', retryAfter: 5 })
  lock.exec('ROLLBACK')
  await Promise.allSettled(held)
})

test('GET /prices answers the worker\'s price map on success', async t => {
  const { db, url } = await fixture(t)
  const res = await fetch(url('/prices'))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { prices: buildLatestPrices(db) })
})

test('GET /storage runs the dbstat walk and row counts on the report worker, not the management connection', async t => {
  const { db, url } = await fixture(t)
  const expected = storageReport(db)
  const prepare = db.prepare, pragma = db.pragma
  let managementReads = 0
  db.prepare = () => { managementReads++; throw new Error('storage report read on the management connection') }
  db.pragma = () => { managementReads++; throw new Error('storage report pragma on the management connection') }
  let res
  try { res = await fetch(url('/storage')) } finally { db.prepare = prepare; db.pragma = pragma }
  assert.equal(res.status, 200)
  assert.equal(managementReads, 0)
  const body = await res.json()
  assert.equal(body.files.db.path, db.name)
  assert.equal(body.dbstatAvailable, expected.dbstatAvailable)
  assert.deepEqual(body.tables.map(r => [r.name, r.rows]).sort(), expected.tables.map(r => [r.name, r.rows]).sort())
  assert.equal(body.tables.find(r => r.name === 'scans').rows, 2)
  assert.equal(body.pageSize, expected.pageSize)
})

test('a route\'s own failure after a good report stays a 500: only report-worker failures are 503', async t => {
  const { db, url } = await fixture(t)
  const prepare = db.prepare
  // The worker reads its own connection and succeeds; the stage view that
  // follows on the management connection fails. That is a bug, not an
  // unavailable report, and must not be dressed up as a retryable 503.
  db.prepare = () => { throw new Error('management read failed') }
  let res
  try { res = await fetch(url('/stage-matrix')) } finally { db.prepare = prepare }
  assert.equal(res.status, 500)
  assert.equal(res.headers.get('retry-after'), null)
  assert.deepEqual(await res.json(), { error: 'management read failed' })
})

test('a request coalesced behind a failing report gets the same 503 and the same Retry-After', async t => {
  const { db, url } = await fixture(t)
  db.pragma('journal_mode=DELETE')
  const lock = new Database(db.name); lock.exec('BEGIN EXCLUSIVE')
  t.after(() => { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() })
  const [leader, waiter] = await Promise.all([fetch(url('/prices')), fetch(url('/prices'))])
  lock.exec('ROLLBACK')
  const statuses = [leader, waiter].map(r => [r.status, r.headers.get('retry-after'), r.headers.get('x-cache')])
  assert.deepEqual(statuses.map(([s, ra]) => [s, ra]), [[503, '30'], [503, '30']])
  assert.deepEqual(statuses.map(r => r[2]).sort(), ['coalesced', 'miss'])
  for (const r of [leader, waiter]) assert.equal((await r.json()).code, 'latest_prices_unavailable')
})
