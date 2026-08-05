// node --test agent/services/closed-market-limits.test.js
//
// Resting limit orders for closed-market setups (Option A: replaces the
// internal re-fire queue; on by default). Every order clears the risk gate;
// one order per symbol; idempotent while resting.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  buildLimitPayload, loadClosedMarketLimitsConfig, DEFAULT_CLOSED_MARKET_LIMITS,
  placeClosedMarketLimit, reconcileStaleClosedMarketLimits,
} from './closed-market-limits.js'

const CREDS = { host: 'demo', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '42' }
const SYNTH = { consensus_bias: 'long', entry: 100, sl: 98, tp1: 104, tp2: 106, strategy: 'rsi2_reversion', timeframe: '8h', overall_conviction: 8 }

function fakes({ approved = true } = {}) {
  const placed = []
  return {
    placed,
    risk: {
      loadRiskConfig: () => ({}),
      evaluateTrade: () => (approved ? { approved: true, adjusted_volume: 0.1 } : { approved: false, veto_reason: 'min_rr' }),
      persistRiskEvent: () => {},
    },
    sizing: {
      getVolumeMeta: async () => ({ digits: 2, lotSize: 100, minVolume: 1 }),
      lotsToVolume: (lots) => ({ volume: Math.round(lots * 100), belowMin: false }),
      relativePoints: (d, dg) => Math.round(d * Math.pow(10, dg)),
    },
    exec: {
      placeOrder: async (_c, payload) => { placed.push(payload); return { order: { orderId: 9001 } } },
      cancelOrder: async () => ({}),
    },
    now: 1_700_000_000_000,
  }
}

test('defaults: on by default; explicit off wins', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadClosedMarketLimitsConfig(db), DEFAULT_CLOSED_MARKET_LIMITS)
  assert.equal(DEFAULT_CLOSED_MARKET_LIMITS.on, true)
  setState(db, 'closed_market_limits_json', JSON.stringify({ on: false }))
  assert.equal(loadClosedMarketLimitsConfig(db).on, false)
})

test('buildLimitPayload: LIMIT, snapped price, relative SL/TP, expiry', () => {
  const p = buildLimitPayload({
    accountId: '42', symbolId: 7, side: 'BUY', volume: 10,
    entry: 100.123456, sl: 98, tp: 104, digits: 2, expiresAtMs: 123, label: 'L',
    relativePoints: (d, dg) => Math.round(d * Math.pow(10, dg)),
  })
  assert.equal(p.orderType, 'LIMIT')
  assert.equal(p.tradeSide, 'BUY')
  assert.equal(p.limitPrice, 100.12)                             // snapped to 2dp
  assert.equal(p.relativeStopLoss, Math.round((100.123456 - 98) * 100))   // dist from raw entry
  assert.equal(p.relativeTakeProfit, Math.round((104 - 100.123456) * 100))
  assert.equal(p.expirationTimestamp, 123)
  assert.equal(p.comment, 'pending-closed')
})

test('off → skipped, no order placed', async () => {
  const db = initDB(':memory:')
  setState(db, 'closed_market_limits_json', JSON.stringify({ on: false }))
  const f = fakes()
  const r = await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, f)
  assert.equal(r.skipped, 'off')
  assert.equal(f.placed.length, 0)
})

test('unknown symbol → skipped', async () => {
  const db = initDB(':memory:')
  const r = await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, fakes())
  assert.equal(r.skipped, 'symbol_unknown')
})

test('risk veto → skipped, no order', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  const f = fakes({ approved: false })
  const r = await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, f)
  assert.equal(r.skipped, 'risk_veto')
  assert.equal(f.placed.length, 0)
})

test('happy path: places a LIMIT and records a working row', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  const f = fakes()
  const r = await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, f)
  assert.equal(r.placed, true)
  assert.equal(r.orderId, 9001)
  assert.equal(f.placed[0].orderType, 'LIMIT')
  const row = db.prepare(`SELECT * FROM pending_orders WHERE symbol='US30' AND note='pending-closed'`).get()
  assert.equal(row.status, 'working')
  assert.equal(row.level, 100)
})

test('idempotent: a second call while resting at the same level does NOT re-place', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  const f = fakes()
  await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, f)
  const r2 = await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, f)
  assert.equal(r2.skipped, 'already_working')
  assert.equal(f.placed.length, 1) // only the first placed an order
})

test('reconcileStaleClosedMarketLimits: still working in broker_orders leaves it alone', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note)
    VALUES ('US30', '4h', '501', 1, 100, 98, 104, 1, '2026-07-21T00:00:00Z', '2026-07-25T00:00:00Z', 'working', 'pending-closed')
  `).run()
  db.prepare(`
    INSERT INTO broker_orders (order_id, symbol, status) VALUES ('501', 'US30', 'working')
  `).run()
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-07-22T00:00:00Z') })
  assert.deepEqual(r, { stillWorking: 1, filled: 0, expired: 0, unknown: 0 })
  const row = db.prepare(`SELECT status FROM pending_orders WHERE order_id = '501'`).get()
  assert.equal(row.status, 'working')
})

test('reconcileStaleClosedMarketLimits: gone from broker_orders, a trade opened since it was placed becomes filled', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note)
    VALUES ('AMZN.US', '1d', '502', -1, 250, 253, 240, 1, '2026-07-21T00:00:00Z', '2026-07-28T00:00:00Z', 'working', 'pending-closed')
  `).run()
  // The broker HAS a record and it says the order left the book. This test
  // used to insert no broker_orders row at all and call that "gone" — which
  // is precisely the misreading that retired thirteen live DOW.US limits on
  // 04-08-2026. Left the book and never heard of are different facts now.
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status) VALUES ('502', 'AMZN.US', 'gone')`).run()
  db.prepare(`INSERT INTO trades (symbol, opened_at) VALUES ('AMZN.US', '2026-07-21T12:00:00Z')`).run()
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-07-22T00:00:00Z') })
  assert.deepEqual(r, { stillWorking: 0, filled: 1, expired: 0, unknown: 0 })
  const row = db.prepare(`SELECT status, note FROM pending_orders WHERE order_id = '502'`).get()
  assert.equal(row.status, 'filled')
  assert.match(row.note, /adopted as trade/)
})

test('reconcileStaleClosedMarketLimits: gone from broker_orders, no matching trade becomes expired', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note)
    VALUES ('TSLA.US', '1w', '503', -1, 381, 420, 251, 1, '2026-07-21T16:58:00Z', '2026-08-04T00:00:00Z', 'working', 'pending-closed')
  `).run()
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status) VALUES ('503', 'TSLA.US', 'gone')`).run()
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-07-22T23:00:00Z') })
  assert.deepEqual(r, { stillWorking: 0, filled: 0, expired: 1, unknown: 0 })
  const row = db.prepare(`SELECT status, note FROM pending_orders WHERE order_id = '503'`).get()
  assert.equal(row.status, 'expired')
  assert.match(row.note, /gone at broker, no fill adopted/)
})

// ---------------------------------------------------------------------------
// THE 04-08-2026 REPLACE LOOP — absence is not evidence of death
// ---------------------------------------------------------------------------

test('THE DOW.US LEAK: an order the broker has never mentioned stays WORKING', () => {
  // broker_orders is per-account: syncBrokerOrders scopes gone-detection by
  // account_id, so a row for account 46130058 is simply absent when the sweep
  // runs after 43097342's reconcile. Treating that as "gone at broker" retired
  // the row, which freed the idempotency check to place a replacement, which
  // is how one DOW.US signal became thirteen live limits at 29.84 between
  // 10:41 and 12:03 and seventeen positions when the market opened.
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, volume, placed_at, expires_at, status, note, account_id)
    VALUES ('DOW.US', '1h', '352987221', -1, 29.84, 30.1777, 250, '2026-08-04T10:41:50Z', '2026-08-07T10:41:50Z', 'working', 'pending-closed', '46130058')
  `).run()
  // Nothing in broker_orders — the other account's pass simply cannot see it.
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-08-04T10:47:52Z') })
  assert.deepEqual(r, { stillWorking: 1, filled: 0, expired: 0, unknown: 1 })
  const row = db.prepare(`SELECT status FROM pending_orders WHERE order_id = '352987221'`).get()
  assert.equal(row.status, 'working', 'the order is alive at the broker and our record must say so')
})

test('an unknown order is still settled by its OWN expiry — unknown is not forever', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, order_id, dir, level, placed_at, expires_at, status, note, account_id)
    VALUES ('DOW.US', '352987221', -1, 29.84, '2026-08-04T10:41:50Z', '2026-08-07T10:41:50Z', 'working', 'pending-closed', '46130058')
  `).run()
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-08-08T00:00:00Z') })
  assert.deepEqual(r, { stillWorking: 0, filled: 0, expired: 1, unknown: 0 })
  const row = db.prepare(`SELECT status, note FROM pending_orders WHERE order_id = '352987221'`).get()
  assert.equal(row.status, 'expired')
  assert.match(row.note, /no broker record and own expiry passed/)
})

test("a fill on ANOTHER account does not close out this account's resting order", () => {
  // The adopted-trade heuristic matched on symbol and time only. With two
  // accounts trading one watchlist that credits a fill to the wrong order.
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, order_id, dir, level, placed_at, expires_at, status, note, account_id)
    VALUES ('DOW.US', '601', -1, 29.84, '2026-08-04T10:00:00Z', '2026-08-07T00:00:00Z', 'working', 'pending-closed', '46130058')
  `).run()
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status) VALUES ('601', 'DOW.US', 'gone')`).run()
  db.prepare(`INSERT INTO trades (symbol, opened_at, account_id) VALUES ('DOW.US', '2026-08-04T11:00:00Z', '43097342')`).run()
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-08-04T12:00:00Z') })
  assert.equal(r.filled, 0, "another account's fill is not this order's fill")
  assert.equal(r.expired, 1)
})

test('reconcileStaleClosedMarketLimits: never got an order_id waits for its own expiry, then gives up', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note)
    VALUES ('HK50', '1w', NULL, -1, 24591, 25490, 22793, 1, '2026-07-22T05:08:00Z', '2026-07-23T00:00:00Z', 'working', 'pending-closed')
  `).run()
  // Before its own expiry — too early to judge, left alone.
  const early = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-07-22T12:00:00Z') })
  assert.deepEqual(early, { stillWorking: 1, filled: 0, expired: 0, unknown: 0 })
  // After its own expiry — no order_id ever means no broker lookup is
  // possible, so this is the only signal left to give up on.
  const late = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-07-23T01:00:00Z') })
  assert.deepEqual(late, { stillWorking: 0, filled: 0, expired: 1, unknown: 0 })
  const row = db.prepare(`SELECT status, note FROM pending_orders WHERE symbol = 'HK50'`).get()
  assert.equal(row.status, 'expired')
  assert.match(row.note, /no broker order_id/)
})

test('reconcileStaleClosedMarketLimits: ignores rows from other notes such as pending-fib', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note)
    VALUES ('AUDNOK', '1h', '999', -1, 6.7396, 6.7522, 6.7208, 1, '2026-07-22T12:42:00Z', '2026-07-22T13:42:00Z', 'working', 'pending-fib')
  `).run()
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-07-23T00:00:00Z') })
  assert.deepEqual(r, { stillWorking: 0, filled: 0, expired: 0, unknown: 0 })
  const row = db.prepare(`SELECT status FROM pending_orders WHERE symbol = 'AUDNOK'`).get()
  assert.equal(row.status, 'working') // untouched — pending-orders.js's own sweep owns this row
})

test('every placed row is STAMPED with the account that placed it', async () => {
  // The column has existed since the M1 multi-account migration and this
  // writer never filled it. Nothing downstream can scope by a value that was
  // never written, so every read that should have been per-account silently
  // widened to all of them.
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, fakes())
  const row = db.prepare(`SELECT account_id FROM pending_orders WHERE symbol = 'US30'`).get()
  assert.equal(row.account_id, '42')
})

test("idempotency is per account — one account's resting order cannot suppress another's", async () => {
  // The other direction of the same fix. Now that account_id is stamped, an
  // unscoped read would let account 42's resting US30 limit stop account 43
  // from ever placing its own.
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  const f = fakes()
  await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, f)
  const other = await placeClosedMarketLimit(db, { ...CREDS, accountId: '43' }, 'US30', SYNTH, f)
  assert.equal(other.placed, true, 'a second account is entitled to its own order')
  assert.equal(f.placed.length, 2)
  const accts = db.prepare(`SELECT account_id FROM pending_orders WHERE symbol='US30' AND status='working' ORDER BY account_id`).all()
  assert.deepEqual(accts.map(r => r.account_id), ['42', '43'])

  // …and the second account's pass did NOT cancel the first account's order.
  const stillFortyTwo = db.prepare(`SELECT status FROM pending_orders WHERE account_id='42'`).get()
  assert.equal(stillFortyTwo.status, 'working')
})

test('level moved → cancels the stale order and places a fresh one', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  const f = fakes()
  await placeClosedMarketLimit(db, CREDS, 'US30', SYNTH, f)
  const r2 = await placeClosedMarketLimit(db, CREDS, 'US30', { ...SYNTH, entry: 95, sl: 93, tp1: 99 }, f)
  assert.equal(r2.placed, true)
  assert.equal(f.placed.length, 2)
  // the old working row is cancelled, exactly one working row remains
  const working = db.prepare(`SELECT * FROM pending_orders WHERE symbol='US30' AND status='working'`).all()
  assert.equal(working.length, 1)
  assert.equal(working[0].level, 95)
})

// ---------------------------------------------------------------------------
// §70.9 LINEAGE THROUGH THE FILL (05-08-2026)
//
// Measured across all three accounts, 7 days: 62 fib_confluence and 26
// fib_618_fade opens, EVERY ONE with risk_event_id NULL — while the
// pending_orders rows that produced them carried ids 97150-97729. The approval
// was recorded; it just never reached the trade.
// ---------------------------------------------------------------------------

test('an adopted fill INHERITS the approval id from the order that produced it', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, order_id, dir, level, placed_at, expires_at, status, note, account_id, risk_event_id)
    VALUES ('DOW.US', '901', -1, 29.84, '2026-08-04T10:00:00Z', '2026-08-07T00:00:00Z', 'working', 'pending-closed', '46130058', 97150)
  `).run()
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status) VALUES ('901', 'DOW.US', 'gone')`).run()
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, opened_at, account_id) VALUES ('DOW.US', '2026-08-04T11:00:00Z', '46130058')`
  ).run().lastInsertRowid

  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-08-04T12:00:00Z') })
  assert.equal(r.filled, 1)
  assert.equal(db.prepare(`SELECT risk_event_id FROM trades WHERE id = ?`).get(tradeId).risk_event_id, 97150,
    'the trade can now name the approval that authorised it')
})

test('an approval id already on the trade is NEVER overwritten', () => {
  // A more direct writer knows better than this heuristic link.
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, order_id, dir, level, placed_at, expires_at, status, note, account_id, risk_event_id)
    VALUES ('DOW.US', '902', -1, 29.84, '2026-08-04T10:00:00Z', '2026-08-07T00:00:00Z', 'working', 'pending-closed', '46130058', 97150)
  `).run()
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status) VALUES ('902', 'DOW.US', 'gone')`).run()
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, opened_at, account_id, risk_event_id) VALUES ('DOW.US', '2026-08-04T11:00:00Z', '46130058', 55555)`
  ).run().lastInsertRowid

  reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-08-04T12:00:00Z') })
  assert.equal(db.prepare(`SELECT risk_event_id FROM trades WHERE id = ?`).get(tradeId).risk_event_id, 55555)
})

test('a pending row with no approval id leaves the trade alone', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO pending_orders (symbol, order_id, dir, level, placed_at, expires_at, status, note, account_id)
    VALUES ('DOW.US', '903', -1, 29.84, '2026-08-04T10:00:00Z', '2026-08-07T00:00:00Z', 'working', 'pending-closed', '46130058')
  `).run()
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status) VALUES ('903', 'DOW.US', 'gone')`).run()
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, opened_at, account_id) VALUES ('DOW.US', '2026-08-04T11:00:00Z', '46130058')`
  ).run().lastInsertRowid
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-08-04T12:00:00Z') })
  assert.equal(r.filled, 1)
  assert.equal(db.prepare(`SELECT risk_event_id FROM trades WHERE id = ?`).get(tradeId).risk_event_id, null)
})
