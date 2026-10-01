// node --test agent/routes/broker-orders-scope.test.js
//
// GET /state/broker-orders?account=X used to answer with the shared snapshot,
// which is whichever account reconciled last: on 01-10-2026 it showed live
// …3489 with no pending orders while that account held a BTC limit the
// margin pool was counting. A named account now reads its own rows from the
// broker_orders ledger; no account named keeps the snapshot.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'

async function server() {
  const db = initDB(':memory:')
  for (const id of ['42993489', '47790949']) db.prepare('INSERT INTO accounts (account_id, enabled) VALUES (?, 1)').run(id)
  setState(db, 'ctrader_account_id', '47790949')
  // The shared snapshot holds the selected account's (empty) book.
  setState(db, 'broker_pending_orders_json', '[]')
  const ins = db.prepare(`INSERT INTO broker_orders (order_id, symbol, side, order_type, volume, limit_price, account_id, status, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
  ins.run('333512466', 'BTCUSD', 'BUY', 'LIMIT', 0.05, 44252.71, '42993489', 'working')
  ins.run('358927828', 'Cocoa', 'BUY', 'STOP', 1, null, '47790949', 'gone')
  const app = express(); app.use('/state', stateRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ close: () => s.close(), get: p => fetch(`http://127.0.0.1:${s.address().port}/state${p}`).then(r => r.json()) }))
  })
}

test("a named account reads its own working orders, not the last reconcile's snapshot", async () => {
  const s = await server()
  try {
    const live = await s.get('/broker-orders?account=42993489')
    assert.equal(live.pendingOrdersScoped, true)
    assert.equal(live.pendingOrdersSource, 'broker_orders')
    assert.deepEqual(live.pendingOrders.map(o => [o.orderId, o.symbolName, o.limitPrice]), [['333512466', 'BTCUSD', 44252.71]])
    const demo = await s.get('/broker-orders?account=47790949')
    assert.deepEqual(demo.pendingOrders, [], 'a gone order is not a working one')
  } finally { s.close() }
})

test('no account named: the snapshot answers, as before', async () => {
  const s = await server()
  try {
    const all = await s.get('/broker-orders?account=all')
    assert.equal(all.pendingOrdersScoped, false)
    assert.equal(all.pendingOrdersSource, 'snapshot')
    assert.deepEqual(all.pendingOrders, [])
  } finally { s.close() }
})
