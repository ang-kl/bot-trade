import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { accountMoney, recordAccountMoney, recordDepositCurrency } from './account-money.js'

const T = Date.parse('2026-09-22T09:00:00Z')
const host = 'demo.ctraderapi.com'
const currency = (db, accountId = '11', ccy = 'USD', extra = {}) => recordDepositCurrency(db, {
  accountId, host, depositAssetId: '1', currency: ccy, receivedAt: T, ...extra,
})
const money = (db, accountId = '11', extra = {}) => recordAccountMoney(db, {
  accountId, host, trader: { depositAssetId: 1, moneyDigits: 2 }, balance: 100, receivedAt: T, ...extra,
})

test('native amounts stay in their own currency; USD requires the matching broker asset', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  currency(db, '11', 'EUR'); currency(db, '22', 'USD')
  money(db, '11'); money(db, '22', { balance: 0 })
  assert.equal(accountMoney(db, '11', { now: T }).observation.balance, 100)
  assert.equal(accountMoney(db, '11', { now: T }).observation.currency, 'EUR')
  assert.equal(accountMoney(db, '11', { now: T }).balanceUsd, null)
  assert.equal(accountMoney(db, '22', { now: T }).balanceUsd, 0)
  assert.equal(getState(db, 'acct:11:account_balance_usd'), null, 'does not change risk inputs')
})

test('same asset ID on another account or host does not confer currency evidence', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  currency(db)
  for (const [id, extra] of [['22', {}], ['11', { host: 'live.ctraderapi.com' }], ['11', { trader: { depositAssetId: 2 } }]]) {
    money(db, id, extra)
    assert.equal(accountMoney(db, id, { now: T }).reason, 'deposit_currency_unverified')
  }
  assert.equal(recordAccountMoney(db, { accountId: '11', host, trader: { ctidTraderAccountId: 22 }, balance: 300, receivedAt: T }), false)
})

test('metadata received after the balance does not renew the balance receipt time', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  currency(db, '11', 'USD', { receivedAt: T + 5000 })
  money(db)
  assert.equal(accountMoney(db, '11', { now: T + 5000 }).ageMs, 5000)
  assert.equal(accountMoney(db, '11', { now: T + 5000 }).observation.sourceTimestamp, null)
  assert.equal(accountMoney(db, '11', { now: T }).reason, 'money_observation_future')
  assert.equal(accountMoney(db, '11', { now: T + 900_000 }).status, 'stale')
  assert.equal(accountMoney(db, '11', { now: T + 900_000 }).balanceUsd, null)
})

test('unknown, invalid and future evidence never become zero or another account balance', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'account_balance_usd', '9999')
  assert.equal(accountMoney(db, '11', { now: T }).status, 'unavailable')
  currency(db); money(db, '11', { balance: null })
  assert.equal(accountMoney(db, '11', { now: T }).reason, 'balance_unavailable')
  money(db, '11', { receivedAt: T + 1 })
  assert.equal(accountMoney(db, '11', { now: T }).status, 'unavailable')
  const invalid = JSON.parse(getState(db, 'acct:11:money_observation_json'))
  setState(db, 'acct:11:money_observation_json', JSON.stringify({ ...invalid, receivedAt: T, balance: '100' }))
  assert.equal(accountMoney(db, '11', { now: T }).status, 'unavailable')
  assert.equal(recordDepositCurrency(db, { accountId: '11', host, depositAssetId: '1', currency: 'US Dollar' }), false)
})
