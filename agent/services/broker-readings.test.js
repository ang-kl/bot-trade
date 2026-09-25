// V3 WEB-4 — the server reads every account once a minute itself, so account
// readings and their history accrue with no page open. These tests drive the
// REAL route builder (routes/actions.js registers it) through its existing
// broker seams, so a dropped registration or a dropped loop call site is red
// (CLAUDE.md failure mode #4), and no test passes on its own comments (#2).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from '../routes/actions.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'
import { accountOverview } from './account-overview.js'
import { CONTROLLERS } from './heartbeat.js'
import {
  makeBrokerReadings, startBrokerReadings, brokerReadingsStatus, firstReadReady, readingFailureReason,
  registerBrokerReadingsReader, READINGS_RECORD_KEY, READINGS_INTERVAL_MS, FIRST_READ_MAX_DELAY_MS, CONTROLLER_NAME,
} from './broker-readings.js'

const host = 'demo.ctraderapi.com'
const open = () => ({ ready: true })
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve() }

function fixture(t, ids = ['11', '22']) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const id of ids) {
    db.prepare('INSERT INTO accounts(account_id,is_live,enabled) VALUES(?,0,1)').run(id)
    recordDepositCurrency(db, { accountId: id, host, depositAssetId: '1', currency: 'USD' })
    recordAccountMoney(db, { accountId: id, host, trader: { depositAssetId: '1' }, balance: 1000 })
  }
  setState(db, 'ctrader_account_id', ids[0])
  setState(db, 'ctrader_access_token', 'test-access')
  return db
}
// What the route's snapshot builder returns per account, in the shape the
// cache writer, captureSnapshotHistory and accountOverview read.
function brokerAccount(a, { error = null } = {}) {
  const now = new Date().toISOString()
  return { ...a, host, currency: 'USD', balanceReceivedAt: now, pnlReceivedAt: now, error,
    health: { balance: 1000, usedMargin: 10 },
    positions: [{ positionId: `${a.accountId}01`, symbol: 'EURUSD', netPnl: 5, pnlSource: 'broker', sl: 1.0, tp: 1.2, rawVolume: 1000, side: 'BUY' }] }
}
function beats() {
  const seen = []
  return { seen, heartbeat: { beat: (_db, name, o) => seen.push({ name, ...o }) } }
}

test('with no page open, one server round refreshes every account\'s reading and writes its history', async t => {
  const db = fixture(t)
  const calls = []
  actionsRouter(db, {
    listCtraderAccounts: async () => [{ accountId: '11' }, { accountId: '22' }],
    snapshotBrokerAccount: async a => { calls.push(String(a.accountId)); return brokerAccount(a) },
  })
  const before = accountOverview(db).accounts
  assert.deepEqual(before.map(a => [a.accountId, a.equity, a.reason]), [['11', null, 'snapshot_missing'], ['22', null, 'snapshot_missing']])
  const { seen, heartbeat } = beats()
  const r = await makeBrokerReadings(db, { ready: open, heartbeat }).poll()
  assert.equal(r.status, 'success')
  assert.deepEqual(calls.sort(), ['11', '22'], 'the route builder read each account')
  const after = accountOverview(db)
  assert.deepEqual(after.accounts.map(a => [a.accountId, a.status, a.equity, a.openPnl, a.freeMargin]),
    [['11', 'fresh', 1005, 5, 995], ['22', 'fresh', 1005, 5, 995]])
  const history = db.prepare("SELECT account_id FROM account_history WHERE source = 'broker_snapshot' ORDER BY account_id").all()
  assert.deepEqual(history.map(h => h.account_id), ['11', '22'], 'history accrues without any page')
  assert.deepEqual(seen.map(b => [b.name, b.ok]), [[CONTROLLER_NAME, true]])
  const status = after.serverReadings
  assert.equal(status.status, 'success'); assert.equal(status.fresh, true)
  assert.equal(status.at, JSON.parse(getState(db, 'acct:11:broker_snapshot_cache_json')).fetchedAt, 'at is the round\'s own fetch time')
})

test('a page read and the server read in flight together are ONE broker round', async t => {
  const db = fixture(t)
  let release; const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const token = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  setState(db, 'device_sessions', JSON.stringify({ [token]: Date.now() + 60_000 }))
  const app = express(); app.use(express.json())
  app.use('/actions', actionsRouter(db, {
    listCtraderAccounts: async () => [{ accountId: '11' }, { accountId: '22' }],
    snapshotBrokerAccount: async a => { calls.push(String(a.accountId)); await gate; return brokerAccount(a) },
  }))
  const server = app.listen(0); t.after(() => server.close())
  const readings = makeBrokerReadings(db, { ready: open, heartbeat: beats().heartbeat })
  const serverRound = readings.poll()
  await tick()
  const page = fetch(`http://127.0.0.1:${server.address().port}/actions/broker-positions`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ accountId: 'all' }) })
  await new Promise(resolve => setTimeout(resolve, 50))
  release()
  const [r, pageReply] = await Promise.all([serverRound, page.then(x => x.json())])
  assert.equal(r.status, 'success')
  assert.equal(pageReply.accounts.length, 2)
  assert.deepEqual(calls.sort(), ['11', '22'], 'each account read once, not once per caller')
})

test('bounded: a round that never settles is recorded as a timeout and no second round stacks behind it', async t => {
  const db = fixture(t)
  let reads = 0, release
  const read = () => { reads++; return new Promise(resolve => { release = resolve }) }
  const { seen, heartbeat } = beats()
  const readings = makeBrokerReadings(db, { read, ready: open, heartbeat, timeoutMs: 20, log: () => {} })
  const first = await readings.poll()
  assert.equal(first.status, 'failed'); assert.equal(first.reason, 'readings_timeout')
  assert.deepEqual(await readings.poll(), { skipped: 'in_flight' })
  assert.equal(reads, 1, 'the hung round still holds the lock')
  release({ ok: true, accounts: [], fetchedAt: new Date().toISOString() })
  await tick()
  await readings.poll()
  assert.equal(reads, 2, 'once it settles the next tick reads again')
  assert.deepEqual(seen.map(b => b.ok), [false, false])
  assert.equal(JSON.parse(getState(db, READINGS_RECORD_KEY)).consecutiveFailures, 2)
})

test('a failed round never renews `at`, names a fixed reason and copies no transport text', async t => {
  const db = fixture(t)
  const T1 = '2026-09-25T16:00:00.000Z'
  let fail = null
  const read = async () => {
    if (fail) throw new Error(fail)
    return { ok: true, fetchedAt: T1, accounts: [brokerAccount({ accountId: '11' }), brokerAccount({ accountId: '22' })] }
  }
  const readings = makeBrokerReadings(db, { read, ready: open, heartbeat: beats().heartbeat, log: () => {} })
  assert.equal((await readings.poll()).status, 'success')
  fail = 'cTrader WS timeout after 25000ms token=planted-secret-value'
  const r = await readings.poll()
  assert.equal(r.status, 'failed'); assert.equal(r.reason, 'broker_timeout')
  const raw = getState(db, READINGS_RECORD_KEY)
  assert.equal(JSON.parse(raw).at, T1, 'the last good round, not the failed attempt')
  assert.doesNotMatch(raw, /planted-secret-value/)
  const status = brokerReadingsStatus(db, { nowMs: Date.parse(T1) + 6 * 60_000 })
  assert.equal(status.fresh, false, 'six minutes after the last good round the reading is stale')
  assert.equal(brokerReadingsStatus(db, { nowMs: Date.parse(T1) + 60_000 }).fresh, true)
  fail = 'No access token stored — connect cTrader first'
  assert.equal((await readings.poll()).reason, 'no_access_token')
  assert.equal(JSON.parse(getState(db, READINGS_RECORD_KEY)).consecutiveFailures, 2)
})

test('partial: an account the broker failed and a registered account the token did not return are both named', async t => {
  const db = fixture(t, ['11', '22', '33'])
  const { seen, heartbeat } = beats()
  const read = async () => ({ ok: true, fetchedAt: new Date().toISOString(),
    accounts: [brokerAccount({ accountId: '11' }), brokerAccount({ accountId: '22' }, { error: 'cTrader WS timeout after 25000ms' })] })
  const r = await makeBrokerReadings(db, { read, ready: open, heartbeat, log: () => {} }).poll()
  assert.equal(r.status, 'partial')
  assert.deepEqual(r.recorded, ['11'])
  assert.deepEqual(r.failed, [{ accountId: '22', reason: 'broker_timeout' }])
  assert.deepEqual(r.missing, ['33'])
  assert.equal(seen[0].ok, false, 'a round that missed an account does not beat healthy')
  const status = brokerReadingsStatus(db)
  assert.equal(status.status, 'partial'); assert.equal(status.fresh, true)
  assert.deepEqual(status.missing, ['33'])
})

test('with no reader registered the round fails visibly instead of reporting health', async t => {
  const db = fixture(t)
  const { seen, heartbeat } = beats()
  const r = await makeBrokerReadings(db, { ready: open, heartbeat, log: () => {} }).poll()
  assert.equal(r.status, 'failed'); assert.equal(r.reason, 'readings_reader_unavailable')
  assert.equal(seen[0].ok, false)
  assert.equal(brokerReadingsStatus(db).at, null)
})

test('the first round waits for M1\'s first protection band, or three minutes after boot', async t => {
  const boot = 1_000_000
  assert.deepEqual(firstReadReady(boot + 10_000, { bootMs: boot, first: () => ({ band: null }) }), { ready: false, reason: 'waiting_first_protection_band' })
  assert.equal(firstReadReady(boot + 10_000, { bootMs: boot, first: () => ({ band: { at: 'x' } }) }).ready, true)
  assert.equal(firstReadReady(boot + FIRST_READ_MAX_DELAY_MS, { bootMs: boot, first: () => ({}) }).ready, true)
  const db = fixture(t)
  let reads = 0, ready = false
  const { seen, heartbeat } = beats()
  const readings = makeBrokerReadings(db, { read: async () => { reads++; return { ok: true, accounts: [] } },
    ready: () => ready ? { ready: true } : { ready: false, reason: 'waiting_first_protection_band' }, heartbeat, log: () => {} })
  assert.deepEqual(await readings.poll(), { skipped: 'waiting_first_protection_band' })
  assert.equal(reads, 0)
  assert.deepEqual(seen.map(b => [b.ok, b.detail?.waiting]), [[true, 'waiting_first_protection_band']], 'waiting beats, so a restart is not a stall')
  ready = true
  await readings.poll()
  assert.equal(reads, 1)
})

test('the ticker: every 60 s; inert when disarmed; stop clears it', () => {
  const set = [], cleared = []
  const deps = { setInterval: (fn, ms) => { set.push(ms); return { unref() {} } }, clearInterval: x => cleared.push(x) }
  const stop = startBrokerReadings({}, deps)
  assert.deepEqual(set, [READINGS_INTERVAL_MS])
  stop(); assert.equal(cleared.length, 1)
  const inert = startBrokerReadings({}, { ...deps, env: { RAILWAY_ENVIRONMENT_NAME: 'staging' } })
  assert.deepEqual(set, [READINGS_INTERVAL_MS], 'no timer in a disarmed environment')
  inert()
})

test('failure reasons are a fixed vocabulary', () => {
  assert.equal(readingFailureReason('readings_timeout'), 'readings_timeout')
  assert.equal(readingFailureReason('No access token stored — connect cTrader first'), 'no_access_token')
  assert.equal(readingFailureReason('cTrader client id/secret env vars not set on the agent'), 'client_credentials_missing')
  assert.equal(readingFailureReason('CH_ACCESS_TOKEN_INVALID'), 'broker_auth_refused')
  assert.equal(readingFailureReason('something else entirely'), 'broker_read_failed')
})

test('registered as a controller with a dated work product', () => {
  assert.equal(CONTROLLERS.broker_readings.expectedSec, 60)
  assert.equal(CONTROLLERS.broker_readings.effect.key, READINGS_RECORD_KEY)
  registerBrokerReadingsReader(null, () => {}) // ignored, never throws
})

test('the loop starts the minute reader (a call site the module cannot see)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const start = src.indexOf('export function startLoop(db)')
  assert.ok(start > 0)
  const body = src.slice(start, start + 40_000)
  assert.match(body, /import\('\.\/services\/broker-readings\.js'\)\s*\.then\(m => m\.startBrokerReadings\(db\)\)/)
})
