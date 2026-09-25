// WEB-9 (8,989-A row 11): the Data-feed card's measured figures. Behavioural —
// every assertion runs the reader against rows in a real (in-memory) schema.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { executionCosts, quoteFreshness, nearestRank, verifiedDepositCurrency, EXECUTION_WINDOW_MAX } from './data-feed-report.js'
import { accountWhere } from '../lib/account-scope.js'

function db() {
  return initDB(':memory:')
}

const insert = (d, rows) => {
  const st = d.prepare(`INSERT INTO trades (symbol, status, account_id, closed_at, opened_at, entry_latency_ms, commission, swap, net_pnl)
    VALUES (@symbol, @status, @account_id, @closed_at, @opened_at, @entry_latency_ms, @commission, @swap, @net_pnl)`)
  for (const r of rows) {
    st.run({ symbol: 'EURUSD', status: 'closed', account_id: null, opened_at: '2026-09-01T00:00:00Z', entry_latency_ms: null, commission: null, swap: null, net_pnl: 1, ...r })
  }
}

const verify = (d, id, currency) => setState(d, `acct:${id}:deposit_currency_evidence_json`, JSON.stringify({
  accountId: id, host: 'demo.ctraderapi.com', depositAssetId: '15', currency, receivedAt: 1, source: 'broker_asset_list',
}))

test('nearestRank returns a measured value, never an interpolated one', () => {
  assert.equal(nearestRank([], 50), null)
  assert.equal(nearestRank([10], 90), 10)
  assert.equal(nearestRank([10, 20, 30, 40], 50), 20)
  assert.equal(nearestRank([10, 20, 30, 40], 90), 40)
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)
})

test('latency carries its coverage: measured of window, percentiles only over measured rows', () => {
  const d = db()
  insert(d, [
    { closed_at: '2026-09-20T10:00:00Z', entry_latency_ms: 100 },
    { closed_at: '2026-09-20T11:00:00Z', entry_latency_ms: 300 },
    { closed_at: '2026-09-20T12:00:00Z', entry_latency_ms: null },
    { closed_at: '2026-09-20T13:00:00Z', entry_latency_ms: 200 },
    { closed_at: '2026-09-20T14:00:00Z', entry_latency_ms: null },
    // Not a close: an open or rejected row is not in the window.
    { closed_at: null, status: 'open', entry_latency_ms: 9_999 },
    { closed_at: '2026-09-20T15:00:00Z', status: 'rejected', entry_latency_ms: 9_999 },
  ])
  const r = executionCosts(d)
  assert.equal(r.window.closes, 5)
  assert.equal(r.latency.measured, 3)
  assert.equal(r.latency.of, 5)
  assert.equal(r.latency.p50Ms, 200)
  assert.equal(r.latency.p90Ms, 300)
  assert.equal(r.latency.maxMs, 300)
  d.close()
})

test('no measured latency is null, not zero', () => {
  const d = db()
  insert(d, [{ closed_at: '2026-09-20T10:00:00Z' }, { closed_at: '2026-09-20T11:00:00Z' }])
  const r = executionCosts(d)
  assert.equal(r.latency.measured, 0)
  assert.equal(r.latency.of, 2)
  assert.equal(r.latency.p50Ms, null)
  assert.equal(r.latency.p90Ms, null)
  d.close()
})

test('the window is the LATEST N closes by close time, bounded', () => {
  const d = db()
  insert(d, [
    { closed_at: '2026-09-01T10:00:00Z', entry_latency_ms: 5_000, commission: -100 },
    { closed_at: '2026-09-20T10:00:00Z', entry_latency_ms: 10, commission: -1 },
    { closed_at: '2026-09-21T10:00:00Z', entry_latency_ms: 20, commission: -2 },
  ])
  const r = executionCosts(d, { limit: 2 })
  assert.equal(r.window.closes, 2)
  assert.equal(r.window.newestClosedAt, '2026-09-21T10:00:00Z')
  assert.equal(r.window.oldestClosedAt, '2026-09-20T10:00:00Z')
  assert.equal(r.latency.maxMs, 20, 'the old 5,000 ms close is outside the window')
  assert.equal(r.costs[0].commission, -3)
  assert.equal(executionCosts(d, { limit: 10 ** 9 }).window.limit, EXECUTION_WINDOW_MAX)
  assert.equal(executionCosts(d, { limit: 'x' }).window.limit, 300)
  d.close()
})

test('fees and swap are summed per VERIFIED deposit currency and never across currencies', () => {
  const d = db()
  verify(d, '11', 'USD')
  verify(d, '22', 'SGD')
  insert(d, [
    { account_id: '11', closed_at: '2026-09-20T10:00:00Z', commission: -3.5, swap: -1.25 },
    { account_id: '11', closed_at: '2026-09-20T11:00:00Z', commission: -2.5, swap: null },
    { account_id: '22', closed_at: '2026-09-20T12:00:00Z', commission: -7, swap: 0.5 },
    // Account with no verified currency, and a row with no account at all.
    { account_id: '33', closed_at: '2026-09-20T13:00:00Z', commission: -1, swap: -1 },
    { account_id: null, closed_at: '2026-09-20T14:00:00Z', commission: null, swap: null },
  ])
  const r = executionCosts(d)
  const by = Object.fromEntries(r.costs.map(b => [b.currency ?? 'unverified', b]))
  assert.deepEqual(Object.keys(by), ['SGD', 'USD', 'unverified'], 'verified currencies first, unverified last')
  assert.equal(by.USD.closes, 2)
  assert.equal(by.USD.commission, -6)
  assert.equal(by.USD.commissionKnown, 2)
  assert.equal(by.USD.swap, -1.25)
  assert.equal(by.USD.swapKnown, 1)
  assert.equal(by.SGD.commission, -7)
  assert.equal(by.SGD.swap, 0.5)
  assert.equal(by.unverified.currency, null)
  assert.equal(by.unverified.closes, 2)
  assert.equal(by.unverified.commission, -1)
  assert.equal(by.unverified.commissionKnown, 1)
  assert.deepEqual(by.unverified.accounts, ['33'])
  assert.equal(r.window.unattributed, 1)
  d.close()
})

test('a bucket with no recorded fee reports null, not 0', () => {
  const d = db()
  verify(d, '11', 'USD')
  insert(d, [{ account_id: '11', closed_at: '2026-09-20T10:00:00Z' }])
  const [b] = executionCosts(d).costs
  assert.equal(b.commission, null)
  assert.equal(b.commissionKnown, 0)
  assert.equal(b.swap, null)
  d.close()
})

test('an account scope reads that account (and unattributed rows), not another account', () => {
  const d = db()
  verify(d, '11', 'USD')
  verify(d, '22', 'USD')
  insert(d, [
    { account_id: '11', closed_at: '2026-09-20T10:00:00Z', entry_latency_ms: 50, commission: -1 },
    { account_id: '22', closed_at: '2026-09-20T11:00:00Z', entry_latency_ms: 900, commission: -50 },
  ])
  const w = accountWhere({ accountId: '11', all: false }, 'account_id')
  const r = executionCosts(d, { where: w.where, params: w.params })
  assert.equal(r.window.closes, 1)
  assert.equal(r.latency.maxMs, 50)
  assert.equal(r.costs[0].commission, -1)
  d.close()
})

test('the deposit currency is the broker-verified one only — no registry or USD default', () => {
  const d = db()
  d.prepare('INSERT INTO accounts (account_id, is_live, base_currency) VALUES (?, ?, ?)').run('44', 0, 'EUR')
  assert.equal(verifiedDepositCurrency(d, '44'), null, 'registry base_currency is a hint, not evidence')
  setState(d, 'acct:44:deposit_currency_evidence_json', JSON.stringify({ accountId: '55', currency: 'EUR' }))
  assert.equal(verifiedDepositCurrency(d, '44'), null, 'evidence for another account is not this account\'s')
  verify(d, '44', 'EUR')
  assert.equal(verifiedDepositCurrency(d, '44'), 'EUR')
  d.close()
})

test('quote freshness reads the fast monitor pass record with its age', () => {
  const d = db()
  assert.equal(quoteFreshness(d, 0).status, 'unavailable')
  const at = '2026-09-25T12:00:00.000Z'
  setState(d, 'fast_monitor_pass_json', JSON.stringify({ at, tick: {
    quotes: { fromSidecar: 1, fromBroker: 2, stale: 0, at, checked: 3 },
    quotes10m: { fromSidecar: 4, fromBroker: 31, stale: 31, passes: 12, sidecarSharePct: 11.4 },
  } }))
  const q = quoteFreshness(d, Date.parse(at) + 7_000)
  assert.equal(q.status, 'measured')
  assert.equal(q.ageMs, 7_000)
  assert.deepEqual(q.window10m, { passes: 12, fromSidecar: 4, fromBroker: 31, stale: 31, sidecarSharePct: 11.4 })
  setState(d, 'fast_monitor_pass_json', JSON.stringify({ at, tick: { quotes10m: null } }))
  const none = quoteFreshness(d, Date.parse(at))
  assert.equal(none.status, 'no_priced_pass')
  assert.equal(none.window10m, null)
  d.close()
})
