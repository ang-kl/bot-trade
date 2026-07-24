// node --test agent/services/reconciler.test.js
//
// Unit tests for the cTrader reconciliation service. Uses an in-memory SQLite
// DB to verify position import, close detection, and pending order storage.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { reconcilePositions, syncBrokerOrders } from './reconciler.js'

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

test('adopted position stores trades.volume in LOTS, not raw broker units', () => {
  // Broker volume 10,000,000 (API units×100) = 100,000 units = 1.0 lot EURUSD.
  // The old code stored 100,000 into the lots column, so the aggregate margin
  // gate saw a ~100,000× notional and vetoed every new trade for
  // "insufficient_margin". It must be 1 lot.
  const db = mkDb()
  const setState = mkSetState(db)
  const brokerPos = [makeBrokerPosition({
    positionId: '950', symbolName: 'EURUSD', openPrice: 1.1,
    label: 'AP|v1|FIB|HI|LDN|12h|REGT', volume: 10_000_000,
  })]
  reconcilePositions(db, brokerPos, [], setState)
  const trade = db.prepare(`SELECT volume FROM trades WHERE ctrader_position_id = '950'`).get()
  assert.equal(trade.volume, 1.0, 'stored as 1 lot, not 100000 units')
})

test('self-heal: a legacy units-in-lots-column row is corrected to LOTS on reconcile', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  // A KNOWN position whose trades.volume was written in broker UNITS (100000)
  // by the old adoption bug — the exact state polluting the live margin gate.
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES ('EURUSD','BUY',1.1,100000,'960','autopilot','open',datetime('now'))`
  ).run().lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
      thesis, initial_risk, source, broker_volume_units, status)
     VALUES ('EURUSD', ?, 'long', 1.1, 1.0, 1.2, 'test', 0.1, 'autopilot', 100000, 'active')`
  ).run(tradeId)
  // Broker truth: 1 lot (10,000,000 API).
  reconcilePositions(db, [makeBrokerPosition({ positionId: '960', symbolName: 'EURUSD', openPrice: 1.1, volume: 10_000_000 })], [], setState)
  const trade = db.prepare(`SELECT volume FROM trades WHERE id = ?`).get(tradeId)
  assert.equal(trade.volume, 1.0, 'units 100000 healed to 1 lot')
})

test('self-heal leaves a correctly-sized LOTS row untouched', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { symbol: 'EURUSD', positionId: '970' })  // trades.volume = 0.01 lot
  // Broker truth matches 0.01 lot: 0.01 × 100000 units × 100 = 100000 API.
  reconcilePositions(db, [makeBrokerPosition({ positionId: '970', symbolName: 'EURUSD', openPrice: 1.1, volume: 100000 })], [], setState)
  const trade = db.prepare(`SELECT volume FROM trades WHERE ctrader_position_id = '970'`).get()
  assert.equal(trade.volume, 0.01, 'a correct lots row is not rewritten')
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
  // Owner: "it didn't say what happen" on a manual DOW.US close — a close
  // detected here happened AT THE BROKER, and the ledger now says so
  // instead of leaving the reason blank.
  assert.match(trade.close_reason, /closed at the broker/)
  assert.match(trade.close_reason, /not closed by the bot/)
})

// Orphan sweep — trades left status='open' with NO active monitored row are
// invisible to the closedDetected loop and accumulate forever (live health:
// 85 'open' trades vs 14 monitored positions).
function insertOrphanOpenTrade(db, { symbol = 'GBPUSD', positionId = '555' } = {}) {
  return db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES (?, 'BUY', 1.25, 0.01, ?, 'autopilot', 'open', datetime('now', '-2 days'))`
  ).run(symbol, positionId).lastInsertRowid
}

test('orphan sweep: an open trade whose position is gone at the broker (no monitored row) is closed', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const tradeId = insertOrphanOpenTrade(db, { symbol: 'GBPUSD', positionId: '555' })

  // Broker returns a DIFFERENT live position — 555 is not among them.
  const brokerPos = [makeBrokerPosition({ positionId: '111', symbolName: 'EURUSD' })]
  const result = reconcilePositions(db, brokerPos, [], setState)

  assert.equal(result.orphansClosed.length, 1)
  assert.equal(String(result.orphansClosed[0].positionId), '555')
  const trade = db.prepare(`SELECT status, close_reason, net_pnl FROM trades WHERE id = ?`).get(tradeId)
  assert.equal(trade.status, 'closed')
  assert.match(trade.close_reason, /stale reconcile/)
  // Root cause of the Edge Health gap this closes elsewhere (loop.js +
  // pnl-backfill.js's shouldRunPnlBackfill): this sweep closes the trade with
  // net_pnl left NULL, and does NOT populate closedDetected — only
  // orphansClosed. A trigger that only checks closedDetected.length can
  // never see this trade.
  assert.equal(trade.net_pnl, null)
  assert.equal(result.closedDetected.length, 0)
})

test('orphan sweep: an open trade STILL live at the broker is NOT closed', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const tradeId = insertOrphanOpenTrade(db, { symbol: 'GBPUSD', positionId: '777' })

  // 777 IS among the live broker positions → must stay open.
  const brokerPos = [makeBrokerPosition({ positionId: '777', symbolName: 'GBPUSD' })]
  const result = reconcilePositions(db, brokerPos, [], setState)

  assert.equal(result.orphansClosed.length, 0)
  const trade = db.prepare(`SELECT status FROM trades WHERE id = ?`).get(tradeId)
  assert.equal(trade.status, 'open', 'a live position is never swept')
})

test('orphan sweep: an open trade still awaiting a fill (no position id) is untouched', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES ('EURUSD', 'BUY', 1.1, 0.01, NULL, 'autopilot', 'open', datetime('now'))`
  ).run().lastInsertRowid

  const result = reconcilePositions(db, [], [], setState)
  assert.equal(result.orphansClosed.length, 0)
  const trade = db.prepare(`SELECT status FROM trades WHERE id = ?`).get(tradeId)
  assert.equal(trade.status, 'open', 'a fill-pending trade with no position id is left alone')
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

test('re-adoption guard: a broker position with an existing open trade is RE-LINKED, not duplicated', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  // An open trade for posId 500 exists, but its monitored row was marked closed
  // (a manage cycle deactivated it) — so knownIds no longer contains 500.
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES ('EURUSD','BUY',1.1,0.01,'500','autopilot','open', datetime('now'))`
  ).run().lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, status) VALUES ('EURUSD', ?, 'long', 'closed')`).run(tradeId)

  const brokerPos = [makeBrokerPosition({ positionId: '500', symbolName: 'EURUSD' })]
  const result = reconcilePositions(db, brokerPos, [], setState)

  // NO new trade for posId 500 — still exactly one.
  const trades = db.prepare(`SELECT COUNT(*) c FROM trades WHERE ctrader_position_id = '500'`).get()
  assert.equal(trades.c, 1, 'no duplicate trade inserted')
  assert.equal(result.relinked.length, 1)
  assert.equal(result.relinked[0].desyncKind, 'reactivated_closed_row')
  assert.equal(result.newExternal.length, 0, 'not adopted as new')
  // its monitored row is active again
  const mp = db.prepare(`SELECT status FROM monitored_positions WHERE trade_id = ?`).get(tradeId)
  assert.equal(mp.status, 'active')
})

test('re-adoption guard: the self-heal is audited into action_log, not just silently fixed', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES ('EURUSD','BUY',1.1,0.01,'501','autopilot','open', datetime('now'))`
  ).run().lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, status) VALUES ('EURUSD', ?, 'long', 'closed')`).run(tradeId)

  const brokerPos = [makeBrokerPosition({ positionId: '501', symbolName: 'EURUSD' })]
  reconcilePositions(db, brokerPos, [], setState)

  const row = db.prepare(`SELECT method, path, body FROM action_log WHERE method = 'RECONCILE_DESYNC'`).get()
  assert.ok(row, 'a RECONCILE_DESYNC audit row was written')
  const body = JSON.parse(row.body)
  assert.equal(body.symbol, 'EURUSD')
  assert.equal(body.positionId, '501')
  assert.equal(body.kind, 'reactivated_closed_row')
  assert.match(body.detail, /closed locally while the broker position was still open/)
})

test('re-adoption guard: a bot fill with NO monitored row at all is also audited (missing-row shape)', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  // Trade exists and open, but no monitored_positions row was ever written
  // for it (the "exec response lacked a positionId" bug) — a different
  // desync shape from a wrongly-closed row.
  db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES ('GBPUSD','BUY',1.25,0.01,'502','autopilot','open', datetime('now'))`
  ).run()

  const brokerPos = [makeBrokerPosition({ positionId: '502', symbolName: 'GBPUSD' })]
  const result = reconcilePositions(db, brokerPos, [], setState)

  assert.equal(result.relinked[0].desyncKind, 'created_missing_row')
  const row = db.prepare(`SELECT body FROM action_log WHERE method = 'RECONCILE_DESYNC'`).get()
  const body = JSON.parse(row.body)
  assert.equal(body.kind, 'created_missing_row')
  assert.match(body.detail, /no monitored_positions row at all/)
})

test('dedup sweep: duplicate open trades sharing a posId are collapsed to the newest', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  // Three leaked open trades for the same live position 600.
  for (let i = 0; i < 3; i++) {
    db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status, opened_at) VALUES ('GBPUSD','BUY','600','open', datetime('now'))`).run()
  }
  const brokerPos = [makeBrokerPosition({ positionId: '600', symbolName: 'GBPUSD' })]
  const result = reconcilePositions(db, brokerPos, [], setState)

  const open = db.prepare(`SELECT COUNT(*) c FROM trades WHERE ctrader_position_id='600' AND status='open'`).get()
  assert.equal(open.c, 1, 'only the newest open trade survives')
  assert.equal(result.dupsClosed.length, 2)
  // Duplicates are REJECTED (not closed) so pnl-backfill can never stamp the
  // same broker P&L onto them — the 4x USDIDR double-count bug.
  const rejected = db.prepare(`SELECT close_reason FROM trades WHERE ctrader_position_id='600' AND status='rejected' LIMIT 1`).get()
  assert.match(rejected.close_reason, /duplicate reconcile adoption/)
})

test('broker_orders ledger: reconcile records resting orders as working', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const orders = [
    makeBrokerOrder({ orderId: '101', symbolName: 'XAUUSD', limitPrice: 3350 }),
    makeBrokerOrder({ orderId: '102', symbolName: 'EURUSD', limitPrice: 1.08 }),
  ]
  reconcilePositions(db, [], orders, setState)
  const rows = db.prepare(`SELECT order_id, symbol, status FROM broker_orders ORDER BY order_id`).all()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].status, 'working')
  assert.equal(rows[0].symbol, 'XAUUSD')
})

test('broker_orders ledger: an order that leaves the book is marked gone and reported', () => {
  const db = mkDb()
  // Round 1: two resting orders recorded.
  syncBrokerOrders(db, [
    { orderId: '101', symbolName: 'XAUUSD', side: 'BUY', orderType: 'LIMIT', limitPrice: 3350, volume: 0.2, label: 'AP|v1|VP|-|-|-|-' },
    { orderId: '102', symbolName: 'EURUSD', side: 'SELL', orderType: 'LIMIT', limitPrice: 1.08, volume: 0.1, label: 'manual' },
  ])
  // Round 2: order 101 is gone (filled or cancelled), 102 still resting.
  const gone = syncBrokerOrders(db, [
    { orderId: '102', symbolName: 'EURUSD', side: 'SELL', orderType: 'LIMIT', limitPrice: 1.08, volume: 0.1, label: 'manual' },
  ])
  assert.deepEqual(gone, ['101'])
  const o101 = db.prepare(`SELECT status, gone_at, is_bot FROM broker_orders WHERE order_id = '101'`).get()
  assert.equal(o101.status, 'gone')
  assert.ok(o101.gone_at, 'gone_at stamped')
  assert.equal(o101.is_bot, 1, 'AP-labelled order flagged as ours')
  const o102 = db.prepare(`SELECT status, is_bot FROM broker_orders WHERE order_id = '102'`).get()
  assert.equal(o102.status, 'working')
  assert.equal(o102.is_bot, 0, 'manual order not flagged as bot')
})

test('broker_orders ledger: a re-appearing order flips back to working (gone_at cleared)', () => {
  const db = mkDb()
  syncBrokerOrders(db, [{ orderId: '101', symbolName: 'XAUUSD', side: 'BUY', orderType: 'LIMIT', limitPrice: 3350 }])
  syncBrokerOrders(db, []) // gone
  syncBrokerOrders(db, [{ orderId: '101', symbolName: 'XAUUSD', side: 'BUY', orderType: 'LIMIT', limitPrice: 3350 }]) // back
  const o = db.prepare(`SELECT status, gone_at FROM broker_orders WHERE order_id = '101'`).get()
  assert.equal(o.status, 'working')
  assert.equal(o.gone_at, null)
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

// --- duplicate-P&L repair (owner: 4 identical USDIDR cards, -$487.76 each,
// reading as ~$2k of losses from ONE real broker position) -----------------

test('dedup sweep marks extra open rows for one positionId as REJECTED, not closed', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  // Three open trades all claiming broker position 42 (pre-guard garbage).
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
       VALUES ('USDIDR', 'BUY', 17947, 0.76, '42', 'external', 'open', datetime('now'))`
    ).run()
  }
  // Position 42 is still live at the broker.
  reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'USDIDR' })], [], setState)
  const byStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM trades GROUP BY status`).all()
  const rejected = byStatus.find(r => r.status === 'rejected')
  const open = byStatus.find(r => r.status === 'open')
  assert.equal(rejected?.n, 2)  // duplicates rejected — never eligible for P&L backfill
  assert.equal(open?.n, 1)      // the newest row stays open and managed
})

test('repair: closed duplicates sharing one positionId + identical net_pnl keep only the original', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  // Four closed rows, same position, same stamped P&L — the double-counting
  // signature (each -487.76 was ONE real loss backfilled onto every row).
  for (let i = 0; i < 4; i++) {
    db.prepare(
      `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, closed_at, net_pnl)
       VALUES ('USDIDR', 'BUY', 17947, 0.76, '42', 'external', 'closed', datetime('now'), datetime('now'), -487.76)`
    ).run()
  }
  // A legitimate closed trade on another position must be untouched.
  db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, closed_at, net_pnl)
     VALUES ('EURUSD', 'BUY', 1.1, 0.1, '77', 'autopilot', 'closed', datetime('now'), datetime('now'), 25.5)`
  ).run()
  reconcilePositions(db, [], [], setState)
  const usdidr = db.prepare(`SELECT status, net_pnl FROM trades WHERE symbol='USDIDR' ORDER BY id`).all()
  assert.equal(usdidr.filter(r => r.status === 'closed').length, 1)   // original kept
  assert.equal(usdidr.filter(r => r.status === 'rejected').length, 3) // dupes out of every stat
  const eur = db.prepare(`SELECT status FROM trades WHERE symbol='EURUSD'`).get()
  assert.equal(eur.status, 'closed')
  // Idempotent: a second pass changes nothing further.
  reconcilePositions(db, [], [], setState)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE status='rejected'`).get().n, 3)
})

// ---------------------------------------------------------------------------
// M2 per-account scoping — one account's broker snapshot must never judge
// another account's rows.
// ---------------------------------------------------------------------------

function seedAccountPosition(db, { account, symbol, positionId }) {
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, account_id, status, opened_at)
     VALUES (?, 'BUY', 100, 0.01, ?, 'autopilot', ?, 'open', datetime('now'))`
  ).run(symbol, positionId, account).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, thesis, source, account_id, status)
     VALUES (?, ?, 'long', 100, 'test', 'autopilot', ?, 'active')`
  ).run(symbol, tradeId, account)
  return tradeId
}

test('contamination: account B empty snapshot never closes account A positions', () => {
  const db = mkDb()
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', 'A')`).run()
  const aTrade = seedAccountPosition(db, { account: 'A', symbol: 'XAUUSD', positionId: '42' })
  // B has nothing at the broker — an EMPTY snapshot scoped to B.
  const res = reconcilePositions(db, [], [], mkSetState(db), { accountId: 'B' })
  assert.equal(res.closedDetected.length, 0)
  assert.equal((res.orphansClosed || []).length, 0)
  assert.equal(db.prepare(`SELECT status FROM trades WHERE id = ?`).get(aTrade).status, 'open',
    'account A trade must survive account B reconcile')
  assert.equal(db.prepare(`SELECT status FROM monitored_positions WHERE trade_id = ?`).get(aTrade).status, 'active')
  // …while A's own empty snapshot DOES close it (its position is truly gone).
  const resA = reconcilePositions(db, [], [], mkSetState(db), { accountId: 'A' })
  assert.equal(resA.closedDetected.length, 1)
  assert.equal(db.prepare(`SELECT status FROM trades WHERE id = ?`).get(aTrade).status, 'closed')
})

test('contamination: legacy NULL-account rows belong to the SELECTED account only', () => {
  const db = mkDb()
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', 'A')`).run()
  const legacy = seedKnownPosition(db, { symbol: 'US30', positionId: '77' }) // account_id NULL
  // B's sweep must not touch the legacy row…
  reconcilePositions(db, [], [], mkSetState(db), { accountId: 'B' })
  assert.equal(db.prepare(`SELECT status FROM trades WHERE id = ?`).get(legacy).status, 'open')
  // …the selected account A owns it.
  const resA = reconcilePositions(db, [], [], mkSetState(db), { accountId: 'A' })
  assert.equal(resA.closedDetected.length, 1)
})

test('contamination: adoption stamps the sweep account on BOTH rows', () => {
  const db = mkDb()
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', 'A')`).run()
  reconcilePositions(db, [makeBrokerPosition({ positionId: '900', symbolName: 'EURUSD' })], [], mkSetState(db), { accountId: 'B' })
  const t = db.prepare(`SELECT account_id FROM trades WHERE ctrader_position_id = '900'`).get()
  const m = db.prepare(`SELECT mp.account_id FROM monitored_positions mp JOIN trades t ON t.id = mp.trade_id WHERE t.ctrader_position_id = '900'`).get()
  assert.equal(t.account_id, 'B')
  assert.equal(m.account_id, 'B')
})

test('contamination: broker_orders gone-sweep is account-scoped', () => {
  const db = mkDb()
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', 'A')`).run()
  // A has a working order; B's empty snapshot must not mark it gone.
  syncBrokerOrders(db, [{ orderId: '500', symbolName: 'EURUSD', side: 'BUY', orderType: 'LIMIT' }], { accountId: 'A', includeNull: true })
  syncBrokerOrders(db, [], { accountId: 'B', includeNull: false })
  assert.equal(db.prepare(`SELECT status FROM broker_orders WHERE order_id = '500'`).get().status, 'working')
  // A's own empty snapshot does.
  const gone = syncBrokerOrders(db, [], { accountId: 'A', includeNull: true })
  assert.deepEqual(gone, ['500'])
})
