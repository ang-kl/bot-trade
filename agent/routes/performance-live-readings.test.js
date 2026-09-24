import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'
import { recordAccountMoney, recordDepositCurrency } from '../services/account-money.js'

test('HTTP readings keep all roster accounts, bypass stale cache and validate reporting timezone', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const id of ['11', '22']) db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(?,0)').run(id)
  const app = express(); app.use('/state', stateRouter(db)); app.use('/actions', actionsRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const get = path => fetch(url + path)
  const a = await (await get('/state/account-overview?account=22')).json()
  assert.deepEqual(a.accounts.map(a => a.accountId), ['11', '22'])
  assert.equal(a.accounts[0].balance, null)
  recordDepositCurrency(db, { accountId: '11', host: 'demo.ctraderapi.com', depositAssetId: '1', currency: 'USD' })
  recordAccountMoney(db, { accountId: '11', host: 'demo.ctraderapi.com', trader: { depositAssetId: '1' }, balance: 0 })
  const r = await get('/state/account-overview?account=22')
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal((await r.json()).accounts[0].balance, 0)
  assert.equal((await get('/state/performance-populations?timeZone=bad')).status, 400)
  const local = await (await get('/state/performance-populations?timeZone=Asia%2FSingapore')).json()
  assert.equal(local.timeZone, 'Asia/Singapore')
  assert.equal((await get('/actions/stream-prices?symbols=ETHUSD&account=all')).status, 400)
  assert.equal((await get('/actions/stream-prices?symbols=ETHUSD&account=99')).status, 400)
  setState(db, 'ctrader_account_id', '22')
  assert.equal((await (await get('/state/account-overview')).json()).accounts[0].balance, 0)
})
