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
// V3 M2b: the older report routes (/watchdog, /postmortems,
// /account-engineering, /performance-populations, /blocker-report) answer in
// the same form; a worker error keeps its driver words (`detail`, logged at
// most once a minute); a fixed bound is not offered as retryable; a real
// worker deadline is exercised end to end; /storage answers a truthful
// partial inside its deadline.
//
// The failing worker is injected at the real boundary: the connection's
// `name` points at a file that does not exist, so the read-only report worker
// fails to open it while the management connection stays usable.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB } from '../db.js'
import { storageReport } from '../services/storage-report.js'
import { buildLatestPrices, readPerformancePopulations, readPerformanceAnalytics, ReportUnavailableError, overrideReportTimingForTest } from '../services/performance-populations.js'
import stateRouter, { sendReportUnavailable } from './state.js'

async function fixture(t, { workerFile = null } = {}) {
  const dir = tempDir('report-unavailable-')
  const db = initDB(join(dir, 'agent.db'))
  t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live,mode) VALUES (?,?,?)').run('11', 0, 'active')
  const at = new Date().toISOString()
  const scan = db.prepare('INSERT INTO scans(symbol,bias,confidence,timeframe,price,scanned_at) VALUES(?,?,?,?,?,?)')
  scan.run('EURUSD', 'long', 7, '1h', 1.1, at)
  scan.run('USDJPY', 'short', 6, '1h', 150.25, at)
  const connection = workerFile ? new Proxy(db, { get(target, key) {
    if (key === 'name') return join(dir, workerFile)
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) : db
  const app = express(); app.use('/state', stateRouter(connection))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { db, dir, connection, url: path => `http://127.0.0.1:${server.address().port}/state${path}` }
}
function lockExclusive(t, db) {
  db.pragma('journal_mode=DELETE')
  const lock = new Database(db.name); lock.exec('BEGIN EXCLUSIVE')
  const release = () => { if (lock.inTransaction) lock.exec('ROLLBACK') }
  t.after(() => { release(); lock.close() })
  return release
}

const to = Date.now(), from = to - 3600_000
const ROUTES = [
  { path: '/decisions-daily?days=7', code: 'decisions_daily_unavailable', message: 'Daily decision counts are temporarily unavailable. Please retry.' },
  { path: '/perf-ledger?account=11', code: 'perf_ledger_unavailable', message: 'The performance ledger is temporarily unavailable. Please retry.' },
  { path: '/account-analytics?account=11', code: 'account_analytics_unavailable', message: 'Account analytics are temporarily unavailable. Please retry.' },
  { path: '/cup-handle-funnel?days=7', code: 'cup_handle_funnel_unavailable', message: 'The Cup & Handle funnel is temporarily unavailable. Please retry.' },
  { path: '/stage-matrix', code: 'stage_matrix_unavailable', message: 'Stage usage counts are temporarily unavailable. Please retry.' },
  { path: '/prices', code: 'latest_prices_unavailable', message: 'Latest prices are temporarily unavailable. Please retry.' },
  { path: '/storage', code: 'storage_report_unavailable', message: 'The storage report is temporarily unavailable. Please retry.' },
  // V3 M2b (M2 check nit 5): the five older report routes, same form.
  { path: '/watchdog', code: 'watchdog_contract_unavailable', message: 'watchdog_contract_unavailable', extra: { workComplete: false } },
  { path: '/postmortems?account=11', code: 'postmortem_report_unavailable', message: 'Trade lessons are temporarily unavailable. Please retry.' },
  { path: '/account-engineering', code: 'account_engineering_unavailable', message: 'Account status is temporarily unavailable. Please retry.' },
  { path: '/performance-populations', code: 'performance_populations_unavailable', message: 'Performance populations are temporarily unavailable. Please retry.' },
  { path: `/blocker-report?account=11&from=${from}&to=${to}`, code: 'blocker_report_unavailable', message: 'The blocker report is temporarily unavailable. Please retry.' },
]

for (const route of ROUTES) {
  test(`GET ${route.path}: a failed report worker is an explicit 503 with a reason, retryAfter and the worker's own words, never a 500 or an empty 200`, async t => {
    const warn = t.mock.method(console, 'warn', () => {})
    const { url } = await fixture(t, { workerFile: 'missing.db' })
    const res = await fetch(url(route.path))
    assert.equal(res.status, 503, `${route.path} status`)
    assert.equal(res.headers.get('retry-after'), '30')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const body = await res.json()
    assert.deepEqual(body, { ...route.extra, status: 'unavailable', error: route.message, code: route.code,
      reason: 'performance_report_worker_error', retryAfter: 30, retryable: true, detail: 'unable to open database file' })
    assert.equal('prices' in body, false, 'an unavailable read carries no empty result')
    // The words are also in the log, once, naming the route's code.
    assert.equal(warn.mock.callCount(), 1)
    assert.match(String(warn.mock.calls[0].arguments[0]), new RegExp(`${route.code}: report worker error — unable to open database file`))
  })
}

test('a worker error is logged at most once a minute per route and message, not once per request', async t => {
  const warn = t.mock.method(console, 'warn', () => {})
  // A missing DIRECTORY: a different driver message from the table above.
  const { url } = await fixture(t, { workerFile: join('no-such-dir', 'agent.db') })
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url('/prices'))
    assert.equal(res.status, 503)
    assert.equal((await res.json()).detail, 'Cannot open database because the directory does not exist')
  }
  assert.equal(warn.mock.callCount(), 1, 'three identical failures, one log line')
  await fetch(url('/perf-ledger?account=11'))
  assert.equal(warn.mock.callCount(), 2, 'another route is its own line')
})

test('a real worker deadline, end to end: /decisions-daily past its (shortened) deadline is a 503 naming the deadline', async t => {
  const restore = overrideReportTimingForTest({ deadlineMs: { 'decisions-daily': 200 } }); t.after(restore)
  // The report worker reads its own file (worker.db), held under an exclusive
  // lock; the route's own account lookup reads the unlocked agent.db. The
  // worker waits on SQLite's busy timeout (1 s) and the 200 ms deadline fires
  // first, from the real timer in isolatedReport.
  const { dir, url } = await fixture(t, { workerFile: 'worker.db' })
  const workerDb = initDB(join(dir, 'worker.db'))
  t.after(() => workerDb.close())
  const release = lockExclusive(t, workerDb)
  const started = Date.now()
  const res = await fetch(url('/decisions-daily?days=7'))
  const took = Date.now() - started
  // Released inside the worker's busy wait, so its statement completes and
  // the terminated worker exits cleanly (see the M2b note on terminate()).
  release()
  assert.equal(res.status, 503)
  assert.ok(took < 900, `answered at the deadline, not after the busy wait (${took} ms)`)
  assert.equal(res.headers.get('retry-after'), '30')
  assert.deepEqual(await res.json(), { status: 'unavailable', error: 'Daily decision counts are temporarily unavailable. Please retry.',
    code: 'decisions_daily_unavailable', reason: 'performance_report_deadline', retryAfter: 30, retryable: true })
})

test('a fixed bound is unavailable but not retryable: no Retry-After, retryAfter null, and the sentence does not say retry', () => {
  const res = { headers: {}, statusCode: 200, body: null,
    set(key, value) { this.headers[key.toLowerCase()] = value; return this },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this } }
  const sent = sendReportUnavailable(res, new ReportUnavailableError(new Error('performance_report_group_bound')),
    { message: 'The performance ledger is temporarily unavailable. Please retry.', code: 'perf_ledger_unavailable' })
  assert.equal(sent, true)
  assert.equal(res.statusCode, 503)
  assert.equal('retry-after' in res.headers, false)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(res.body, { status: 'unavailable', code: 'perf_ledger_unavailable', reason: 'performance_report_group_bound',
    error: 'The performance ledger is unavailable: the report exceeds a fixed size bound, so a retry will not help.',
    retryAfter: null, retryable: false })
  assert.equal(sendReportUnavailable(res, new Error('not a report failure'), { message: 'x', code: 'y' }), false)
})

test('GET /prices with both shared report slots busy is a 503 naming capacity, with its shorter retry hint', async t => {
  const { db, url } = await fixture(t)
  // Hold both shared slots: an exclusive lock keeps the two workers waiting
  // on SQLite's busy timeout while /prices asks for a third.
  const release = lockExclusive(t, db)
  const held = [readPerformancePopulations(db), readPerformanceAnalytics(db, { accountId: '11' })]
  const res = await fetch(url('/prices'))
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('retry-after'), '5')
  assert.deepEqual(await res.json(), { status: 'unavailable', error: 'Latest prices are temporarily unavailable. Please retry.',
    code: 'latest_prices_unavailable', reason: 'performance_report_worker_capacity', retryAfter: 5, retryable: true })
  release()
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
  assert.equal(body.status, 'complete')
  assert.equal(body.served.source, 'walk')
})

test('GET /storage whose walk outlasts its answer deadline answers a labelled partial (200), and the finished walk is served next', async t => {
  const restore = overrideReportTimingForTest({ storage: { answerMs: 2000, busyTimeoutMs: 10_000 } }); t.after(restore)
  const { db, url } = await fixture(t)
  const release = lockExclusive(t, db)
  const res = await fetch(url('/storage'))
  release()
  assert.equal(res.status, 200, 'an answer inside the deadline, not a 503')
  const partial = await res.json()
  assert.equal(partial.status, 'partial')
  assert.equal(partial.partialReason, 'answer_deadline')
  assert.equal(partial.served.walkRunning, true)
  assert.equal(partial.unmeasured.tableList, true)
  assert.equal(partial.pageSize, null, 'unmeasured is null, never a guessed number')
  let next
  const deadline = Date.now() + 8000
  for (let i = 0; Date.now() < deadline; i++) {
    // A new URL each time: the route cache must not replay the partial.
    next = await (await fetch(url(`/storage?poll=${i}`))).json()
    if (next.served.source === 'cache') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(next.served.source, 'cache')
  assert.equal(next.status, 'complete')
  assert.equal(next.walk.startedAt, partial.walk.startedAt)
  assert.equal(next.tables.find(r => r.name === 'scans').rows, 2)
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
  const release = lockExclusive(t, db)
  const [leader, waiter] = await Promise.all([fetch(url('/prices')), fetch(url('/prices'))])
  release()
  const statuses = [leader, waiter].map(r => [r.status, r.headers.get('retry-after'), r.headers.get('x-cache')])
  assert.deepEqual(statuses.map(([s, ra]) => [s, ra]), [[503, '30'], [503, '30']])
  assert.deepEqual(statuses.map(r => r[2]).sort(), ['coalesced', 'miss'])
  for (const r of [leader, waiter]) assert.equal((await r.json()).code, 'latest_prices_unavailable')
})
