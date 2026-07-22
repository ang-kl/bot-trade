// node --test agent/services/pnl-backfill.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { backfillClosedPnl, shouldRunPnlBackfill } from './pnl-backfill.js'

const NOW = 1_700_000_000_000
// A closing deal as cTrader returns it: realised money on closePositionDetail,
// scaled by moneyDigits (2 → cents). executionTimestamp lets the fake API
// return it only in the matching weekly window, like the real wsGetDeals.
const deal = (positionId, grossCents, { swapCents = 0, commCents = 0, ts = NOW - 3_600_000 } = {}) => ({
  positionId,
  dealId: `${positionId}-${grossCents}`,
  executionTimestamp: ts,
  closePositionDetail: { grossProfit: grossCents, swap: swapCents, commission: commCents, moneyDigits: 2 },
})

// Window-aware fake of wsGetDeals: returns only the deals whose timestamp
// falls in [t0, t1), so the service's weekly chunking is exercised honestly
// (each deal surfaces in exactly one chunk, never double-counted).
const dealsApi = (all) => async (t0, t1) => ({ deal: all.filter(d => d.executionTimestamp >= t0 && d.executionTimestamp < t1) })

function seedClosed(db, { positionId, net = null }) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl)
     VALUES ('EURUSD', 'BUY', 'closed', ?, ?)`
  ).run(String(positionId), net)
}

test('fills NULL net_pnl on a broker-closed trade from its close deal', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 111, net: null })
  // gross -5000 cents = -$50, minus $2 commission → -$52 net.
  const getDeals = dealsApi([deal(111, -5000, { commCents: -200 })])

  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(r.backfilled, 1)
  const row = db.prepare(`SELECT net_pnl, gross_pnl FROM trades WHERE ctrader_position_id = '111'`).get()
  assert.equal(row.net_pnl, -52)
  assert.equal(row.gross_pnl, -50)
})

test('never overwrites a net_pnl the bot already stamped', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 222, net: 12.34 }) // bot-computed, must be preserved
  const getDeals = dealsApi([deal(222, -9999)]) // would say something else
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(r.backfilled, 0)
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '222'`).get().net_pnl, 12.34)
})

test('aggregates partial closes (several deals) into one net figure', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 333, net: null })
  const getDeals = dealsApi([deal(333, 3000), deal(333, 1500, { swapCents: -100 })])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(r.backfilled, 1)
  // (30 + 15) gross, swap -1 → 44 net.
  const row = db.prepare(`SELECT net_pnl, gross_pnl FROM trades WHERE ctrader_position_id = '333'`).get()
  assert.equal(row.net_pnl, 44)
  assert.equal(row.gross_pnl, 45)
})

test('skips the broker round-trip entirely when no closed trade is missing P&L', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 444, net: 5 }) // already filled
  let called = false
  const getDeals = async () => { called = true; return { deal: [] } }
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(called, false, 'must not fetch deals when there is no gap')
  assert.deepEqual(r, { backfilled: 0, closingDeals: 0, scanned: 0 })
})

test('an open trade is never backfilled, even with a matching deal', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl) VALUES ('EURUSD','BUY','open','555',NULL)`).run()
  seedClosed(db, { positionId: 556, net: null }) // a real gap so the fetch runs
  const getDeals = dealsApi([deal(555, -1000), deal(556, 700)])
  await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id='555'`).get().net_pnl, null)
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id='556'`).get().net_pnl, 7)
})

// shouldRunPnlBackfill: the trigger gap this fix closes. Before this fix,
// loop.js only checked closedDetected — a trade closed ONLY via the orphan
// sweep or the dedup sweep (reconciler.js) could never trigger the backfill
// and sat permanently excluded from Edge Health (alpha-decay.js's
// `net_pnl IS NOT NULL` read).
test('shouldRunPnlBackfill: true when closedDetected has entries (pre-existing path)', () => {
  assert.equal(shouldRunPnlBackfill({ closedDetected: [{ symbol: 'EURUSD' }], orphansClosed: [], dupsClosed: [] }), true)
})

test('shouldRunPnlBackfill: true when ONLY orphansClosed has entries — the fixed gap', () => {
  assert.equal(shouldRunPnlBackfill({ closedDetected: [], orphansClosed: [{ tradeId: 1 }], dupsClosed: [] }), true)
})

test('shouldRunPnlBackfill: true when ONLY dupsClosed has entries — the fixed gap', () => {
  assert.equal(shouldRunPnlBackfill({ closedDetected: [], orphansClosed: [], dupsClosed: [{ tradeId: 2 }] }), true)
})

test('shouldRunPnlBackfill: false when every reconcile path found nothing to close', () => {
  assert.equal(shouldRunPnlBackfill({ closedDetected: [], orphansClosed: [], dupsClosed: [] }), false)
})

test('shouldRunPnlBackfill: tolerates a missing/undefined result shape', () => {
  assert.equal(shouldRunPnlBackfill({}), false)
  assert.equal(shouldRunPnlBackfill(undefined), false)
})

test('end-to-end: a trade closed ONLY via the orphan-sweep path (net_pnl NULL, no closedDetected entry) gets backfilled once shouldRunPnlBackfill gates it on', async () => {
  const db = initDB(':memory:')
  // Simulates reconciler.js's orphan sweep: an open trade whose position
  // vanished at the broker gets marked closed directly, net_pnl left NULL —
  // this is the exact shape reconciler.test.js's orphan-sweep test produces.
  seedClosed(db, { positionId: 555, net: null })
  const reconcileResult = { closedDetected: [], orphansClosed: [{ tradeId: 1, symbol: 'GBPUSD', positionId: '555' }], dupsClosed: [] }

  assert.equal(shouldRunPnlBackfill(reconcileResult), true)
  const getDeals = dealsApi([deal(555, -1000, { commCents: -50 })])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(r.backfilled, 1)
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '555'`).get().net_pnl, -10.5)
})
