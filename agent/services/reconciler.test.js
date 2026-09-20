// node --test agent/services/reconciler.test.js
//
// Unit tests for the cTrader reconciliation service. Uses an in-memory SQLite
// DB to verify position import, close detection, and pending order storage.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { reconcilePositions, syncBrokerOrders, reclassifyBrokerCloses, decodeRawBrokerOrder, repairMisfiledOwnPositions, undoIntentUpgrades, attributeBrokerClose } from './reconciler.js'

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

// ---------------------------------------------------------------------------
// reclassifyBrokerCloses — generic broker-close stamps upgrade to a real
// cause once the broker-true exit price is known (owner: "Pipeline
// integrity = 0% — investigate", 2026-07-27).
// ---------------------------------------------------------------------------

const GENERIC = 'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot'

function seedClosedTrade(db, { side = 'BUY', exit = null, sl = null, tp = null, reason = GENERIC }) {
  return db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, closed_at,
       exit_price, sl_price, tp_price, close_reason)
     VALUES ('EURUSD', ?, 100, 0.01, 'closed', datetime('now'), datetime('now'), ?, ?, ?, ?)`
  ).run(side, exit, sl, tp, reason).lastInsertRowid
}

test('reclassify: exit at the TP level becomes a TP fill', () => {
  const db = mkDb()
  const id = seedClosedTrade(db, { exit: 110.005, sl: 99, tp: 110 }) // within 0.1%
  const n = reclassifyBrokerCloses(db)
  assert.equal(n, 1)
  assert.match(db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason, /take profit hit/)
})

test('reclassify: exit at the SL level becomes an SL fill', () => {
  const db = mkDb()
  const id = seedClosedTrade(db, { exit: 99.02, sl: 99, tp: 110 })
  reclassifyBrokerCloses(db)
  assert.match(db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason, /stop loss hit/)
})

test('reclassify: long exit far BELOW the SL flags gap/liquidation', () => {
  const db = mkDb()
  const id = seedClosedTrade(db, { side: 'BUY', exit: 95, sl: 99, tp: 110 })
  reclassifyBrokerCloses(db)
  assert.match(db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason, /beyond the SL/)
})

test('reclassify: mid-range exit keeps the generic stamp (honest manual residual)', () => {
  const db = mkDb()
  const id = seedClosedTrade(db, { exit: 104, sl: 99, tp: 110 })
  const n = reclassifyBrokerCloses(db)
  assert.equal(n, 0)
  assert.equal(db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason, GENERIC)
})

test('reclassify: a bot-written close_reason is never overwritten', () => {
  const db = mkDb()
  const id = seedClosedTrade(db, { exit: 110, sl: 99, tp: 110, reason: 'time_cap_expired (6h)' })
  const n = reclassifyBrokerCloses(db)
  assert.equal(n, 0)
  assert.equal(db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason, 'time_cap_expired (6h)')
})

test('reclassify: no exit price yet — row left for a later pass', () => {
  const db = mkDb()
  const id = seedClosedTrade(db, { exit: null, sl: 99, tp: 110 })
  assert.equal(reclassifyBrokerCloses(db), 0)
  assert.equal(db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason, GENERIC)
})

test('reclassify: short exit ABOVE the SL flags gap/liquidation', () => {
  const db = mkDb()
  const id = seedClosedTrade(db, { side: 'SELL', exit: 103, sl: 101, tp: 95 })
  reclassifyBrokerCloses(db)
  assert.match(db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason, /beyond the SL/)
})

// ---------------------------------------------------------------------------
// LEDGER CONVERGENCE. The adoption branch reacts to a broker-side CHANGE
// (`differs(bSl, row.broker_sl)`), so a ledger that drifts while the broker's
// stop then sits still was never repaired — and protection_audit logged
// POSITION_STOP_MISMATCH on that row every loop cycle, forever.
// ---------------------------------------------------------------------------

const slOf = (db, positionId) => db.prepare(
  `SELECT mp.current_sl AS sl, mp.current_tp AS tp, mp.broker_sl AS bsl, mp.broker_tp AS btp
     FROM monitored_positions mp JOIN trades t ON t.id = mp.trade_id
    WHERE t.ctrader_position_id = ?`).get(positionId)


test('convergence: a standing disagreement is adopted on the SECOND sighting', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { positionId: '77' })           // ledger sl 99, tp 110
  const bp = () => [makeBrokerPosition({ positionId: '77', symbolName: 'XAUUSD', stopLoss: 95, takeProfit: 110 })]

  // Pass 1 only remembers the disagreement. Converging here could revert a
  // stop the bot had just tightened but the broker had not yet applied.
  const r1 = reconcilePositions(db, bp(), [], setState)
  assert.deepEqual(r1.ledgerSynced, [], 'never converges on first sighting')
  assert.equal(slOf(db, '77').sl, 99, 'ledger untouched')
  assert.equal(slOf(db, '77').bsl, 95, 'but broker truth is on record')

  // Pass 2: identical disagreement, so it is standing, not in flight. Under
  // the old rule `differs(95, 95)` was false and this row stayed wrong for
  // the life of the position while protection_audit logged it every cycle.
  const r2 = reconcilePositions(db, bp(), [], setState)
  assert.deepEqual(r2.ledgerSynced, [{ kind: 'sl_resync', symbol: 'XAUUSD', positionId: '77', from: 99, to: 95 }])
  assert.equal(slOf(db, '77').sl, 95, 'ledger converged on broker truth')

  // And it settles — nothing left to report once they agree.
  assert.deepEqual(reconcilePositions(db, bp(), [], setState).ledgerSynced, [])
})

test('convergence: an IN-FLIGHT amend is never clobbered', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { positionId: '79' })
  const atBroker = (sl) => [makeBrokerPosition({ positionId: '79', symbolName: 'XAUUSD', stopLoss: sl, takeProfit: 110 })]

  // Ledger and broker agree at 99. The keeper then ratchets to 103 and the
  // broker has not applied it yet when the next snapshot is taken.
  reconcilePositions(db, atBroker(99), [], setState)
  db.prepare(`UPDATE monitored_positions SET current_sl = 103
              WHERE trade_id IN (SELECT id FROM trades WHERE ctrader_position_id = '79')`).run()
  const r = reconcilePositions(db, atBroker(99), [], setState)
  assert.deepEqual(r.ledgerSynced, [], 'first sighting of this disagreement — only remembered')
  assert.equal(slOf(db, '79').sl, 103, 'the tightened stop survives')

  // The amend lands before the next reconcile. Broker and ledger agree, the
  // watch entry clears, and nothing was ever reverted.
  const r2 = reconcilePositions(db, atBroker(103), [], setState)
  assert.deepEqual(r2.ledgerSynced, [])
  assert.equal(slOf(db, '79').sl, 103)
  assert.equal(JSON.parse(getState(db, 'ledger_resync_watch_json') || '{}')['sl:79'], undefined, 'watch cleared')
})

test('convergence: a resync is NOT reported as a manual change', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { positionId: '78' })
  const bp = () => [makeBrokerPosition({ positionId: '78', symbolName: 'XAUUSD', stopLoss: 95, takeProfit: 110 })]
  reconcilePositions(db, bp(), [], setState)
  const r = reconcilePositions(db, bp(), [], setState)
  // manualChanges means "you moved this at the broker" and drives an alert.
  // Our own stale cache is not that, and must not ring the same bell.
  assert.deepEqual(r.manualChanges, [])
  assert.equal(r.ledgerSynced.length, 1)
})

test('convergence: a genuine manual move still takes the manual-change path', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { positionId: '80' })
  reconcilePositions(db, [makeBrokerPosition({ positionId: '80', symbolName: 'XAUUSD', stopLoss: 99, takeProfit: 110 })], [], setState)
  // Owner drags the stop in the cTrader app: 99 → 97.
  const r = reconcilePositions(db, [makeBrokerPosition({ positionId: '80', symbolName: 'XAUUSD', stopLoss: 97, takeProfit: 110 })], [], setState)
  assert.equal(r.manualChanges.length, 1)
  assert.equal(r.manualChanges[0].kind, 'sl_moved')
  assert.deepEqual(r.ledgerSynced, [], 'not double-counted as a resync')
  assert.equal(slOf(db, '80').sl, 97)
})

test('convergence: the take-profit side behaves the same way', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { positionId: '81' })            // ledger tp 110
  const bp = () => [makeBrokerPosition({ positionId: '81', symbolName: 'XAUUSD', stopLoss: 99, takeProfit: 120 })]
  reconcilePositions(db, bp(), [], setState)
  const r = reconcilePositions(db, bp(), [], setState)
  assert.equal(r.ledgerSynced.length, 1)
  assert.equal(r.ledgerSynced[0].kind, 'tp_resync')
  assert.equal(slOf(db, '81').tp, 120)
})

test('convergence: a CHANGING disagreement never converges', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  seedKnownPosition(db, { positionId: '82' })
  // A stop being walked by the C++ trail engine: a different broker value
  // every pass. Each is a fresh disagreement, so none is ever "standing".
  for (const sl of [95, 96, 97, 98]) {
    const r = reconcilePositions(db, [makeBrokerPosition({ positionId: '82', symbolName: 'XAUUSD', stopLoss: sl, takeProfit: 110 })], [], setState)
    assert.deepEqual(r.ledgerSynced, [], `sl ${sl} must not resync`)
  }
})

// ---------------------------------------------------------------------------
// Production, 2026-08-03: monitored_positions rows carrying `entry_price: null`
// broke two unrelated things — the time cap could not be evaluated (#580) and
// the SL/TP money column reported notional instead of risk (#581). Broker truth
// (`bp.price`) was present on every reconcile pass but was only ever applied
// when the SIDE reversed, so a plain missing entry stayed null forever.
// ---------------------------------------------------------------------------
function seedEntrylessPosition(db, { symbol = 'EURUSD', positionId = '9001', entry = null }) {
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES (?, 'BUY', ?, 0.1, ?, 'autopilot', 'open', datetime('now'))`
  ).run(symbol, entry, positionId).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, source, status)
     VALUES (?, ?, 'long', ?, 'autopilot', 'active')`
  ).run(symbol, tradeId, entry)
  return tradeId
}

test('reconcile BACKFILLS a null entry price from broker truth', () => {
  const db = mkDb()
  const tradeId = seedEntrylessPosition(db, { positionId: '9001', entry: null })

  reconcilePositions(
    db,
    [makeBrokerPosition({ positionId: '9001', symbolName: 'EURUSD', openPrice: 1.0855 })],
    [],
    mkSetState(db),
  )

  const mp = db.prepare('SELECT entry_price FROM monitored_positions WHERE trade_id = ?').get(tradeId)
  assert.equal(mp.entry_price, 1.0855, 'broker truth must fill the gap')
})

test('reconcile NEVER overwrites an entry price it already has', () => {
  const db = mkDb()
  const tradeId = seedEntrylessPosition(db, { positionId: '9002', entry: 1.08 })

  // A later broker snapshot of an averaged or partially-closed position is NOT
  // a better answer to "what did we get in at" than the fill we recorded.
  reconcilePositions(
    db,
    [makeBrokerPosition({ positionId: '9002', symbolName: 'EURUSD', openPrice: 1.0999 })],
    [],
    mkSetState(db),
  )

  const mp = db.prepare('SELECT entry_price FROM monitored_positions WHERE trade_id = ?').get(tradeId)
  assert.equal(mp.entry_price, 1.08, 'a recorded entry is never rewritten')
})

// ---------------------------------------------------------------------------
// decodeRawBrokerOrder — the UNFILTERED read behind /state/broker-orders?fresh=1.
// The filtered snapshot dropped every order carrying a broker-assigned
// positionId (measured 2026-08-26: broker held 4, snapshot []); this decode
// must keep such orders AND surface the fields the filter judged them by.
// ---------------------------------------------------------------------------

test('decodeRawBrokerOrder keeps a positionId-bearing entry order and surfaces identity fields', () => {
  const out = decodeRawBrokerOrder({
    orderId: 356653559,
    positionId: 238000001,
    orderType: 2,
    limitPrice: 363.02,
    tradeData: { symbolId: 42, tradeSide: 2, volume: 8158, label: 'PRE|v1|RSI', comment: 'pending-closed' },
    expirationTimestamp: 1756227642000,
  })
  assert.equal(out.orderId, 356653559)
  assert.equal(out.positionId, 238000001, 'the field the snapshot filter judged by must be visible, not fatal')
  assert.equal(out.side, 'SELL')
  assert.equal(out.orderType, 'LIMIT')
  assert.equal(out.limitPrice, 363.02)
  assert.equal(out.volumeUnits, 81.58)
  assert.equal(out.label, 'PRE|v1|RSI')
  assert.equal(out.comment, 'pending-closed')
  assert.equal(out.expiresAt, new Date(1756227642000).toISOString())
})

test('decodeRawBrokerOrder tolerates a bare STOP order with no tradeData', () => {
  const out = decodeRawBrokerOrder({ orderId: '7', orderType: 3, stopPrice: 38.5 })
  assert.equal(out.orderId, '7')
  assert.equal(out.orderType, 'STOP')
  assert.equal(out.stopPrice, 38.5)
  assert.equal(out.limitPrice, null)
  assert.equal(out.side, null)
  assert.equal(out.volumeUnits, null)
  assert.equal(out.label, '')
})

// ---------------------------------------------------------------------------
// The snapshot's entry-order filter vs the cpp sidecar's verbatim dump.
// Measured 2026-08-26: the broker pre-assigns positionId to resting ENTRY
// orders, and the cpp path dumps that field where the ws path omitted it —
// so filtering on positionId alone blanked the snapshot while the broker
// held 4 orders. closingOrder is authoritative when present; positionId is
// the proxy only when it is not.
// ---------------------------------------------------------------------------

test('snapshot keeps a cpp-path entry order (positionId set, closingOrder false)', () => {
  const db = mkDb()
  reconcilePositions(db, [], [
    makeBrokerOrder({ orderId: '801', symbolName: 'JPM.US', positionId: 238000001, closingOrder: false }),
  ], mkSetState(db))
  const stored = JSON.parse(getState(db, 'broker_pending_orders_json'))
  assert.equal(stored.length, 1, 'an entry order with a broker-assigned positionId must survive the filter')
  assert.equal(String(stored[0].orderId), '801')
})

test('snapshot still drops closing orders on both paths', () => {
  const db = mkDb()
  reconcilePositions(db, [], [
    // cpp path: closingOrder present and true
    makeBrokerOrder({ orderId: '802', symbolName: 'JPM.US', positionId: 238000002, closingOrder: true }),
    // ws path: closingOrder omitted, bound positionId is the only signal
    makeBrokerOrder({ orderId: '803', symbolName: 'JPM.US', positionId: 238000003 }),
  ], mkSetState(db))
  const stored = JSON.parse(getState(db, 'broker_pending_orders_json'))
  assert.equal(stored.length, 0, 'closing orders must not appear as pending entries')
})

// ---------------------------------------------------------------------------
// The pre-open adoption gap (owner "go adoption fix", 29-08-2026): PRE labels
// are OURS — a bot pre-open fill must be adopted and managed, and rows the
// gap already misfiled as external get their real source back.
// ---------------------------------------------------------------------------

test('a PRE-labelled broker orphan is ADOPTED with source preopen, not imported external', () => {
  const db = mkDb()
  const result = reconcilePositions(db, [makeBrokerPosition({
    positionId: '910', symbolName: '0016.HK', tradeSide: 'SELL', openPrice: 125.01,
    label: 'PRE|v1|VP|HI|LDN|4h|-', volume: 2000,
  })], [], mkSetState(db))
  assert.equal(result.newExternal.length, 1)
  assert.equal(result.newExternal[0].adopted, true, 'PRE is placed by this system — adoption, not observation')
  const mp = db.prepare(`SELECT source FROM monitored_positions WHERE symbol = '0016.HK'`).get()
  assert.equal(mp.source, 'preopen', 'the P&L attribution split survives: source stays preopen, not autopilot')
})

test('repairMisfiledOwnPositions upgrades PRE rows stuck as external and leaves manual alone', () => {
  const db = mkDb()
  const seed = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES (?, 'BUY', 100, 1, ?, 'external', 'open', datetime('now'))`)
  const mon = db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
      thesis, initial_risk, source, status, label_raw)
     VALUES (?, ?, 'long', 100, 99, 110, 't', 1, 'external', 'active', ?)`)
  const t1 = seed.run('AAA', '1001').lastInsertRowid
  mon.run('AAA', t1, 'PRE|v1|VP|HI|LDN|4h|-')
  const t2 = seed.run('BBB', '1002').lastInsertRowid
  mon.run('BBB', t2, 'MAN|v1|-|MD|LDN|1h|-')
  const t3 = seed.run('CCC', '1003').lastInsertRowid
  mon.run('CCC', t3, null)

  const n = repairMisfiledOwnPositions(db)
  assert.equal(n, 1, 'exactly the PRE row upgrades')
  assert.equal(db.prepare(`SELECT source FROM monitored_positions WHERE symbol='AAA'`).get().source, 'preopen')
  assert.equal(db.prepare(`SELECT source FROM trades WHERE id=?`).get(t1).source, 'preopen')
  assert.equal(db.prepare(`SELECT source FROM monitored_positions WHERE symbol='BBB'`).get().source, 'external', 'MAN stays external/observe-only')
  assert.equal(db.prepare(`SELECT source FROM monitored_positions WHERE symbol='CCC'`).get().source, 'external', 'no label, no claim')
  assert.equal(repairMisfiledOwnPositions(db), 0, 'idempotent — a second pass finds nothing')
})

test('the first broker stop observed is stamped on the trade once, and never after a break-even move (02-09-2026)', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const tradeId = seedKnownPosition(db, { symbol: 'XAUUSD', positionId: '42' })
  // First pass: the broker holds the stop re-anchored to the fill (98.7, not our 99).
  reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', stopLoss: 98.7, takeProfit: 110 })], [], setState)
  const sl = () => db.prepare('SELECT broker_sl_initial FROM trades WHERE id = ?').get(tradeId).broker_sl_initial
  assert.equal(sl(), 98.7)
  // The stop trails; the initial record does not follow it.
  reconcilePositions(db, [makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', stopLoss: 100.5, takeProfit: 110 })], [], setState)
  assert.equal(sl(), 98.7)

  // A position whose break-even already moved before the first pass gets NO
  // initial stop — a trailed stop is not the risk taken at entry.
  const t2 = seedKnownPosition(db, { symbol: 'EURUSD', positionId: '43' })
  db.prepare('UPDATE monitored_positions SET be_moved = 1 WHERE trade_id = ?').run(t2)
  reconcilePositions(db, [
    makeBrokerPosition({ positionId: '42', symbolName: 'XAUUSD', stopLoss: 100.5 }),
    makeBrokerPosition({ positionId: '43', symbolName: 'EURUSD', stopLoss: 100.2 }),
  ], [], setState)
  assert.equal(db.prepare('SELECT broker_sl_initial FROM trades WHERE id = ?').get(t2).broker_sl_initial, null)
})

test('reclassifyBrokerCloses judges against the broker stop when it is on record', () => {
  const db = mkDb()
  // Proposal stop 29172.77 — an exit at 29253.1 is "beyond the SL" against
  // it, but the broker's stop was 29253.3: an ordinary stop fill.
  db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, exit_price, sl_price, broker_sl_initial, tp_price, close_reason)
    VALUES ('NAS100','SELL','closed', 29135.8, 29253.1, 29172.77142857143, 29253.3, 28000, 'closed at the broker (manual close or broker-side SL/TP fill)')`).run()
  assert.equal(reclassifyBrokerCloses(db), 1)
  assert.match(db.prepare('SELECT close_reason FROM trades').get().close_reason, /^stop loss hit/)
})

// ---------------------------------------------------------------------------
// The dedup sweep and the duplicate-P&L repair were `catch { /* best-effort */ }`
// — a failing sweep returned the same empty `dupsClosed` as a clean one. The
// throw is forced with a trigger so the real transaction is what fails.
// ---------------------------------------------------------------------------
const REJECT_TRIGGER = `CREATE TRIGGER boom BEFORE UPDATE OF status ON trades
  WHEN NEW.status = 'rejected' BEGIN SELECT RAISE(ABORT, 'simulated reject failure'); END`

test('a dedup sweep that throws reports dedupError instead of an empty success', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  for (let i = 0; i < 2; i++) {
    db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status, opened_at) VALUES ('GBPUSD','BUY','700','open', datetime('now'))`).run()
  }
  db.exec(REJECT_TRIGGER)
  const result = reconcilePositions(db, [makeBrokerPosition({ positionId: '700', symbolName: 'GBPUSD' })], [], setState)
  assert.equal(result.dupsClosed.length, 0, 'nothing was rejected — the transaction rolled back')
  assert.match(String(result.dedupError), /simulated reject failure/)
  assert.equal(result.dupPnlError, undefined, 'the other block had nothing to do and must not report')
})

test('a duplicate-P&L repair that throws reports dupPnlError', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  for (let i = 0; i < 2; i++) {
    db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status, net_pnl, opened_at, closed_at)
                VALUES ('GBPUSD','BUY','701','closed', -42.5, datetime('now'), datetime('now'))`).run()
  }
  db.exec(REJECT_TRIGGER)
  const result = reconcilePositions(db, [], [], setState)
  assert.match(String(result.dupPnlError), /simulated reject failure/)
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM trades WHERE status = 'closed' AND ctrader_position_id = '701'`).get().c, 2)
})

test('the loop logs a reconciler block error when the field is present', async () => {
  const { readFileSync } = await import('node:fs')
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const start = loop.indexOf('result.dupsClosed')
  assert.ok(start > 0)
  const slice = loop.slice(start - 200, start + 1500).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(slice, /result\.dedupError/)
  assert.match(slice, /result\.dupPnlError/)
})

test('PR-E M4: an adopted position whose label carries an intent tag is stamped as the bot trade it is — origin, strategy, the approval id and a plan from the intent', async () => {
  const { tagLabelWithIntent } = await import('../lib/trade-labels.js')
  const db = mkDb()
  const ACCT = '46130058'
  const created = '2026-09-11T08:00:00.000Z'
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, checks_json, proposal_json, account_id, created_at) VALUES ('EURUSD','BUY',1,'{}','{}',?, '2026-09-11T07:59:30.000Z')`).run(ACCT)
  const ev = db.prepare(`SELECT id FROM risk_events`).get().id
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, checks_json, proposal_json, account_id, created_at) VALUES ('EURUSD','BUY',0,'{}','{}',?, '2026-09-11T07:59:40.000Z')`).run(ACCT) // a veto is not an approval
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, order_type, volume, sl, tp, producer_id, basis, mode_epoch, permit_id, permit_expires_at, state, created_at, updated_at)
              VALUES ('iabcdefabcdef', ?, 'demo', 'EURUSD', 1, 'BUY', 'MARKET', 1000, 99, 104, 'scan_dispatch', 'bar', 0, 'pabcdefabcdef', ?, 'UNKNOWN', ?, ?)`).run(ACCT, created, created, created)
  const label = tagLabelWithIntent('ap|v1|FIB|H|LN|4h|RG', 'iabcdefabcdef')
  const brokerPos = [makeBrokerPosition({ positionId: 501, symbolName: 'EURUSD', openPrice: 100, stopLoss: 99, label })]
  const result = reconcilePositions(db, brokerPos, [], mkSetState(db), { accountId: ACCT })
  assert.equal(result.newExternal.length, 1)
  assert.deepEqual(result.newExternal[0].stampedFromIntent, { intentId: 'iabcdefabcdef', origin: 'bot_market_dispatch', strategy: 'fib_618_fade', riskEventId: ev })
  const t = db.prepare(`SELECT origin, origin_source, strategy, risk_event_id FROM trades WHERE ctrader_position_id = '501'`).get()
  assert.deepEqual(t, { origin: 'bot_market_dispatch', origin_source: 'write', strategy: 'fib_618_fade', risk_event_id: ev })
  const p = db.prepare(`SELECT * FROM trade_plans WHERE trade_id = (SELECT id FROM trades WHERE ctrader_position_id = '501')`).get()
  assert.equal(p.source, 'reconciler_adopted_intent'); assert.equal(p.planned_entry, 100); assert.equal(p.planned_sl, 99); assert.equal(p.planned_tp, 104); assert.equal(p.strategy, 'fib_618_fade')
  const { findUnreasonedTrades } = await import('./close-completeness.js')
  assert.equal(findUnreasonedTrades(db, { now: Date.parse('2026-09-11T09:00:00Z') }).violations.filter(v => v.tradeId).length, 0, 'the stamped row has every reason')
  // our label, NO intent tag → stays reconciler_adopted and is listed
  const plain = [makeBrokerPosition({ positionId: 502, symbolName: 'EURUSD', openPrice: 100, label: 'ap|v1|FIB|H|LN|4h|RG' })]
  reconcilePositions(db, [...brokerPos, ...plain], [], mkSetState(db), { accountId: ACCT })
  assert.equal(db.prepare(`SELECT origin FROM trades WHERE ctrader_position_id = '502'`).get().origin, 'reconciler_adopted')
  const v = findUnreasonedTrades(db, { now: Date.parse('2026-09-11T09:00:00Z') })
  assert.deepEqual(v.violations.filter(x => x.tradeId).map(x => x.kind), ['adopted_ours_unreasoned'])
})

// ---------------------------------------------------------------------------
// fix-the-exits BA (18-09-2026): a close the bot performed is attributed to
// its closer from the position_events journal (or the momentum book's
// exit_sent row) when the reconciler sees the position gone. Measured before
// the fix on …0949: 11 of 18 "closed at the broker" rows were bot closes.
// ---------------------------------------------------------------------------

test('BA: a close the profit keeper journalled is attributed to it, not stamped generic', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const tradeId = seedKnownPosition(db, { symbol: 'DOW.US', positionId: '5101' })
  db.prepare(`INSERT INTO position_events (position_id, trade_id, symbol, kind, reason, source) VALUES ('5101', ?, 'DOW.US', 'close', 'chandelier breach at 29.60', 'profit_keeper')`).run(tradeId)
  reconcilePositions(db, [], [], setState)
  const t = db.prepare(`SELECT status, close_reason FROM trades WHERE id = ?`).get(tradeId)
  assert.equal(t.status, 'closed')
  assert.equal(t.close_reason, 'profit_keeper: chandelier breach at 29.60')
  assert.doesNotMatch(t.close_reason, /closed at the broker/)
})

test('BA: a loss_cap_close event (its own kind) attributes too; the NEWEST close event wins', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const tradeId = seedKnownPosition(db, { symbol: 'XAUUSD', positionId: '5102' })
  db.prepare(`INSERT INTO position_events (position_id, symbol, kind, reason, source) VALUES ('5102', 'XAUUSD', 'close', 'first attempt', 'loss_guardian')`).run()
  db.prepare(`INSERT INTO position_events (position_id, symbol, kind, reason, source) VALUES ('5102', 'XAUUSD', 'loss_cap_close', 'floating loss $120 breached cap $100', 'loss_cap')`).run()
  reconcilePositions(db, [], [], setState)
  assert.equal(db.prepare(`SELECT close_reason FROM trades WHERE id = ?`).get(tradeId).close_reason, 'loss_cap: floating loss $120 breached cap $100')
})

test('BA: a scale_out (partial take-profit) is NOT a close — a later broker close stays generic', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  const tradeId = seedKnownPosition(db, { symbol: 'EURUSD', positionId: '5103' })
  db.prepare(`INSERT INTO position_events (position_id, trade_id, symbol, kind, reason, source) VALUES ('5103', ?, 'EURUSD', 'scale_out', 'partial take-profit TP1', 'trade_guard')`).run(tradeId)
  reconcilePositions(db, [], [], setState)
  assert.equal(db.prepare(`SELECT close_reason FROM trades WHERE id = ?`).get(tradeId).close_reason, GENERIC)
})

test('BA: the momentum book\'s exit_sent row attributes a book close; another account\'s row does not', () => {
  const db = mkDb()
  const setState = mkSetState(db)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', 'A')`).run()
  const tradeId = seedKnownPosition(db, { symbol: 'NATGAS', positionId: '5104' })
  db.prepare(`UPDATE trades SET account_id = 'A' WHERE id = ?`).run(tradeId)
  db.prepare(`UPDATE monitored_positions SET account_id = 'A' WHERE trade_id = ?`).run(tradeId)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, status, note, entered_at) VALUES (?, 'B', 'NATGAS', '5104', 'exit_sent', 'rank exit (flip)', datetime('now'))`).run(tradeId)
  reconcilePositions(db, [], [], setState, { accountId: 'A' })
  assert.equal(db.prepare(`SELECT close_reason FROM trades WHERE id = ?`).get(tradeId).close_reason, GENERIC, 'B\'s book row says nothing about A\'s position')

  const db2 = mkDb()
  db2.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', 'A')`).run()
  const t2 = seedKnownPosition(db2, { symbol: 'NATGAS', positionId: '5105' })
  db2.prepare(`UPDATE trades SET account_id = 'A' WHERE id = ?`).run(t2)
  db2.prepare(`UPDATE monitored_positions SET account_id = 'A' WHERE trade_id = ?`).run(t2)
  db2.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, status, note, entered_at) VALUES (?, 'A', 'NATGAS', '5105', 'exit_sent', 'rank exit (flip)', datetime('now'))`).run(t2)
  reconcilePositions(db2, [], [], mkSetState(db2), { accountId: 'A' })
  assert.equal(db2.prepare(`SELECT close_reason FROM trades WHERE id = ?`).get(t2).close_reason, 'momentum_book: rank exit (flip)')
})

test('BA: attributeBrokerClose reads the journal by trade id when the position id is unknown, and returns null with no ledger', () => {
  const db = mkDb()
  const tradeId = seedKnownPosition(db, { symbol: 'EURUSD', positionId: '5106' })
  assert.equal(attributeBrokerClose(db, { positionId: '5106', tradeId }), null)
  db.prepare(`INSERT INTO position_events (trade_id, symbol, kind, reason, source) VALUES (?, 'EURUSD', 'close', 'time cap', 'position_manager')`).run(tradeId)
  assert.equal(attributeBrokerClose(db, { tradeId }), 'position_manager: time cap')
  assert.equal(attributeBrokerClose(db, {}), null)
})

test('BA: reclassifyBrokerCloses upgrades a row stamped generic BEFORE the fix when the journal knows the closer — and leaves it alone once attributed', () => {
  const db = mkDb()
  const tradeId = seedKnownPosition(db, { symbol: 'AVGO.US', positionId: '5107' })
  db.prepare(`UPDATE trades SET status = 'closed', closed_at = datetime('now'), close_reason = ?, exit_price = 110, tp_price = 110 WHERE id = ?`).run(GENERIC, tradeId)
  db.prepare(`INSERT INTO position_events (position_id, symbol, kind, reason, source) VALUES ('5107', 'AVGO.US', 'close', 'giveback 40% from peak', 'profit_keeper')`).run()
  assert.equal(reclassifyBrokerCloses(db), 1)
  // the keeper's close wins over the exit-price-near-TP guess
  assert.equal(db.prepare(`SELECT close_reason FROM trades WHERE id = ?`).get(tradeId).close_reason, 'profit_keeper: giveback 40% from peak')
  assert.equal(reclassifyBrokerCloses(db), 0, 'idempotent: an attributed row is never rewritten')
})

test('Wave 2 (§K·8): a close on a row the BOOK holds with no journal entry is attributed to the book\'s broker-side stop, by trade id or position id; an exit_sent row keeps its note; another account\'s row does not match', () => {
  const db = mkDb()
  const t = seedKnownPosition(db, { symbol: 'JPM.US', positionId: '5201' })
  db.prepare(`UPDATE trades SET account_id = 'A' WHERE id = ?`).run(t)
  assert.equal(attributeBrokerClose(db, { tradeId: t, accountId: 'A' }), null, 'no book row, no journal → not attributed')
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, status, note, entered_at) VALUES (?, 'A', 'JPM.US', NULL, 'open', 'entered', datetime('now'))`).run(t)
  assert.equal(attributeBrokerClose(db, { tradeId: t, accountId: 'A' }), 'momentum_book: broker-side stop fill (3×ATR trail)')
  assert.equal(attributeBrokerClose(db, { positionId: '5201', tradeId: t, accountId: 'B' }), null, 'scoped to the account')
  db.prepare(`UPDATE momentum_book SET status = 'exit_sent', note = 'rank exit', position_id = '5201' WHERE trade_id = ?`).run(t)
  assert.equal(attributeBrokerClose(db, { positionId: '5201', accountId: 'A' }), 'momentum_book: rank exit')
})

// ---------------------------------------------------------------------------
// TICK FILLS ARE OWNED BY THE BOT (20-09-2026).
//
// Measured defect: the sidecar's tick firer labels its order
// `tick:<profileHash>|||||||i<intentId>`. Field 0 is in no SOURCES vocabulary,
// so isOurs() said false and the fill this system sent was adopted `external` —
// skipped by the fast monitor, the equity stop, the session-open guard, the
// naked-position guard and exit-mark stamping. Ownership now comes from the
// FILLED INTENT, and the row is stamped `autopilot` so all six source
// whitelists treat it as the bar entry it behaves like. The negatives below are
// the point: the tag alone is not the evidence — the intent must exist, on this
// account, from an automatic producer.
// ---------------------------------------------------------------------------

const TICK_LABEL = (intentId, hash = 'a'.repeat(16)) => `tick:${hash}|||||||${intentId}`

function seedTickIntent(db, { id = 'itick01abcdef', accountId = '46130058', producerId = 'tick_momentum', state = 'FILLED', symbol = 'EURUSD', side = 'BUY', sl = null, tp = null } = {}) {
  const at = '2026-09-20T08:00:00.000Z'
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, order_type, volume, sl, tp, producer_id, basis, mode_epoch, permit_id, permit_expires_at, state, created_at, updated_at)
              VALUES (?, ?, 'demo', ?, 1, ?, 'MARKET', 1000, ?, ?, ?, 'tick', 0, ?, ?, ?, ?, ?)`)
    .run(id, String(accountId), symbol, side, sl, tp, producerId, `p${id.slice(1)}`, at, state, at, at)
  return id
}

test('tick fill: a FILLED tick intent makes the broker position OURS — adopted autopilot, strategy tick_momentum_breakout, origin bot_market_dispatch, with a plan', () => {
  const db = mkDb()
  const ACCT = '46130058'
  const id = seedTickIntent(db, { accountId: ACCT })
  // The standing tick permit carries NO sl/tp of its own — the sidecar sets a
  // broker bracket at fire time. The plan must fall back to what the
  // reconciler reads off the broker position, or `planned_sl` is null and the
  // close can never be scored against a plan.
  const brokerPos = [makeBrokerPosition({
    positionId: 7001, symbolName: 'EURUSD', tradeSide: 'BUY', openPrice: 100,
    stopLoss: 99.5, takeProfit: 101, label: TICK_LABEL(id), volume: 1000,
  })]
  const result = reconcilePositions(db, brokerPos, [], mkSetState(db), { accountId: ACCT })

  assert.equal(result.newExternal.length, 1)
  assert.equal(result.newExternal[0].adopted, true, 'a tick fill is OURS')
  assert.equal(result.newExternal[0].source, 'autopilot')
  assert.deepEqual(result.newExternal[0].stampedFromIntent,
    { intentId: id, origin: 'bot_market_dispatch', strategy: 'tick_momentum_breakout', riskEventId: null })

  const t = db.prepare(`SELECT source, origin, strategy FROM trades WHERE ctrader_position_id = '7001'`).get()
  assert.deepEqual(t, { source: 'autopilot', origin: 'bot_market_dispatch', strategy: 'tick_momentum_breakout' })
  const mp = db.prepare(`SELECT source, strategy, status, thesis FROM monitored_positions WHERE trade_id = (SELECT id FROM trades WHERE ctrader_position_id = '7001')`).get()
  assert.equal(mp.source, 'autopilot')
  assert.equal(mp.strategy, 'tick_momentum_breakout')
  assert.equal(mp.status, 'active')
  assert.match(mp.thesis, new RegExp(`Adopted bot position — intent ${id} \\(tick_momentum\\)`))
  const p = db.prepare(`SELECT * FROM trade_plans WHERE trade_id = (SELECT id FROM trades WHERE ctrader_position_id = '7001')`).get()
  assert.ok(p, 'a plan row exists')
  assert.equal(p.planned_sl, 99.5, 'the plan falls back to the broker bracket the permit did not carry')
  assert.equal(p.planned_tp, 101)
  assert.equal(p.strategy, 'tick_momentum_breakout')
})

test('tick fill: loop.js OWN selectActivePositions statement returns the adopted row', async () => {
  // The REAL prepared statement, imported from loop.js — not a re-typed SQL
  // string. A re-typed copy would keep passing after the whitelist in loop.js
  // changed, which is the exact failure the preopen incident recorded there.
  //
  // AND IT MUST BE THE ADOPTION THAT PUT IT THERE (20-09-2026, checker round).
  // The first version of this test asserted only that the statement returned
  // the row, and SURVIVED both mutations of the mechanism it claimed to pin:
  // `repairMisfiledOwnPositions` runs at the end of every reconcile pass and
  // re-upgrades the row within the same call, so killing `byIntent` at the
  // adoption site left the row monitored anyway. A test that cannot go red
  // when the thing it names is deleted is failure mode #1.
  //
  // Two assertions close that: `sourcesRepaired === 0` (the healer did not
  // have to rescue it — red if the adoption produced `external`), and the
  // stamped strategy on the monitored row (red if `ours` is false, since the
  // stamp is gated on it and the healer never runs for an already-autopilot
  // row).
  const { prepareStatements } = await import('../loop.js')
  const db = mkDb()
  const ACCT = '46130058'
  const id = seedTickIntent(db, { accountId: ACCT })
  const result = reconcilePositions(db, [makeBrokerPosition({
    positionId: 7002, symbolName: 'EURUSD', openPrice: 100, stopLoss: 99.5, label: TICK_LABEL(id), volume: 1000,
  })], [], mkSetState(db), { accountId: ACCT })

  assert.equal(result.sourcesRepaired, 0, 'OURS at adoption — not rescued afterwards by the healer')
  const s = prepareStatements(db)
  const rows = s.selectActivePositions.all('active')
  assert.equal(rows.length, 1, 'the adopted tick position is monitored')
  assert.equal(rows[0].symbol, 'EURUSD')
  assert.equal(rows[0].source, 'autopilot')
  assert.equal(rows[0].strategy, 'tick_momentum_breakout', 'monitored AND attributed, on the adoption pass itself')
})

test('tick fill: manageStageAllows says YES for tick_momentum_breakout — no matrix cell can strand it', async () => {
  const { manageStageAllows } = await import('./stage-matrix.js')
  const { STRATEGY_KEYS } = await import('./strategies.js')
  const { setState: setStateFn } = await import('../db.js')
  const db = mkDb()
  assert.ok(!STRATEGY_KEYS.includes('tick_momentum_breakout'),
    'tick_momentum_breakout must stay OUT of STRATEGY_REGISTRY — in it, management depends on a matrix cell')
  assert.equal(manageStageAllows(db, getState, 'tick_momentum_breakout'), true)
  // Turn the manage cell OFF by hand (setStage refuses a non-registry key) —
  // an unknown key is managed regardless, which is the property being pinned.
  setStateFn(db, 'stage_matrix_json', JSON.stringify({ strategy: { tick_momentum_breakout: { manage: false } } }))
  assert.equal(manageStageAllows(db, getState, 'tick_momentum_breakout'), true,
    'a live tick fill must never be stranded by a stage-matrix cell nobody edited')
})

test('tick fill NEGATIVE: a MAN-labelled position with a well-formed but UNKNOWN intent tag stays external', () => {
  const db = mkDb()
  const ACCT = '46130058'
  // no entry_intents row at all — the tag names nothing
  reconcilePositions(db, [makeBrokerPosition({
    positionId: 7003, symbolName: 'NATGAS', openPrice: 3, label: 'MAN|v1|-|-|-|-|-|inosuch01abc', volume: 1000,
  })], [], mkSetState(db), { accountId: ACCT })
  const t = db.prepare(`SELECT source FROM trades WHERE ctrader_position_id = '7003'`).get()
  assert.equal(t.source, 'external', 'a tag is not evidence — the ledger row is')
  assert.equal(db.prepare(`SELECT source FROM monitored_positions WHERE trade_id = (SELECT id FROM trades WHERE ctrader_position_id = '7003')`).get().source, 'external')
})

test('tick fill NEGATIVE: a tick label whose intent belongs to a DIFFERENT account stays external', () => {
  const db = mkDb()
  const id = seedTickIntent(db, { accountId: '46130058' })
  reconcilePositions(db, [makeBrokerPosition({
    positionId: 7004, symbolName: 'EURUSD', openPrice: 100, stopLoss: 99.5, label: TICK_LABEL(id), volume: 1000,
  })], [], mkSetState(db), { accountId: '99990000' })
  assert.equal(db.prepare(`SELECT source FROM trades WHERE ctrader_position_id = '7004'`).get().source, 'external',
    'one account intent must never hand another account position to bot management')
})

test('tick fill: repairMisfiledOwnPositions upgrades a PRE-PR misfiled row, is idempotent, and undoIntentUpgrades puts it back', () => {
  const db = mkDb()
  const ACCT = '46130058'
  const id = seedTickIntent(db, { accountId: ACCT })
  const label = TICK_LABEL(id)
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, label_raw, account_id, status, opened_at)
     VALUES ('EURUSD', 'BUY', 100, 0.01, '7005', 'external', ?, ?, 'open', datetime('now'))`
  ).run(label, ACCT).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, thesis, source, label_raw, account_id, status)
     VALUES ('EURUSD', ?, 'long', 100, 99.25, 'External position — reconciliation import', 'external', ?, ?, 'active')`
  ).run(tradeId, label, ACCT)

  assert.equal(repairMisfiledOwnPositions(db), 1)
  assert.equal(db.prepare(`SELECT source FROM trades WHERE id = ?`).get(tradeId).source, 'autopilot')
  assert.equal(db.prepare(`SELECT source FROM monitored_positions WHERE trade_id = ?`).get(tradeId).source, 'autopilot')
  // ATTRIBUTION, NOT JUST SCOPE. Rescuing `source` alone left exactly the rows
  // this healer exists for managed but unattributed — strategy NULL (so
  // strategy-attribution buckets them as unlabelled), origin untouched, no
  // trade_plans row (so position_history's required fields go unmet). The
  // original test asserted only `source`, which is why that was invisible.
  const healed = db.prepare(`SELECT source, origin, strategy FROM trades WHERE id = ?`).get(tradeId)
  assert.deepEqual(healed, { source: 'autopilot', origin: 'bot_market_dispatch', strategy: 'tick_momentum_breakout' })
  assert.equal(db.prepare(`SELECT strategy FROM monitored_positions WHERE trade_id = ?`).get(tradeId).strategy, 'tick_momentum_breakout')
  const healedPlan = db.prepare(`SELECT * FROM trade_plans WHERE trade_id = ?`).get(tradeId)
  assert.ok(healedPlan, 'the healed row gets its plan too')
  assert.equal(healedPlan.planned_sl, 99.25, 'from the monitored row\'s stop, the only bracket a healed row has')
  assert.equal(healedPlan.source, 'reconciler_adopted_intent')
  assert.equal(repairMisfiledOwnPositions(db), 0, 'idempotent: an upgraded row no longer matches')

  // The inverse — a revert of the code does NOT undo the writes, so the undo
  // ships with the change.
  const undone = undoIntentUpgrades(db, { tradeIds: [tradeId] })
  assert.equal(undone.reverted, 1)
  assert.deepEqual(undone.skipped, [])
  assert.equal(db.prepare(`SELECT source FROM trades WHERE id = ?`).get(tradeId).source, 'external')
  assert.equal(db.prepare(`SELECT source FROM monitored_positions WHERE trade_id = ?`).get(tradeId).source, 'external')
  // and it refuses a row that is ours by LABEL — that is the pre-open repair,
  // a different fix, which this must never undo.
  const preTrade = seedKnownPosition(db, { symbol: 'US30', positionId: '7006', source: 'autopilot' })
  db.prepare(`UPDATE monitored_positions SET label_raw = 'PRE|v1|TREND|HI|LDN|H1|REGT' WHERE trade_id = ?`).run(preTrade)
  const refused = undoIntentUpgrades(db, { tradeIds: [preTrade] })
  assert.equal(refused.reverted, 0)
  assert.match(refused.skipped[0].why, /label is ours/)
})

test('ownedByIntent is STATE-AGNOSTIC: an intent already FILLed by reconcileIntents is still found', async () => {
  const { ownedByIntent } = await import('../lib/trade-labels.js')
  const db = mkDb()
  const ACCT = '46130058'
  const label = TICK_LABEL(seedTickIntent(db, { accountId: ACCT, state: 'RESERVED', id: 'itickres0001' }))
  assert.equal(ownedByIntent(db, label, ACCT), true, 'RESERVED')
  db.prepare(`UPDATE entry_intents SET state = 'FILLED' WHERE id = 'itickres0001'`).run()
  assert.equal(ownedByIntent(db, label, ACCT), true, 'FILLED — reconcileIntents and this pass race; state must not decide ownership')
  db.prepare(`UPDATE entry_intents SET state = 'REJECTED' WHERE id = 'itickres0001'`).run()
  assert.equal(ownedByIntent(db, label, ACCT), true, 'still the decision this system took')
  // a MANUAL-family producer is not automatic ownership
  db.prepare(`UPDATE entry_intents SET producer_id = 'route_manual_order' WHERE id = 'itickres0001'`).run()
  assert.equal(ownedByIntent(db, label, ACCT), false, 'a manual producer is the decision of a human, not the bot')
  assert.equal(ownedByIntent(db, 'MAN|v1|-|-|-|-|-', ACCT), false, 'no tag, no ownership')
  assert.equal(ownedByIntent(null, label, ACCT), false, 'a DB error returns false, never throws')
})

test('tick fill: a RELEASED permit that fired anyway is STILL adopted — and the breach is journalled', () => {
  // The cost of state-agnostic ownership, made legible rather than argued
  // away (20-09-2026, checker round). A RELEASED or REJECTED intent with a
  // live position at the broker means the sidecar fired past a withdrawn
  // permit — this repo's ambiguous-submission shape. Ownership must NOT
  // change: live risk owned by nobody is the worse failure of the two. But an
  // ordinary adoption thesis would record a fence breach as a routine import,
  // so the state goes in the thesis and an action_log row names it.
  const db = mkDb()
  const ACCT = '46130058'
  const id = seedTickIntent(db, { accountId: ACCT, state: 'RELEASED' })
  const result = reconcilePositions(db, [makeBrokerPosition({
    positionId: 7007, symbolName: 'EURUSD', openPrice: 100, stopLoss: 99.5, label: TICK_LABEL(id), volume: 1000,
  })], [], mkSetState(db), { accountId: ACCT })

  assert.equal(result.newExternal[0].adopted, true, 'a withdrawn permit does not disown live risk')
  assert.equal(result.newExternal[0].source, 'autopilot')
  assert.equal(result.newExternal[0].fenceBreach, 'RELEASED')
  const mp = db.prepare(`SELECT thesis FROM monitored_positions WHERE trade_id = (SELECT id FROM trades WHERE ctrader_position_id = '7007')`).get()
  assert.match(mp.thesis, /PERMIT RELEASED: fired past a withdrawn permit/)

  const log = db.prepare(`SELECT body FROM action_log WHERE method = 'FENCE_BREACH_ADOPTED' ORDER BY id DESC LIMIT 1`).get()
  assert.ok(log, 'the breach is journalled')
  const body = JSON.parse(log.body)
  assert.equal(body.intentId, id)
  assert.equal(body.state, 'RELEASED')
  assert.equal(body.producerId, 'tick_momentum')
  assert.equal(body.account, '…0058', 'account by last 4 only')

  // A normally-resolved intent writes NO breach row — the journal must mean
  // something when it is there.
  const ok = seedTickIntent(db, { accountId: ACCT, id: 'itickok000001', state: 'FILLED' })
  reconcilePositions(db, [
    makeBrokerPosition({ positionId: 7007, symbolName: 'EURUSD', openPrice: 100, stopLoss: 99.5, label: TICK_LABEL(id), volume: 1000 }),
    makeBrokerPosition({ positionId: 7008, symbolName: 'EURUSD', openPrice: 100, stopLoss: 99.5, label: TICK_LABEL(ok), volume: 1000 }),
  ], [], mkSetState(db), { accountId: ACCT })
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM action_log WHERE method = 'FENCE_BREACH_ADOPTED'`).get().c, 1,
    'one breach, one row — a FILLED intent is not a breach')
})
