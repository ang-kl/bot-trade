// ---------------------------------------------------------------------------
// pending-orders.test.js — full lifecycle of resting-limit-order mode against
// injected fakes, on the REAL db.js schema (in-memory). No network, no broker.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { managePendingOrders, persistFilledTrade } from './pending-orders.js'

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

// ---------------------------------------------------------------------------
// Build 2 (owner-approved 2026-07-27): pending-closed orders are bot orders
// too, duplicates collapse to the newest, and a total resting cap holds
// across placement.
// ---------------------------------------------------------------------------

test('broker cleanup recognises pending-closed labels as bot orders', async () => {
  const db = freshDb()
  const { deps, calls } = makeDeps({
    reconcile: {
      position: [],
      order: [
        { orderId: 61, tradeData: { label: 'ap|v1|other|low|Off|4h|-|pending-closed', symbolId: 3 } }, // orphan → cancel
        { orderId: 62, tradeData: { label: 'truly manual', symbolId: 3 } },                            // manual → keep
      ],
    },
  })
  const { reconcileBrokerPendingOrders } = await import('./pending-orders.js')
  const out = await reconcileBrokerPendingOrders(db, CREDS, deps)
  assert.equal(out.botMarked, 1)
  assert.equal(out.manual, 1)
  assert.deepEqual(calls.cancelled, [61])
})

test('broker cleanup collapses same-symbol same-side near-price duplicates to the newest', async () => {
  const db = freshDb()
  for (const id of ['710', '720']) {
    db.prepare(`
      INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note)
      VALUES ('EURUSD', '4h', ?, 1, 1.1, 1.09, 1.12, 0.01, '2030-01-01T00:00:00Z', 'working', 'pending-fib')
    `).run(id)
  }
  const { deps, calls } = makeDeps({
    reconcile: {
      position: [],
      order: [
        { orderId: 710, tradeData: { label: 'a|pending-fib', tradeSide: 'BUY', symbolId: 1 }, limitPrice: 1.10001, utcLastUpdateTimestamp: 1000 },
        { orderId: 720, tradeData: { label: 'a|pending-fib', tradeSide: 'BUY', symbolId: 1 }, limitPrice: 1.10002, utcLastUpdateTimestamp: 2000 }, // newer → survives
      ],
    },
  })
  const { reconcileBrokerPendingOrders } = await import('./pending-orders.js')
  const out = await reconcileBrokerPendingOrders(db, CREDS, deps)
  assert.deepEqual(calls.cancelled, [710], 'older duplicate cancelled, newer kept')
  assert.equal(out.kept, 1)
  assert.equal(db.prepare(`SELECT status FROM pending_orders WHERE order_id = '710'`).get().status, 'cancelled')
  assert.equal(db.prepare(`SELECT status FROM pending_orders WHERE order_id = '720'`).get().status, 'working')
})

test('broker cleanup keeps distinct-price same-symbol orders (not duplicates)', async () => {
  const db = freshDb()
  for (const id of ['810', '820']) {
    db.prepare(`
      INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note)
      VALUES ('EURUSD', '4h', ?, 1, 1.1, 1.09, 1.12, 0.01, '2030-01-01T00:00:00Z', 'working', 'pending-fib')
    `).run(id)
  }
  const { deps, calls } = makeDeps({
    reconcile: {
      position: [],
      order: [
        { orderId: 810, tradeData: { label: 'a|pending-fib', tradeSide: 'BUY', symbolId: 1 }, limitPrice: 1.10, utcLastUpdateTimestamp: 1000 },
        { orderId: 820, tradeData: { label: 'a|pending-fib', tradeSide: 'BUY', symbolId: 1 }, limitPrice: 1.15, utcLastUpdateTimestamp: 2000 },
      ],
    },
  })
  const { reconcileBrokerPendingOrders } = await import('./pending-orders.js')
  const out = await reconcileBrokerPendingOrders(db, CREDS, deps)
  assert.deepEqual(calls.cancelled, [], 'different levels are two real orders')
  assert.equal(out.kept, 2)
})

test('placement refuses past the PENDING_MAX_TOTAL cap', async () => {
  const db = freshDb()
  process.env.PENDING_MAX_TOTAL = '1'
  try {
    db.prepare(`
      INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note)
      VALUES ('GBPUSD', '4h', '910', 1, 1.3, 1.29, 1.32, 0.01, '2030-01-01T00:00:00Z', 'working', 'pending-closed')
    `).run()
    const { deps, calls } = makeDeps({ setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL }] })
    const out = await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
    assert.equal(calls.placed.length, 0, 'no order placed past the cap')
    assert.ok(out.skipped.some(s => /pending cap/.test(s)), `expected a pending-cap skip, got: ${out.skipped}`)
  } finally {
    delete process.env.PENDING_MAX_TOTAL
  }
})

// ---------------------------------------------------------------------------
// ACCOUNT SCOPING (05-08-2026) — traced from the closed-market path, found here
// ---------------------------------------------------------------------------

test('a placed row is STAMPED with the account whose creds placed it', async () => {
  const db = freshDb()
  const { deps } = makeDeps({ setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: SIGNAL }] })
  await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  const row = db.prepare(`SELECT account_id FROM pending_orders WHERE symbol = 'EURUSD'`).get()
  assert.equal(row.account_id, '123')
})

test("ANOTHER account's resting order is neither written off nor cancelled", async () => {
  // `reconcile` here is ONE account's book. Before scoping, every working row
  // missing from it was marked "gone at broker" and handed to cancelOrder with
  // THIS pass's credentials — judging and cancelling a foreign account's order.
  // It is the same defect that ran thirteen deep on the closed-market path.
  const db = freshDb()
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note, account_id)
    VALUES ('EURUSD', '4h', '777', 1, 1.1, 1.095, 1.11, 0.01, '2030-01-01T00:00:00Z', 'working', 'pending-fib', '999')
  `).run()
  // This account's broker book is empty, and price is far through the foreign
  // row's stop — which would have triggered the invalidation cancel too.
  const { deps, calls } = makeDeps({ reconcile: { order: [], position: [] }, lastClose: { EURUSD: 1.0 } })
  await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)

  const row = db.prepare(`SELECT status FROM pending_orders WHERE order_id = '777'`).get()
  assert.equal(row.status, 'working', "another account's order is not ours to retire")
  assert.deepEqual(calls.cancelled, [], 'and certainly not ours to cancel with our credentials')
})

test('a legacy unattributed row is still claimed — not orphaned forever', async () => {
  // Rows written before the stamp exist in production. Leaving them
  // unclaimable would strand them 'working' with nothing able to settle them.
  const db = freshDb()
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note, account_id)
    VALUES ('EURUSD', '4h', '778', 1, 1.1, 1.095, 1.11, 0.01, '2030-01-01T00:00:00Z', 'working', 'pending-fib', NULL)
  `).run()
  const { deps } = makeDeps({ reconcile: { order: [], position: [] } })
  await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  const row = db.prepare(`SELECT status FROM pending_orders WHERE order_id = '778'`).get()
  assert.equal(row.status, 'expired', 'legacy rows stay settleable by whichever pass sees them')
})

test('a filled fib order carries its approval id onto the trade', () => {
  // §70.9 lineage. pending_orders.risk_event_id was written at placement and
  // dropped at the fill, so the trade had no way back to its authorisation.
  const db = freshDb()
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note, account_id, risk_event_id)
    VALUES ('EURUSD', '4h', '880', 1, 1.1, 1.095, 1.11, 0.01, '2030-01-01T00:00:00Z', 'working', 'pending-fib', '123', 97150)
  `).run()
  const row = db.prepare(`SELECT * FROM pending_orders WHERE order_id = '880'`).get()
  persistFilledTrade(db, row, { positionId: 555, price: 1.1002 }, '123')
  const t = db.prepare(`SELECT risk_event_id, account_id FROM trades WHERE ctrader_position_id = '555'`).get()
  assert.equal(t.risk_event_id, 97150)
  assert.equal(t.account_id, '123')
})

// ---------------------------------------------------------------------------
// The position's clock starts at the FILL — 2026-08-10.
//
// `expires_at` (order deadline) was written straight into
// `monitored_positions.time_cap_at` (position deadline). A fib limit rests for
// most of its life by design, so the position inherited only the REMAINDER of
// its intended hold — and a fill after the deadline inherited a cap already in
// the past. evaluatePosition checks the cap before anything else, so those
// closed on the first monitor pass: thirteen in the hour after the open.
// ---------------------------------------------------------------------------

test('a fill late in the order life still gets its FULL intended hold', () => {
  const db = freshDb()
  // Placed 7h ago with an 8h hold — under the old rule this position would
  // have been born with 60 minutes to live instead of 480.
  const placed = new Date(Date.now() - 7 * 3_600_000).toISOString()
  const expires = new Date(Date.parse(placed) + 480 * 60_000).toISOString()
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note, account_id, time_cap_minutes)
    VALUES ('EURUSD', '15m', '901', 1, 1.1, 1.095, 1.11, 0.01, ?, ?, 'working', 'pending-fib', '123', 480)
  `).run(placed, expires)
  const row = db.prepare(`SELECT * FROM pending_orders WHERE order_id = '901'`).get()

  const openedMs = Date.now()
  persistFilledTrade(db, row, { positionId: 901, price: 1.1002, tradeData: { openTimestamp: openedMs } }, '123')

  const mp = db.prepare(`SELECT time_cap_at FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
  const capMs = Date.parse(mp.time_cap_at)
  assert.ok(capMs > Date.now() + 470 * 60_000, 'the hold is measured from the fill, not the placement')
  assert.ok(capMs < Date.now() + 490 * 60_000)
  assert.ok(capMs > Date.parse(expires), 'and therefore outlives the order deadline it used to copy')
})

test('a fill AFTER the order deadline is not born already expired', () => {
  // The Monday-open case: an order that rested through the weekend and filled
  // on the gap. Copying expires_at made time_cap_at two days stale, so the
  // very first monitor pass returned FULL_EXIT time_cap_expired.
  const db = freshDb()
  const placed = new Date(Date.now() - 72 * 3_600_000).toISOString()
  const expires = new Date(Date.now() - 48 * 3_600_000).toISOString()
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note, account_id, time_cap_minutes)
    VALUES ('EURUSD', '15m', '902', 1, 1.1, 1.095, 1.11, 0.01, ?, ?, 'working', 'pending-fib', '123', 480)
  `).run(placed, expires)
  const row = db.prepare(`SELECT * FROM pending_orders WHERE order_id = '902'`).get()
  persistFilledTrade(db, row, { positionId: 902, price: 1.1002 }, '123')

  const mp = db.prepare(`SELECT time_cap_at FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
  assert.ok(Date.parse(mp.time_cap_at) > Date.now(), 'a position may not be born past its own cap')
})

test('a legacy row recovers its hold from the placed→expires span', () => {
  // Rows written before time_cap_minutes existed. The span IS the
  // expiryMinutes the placement computed, so the intent is recoverable.
  const db = freshDb()
  const placed = new Date(Date.now() - 200 * 60_000).toISOString()
  const expires = new Date(Date.parse(placed) + 240 * 60_000).toISOString()
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note, account_id)
    VALUES ('EURUSD', '5m', '903', 1, 1.1, 1.095, 1.11, 0.01, ?, ?, 'working', 'pending-fib', '123')
  `).run(placed, expires)
  const row = db.prepare(`SELECT * FROM pending_orders WHERE order_id = '903'`).get()
  persistFilledTrade(db, row, { positionId: 903, price: 1.1002 }, '123')

  const mp = db.prepare(`SELECT time_cap_at FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
  const capMs = Date.parse(mp.time_cap_at)
  assert.ok(capMs > Date.now() + 235 * 60_000 && capMs < Date.now() + 245 * 60_000,
    '240 minutes from the fill, not the 40 minutes left on the order')
})

test('a signal with no cap of its own yields no position cap', () => {
  // The order took the 24h fallback expiry; that fallback is an order-lifetime
  // default and was never a statement about how long to hold. A null cap hands
  // the position to the loss-guardian's maxHoldHours, which is the designed
  // backstop for exactly this case.
  const db = freshDb()
  const placed = new Date(Date.now() - 60 * 60_000).toISOString()
  const expires = new Date(Date.parse(placed) + 24 * 3_600_000).toISOString()
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note, account_id)
    VALUES ('EURUSD', '4h', '904', 1, 1.1, 1.095, 1.11, 0.01, ?, ?, 'working', 'pending-fib', '123')
  `).run(placed, expires)
  const row = db.prepare(`SELECT * FROM pending_orders WHERE order_id = '904'`).get()
  persistFilledTrade(db, row, { positionId: 904, price: 1.1002 }, '123')

  const mp = db.prepare(`SELECT time_cap_at FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
  assert.equal(mp.time_cap_at, null)
})

test('placement records the hold alongside the order deadline', async () => {
  const db = freshDb()
  const { deps } = makeDeps({
    setups: [{ symbol: 'EURUSD', timeframe: '4h', signal: { bias: 'long', entry: 1.1, sl: 1.09, tp1: 1.12, conviction: 7, time_cap_minutes: 4320 } }],
  })
  await managePendingOrders(db, CREDS, SYMBOL_MAP, deps)
  const row = db.prepare(`SELECT time_cap_minutes, placed_at, expires_at FROM pending_orders WHERE symbol = 'EURUSD'`).get()
  assert.equal(row.time_cap_minutes, 4320, 'the hold is stored, not inferred later')
  const span = (Date.parse(row.expires_at) - Date.parse(row.placed_at)) / 60_000
  assert.ok(Math.abs(span - 4320) < 2, 'and the order deadline still tracks it')
})

// ---------------------------------------------------------------------------
// ACCEPTANCE 2.6.4 — Fill-Time Clock Calculation.
//
// The plan asks: "verify duration evaluates from T_fill, not T_placed". The
// cases above cover the behaviour this protects (a late fill keeps its full
// hold; a post-deadline fill is not born expired). This states the identity
// itself, as an equation rather than a bound, so a future change that merely
// moves the cap in the right direction cannot pass for correctness.
// ---------------------------------------------------------------------------

test('2.6.4 — time_cap_at == T_fill + hold, exactly, and never T_placed + hold', () => {
  const db = freshDb()
  const HOLD_MIN = 240
  const placedMs = Date.now() - 95 * 60_000          // rested 95 minutes
  const placed = new Date(placedMs).toISOString()
  const expires = new Date(placedMs + HOLD_MIN * 60_000).toISOString()
  db.prepare(`
    INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note, account_id, time_cap_minutes)
    VALUES ('EURUSD', '4h', '2604', 1, 1.1, 1.095, 1.11, 0.01, ?, ?, 'working', 'pending-fib', '123', ?)
  `).run(placed, expires, HOLD_MIN)
  const row = db.prepare(`SELECT * FROM pending_orders WHERE order_id = '2604'`).get()

  const fillMs = Date.now()
  persistFilledTrade(db, row, { positionId: 2604, price: 1.1002, tradeData: { openTimestamp: fillMs } }, '123')

  const capMs = Date.parse(db.prepare(`SELECT time_cap_at FROM monitored_positions WHERE symbol = 'EURUSD'`).get().time_cap_at)
  assert.equal(capMs, fillMs + HOLD_MIN * 60_000, 'the cap is fill + hold, to the millisecond')
  assert.notEqual(capMs, placedMs + HOLD_MIN * 60_000)
  // The 95 minutes the order spent resting are the whole bug: under the old
  // rule this position was born with 145 minutes to live instead of 240.
  assert.equal(capMs - (placedMs + HOLD_MIN * 60_000), 95 * 60_000)
})
