import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import stateRouter from './state.js'

async function server(t) {
  const db = initDB(':memory:')
  const app = express()
  app.use('/state', stateRouter(db))
  const http = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  t.after(() => new Promise(resolve => http.close(() => { db.close(); resolve() })))
  return {
    db,
    read: (id) => fetch(`http://127.0.0.1:${http.address().port}/state/risk-full${id ? `?account=${id}` : ''}`).then(r => r.json()),
  }
}

const snapshot = (id, balance, usedMargin, patch = {}) => ({
  fetchedAt: new Date(Date.now() - 1000).toISOString(),
  account: { accountId: id, currency: 'USD', isLive: id === '22', health: {
    balance, usedMargin, equity: balance, freeMargin: balance - usedMargin,
    marginLevelPct: usedMargin ? balance / usedMargin * 100 : null,
  } },
  ...patch,
})

test('Risk account switching reads each account snapshot, including the selected-account view', async t => {
  const { db, read } = await server(t)
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'ctrader_is_live', 'false')
  setState(db, 'account_balance_usd', '900000')
  setState(db, 'account_leverage', '999')
  for (const [id, balance, margin, leverage] of [['11', 10000, 8000, 100], ['22', 100, 0, 20]]) {
    setState(db, `acct:${id}:broker_snapshot_cache_json`, JSON.stringify(snapshot(id, balance, margin)))
    setState(db, `acct:${id}:account_balance_usd`, String(balance - 1))
    setState(db, `acct:${id}:account_leverage`, String(leverage))
  }
  setState(db, 'broker_snapshot_cache_json', JSON.stringify(snapshot('11', 900000, 700000)))
  const a = await read('22')
  assert.equal(a.account.balance, 100, 'fresh own broker balance wins over older stored value')
  assert.equal(a.account.balanceSource, 'broker')
  assert.equal(a.account.leverage, 20)
  assert.equal(a.account.isLive, true)
  assert.equal(a.margin.usedMargin, 0)
  assert.equal(a.margin.accountId, '22')
  assert.equal(a.margin.currency, 'USD')
  assert.equal(a.dailyPacing.balance, 100)
  assert.equal(a.account.brokerSnapshot.status, 'fresh')
  const b = await read('11')
  assert.equal(b.margin.usedMargin, 8000)
  assert.equal(b.account.balance, 10000)
  const selected = await read()
  assert.equal(selected.risk.scopedTo, null, 'omitting account still requests global configuration')
  assert.equal(selected.account.accountId, '11')
  assert.equal(selected.account.balance, 10000)
})

test('missing or foreign snapshot never borrows the selected account money or leverage', async t => {
  const { db, read } = await server(t)
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'ctrader_is_live', 'true')
  setState(db, 'account_balance_usd', '900000')
  setState(db, 'account_leverage', '999')
  setState(db, 'acct:11:account_balance_usd', '900000')
  setState(db, 'broker_snapshot_cache_json', JSON.stringify(snapshot('11', 900000, 700000)))
  let actual = await read('22')
  assert.equal(actual.account.balance, null)
  assert.equal(actual.account.balanceSource, null)
  assert.equal(actual.account.leverage, null)
  assert.equal(actual.account.isLive, null)
  assert.equal(actual.margin, null)
  assert.equal(actual.account.brokerSnapshot.reason, 'snapshot_missing')
  setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify(snapshot('11', 900000, 700000)))
  invalidateStateCache() // direct fixture write, normally done by /actions
  actual = await read('22')
  assert.equal(actual.account.balance, null)
  assert.equal(actual.margin, null)
  assert.equal(actual.account.brokerSnapshot.reason, 'account_mismatch')
})

test('unusable broker evidence exposes its reason while a same-account stored zero remains visible', async t => {
  const { db, read } = await server(t)
  setState(db, 'acct:22:account_balance_usd', '0')
  for (const [value, reason] of [
    [snapshot('22', 100, 20, { fetchedAt: new Date(Date.now() - 16 * 60_000).toISOString() }), 'snapshot_stale'],
    [snapshot('22', 100, 20, { fetchedAt: new Date(Date.now() + 60_000).toISOString() }), 'snapshot_time_future'],
    [snapshot('22', 100, 20, { account: { accountId: '22', health: { balance: 100, usedMargin: 20 } } }), 'currency_unknown'],
  ]) {
    setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify(value))
    invalidateStateCache()
    const actual = await read('22')
    assert.equal(actual.account.balance, 0, reason)
    assert.equal(actual.account.balanceSource, 'stored', reason)
    assert.equal(actual.account.balanceFetchedAt, null, 'stored value has no fresh broker timestamp')
    assert.equal(actual.account.brokerSnapshot.reason, reason)
    assert.equal(actual.dailyPacing.balance, 0)
    assert.equal(actual.margin, null)
  }
})

test('known non-USD money cannot return through the legacy stored-balance fallback', async t => {
  const { db, read } = await server(t)
  setState(db, 'acct:22:account_balance_usd', '5000')
  db.prepare('INSERT INTO accounts (account_id, is_live, base_currency) VALUES (?, ?, ?)').run('22', 0, 'EUR')
  let actual = await read('22')
  assert.equal(actual.account.balance, null)
  assert.equal(actual.account.depositCurrency, 'EUR')
  assert.equal(actual.account.isLive, false)
  setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify(snapshot('22', 100, 20, {
    account: { accountId: '22', currency: 'EUR', health: { balance: 100, usedMargin: 20 } },
  })))
  invalidateStateCache()
  actual = await read('22')
  assert.equal(actual.account.brokerSnapshot.reason, 'currency_mismatch')
  assert.equal(actual.account.balance, null)
  assert.equal(actual.account.balanceSource, null)
  assert.equal(actual.dailyPacing.balance, null)
  assert.equal(actual.margin, null)
})
