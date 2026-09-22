import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import { recordAccountHistory } from '../services/account-history.js'

test('reporting HTTP routes require registered identity, preserve empty vs missing evidence and prohibit caching', async t => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (11,0)').run()
  const app = express(); app.use('/state', stateRouter(db))
  const server = app.listen(0); await new Promise(r => server.once('listening', r))
  t.after(() => { server.closeAllConnections(); server.close(); db.close() })
  const to = Date.now(), from = to - 3600_000
  const get = path => fetch(`http://127.0.0.1:${server.address().port}/state/${path}`)
  for (const route of ['blocker-report', 'account-history']) {
    assert.equal((await get(`${route}?from=${from}&to=${to}`)).status, 400)
    assert.equal((await get(`${route}?account=22&from=${from}&to=${to}`)).status, 400)
    const response = await get(`${route}?account=11&from=${from}&to=${to}`)
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
    const data = await response.json(); assert.equal(data.accountId, '11'); assert.equal(data.from, from)
    if (route === 'blocker-report') assert.equal(data.totalRecords, 0)
    else { assert.deepEqual(data.points, []); assert.equal(data.equityChange, null) }
  }
  recordAccountHistory(db, { accountId: '11', host: 'demo.ctraderapi.com', source: 'broker_trader', receivedAt: to - 1000, currency: 'SGD', equity: 100 })
  const data = await (await get(`account-history?account=11&from=${from}&to=${to}`)).json()
  assert.equal(data.points.length, 1); assert.equal(data.currency, 'SGD')
  assert.equal(data.equityChange, null); assert.equal(data.sampledDrawdown, null)
})
