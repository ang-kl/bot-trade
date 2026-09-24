import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'
import { accountOverview } from './account-overview.js'

const NOW = Date.parse('2026-09-24T22:00:00Z'), host = 'demo.ctraderapi.com'
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const id of ['11', '22', '33', '44', '55', '66', '77']) db.prepare('INSERT INTO accounts(account_id,is_live,enabled) VALUES(?,0,1)').run(id)
  recordDepositCurrency(db, { accountId: '11', host, depositAssetId: '1', currency: 'USD', receivedAt: NOW - 2000 })
  recordAccountMoney(db, { accountId: '11', host, trader: { depositAssetId: '1' }, balance: 100, receivedAt: NOW - 1000 })
  return db
}
function snapshot(db, patch = {}) {
  setState(db, 'acct:11:broker_snapshot_cache_json', JSON.stringify({ fetchedAt: new Date(NOW - 500).toISOString(), account: {
    accountId: '11', host, currency: 'USD', health: { balance: 100, usedMargin: 2 },
    balanceReceivedAt: new Date(NOW - 1000).toISOString(), pnlReceivedAt: new Date(NOW - 500).toISOString(),
    positions: [{ positionId: '88', symbol: 'ETHUSD', symbolId: 9, netPnl: 5, pnlSource: 'broker' }], ...patch,
  } }))
}
test('all seven account rows survive missing readings; current money uses owned broker evidence', t => {
  const db = fixture(t); snapshot(db)
  const r = accountOverview(db, { nowMs: NOW })
  assert.equal(r.accounts.length, 7)
  const a = r.accounts.find(a => a.accountId === '11')
  assert.equal(a.balance, 100); assert.equal(a.openPnl, 5); assert.equal(a.equity, 105)
  assert.equal(a.freeMargin, 103); assert.equal(a.currency, 'USD'); assert.equal(a.pnlReceivedAt, NOW - 500)
  assert.equal(r.accounts.find(a => a.accountId === '22').balance, null)
})
test('foreign identity, host, currency, unpriced legs and stale source receipts cannot become live money', t => {
  const db = fixture(t)
  for (const patch of [{ accountId: '22' }, { host: 'live.ctraderapi.com' }, { currency: 'EUR' },
    { positions: [{ netPnl: 5, pnlSource: 'estimated' }] },
    { pnlReceivedAt: new Date(NOW - 900001).toISOString() }]) {
    snapshot(db, patch)
    const a = accountOverview(db, { nowMs: NOW }).accounts.find(a => a.accountId === '11')
    assert.equal(a.openPnl, null, JSON.stringify(patch)); assert.equal(a.equity, null)
    assert.equal(a.balance, 100)
  }
})
test('flat account has true zero floating; reads never renew source times or write state', t => {
  const db = fixture(t); snapshot(db, { positions: [] })
  const before = db.prepare('SELECT total_changes() n').get().n
  const a = accountOverview(db, { nowMs: NOW }).accounts[0]
  assert.equal(a.openPnl, 0); assert.equal(a.equity, 100)
  assert.equal(accountOverview(db, { nowMs: NOW + 900000 }).accounts[0].balance, null)
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before)
})

test('registered live-host readings use the identical calculation and freshness contract', t => {
  const db = fixture(t), route = 'live.ctraderapi.com'
  db.prepare('UPDATE accounts SET is_live=1 WHERE account_id=?').run('11')
  recordDepositCurrency(db, { accountId: '11', host: route, depositAssetId: '1', currency: 'USD', receivedAt: NOW - 2000 })
  recordAccountMoney(db, { accountId: '11', host: route, trader: { depositAssetId: '1' }, balance: 100, receivedAt: NOW - 1000 })
  snapshot(db, { host: route })
  const a = accountOverview(db, { nowMs: NOW }).accounts[0]
  assert.equal(a.balance, 100); assert.equal(a.openPnl, 5); assert.equal(a.equity, 105)
  assert.equal(accountOverview(db, { nowMs: NOW + 900000 }).accounts[0].equity, null)
})
