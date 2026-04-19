// node --test agent/services/reconciler.test.js
//
// Unit tests for the cTrader reconciliation service. Uses an in-memory SQLite
// DB to verify position import, close detection, and pending order storage.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { reconcilePositions } from './reconciler.js'

function mkDb() {
  return initDB(':memory:')
}

function mkSetState(db) {
  return (key, value) => {
    db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)').run(key, value)
  }
}

function makeBrokerPosition({ positionId, symbolName, tradeSide = 'BUY', openPrice = 100, volume = 10000, label = '', stopLoss = null, takeProfit = null }) {
  return {
    positionId,
    tradeData: { positionId, symbolId: 1, tradeSide, openPrice, volume, label },
    price: openPrice,
    stopLoss,
    takeProfit,
    symbolName,
    label,
  }
}

function makeBrokerOrder({ orderId, symbolName, tradeSide = 'BUY', orderType = 'LIMIT', limitPrice = 100, volume = 10000 }) {
  return {
    orderId,
    tradeData: { orderId, symbolId: 1, tradeSide, volume },
    orderType,
    limitPrice,
    symbolName,
  }
}

function seedKnownPosition(db, { symbol = 'XAUUSD', positionId = '42', source = 'autopilot' }) {
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES (?, 'BUY', 100, 0.01, ?, ?, 'open', datetime('now'))`
  ).run(symbol, positionId, source).lastInsertRowid

  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
      thesis, initial_risk, source, status)
     VALUES (?, ?, 'long', 100, 99, 110, 'test', 1, ?, 'active')`
  ).run(symbol, tradeId, source)

  return tradeId
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('new external position detected and inserted', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const brokerPos = [makeBrokerPosition({ positionId: '999', symbolName: 'BTCUSD', openPrice: 90000, stopLoss: 88000 })]

  const result = reconcilePositions(db, brokerPos, [], setState)

  assert.equal(result.newExternal.length, 1)
  assert.equal(result.newExternal[0].symbol, 'BTCUSD')
  assert.equal(result.newExternal[0].positionId, '999')

  const trade = db.prepare(`SELECT * FROM trades WHERE ctrader_position_id = '999'`).get()
  assert.ok(trade, 'trade row inserted')
  assert.equal(trade.source, 'external')
  assert.equal(trade.status, 'open')
  assert.equal(trade.entry_price, 90000)

  const mp = db.prepare(`SELECT * FROM monitored_positions WHERE trade_id = ?`).get(trade.id)
  assert.ok(mp, 'monitored_position row inserted')
  assert.equal(mp.source, 'external')
  assert.equal(mp.status, 'active')
  assert.equal(mp.initial_risk, 2000)
})

test('known autopilot position NOT duplicated', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { symbol: 'XAUUSD', positionId: '42' })

  const brokerPos = [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', label: 'AP|v1|TREND|HI|LDN|H1|REGT' })]
  const result = reconcilePositions(db, brokerPos, [], setState)

  assert.equal(result.newExternal.length, 0, 'should not duplicate known positions')
  const trades = db.prepare(`SELECT * FROM trades WHERE ctrader_position_id = '42'`).all()
  assert.equal(trades.length, 1, 'still just one trade row')
})

test('closed position detection marks status=closed', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { symbol: 'EURUSD', positionId: '77' })

  // Broker returns empty — the position was closed externally
  const result = reconcilePositions(db, [], [], setState)

  assert.equal(result.closedDetected.length, 1)
  assert.equal(result.closedDetected[0].positionId, '77')

  const mp = db.prepare(`SELECT * FROM monitored_positions WHERE source = 'autopilot'`).get()
  assert.equal(mp.status, 'closed')

  const trade = db.prepare(`SELECT * FROM trades WHERE ctrader_position_id = '77'`).get()
  assert.equal(trade.status, 'closed')
  assert.ok(trade.closed_at, 'closed_at timestamp set')
})

test('pending orders stored in agent_state', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const orders = [
    makeBrokerOrder({ orderId: '101', symbolName: 'XAUUSD', limitPrice: 3350 }),
    makeBrokerOrder({ orderId: '102', symbolName: 'EURUSD', limitPrice: 1.08 }),
  ]

  const result = reconcilePositions(db, [], orders, setState)

  assert.equal(result.pendingOrders.length, 2)
  const stored = JSON.parse(getState(db, 'broker_pending_orders_json'))
  assert.equal(stored.length, 2)
  assert.equal(stored[0].symbolName, 'XAUUSD')
})

test('external position with SL computes initial_risk', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const brokerPos = [makeBrokerPosition({
    positionId: '555',
    symbolName: 'EURUSD',
    openPrice: 1.1000,
    stopLoss: 1.0950,
    tradeSide: 'BUY',
  })]

  reconcilePositions(db, brokerPos, [], setState)

  const mp = db.prepare(`SELECT * FROM monitored_positions WHERE source = 'external'`).get()
  assert.ok(mp, 'external position created')
  assert.ok(Math.abs(mp.initial_risk - 0.005) < 1e-9, `initial_risk should be 0.005, got ${mp.initial_risk}`)
})

test('reconcile timestamp stored', () => {
  const db = mkDb()
  const setState = mkSetState(db)

  reconcilePositions(db, [], [], setState)

  const ts = getState(db, 'last_reconcile_at')
  assert.ok(ts, 'last_reconcile_at should be set')
  assert.ok(new Date(ts).getTime() > 0, 'should be a valid ISO timestamp')
})
