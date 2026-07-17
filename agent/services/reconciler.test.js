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

function makeBrokerOrder({ orderId, symbolName, tradeSide = 'BUY', orderType = 'LIMIT', limitPrice = 100, volume = 10000, ...rest }) {
  return {
    orderId,
    tradeData: { orderId, symbolId: 1, tradeSide, volume },
    orderType,
    limitPrice,
    symbolName,
    ...rest,
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

test('ours-labelled broker orphan (no local row) is ADOPTED as a bot position', () => {
  // The bug: a bot fill whose local monitored_positions row was never
  // written (exec returned no positionId) was skipped forever because the
  // label said "ours" — owner saw 4 at the broker, 1 shown.
  const db = mkDb()
  const setState = mkSetState(db)
  const brokerPos = [makeBrokerPosition({
    positionId: '900', symbolName: 'USDJPY', tradeSide: 'BUY', openPrice: 150,
    label: 'AP|v1|FIB|HI|LDN|12h|REGT', volume: 1000,
  })]
  const result = reconcilePositions(db, brokerPos, [], setState)

  assert.equal(result.newExternal.length, 1)
  assert.equal(result.newExternal[0].adopted, true)
  assert.equal(result.newExternal[0].source, 'autopilot')
  const mp = db.prepare(`SELECT * FROM monitored_positions WHERE symbol = 'USDJPY' AND status = 'active'`).get()
  assert.ok(mp, 'adopted position is now tracked')
  assert.equal(mp.source, 'autopilot')       // a BOT position, not observe-only 'external'
  assert.equal(mp.strategy, 'fib_618_fade')
  const trade = db.prepare(`SELECT * FROM trades WHERE ctrader_position_id = '900'`).get()
  assert.equal(trade.source, 'autopilot')
})

test('foreign-labelled broker position is imported observe-only (external)', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const brokerPos = [makeBrokerPosition({ positionId: '901', symbolName: 'NATGAS', label: 'hand-placed', volume: 50000 })]
  const result = reconcilePositions(db, brokerPos, [], setState)
  assert.equal(result.newExternal[0].adopted, false)
  const mp = db.prepare(`SELECT source FROM monitored_positions WHERE symbol = 'NATGAS'`).get()
  assert.equal(mp.source, 'external')
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

test('pending orders: relative SL/TP decoded, closers excluded, updatedAt kept', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const orders = [
    // App-placed BUY LIMIT @ 1.10 with SL 50 pips below, TP 100 pips above,
    // expressed the way cTrader sends them: relative 1/100000-price units.
    makeBrokerOrder({
      orderId: '201', symbolName: 'EURUSD', limitPrice: 1.10,
      relativeStopLoss: 0.005 * 100000, relativeTakeProfit: 0.010 * 100000,
      utcLastUpdateTimestamp: Date.parse('2026-07-17T12:00:00Z'),
    }),
    // Absolute fields win over relative when both are present.
    makeBrokerOrder({
      orderId: '202', symbolName: 'XAUUSD', limitPrice: 3300,
      stopLoss: 3280, takeProfit: 3350, relativeStopLoss: 999,
    }),
    // A closing order (a live position's TP level) is NOT a pending entry.
    makeBrokerOrder({ orderId: '203', symbolName: 'NATGAS', limitPrice: 3.0, closingOrder: true, positionId: 55 }),
  ]

  const result = reconcilePositions(db, [], orders, setState)

  assert.equal(result.pendingOrders.length, 2)
  const eur = result.pendingOrders.find(o => o.orderId === '201')
  assert.equal(eur.sl, 1.095)
  assert.equal(eur.tp, 1.11)
  assert.equal(eur.updatedAt, '2026-07-17T12:00:00.000Z')
  const gold = result.pendingOrders.find(o => o.orderId === '202')
  assert.equal(gold.sl, 3280)
  assert.equal(gold.tp, 3350)
  assert.ok(!result.pendingOrders.some(o => o.orderId === '203'))
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

// ---------------------------------------------------------------------------
// Tamper watch — owner manual changes to tracked positions
// ---------------------------------------------------------------------------

test('tamper watch: first reconcile stamps the baseline without alerting', () => {
  const db = mkDb()
  seedKnownPosition(db, { positionId: '42' })
  const bp = [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', volume: 1000, stopLoss: 99, takeProfit: 110 })]

  const result = reconcilePositions(db, bp, [], mkSetState(db))
  assert.equal(result.manualChanges.length, 0)
  const row = db.prepare(`SELECT * FROM monitored_positions`).get()
  assert.equal(row.broker_volume_units, 10) // 1000/100
  assert.equal(row.broker_sl, 99)
  assert.equal(row.broker_tp, 110)
})

test('tamper watch: manual volume change is flagged after a baseline exists', () => {
  const db = mkDb()
  seedKnownPosition(db, { positionId: '42' })
  const setState = mkSetState(db)
  reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', volume: 1000, stopLoss: 99, takeProfit: 110 })], [], setState)

  // Owner bumps the position from 10 to 50 units in the cTrader app.
  const result = reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', volume: 5000, stopLoss: 99, takeProfit: 110 })], [], setState)
  assert.equal(result.manualChanges.length, 1)
  assert.deepEqual(result.manualChanges[0], { kind: 'volume', symbol: 'XAUUSD', positionId: '42', from: 10, to: 50 })
})

test('tamper watch: manual SL/TP move is flagged and ADOPTED as the managed level', () => {
  const db = mkDb()
  seedKnownPosition(db, { positionId: '42' })
  const setState = mkSetState(db)
  reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', volume: 1000, stopLoss: 99, takeProfit: 110 })], [], setState)

  const result = reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', volume: 1000, stopLoss: 95, takeProfit: 120 })], [], setState)
  assert.equal(result.manualChanges.length, 2)
  assert.equal(result.manualChanges.find(c => c.kind === 'sl_moved').to, 95)
  assert.equal(result.manualChanges.find(c => c.kind === 'tp_moved').to, 120)
  const row = db.prepare(`SELECT * FROM monitored_positions`).get()
  assert.equal(row.current_sl, 95)  // monitor now manages the owner's level
  assert.equal(row.current_tp, 120)
})

test('tamper watch: a BOT amend does not false-alert (broker catches up to current_sl)', () => {
  const db = mkDb()
  seedKnownPosition(db, { positionId: '42' })
  const setState = mkSetState(db)
  reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', volume: 1000, stopLoss: 99, takeProfit: 110 })], [], setState)

  // Bot amends SL to 101 and records it locally FIRST (as executeBrokerAction does)…
  db.prepare(`UPDATE monitored_positions SET current_sl = 101`).run()
  // …then the next reconcile sees the broker at 101 too.
  const result = reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', volume: 1000, stopLoss: 101, takeProfit: 110 })], [], setState)
  assert.equal(result.manualChanges.length, 0)
})

test('tamper watch: a manual REVERSAL flips the managed side and rewrites the thesis', () => {
  const db = mkDb()
  seedKnownPosition(db, { positionId: '42' })
  const setState = mkSetState(db)
  reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', volume: 1000, stopLoss: 99, takeProfit: 110 })], [], setState)

  // Owner reverses: netting account flips the same position to SELL at 102.
  const result = reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', tradeSide: 'SELL', openPrice: 102, volume: 1000, stopLoss: 104, takeProfit: 96 })], [], setState)
  const rev = result.manualChanges.find(c => c.kind === 'reversed')
  assert.ok(rev)
  assert.equal(rev.from, 'long')
  assert.equal(rev.to, 'short')
  const row = db.prepare(`SELECT * FROM monitored_positions`).get()
  assert.equal(row.side, 'short')
  assert.equal(row.entry_price, 102)
  assert.equal(row.current_sl, 104)
  assert.equal(row.current_tp, 96)
  assert.match(row.thesis, /MANUAL REVERSAL/)
})
