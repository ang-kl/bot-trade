import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import stateRouter from './state.js'

test('portfolio Reasons reads include both accounts while explicit account reads keep their population', async t => {
  const db = initDB(':memory:'), token = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  setState(db, 'device_sessions', JSON.stringify({ [token]: Date.now() + 60_000 }))
  setState(db, 'ctrader_account_id', '11')
  const insert = db.prepare(`INSERT INTO trades (account_id,symbol,side,status,entry_price,exit_price,volume,net_pnl,closed_at,label_strategy)
    VALUES (?,'JPN225','SELL','closed',100,90,1,10,datetime('now'),'fib_fx')`)
  for (const id of ['11', '11', '22']) insert.run(id)
  const app = express(); app.use('/state', stateRouter(db))
  const server = app.listen(0)
  t.after(() => { server.close(); db.close() })
  const read = async path => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/state/${path}`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    return response.json()
  }
  for (const endpoint of ['go-live-readiness', 'exit-price-suspects']) {
    const all = await read(`${endpoint}?account=all`), implicit = await read(endpoint), own = await read(`${endpoint}?account=11`)
    assert.equal(all.accountId, null); assert.equal(own.accountId, '11')
    if (endpoint === 'go-live-readiness') {
      assert.equal(all.edge.trades, 3); assert.equal(implicit.edge.trades, 3); assert.equal(own.edge.trades, 2)
    } else {
      assert.equal(all.symbols[0].trades, 3); assert.equal(implicit.symbols[0].trades, 3); assert.equal(own.symbols[0].trades, 2)
    }
  }
  assert.equal(getState(db, 'ctrader_account_id'), '11')
})
