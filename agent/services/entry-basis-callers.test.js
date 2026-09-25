// node --test agent/services/entry-basis-callers.test.js
//
// WP-A (dual admission, 25-09-2026): the two call sites that used to pass a
// hardcoded `basis: 'bar'` with a VARIABLE producer id (loop.js autoTrade's
// retired-producer ask, closed-market-limits.js's fence) now name no basis,
// so admitEntry takes it from the registered producer. A tick-declared
// producer sent through either reads `entry_mode_basis` on a bar-only
// account — the true reason — and never `producer_basis_conflict` against a
// literal the caller did not mean. The decision_log keeps ONE row per
// (account, producer, epoch), so the first reason recorded is the one a
// reader sees: a wrong first reason would mask the real one for the epoch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { _resetRefusalDedupe } from './entry-mode.js'
import { placeClosedMarketLimit } from './closed-market-limits.js'

const ACCT = '42'
const SYNTH = { consensus_bias: 'long', entry: 100, sl: 98, tp1: 104, tp2: 106, strategy: 'rsi2_reversion', timeframe: '8h', overall_conviction: 8 }

function entryModeReasons(db, producerId) {
  return db.prepare(`SELECT reason, detail_json AS detail FROM decision_log WHERE stage = 'entry_mode' AND account_id = ? ORDER BY id`).all(ACCT)
    .filter(r => { try { return JSON.parse(r.detail || '{}').producerId === producerId } catch { return false } })
    .map(r => r.reason)
}

test('closed-market-limits: a tick-declared producer through the fence is refused entry_mode_basis, not producer_basis_conflict', async () => {
  const db = initDB(':memory:')
  _resetRefusalDedupe()
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  const placed = []
  const r = await placeClosedMarketLimit(db, { host: 'demo', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: ACCT }, 'US30', SYNTH, {
    producerId: 'tick_momentum',
    risk: { loadRiskConfig: () => ({}), evaluateTrade: () => ({ approved: true, adjusted_volume: 0.1 }), persistRiskEvent: () => {} },
    sizing: { getVolumeMeta: async () => ({ digits: 2, lotSize: 100, minVolume: 1 }), lotsToVolume: (l) => ({ volume: Math.round(l * 100), belowMin: false }), relativePoints: (d, dg) => Math.round(d * Math.pow(10, dg)) },
    exec: { placeOrder: async (_c, p) => { placed.push(p); return { order: { orderId: 1 } } }, cancelOrder: async () => ({}) },
    now: 1_700_000_000_000,
  })
  assert.ok(!r.placed)
  assert.equal(r.skipped, 'entry_mode')
  assert.match(r.reason, /^entry_mode_basis: TIME_BASED admits bar producers, tick_momentum is tick/, 'RED if the call site keeps basis: \'bar\' (producer_basis_conflict)')
  assert.equal(placed.length, 0)
  assert.deepEqual(entryModeReasons(db, 'tick_momentum').map(x => x.split(':')[0]), ['entry_mode_basis'])
})

test('loop.js autoTrade: the retired-producer ask names no basis — a tick-declared producer records entry_mode_basis as the epoch\'s one decision_log reason', async () => {
  const db = initDB(':memory:')
  _resetRefusalDedupe()
  const saved = { id: process.env.CTRADER_CLIENT_ID, secret: process.env.CTRADER_CLIENT_SECRET }
  process.env.CTRADER_CLIENT_ID = 'c'; process.env.CTRADER_CLIENT_SECRET = 's'
  try {
    setState(db, 'ctrader_access_token', 't')
    // A closed market with the resting-limit feature OFF: autoTrade asks the
    // fence at the top (the site under test), then takes the legacy
    // closed-market branch, which records a risk event and places nothing —
    // no broker, no network.
    setState(db, 'closed_market_limits_json', JSON.stringify({ on: false }))
    db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES (?, ?, ?)`).run('EURUSD', '[]', 'UTC')
    const { autoTrade } = await import('../loop.js')
    const out = await autoTrade(db, 'EURUSD', SYNTH, {}, { accountId: ACCT, isLive: false, producerId: 'tick_momentum' })
    assert.equal(out ?? null, null, 'nothing placed')
    const reasons = entryModeReasons(db, 'tick_momentum')
    assert.ok(reasons.length >= 1, 'the fence was asked')
    assert.match(reasons[0], /^entry_mode_basis: TIME_BASED admits bar producers, tick_momentum is tick/, 'RED if loop.js keeps basis: \'bar\' (the first — and for this epoch only — reason would be producer_basis_conflict)')
  } finally {
    if (saved.id === undefined) delete process.env.CTRADER_CLIENT_ID; else process.env.CTRADER_CLIENT_ID = saved.id
    if (saved.secret === undefined) delete process.env.CTRADER_CLIENT_SECRET; else process.env.CTRADER_CLIENT_SECRET = saved.secret
  }
})
