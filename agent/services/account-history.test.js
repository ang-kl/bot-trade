import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { accountHistory, recordAccountHistory, captureSnapshotHistory } from './account-history.js'
import { recordCashflowWindow } from './account-cashflows.js'
import { runEquitySnapshot, snapshotAccountEquity } from './equity-snapshot.js'
const T = Math.floor(Date.now() / 60_000) * 60_000, host = 'demo.ctraderapi.com'
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'account_history_pruned_ms', String(Date.now()))
  const point = (at, equity, extra = {}) => recordAccountHistory(db, { accountId: '11', host, source: 'nightly_equity', receivedAt: at, currency: 'USD', balance: equity, equity, openPnl: 0, ...extra })
  const cashflows = (rows = [], extra = {}) => recordCashflowWindow(db, { accountId: '11', host, currency: 'USD', from: T - 3600_000, to: T, receivedAt: T,
    response: { ctidTraderAccountId: '11', depositWithdraw: rows }, ...extra })
  const event = (eventId, delta, type = 0) => ({ balanceHistoryId: eventId, changeBalanceTimestamp: T - 30_000, delta, operationType: type, moneyDigits: 2 })
  return { db, point, cashflows, event, read: extra => accountHistory(db, '11', { from: T - 3600_000, to: T + 1, ...extra }) }
}

test('deposits do not become profit; covered empty cashflows are zero, absent coverage is unknown', t => {
  const { point, cashflows, event, read } = fixture(t)
  point(T - 60_000, 100); point(T, 620)
  assert.equal(read().externalFlowAdjustedChange, null)
  cashflows([event('1', 50000)])
  assert.equal(read().equityChange, 520)
  assert.equal(read().externalFlowAdjustedChange, 20)
  assert.equal(read().cashflows.externalNet, 500)
})

test('cashflow events deduplicate, conflict atomically, and preserve fees as adjustments', t => {
  const { db, point, cashflows, event, read } = fixture(t)
  point(T - 60_000, 100); point(T, 95)
  cashflows([event('1', -500, 17)]); cashflows([event('1', -500, 17)])
  assert.equal(read().externalFlowAdjustedChange, -5)
  assert.equal(read().cashflows.otherAdjustments, -5)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_cashflows').get().n, 1)
  assert.throws(() => cashflows([event('2', 10000), event('1', -600, 17)]), /duplicate_conflict/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_cashflows').get().n, 1)
  assert.throws(() => cashflows([], { response: { ctidTraderAccountId: '22' } }), /response_invalid/)
})

test('unknown classification, currency changes, source errors and pagination cannot yield a complete return', t => {
  const { point, cashflows, event, read } = fixture(t)
  point(T - 60_000, 100); point(T, 120)
  cashflows([event('1', 2000, 999)])
  assert.equal(read().cashflows.reason, 'cashflow_classification_unknown')
  assert.equal(read().externalFlowAdjustedChange, null)
  assert.equal(read({ limit: 1 }).summaryComplete, false)
  point(T - 120_000, 50, { currency: 'EUR' })
  assert.equal(read().currency, null)
  assert.equal(read().sampledDrawdown, null)
})

test('minute observations retain source time and account isolation; estimates do not become broker equity', t => {
  const { db, point, read } = fixture(t)
  point(T, 100); point(T + 1, 101); point(T, 9)
  const own = accountHistory(db, '11', { from: T - 3600_000, to: T + 2 })
  assert.equal(own.points.length, 1); assert.equal(own.points[0].equity, 101)
  assert.equal(accountHistory(db, '22', { from: T - 3600_000, to: T + 2 }).points.length, 0)
  captureSnapshotHistory(db, { accountId: '11', host, currency: 'USD', balanceReceivedAt: new Date(T - 20_000).toISOString(), health: { balance: 100, equity: 200 },
    positions: [{ positionId: 1, sl: 90, tp: null, pnlSource: 'estimate', netPnl: 100 }] }, new Date(T).toISOString())
  const p = read().points.find(p => p.source === 'broker_snapshot')
  assert.equal(p.equity, null); assert.equal(p.openPnl, null)
  assert.equal(p.balanceReceivedAt, T - 20_000)
  assert.deepEqual([p.protection.missingSL, p.protection.missingTP], [0, 1])
})

test('a timed-out nightly read cannot write a successful late snapshot', async t => {
  const { db } = fixture(t)
  db.prepare('INSERT INTO accounts (account_id,enabled,is_live) VALUES (?,?,0)').run('11', 1)
  let resolve
  const trader = new Promise(r => { resolve = r })
  const ws = { wsGetTrader: () => trader, traderBalance: t => t.balance, wsGetUnrealizedPnl: async () => ({}) }
  const result = await runEquitySnapshot(db, {}, { timeoutMs: 5, deps: { ws, tokenRefused: new Set() } })
  assert.equal(result.timedOut, 1)
  resolve({ balance: 100, depositAssetId: 1 })
  await new Promise(r => setTimeout(r, 5))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM equity_snapshots').get().n, 0)
})

test('nightly integration records native currency and completed cashflow coverage without converting to USD', async t => {
  const { db, read, point } = fixture(t)
  point(T - 60_000, 100, { currency: 'EUR' })
  const ws = {
    wsGetTrader: async () => ({ balance: 10000, moneyDigits: 2, depositAssetId: 2 }),
    traderBalance: t => t.balance / 100,
    wsGetAssets: async () => ({ asset: [{ assetId: 2, name: 'EUR' }] }),
    wsGetUnrealizedPnl: async () => ({ 123: { net: 5 } }),
    wsGetCashflowHistory: async () => ({ ctidTraderAccountId: 11, depositWithdraw: [] }),
  }
  const out = await snapshotAccountEquity(db, { host }, '11', { deps: { ws, clock: () => T }, now: T })
  assert.equal(out.currency, 'EUR'); assert.equal(out.equity, 105)
  const stored = db.prepare('SELECT * FROM equity_snapshots').get()
  assert.equal(stored.currency, 'EUR'); assert.equal(stored.broker_host, host)
  assert.equal(read().points.findLast(p => p.source === 'nightly_equity').equity, 105)
  assert.equal(read().currency, 'EUR')
  assert.equal(read().cashflows.complete, true)
  assert.equal(read().equityChange, 5)
})

test('one receipt or simultaneous receipts cannot manufacture zero change or zero drawdown', t => {
  const { point, cashflows, read } = fixture(t)
  point(T, 100); cashflows()
  point(T, 101, { source: 'broker_snapshot' })
  assert.equal(read().currency, 'USD')
  assert.equal(read().equityChange, null)
  assert.equal(read().sampledDrawdown, null)
  assert.equal(read().externalFlowAdjustedChange, null)
  point(T - 60_000, 100)
  assert.equal(read().equityChange, 1)
})

test('a missing position P&L cannot be quietly summed as zero', async t => {
  const { db } = fixture(t)
  const ws = { wsGetTrader: async () => ({ balance: 100 }), traderBalance: t => t.balance,
    wsGetUnrealizedPnl: async () => ({ 1: { net: 10 }, 2: { net: null } }) }
  const out = await snapshotAccountEquity(db, { host }, '11', { deps: { ws, clock: () => T }, now: T })
  assert.equal(out.openPnl, null); assert.equal(out.equity, null)
  assert.match(out.error, /P&L incomplete/)
})
