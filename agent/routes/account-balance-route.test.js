import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from './actions.js'
import stateRouter from './state.js'
import { accountInputDraft, editAccountInput, accountInputPatch } from '../../src/lib/account-input-draft.js'

async function server(t) {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  app.use('/state', stateRouter(db))
  const http = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  t.after(() => new Promise(resolve => http.close(() => { db.close(); resolve() })))
  const url = `http://127.0.0.1:${http.address().port}`
  for (const id of ['11', '22']) db.prepare('INSERT INTO accounts (account_id, base_currency) VALUES (?, ?)').run(id, 'USD')
  return {
    db,
    post: async body => {
      const r = await fetch(url + '/actions/balance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json() }
    },
    read: id => fetch(url + `/state/risk-full?account=${id}`).then(r => r.json()),
  }
}

test('saving an explicit account updates only its own sizing inputs and reads back the saved value', async t => {
  const { db, post, read } = await server(t)
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'account_balance_usd', '900000')
  setState(db, 'account_leverage', '999')
  setState(db, 'acct:11:account_balance_usd', '900000')
  setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify({ fetchedAt: new Date().toISOString(), account: { accountId: '22', currency: 'USD', health: { balance: 500 } } }))
  await read('22') // populate the route cache before the write
  const result = await post({ accountId: '22', balance: 100, leverage: 20 })
  assert.equal(result.status, 200)
  assert.equal(result.body.accountId, '22')
  assert.equal(getState(db, 'acct:22:account_balance_usd'), '100')
  assert.equal(getState(db, 'acct:22:account_leverage'), '20')
  assert.equal(getState(db, 'account_balance_usd'), '900000')
  assert.equal(getState(db, 'account_leverage'), '999')
  assert.equal(getState(db, 'acct:11:account_balance_usd'), '900000')
  const view = await read('22')
  assert.equal(view.account.storedBalance, 100, 'editable stored input reads back even when the broker cache differs')
  assert.equal(view.account.balance, 500, 'broker observation remains separately labelled')
})

test('invalid or unscoped account requests change nothing; validation precedes every write', async t => {
  const { db, post } = await server(t)
  setState(db, 'account_balance_usd', '900000')
  setState(db, 'acct:22:account_balance_usd', '100')
  for (const body of [
    { balance: 200 }, { accountId: 'all', balance: 200 }, { accountId: '33', balance: 200 },
    { accountId: '22', balance: 200, leverage: -1 }, { accountId: '22', balance: null },
    { accountId: '22', balance: '' }, { accountId: '22', balance: true },
    { accountId: '22', clear: true, balance: 200 },
  ]) {
    const r = await post(body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(getState(db, 'acct:22:account_balance_usd'), '100')
    assert.equal(getState(db, 'account_balance_usd'), '900000')
  }
})

test('zero and clear apply only to the named account', async t => {
  const { db, post } = await server(t)
  setState(db, 'acct:11:account_balance_usd', '100')
  assert.equal((await post({ accountId: '22', balance: 0, leverage: 50 })).status, 200)
  assert.equal(getState(db, 'acct:22:account_balance_usd'), '0')
  const r = await post({ accountId: '22', clear: true })
  assert.equal(r.status, 200)
  assert.equal(getState(db, 'acct:22:account_balance_usd'), null)
  assert.equal(getState(db, 'acct:22:account_leverage'), null)
  assert.equal(getState(db, 'acct:11:account_balance_usd'), '100')
})

test('a known non-USD deposit currency cannot be entered as a USD balance', async t => {
  const { db, post } = await server(t)
  db.prepare("UPDATE accounts SET base_currency = 'EUR' WHERE account_id = '22'").run()
  assert.equal((await post({ accountId: '22', balance: 100, leverage: 20 })).status, 400)
  assert.equal(getState(db, 'acct:22:account_leverage'), null, 'rejection is atomic')
  assert.equal((await post({ accountId: '22', leverage: 20 })).status, 200, 'leverage has no money unit')
})

test('a one-field form save preserves the other value refreshed by the broker after load', async t => {
  const { db, post, read } = await server(t)
  setState(db, 'acct:22:account_balance_usd', '100')
  setState(db, 'acct:22:account_leverage', '20')
  const form = accountInputDraft((await read('22')).account)
  setState(db, 'acct:22:account_balance_usd', '75') // independent broker update
  assert.equal((await post(accountInputPatch(editAccountInput(form, 'leverage', 30)))).status, 200)
  assert.equal(getState(db, 'acct:22:account_balance_usd'), '75')
  assert.equal(getState(db, 'acct:22:account_leverage'), '30')
  const reloaded = accountInputDraft((await read('22')).account)
  setState(db, 'acct:22:account_leverage', '50')
  assert.equal((await post(accountInputPatch(editAccountInput(reloaded, 'balance', 0)))).status, 200)
  assert.equal(getState(db, 'acct:22:account_balance_usd'), '0')
  assert.equal(getState(db, 'acct:22:account_leverage'), '50')
})
