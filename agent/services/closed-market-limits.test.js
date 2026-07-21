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
  placeClosedMarketLimit,
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
