// node --test agent/routes/balance-currency-routes.test.js
//
// C·1 (02-10-2026): routes that carry a stored balance also name its unit, from
// the broker-verified deposit currency. Additive: every value is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import { recordAccountMoney, recordDepositCurrency } from '../services/account-money.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ db, close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` }))
  })
}
const get = async (s, p) => (await fetch(s.url(p))).json()
function seed(db) {
  const host = 'live.ctraderapi.com'
  const T = Date.now() - 60_000
  for (const id of ['11', '22']) db.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, 1, 1, 'active')`).run(id)
  recordDepositCurrency(db, { accountId: '11', host, depositAssetId: '14', currency: 'SGD', receivedAt: T })
  recordAccountMoney(db, { accountId: '11', host, trader: { depositAssetId: 14, moneyDigits: 2 }, balance: 51.41, receivedAt: T })
  setState(db, 'acct:11:account_balance_usd', '51.41')
  setState(db, 'acct:22:account_balance_usd', '500')   // no broker evidence for 22
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'account_balance_usd', '51.41')
}

test('/state/health names the unit of the selected account\'s balance and keeps the value', async () => {
  const s = await server()
  try {
    seed(s.db)
    const body = await get(s, '/state/health')
    assert.equal(body.broker.balance, 51.41, 'value unchanged')
    assert.equal(body.broker.balanceCurrency, 'SGD')
  } finally { s.close() }
})

test('/state/risk-config derived balance names its unit; an account with no broker evidence is null, not USD', async () => {
  const s = await server()
  try {
    seed(s.db)
    const sgd = await get(s, '/state/risk-config?account=11')
    assert.equal(sgd.derived.balance, 51.41)
    assert.equal(sgd.derived.balanceCurrency, 'SGD')
    const unknown = await get(s, '/state/risk-config?account=22')
    assert.equal(unknown.derived.balance, 500)
    assert.equal(unknown.derived.balanceCurrency, null)
  } finally { s.close() }
})

test('/state/perf-ledger and /state/profit-ratchet name the unit beside the balance', async () => {
  const s = await server()
  try {
    seed(s.db)
    const ledger = await get(s, '/state/perf-ledger?account=11')
    assert.equal(ledger.balance, 51.41)
    assert.equal(ledger.balanceCurrency, 'SGD')
    const ratchet = await get(s, '/state/profit-ratchet')
    const row = (ratchet.accounts || []).find(a => a.accountId === '11')
    assert.ok(row, JSON.stringify(ratchet).slice(0, 200))
    assert.equal(row.balanceCurrency, 'SGD')
    assert.equal((ratchet.accounts || []).find(a => a.accountId === '22').balanceCurrency, null)
  } finally { s.close() }
})
