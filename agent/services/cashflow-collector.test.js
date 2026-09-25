import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { accountHistory, recordAccountHistory, cashflowCoverage } from './account-history.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'
import { recordCashflowWindow } from './account-cashflows.js'
import { makeCashflowCollector, nextCashflowWindow } from './cashflow-collector.js'

const T = Math.floor(Date.now() / 60_000) * 60_000
const host = 'demo.ctraderapi.com', WEEK = 604800_000
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'account_history_pruned_ms', String(Date.now()))
  const point = (accountId, at, equity, currency = 'USD', route = host) => recordAccountHistory(db,
    { accountId, host: route, source: 'nightly_equity', receivedAt: at, currency, balance: equity, equity, openPnl: 0 })
  const money = (id, currency = 'USD', route = host, at = T) => {
    recordDepositCurrency(db, { accountId: id, host: route, depositAssetId: '1', currency, receivedAt: at })
    recordAccountMoney(db, { accountId: id, host: route, trader: { ctidTraderAccountId: id, depositAssetId: '1', moneyDigits: 2 }, balance: 620, receivedAt: at })
  }
  const account = (id, currency = 'USD', route = host) => {
    db.prepare("INSERT INTO accounts (account_id,enabled,mode) VALUES (?,0,'manage_only')").run(id)
    money(id, currency, route)
    point(id, T - 120_000, 100, currency, route); point(id, T - 60_000, 620, currency, route)
  }
  const getCreds = (_db, id) => ({ ready: true, accountId: id, host, clientId: 'i', clientSecret: 's', accessToken: 't' })
  const report = id => accountHistory(db, id, { from: T - 3600_000, to: T + 1 })
  const response = (id, events = []) => ({ ctidTraderAccountId: id, depositWithdraw: events })
  const collector = overrides => makeCashflowCollector(db, { getCreds, clock: () => T + 1000, log: () => {}, ...overrides })
  const status = id => JSON.parse(getState(db, `acct:${id}:cashflow_collection_json`))
  return { db, point, money, account, getCreds, report, response, collector, status }
}

test('the real producer records deposits and makes the report reconcile for manage-only accounts', async t => {
  const { account, collector, response, report, status, db } = fixture(t)
  account('11')
  assert.equal(report('11').externalFlowAdjustedChange, null)
  const calls = []
  const c = collector({ read: async (...args) => { calls.push(args); return response(args[4], [
    { balanceHistoryId: '9', changeBalanceTimestamp: T - 90_000, delta: 50000, moneyDigits: 2, operationType: 0 },
  ]) } })
  assert.equal((await c.poll()).events, 1)
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(4), ['11', T - 120_000, T, 5000])
  assert.equal(report('11').cashflows.externalNet, 500)
  assert.equal(report('11').externalFlowAdjustedChange, 20)
  assert.equal(report('11').cashflowCollection.lastSuccessAt, T + 1000)
  assert.equal(status('11').status, 'success')
  assert.equal(db.prepare('SELECT enabled FROM accounts').get().enabled, 0)
  assert.equal((await c.poll()).skipped, 'no_uncovered_observations')
  assert.equal(calls.length, 1)
})

test('seven-day catchup is fair across accounts and resumes its persisted coverage after restart', async t => {
  const { account, point, collector, response, db } = fixture(t)
  for (const id of ['11', '22']) { account(id); point(id, T - 20 * 86400_000, 100) }
  const calls = [], read = async (...args) => { calls.push(args); return response(args[4]) }
  const first = collector({ read })
  await first.poll(); first.stop()
  const restarted = collector({ read })
  await restarted.poll(); await restarted.poll()
  assert.deepEqual(calls.map(a => a[4]), ['11', '22', '11'])
  assert.equal(calls[0][6] - calls[0][5], WEEK)
  assert.equal(calls[2][5], calls[0][6])
  assert.equal(calls[2][6] - calls[2][5], WEEK)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account_cashflow_windows WHERE account_id='11'").get().n, 1)
})

test('a failed account keeps its hole and cannot starve a peer or leak request credentials', async t => {
  const { account, collector, response, status, db } = fixture(t)
  account('11'); account('22')
  const calls = [], c = collector({ read: async (...args) => {
    calls.push(args); if (args[4] === '11') throw new Error('accessToken=PRIVATE'); return response('22')
  } })
  assert.equal((await c.poll()).error, 'cashflow_read_failed')
  assert.equal(status('11').reason, 'cashflow_read_failed')
  assert.equal((await c.poll()).accountId, '22')
  await c.poll()
  assert.deepEqual(calls.map(a => a[4]), ['11', '22', '11'])
  assert.equal(calls[2][5], calls[0][5])
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account_cashflow_windows WHERE account_id='11'").get().n, 0)
})

test('refused, stale, unknown-currency and mismatched-route accounts do not initiate reads', async t => {
  const { account, collector, db, status, money } = fixture(t)
  for (const id of ['11', '22', '33', '44']) account(id)
  setState(db, 'cpp_exec_refused_accounts_json', '["11"]')
  const old = JSON.parse(getState(db, 'acct:22:money_observation_json')); old.receivedAt = T - 900_000
  setState(db, 'acct:22:money_observation_json', JSON.stringify(old))
  const unknown = JSON.parse(getState(db, 'acct:33:money_observation_json')); unknown.currency = null; unknown.reason = 'deposit_currency_unverified'
  setState(db, 'acct:33:money_observation_json', JSON.stringify(unknown))
  money('44', 'USD', 'live.ctraderapi.com')
  let calls = 0
  const result = await collector({ read: async () => { calls++ } }).poll()
  assert.equal(result.skipped, 'no_uncovered_observations'); assert.equal(calls, 0)
  assert.equal(status('11').reason, 'token_refused')
  for (const id of ['22', '33', '44']) assert.equal(status(id).reason, 'currency_or_account_evidence_unavailable')
})

test('wrong identity, incomplete responses, money errors and currency changes cannot complete coverage', async t => {
  const { account, collector, response, db, money } = fixture(t)
  account('11')
  for (const r of [response('22'), { ...response('11'), hasMore: true }, { ...response('11'), errorCode: 'FAILED' },
    response('11', [{ balanceHistoryId: '1', changeBalanceTimestamp: T - 90_000, operationType: 0, delta: 'bad', moneyDigits: 2 }])]) {
    assert.ok((await collector({ read: async () => r }).poll()).error)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_cashflow_windows').get().n, 0)
  }
  assert.equal((await collector({ read: async () => { money('11', 'EUR'); return response('11') } }).poll()).error, 'cashflow_identity_changed')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_cashflow_windows').get().n, 0)
})

test('a hung transport is timed out, remains non-overlapping, and cannot write when it finally replies', async t => {
  const { account, collector, response, db, status } = fixture(t)
  account('11')
  let release, calls = 0
  const pending = new Promise(r => { release = r })
  const c = collector({ timeoutMs: 10, read: () => { calls++; return pending } })
  const first = c.poll()
  assert.equal((await c.poll()).skipped, 'in_flight')
  assert.equal((await first).error, 'cashflow_read_timeout')
  assert.equal((await c.poll()).skipped, 'in_flight')
  assert.equal(calls, 1); assert.equal(status('11').status, 'failed')
  release(response('11')); await new Promise(r => setImmediate(r))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_cashflow_windows').get().n, 0)
})

test('stopping the collector invalidates an outstanding response', async t => {
  const { account, collector, response, db } = fixture(t); account('11')
  let release
  const c = collector({ read: () => new Promise(r => { release = r }) })
  const pending = c.poll(); await new Promise(r => setImmediate(r)); c.stop(); release(response('11'))
  assert.equal((await pending).skipped, 'stopped')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_cashflow_windows').get().n, 0)
})

test('window compaction keeps transitive coverage, real gaps and separate account/host/currency identities', t => {
  const { db, response } = fixture(t)
  const insert = db.prepare('INSERT INTO account_cashflow_windows VALUES (?,?,?,?,?,?)')
  // Existing nightly windows may overlap each other before compaction exists.
  insert.run('11',host,'USD',1000,3000,T); insert.run('11',host,'USD',2500,4000,T)
  insert.run('11',host,'USD',8000,9000,T); insert.run('22',host,'USD',1000,3000,T)
  insert.run('11','live.ctraderapi.com','USD',1000,3000,T); insert.run('11',host,'EUR',1000,3000,T)
  recordCashflowWindow(db, { accountId: '11', host, currency: 'USD', from: 4000, to: 5000, receivedAt: T, response: response('11') })
  assert.deepEqual(db.prepare("SELECT from_ms,to_ms FROM account_cashflow_windows WHERE account_id='11' AND host=? AND currency='USD' ORDER BY from_ms").all(host),
    [{ from_ms: 1000, to_ms: 5000 }, { from_ms: 8000, to_ms: 9000 }])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_cashflow_windows').get().n, 5)
  const coverage = cashflowCoverage(db, { accountId: '11', host, currency: 'USD', from: 1000, to: 9000 })
  assert.equal(coverage.complete, false); assert.equal(coverage.coveredThrough, 5000)
})

test('a dated reconciled portion never becomes the full-window result or hides unknown classifications', async t => {
  const { account, point, collector, response, report, db } = fixture(t); account('11')
  await collector({ read: async () => response('11') }).poll()
  point('11', T + 60_000, 640)
  const read = () => accountHistory(db, '11', { from: T - 3600_000, to: T + 60_001 })
  assert.equal(report('11').externalFlowAdjustedChange, 520)
  assert.equal(read().externalFlowAdjustedChange, null)
  assert.deepEqual(read().reconciledSpan, { from: T - 120_000, to: T - 60_000, currency: 'USD',
    equityChange: 520, externalNet: 0, externalFlowAdjustedChange: 520, pendingObservations: 1 })
  // V3 B3: the reconciled portion is the whole window's, so a one-row page
  // reports the same dated portion instead of none.
  assert.deepEqual(accountHistory(db, '11', { from: T - 3600_000, to: T + 60_001, limit: 1 }).reconciledSpan, read().reconciledSpan)
  recordCashflowWindow(db, { accountId: '11', host, currency: 'USD', from: T - 120_000, to: T, receivedAt: T,
    response: response('11', [{ balanceHistoryId: '9', changeBalanceTimestamp: T - 90_000, operationType: 999, delta: 100, moneyDigits: 2 }]) })
  assert.equal(read().reconciledSpan, null)
})

test('collection cannot reach beyond retention or relabel an older currency regime', t => {
  const { account, point, db } = fixture(t); account('11')
  point('11', T - 91 * 86400_000, 1)
  point('11', T - 10 * 86400_000, 2)
  point('11', T - 5 * 86400_000, 3, 'EUR')
  const next = nextCashflowWindow(db, { accountId: '11', host, currency: 'USD', now: T + 1000 })
  assert.equal(next.from, T - 120_000)
})
