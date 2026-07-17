// ---------------------------------------------------------------------------
// pending-orders.test.js — full lifecycle of resting-limit-order mode against
// injected fakes, on the REAL db.js schema (in-memory). No network, no broker.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { managePendingOrders } from './pending-orders.js'

const SYMBOL_MAP = { EURUSD: 1, XAUUSD: 41 }
const CREDS = { host: 'demo.ctraderapi.com', clientId: 'id', clientSecret: 'sec', accessToken: 'tok', accountId: '123' }

function freshDb(matrix = { EURUSD: ['4h'] }) {
  const db = initDB(':memory:')
  if (matrix) setState(db, 'pending_matrix_json', JSON.stringify(matrix))
  setState(db, 'pending_mode_enabled', 'true')
  return db
}

// Fakes record every call so assertions can inspect payloads.
function makeDeps({ reconcile = { order: [], position: [] }, setups = [], lastClose = {}, approve = true } = {}) {
  const calls = { placed: [], cancelled: [], riskEvents: [] }
  return {
    calls,
    deps: {
      exec: {
        reconcile: async () => reconcile,
        placeOrder: async (_creds, payload) => {
          calls.placed.push(payload)
          return { order: { orderId: 9000 + calls.placed.length } }
        },
        cancelOrder: async (_creds, { orderId }) => {
          calls.cancelled.push(orderId)
          return { ok: true }
        },
      },
      scan: async () => ({ setups, lastClose, errors: [] }),
      risk: {
        loadRiskConfig: () => ({ minLotSize: 0.01 }),
        evaluateTrade: (_db, proposal) => approve
          ? { approved: true, adjusted_volume: proposal.requestedVolume }
          : { approved: false, veto_reason: 'test_veto' },
        persistRiskEvent: (_db, proposal, result) => calls.riskEvents.push({ proposal, result }),
      },
      sizing: {
        getVolumeMeta: async () => ({ lotSize: 100000, minVolume: 1000 }),
        lotsToVolume: (lots, meta) => ({ volume: Math.round(lots * meta.lotSize), belowMin: false }),
      },
    },
  }
}

const SIGNAL = {
  bias: 'long', conviction: 8, entry: 1.1000, sl: 1.0950, tp1: 1.1100, tp2: 1.1200,
  strategy: 'fib_618_fade', timeframe: '4h', time_cap_minutes: 240,
}

test('returns skipped when no matrix is configured', async () => {
  const db = initDB(':memory:')
  const { deps } = makeDeps()
  const res = await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  assert.deepEqual(res, { skipped: 'no matrix' })
})

test('places a LIMIT order on a new setup and records the db row + audit trail', async () => {
  const db = freshDb()
  const { deps, calls } = makeDeps({ setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL }] })
  const res = await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)

  assert.equal(res.placed, 1)
  assert.equal(calls.placed.length, 1)
  const payload = calls.placed[0]
  assert.equal(payload.orderType, 'LIMIT')
  assert.equal(payload.tradeSide, 'BUY')
  assert.equal(payload.limitPrice, 1.1)
  assert.equal(payload.symbolId, 1)
  assert.equal(payload.comment, 'pending-fib')
  assert.ok(payload.label.length > 0)
  assert.equal(payload.relativeStopLoss, Math.round(0.005 * 100000))
  assert.ok(payload.expirationTimestamp > Date.now())

  const row = db.prepare(`SELECT * FROM pending_orders`).get()
  assert.equal(row.symbol, 'EURUSD')
  assert.equal(row.timeframe, '4h')
  assert.equal(row.order_id, '9001')
  assert.equal(row.dir, 1)
  assert.equal(row.status, 'working')
  assert.equal(row.level, 1.1)
  assert.ok(row.expires_at)

  // evaluateTrade result + placement confirmation both audited
  assert.ok(calls.riskEvents.some(e => e.result.approved && e.result.checks?.pending_order_placed))
})

test('risk veto blocks placement', async () => {
  const db = freshDb()
  const { deps, calls } = makeDeps({ setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL }], approve: false })
  const res = await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  assert.equal(res.placed, 0)
  assert.equal(calls.placed.length, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM pending_orders`).get().c, 0)
})

test('one working order per symbol — duplicate setups are deduped', async () => {
  const db = freshDb()
  db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, status)
              VALUES ('EURUSD','4h','555',1,1.1,1.095,1.11,0.01,'working')`).run()
  const { deps, calls } = makeDeps({
    reconcile: { order: [{ orderId: 555 }], position: [] },
    setups: [
      { symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL },
      { symbol: 'EURUSD', timeframe: '1d', signal: { ...SIGNAL, timeframe: '1d' } },
    ],
  })
  const res = await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  assert.equal(res.placed, 0)
  assert.equal(calls.placed.length, 0)
  assert.equal(res.skipped.length, 2)
})

test('cancels a working order when a closed bar breaches the SL (invalidation)', async () => {
  const db = freshDb()
  db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, status)
              VALUES ('EURUSD','4h','777',1,1.1,1.095,1.11,0.01,'working')`).run()
  const { deps, calls } = makeDeps({
    reconcile: { order: [{ orderId: 777 }], position: [] },
    lastClose: { EURUSD: 1.0900 }, // long setup, close below SL → invalid
  })
  const res = await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  assert.equal(res.cancelled, 1)
  assert.deepEqual(calls.cancelled, ['777'])
  const row = db.prepare(`SELECT * FROM pending_orders`).get()
  assert.equal(row.status, 'cancelled')
  assert.equal(row.note, 'invalidated')
  assert.ok(calls.riskEvents.some(e => /pending_invalidated/.test(e.result.veto_reason || '')))
})

test('marks a vanished order FILLED and mirrors trades + monitored_positions', async () => {
  const db = freshDb()
  db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, status)
              VALUES ('EURUSD','4h','888',1,1.1,1.095,1.11,0.02,'working')`).run()
  const { deps } = makeDeps({
    reconcile: {
      order: [],
      position: [{ positionId: 42, price: 1.0999, tradeData: { symbolId: 1, tradeSide: 'BUY', label: 'ap|v1|fib_618_fade|high|LDN|4h|-|pending-fib' } }],
    },
  })
  const res = await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  assert.equal(res.filled, 1)

  const po = db.prepare(`SELECT * FROM pending_orders`).get()
  assert.equal(po.status, 'filled')

  const trade = db.prepare(`SELECT * FROM trades`).get()
  assert.equal(trade.symbol, 'EURUSD')
  assert.equal(trade.side, 'BUY')
  assert.equal(trade.entry_price, 1.0999)
  assert.equal(trade.sl_price, 1.095)
  assert.equal(trade.tp_price, 1.11)
  assert.equal(trade.volume, 0.02)
  assert.equal(trade.status, 'open')
  assert.equal(trade.ctrader_position_id, '42')
  assert.equal(trade.strategy, 'fib_618_fade')

  const mp = db.prepare(`SELECT * FROM monitored_positions`).get()
  assert.equal(mp.symbol, 'EURUSD')
  assert.equal(mp.trade_id, trade.id)
  assert.equal(mp.side, 'long')
  assert.equal(mp.status, 'active')
  assert.equal(mp.current_sl, 1.095)
  assert.ok(mp.initial_risk > 0)
})

test('marks a vanished order EXPIRED when no matching position exists', async () => {
  const db = freshDb()
  db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, status)
              VALUES ('EURUSD','4h','999',1,1.1,1.095,1.11,0.01,'working')`).run()
  const { deps } = makeDeps({ reconcile: { order: [], position: [] } })
  const res = await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  assert.equal(res.expired, 1)
  const row = db.prepare(`SELECT * FROM pending_orders`).get()
  assert.equal(row.status, 'expired')
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM trades`).get().c, 0)
})

test('full lifecycle: place → invalidate-cancel → new setup places again', async () => {
  const db = freshDb()
  // Pass 1: place
  let fx = makeDeps({ setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL }] })
  await managePendingOrders(db, CREDS, SYMBOL_MAP, fx.deps)
  // Pass 2: broker shows the order; closed bar breaches SL → cancel
  fx = makeDeps({ reconcile: { order: [{ orderId: 9001 }], position: [] }, lastClose: { EURUSD: 1.05 } })
  let res = await managePendingOrders(db, CREDS, SYMBOL_MAP, fx.deps)
  assert.equal(res.cancelled, 1)
  // Pass 3: fresh setup on a symbol with no working row → places
  fx = makeDeps({ setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL }] })
  res = await managePendingOrders(db, CREDS, SYMBOL_MAP, fx.deps)
  assert.equal(res.placed, 1)
  const statuses = db.prepare(`SELECT status FROM pending_orders ORDER BY id`).all().map(r => r.status)
  assert.deepEqual(statuses, ['cancelled', 'working'])
})

// ---------------------------------------------------------------------------
// reconcileBrokerPendingOrders — the owner-triggered broker cleanup: cancel
// bot-marked resting orders the ledger no longer tracks; never touch the
// owner's manual orders or the actively-managed set.
// ---------------------------------------------------------------------------

test('broker cleanup cancels only stale bot-marked orders', async () => {
  const db = freshDb()
  // one actively-managed row → its order must be KEPT
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note)
    VALUES ('EURUSD', '4h', '111', 1, 1.1, 1.09, 1.12, 0.01, '2030-01-01T00:00:00Z', 'working', 'pending-fib')
  `).run()
  const { deps, calls } = makeDeps({
    reconcile: {
      position: [],
      order: [
        { orderId: 111, tradeData: { label: 'abot|pending-fib', symbolId: 1 } },   // managed → keep
        { orderId: 222, tradeData: { label: 'abot|pending-fib', symbolId: 1 } },   // stale bot → cancel
        { orderId: 333, tradeData: { label: 'abot|pending-fib', symbolId: 41 } },  // stale bot → cancel
        { orderId: 444, tradeData: { label: 'my-own-manual-order', symbolId: 1 } }, // manual → untouchable
        { orderId: 555, tradeData: {} },                                            // unlabelled manual → untouchable
      ],
    },
  })
  const { reconcileBrokerPendingOrders } = await import('./pending-orders.js')
  const out = await reconcileBrokerPendingOrders(db, CREDS, deps)
  assert.equal(out.brokerOrders, 5)
  assert.equal(out.botMarked, 3)
  assert.equal(out.kept, 1)
  assert.equal(out.manual, 2)
  assert.deepEqual(out.cancelled.map(c => c.orderId).sort(), ['222', '333'])
  assert.deepEqual(calls.cancelled.sort(), [222, 333])
  assert.equal(out.failures.length, 0)
})

test('broker cleanup reports per-order cancel failures without throwing', async () => {
  const db = freshDb()
  const { deps } = makeDeps({
    reconcile: { position: [], order: [{ orderId: 777, tradeData: { label: 'pending-fib' } }] },
  })
  deps.exec.cancelOrder = async () => { throw new Error('ORDER_LOCKED') }
  const { reconcileBrokerPendingOrders } = await import('./pending-orders.js')
  const out = await reconcileBrokerPendingOrders(db, CREDS, deps)
  assert.equal(out.cancelled.length, 0)
  assert.equal(out.failures.length, 1)
  assert.match(out.failures[0].error, /ORDER_LOCKED/)
})

test('pending orders size DYNAMICALLY: uncapped by default, watchlist Max lots caps', async () => {
  // Default: no watchlist cap → requestedVolume null → risk gate sizes free.
  const db = freshDb()
  const { deps, calls } = makeDeps({ setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL }] })
  deps.risk.evaluateTrade = (_db, proposal) => {
    calls.riskEvents.push({ proposal, result: null })
    return { approved: true, adjusted_volume: 0.37 } // risk-based size, not min lot
  }
  await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  const prop = calls.riskEvents.find(e => e.proposal.symbol === 'EURUSD').proposal
  assert.equal(prop.requestedVolume, null, 'no hardcoded min-lot cap')
  assert.equal(calls.placed[0].volume, 37000, '0.37 lots × 100000 units')

  // Watchlist Max lots present → passes through as the cap.
  const db2 = freshDb()
  setState(db2, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true, maxVolume: 0.05 }]))
  const h2 = makeDeps({ setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL }] })
  const seen = []
  h2.deps.risk.evaluateTrade = (_db, proposal) => { seen.push(proposal); return { approved: true, adjusted_volume: 0.05 } }
  await managePendingOrders(db2, CREDS, SYMBOL_MAP, h2.deps)
  assert.equal(seen[0].requestedVolume, 0.05)
})
