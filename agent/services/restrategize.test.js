// node --test agent/services/restrategize.test.js
//
// Post-tamper re-strategize: level recalibration math, risk audit, and the
// per-kind behaviour (reversal amends fresh SL/TP; volume syncs the ledger
// and audits risk; owner-moved levels are respected and only audited).

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recalibrateLevels, auditRisk, restrategizeAfterTamper, summarize } from './restrategize.js'

function seed(db, { positionId = '42', side = 'long', entry = 100, sl = 99, tp = 102, lots = 0.1 } = {}) {
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at)
     VALUES ('XAUUSD', ?, ?, ?, ?, 'autopilot', 'open', datetime('now'))`
  ).run(side === 'long' ? 'BUY' : 'SELL', entry, lots, positionId).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, source, status)
     VALUES ('XAUUSD', ?, ?, ?, ?, ?, 'test', 'autopilot', 'active')`
  ).run(tradeId, side, entry, sl, tp)
  return tradeId
}

// Rising 1h series: close climbs 1 per bar → momentum positive, ATR ≈ 1.
const risingBars = Array.from({ length: 40 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 99.5 + i, c: 100.5 + i, v: 10 }))

test('recalibrateLevels: 1×ATR stop, minRR reward, direction-aware', () => {
  const long = recalibrateLevels({ side: 'long', price: 100, atr: 2, rr: 1.5 })
  assert.deepEqual(long, { sl: 98, tp: 103, slDist: 2 })
  const short = recalibrateLevels({ side: 'short', price: 100, atr: 2, rr: 1.5 })
  assert.deepEqual(short, { sl: 102, tp: 97, slDist: 2 })
  // ATR unknown → minSlPct floor keeps a real stop
  const floor = recalibrateLevels({ side: 'long', price: 100, atr: null, minSlPct: 0.001, rr: 1.5 })
  assert.equal(floor.slDist, 0.1)
  assert.equal(recalibrateLevels({ side: 'long', price: 0, atr: 1 }), null)
})

test('auditRisk flags over-cap risk, missing SL, and thin R:R', () => {
  const riskCfg = { perTradeRiskPct: 0.01, minRR: 1.5 }
  // XAUUSD ~100 lots-per-unit contract: use a generic symbol so usdLossPerLot
  // resolves via its default path — issues list is what we assert on.
  const bad = auditRisk({ symbol: 'EURUSD', side: 'long', entry: 1.1, sl: null, tp: 1.2, lots: 1, balance: 1000, riskCfg })
  assert.ok(bad.issues.some(i => /NO stop loss/.test(i)))
  const thin = auditRisk({ symbol: 'EURUSD', side: 'long', entry: 1.1, sl: 1.09, tp: 1.105, lots: 0.01, balance: 100000, riskCfg })
  assert.ok(thin.issues.some(i => /R:R/.test(i)))
  assert.equal(thin.rr, 0.5)
})

test('reversal → fresh SL/TP amended at the broker and persisted, momentum verdict included', async () => {
  const db = initDB(':memory:')
  seed(db, { side: 'long' }) // owner reversed TO long; market is rising → aligned
  const amends = []
  const out = await restrategizeAfterTamper(db, { host: 'h' }, { kind: 'reversed', symbol: 'XAUUSD', positionId: '42', from: 'short', to: 'long' }, {
    fetchBars: async () => risingBars,
    amend: async (_c, args) => { amends.push(args); return { ok: true } },
  })
  assert.equal(out.did, 'recalibrated')
  assert.equal(out.aligned, true)
  assert.equal(amends.length, 1)
  assert.equal(amends[0].positionId, '42')
  assert.ok(amends[0].stopLoss < 139.5 && amends[0].stopLoss > 130) // below last close ~139.5
  assert.ok(amends[0].takeProfit > 139.5)
  const row = db.prepare('SELECT * FROM monitored_positions').get()
  assert.equal(row.current_sl, amends[0].stopLoss)
  assert.equal(row.current_tp, amends[0].takeProfit)
  assert.match(row.thesis, /recalibrated/)
})

test('reversal with recalibration disabled → verdict only, no amend', async () => {
  const db = initDB(':memory:')
  seed(db, { side: 'short' }) // reversed to short while market rises → NOT aligned
  setState(db, 'tamper_restrategize', 'false')
  const amends = []
  const out = await restrategizeAfterTamper(db, { host: 'h' }, { kind: 'reversed', symbol: 'XAUUSD', positionId: '42', from: 'long', to: 'short' }, {
    fetchBars: async () => risingBars,
    amend: async (_c, args) => { amends.push(args) },
  })
  assert.equal(out.did, 'verified_only')
  assert.equal(out.aligned, false)
  assert.ok(out.proposed.sl > 139.5) // short: SL above price
  assert.equal(amends.length, 0)
  assert.match(summarize(out), /not applied/)
})

test('volume change → trades.volume synced by ratio and risk audited', async () => {
  const db = initDB(':memory:')
  const tradeId = seed(db, { lots: 0.1 })
  setState(db, 'account_balance_usd', '10000')
  const out = await restrategizeAfterTamper(db, { host: 'h' }, { kind: 'volume', symbol: 'XAUUSD', positionId: '42', from: 10, to: 50 })
  assert.equal(out.did, 'risk_audit')
  assert.equal(out.lots, 0.5) // 0.1 × (50/10)
  assert.equal(db.prepare('SELECT volume FROM trades WHERE id = ?').get(tradeId).volume, 0.5)
})

test('owner-moved SL/TP → audit only, never amends', async () => {
  const db = initDB(':memory:')
  seed(db)
  const amends = []
  const out = await restrategizeAfterTamper(db, { host: 'h' }, { kind: 'sl_moved', symbol: 'XAUUSD', positionId: '42', from: 99, to: 95 }, {
    amend: async () => { amends.push(1) },
  })
  assert.equal(out.did, 'risk_audit')
  assert.equal(amends.length, 0)
})

test('summarize renders momentum disagreement and risk issues', () => {
  assert.match(summarize({ did: 'recalibrated', aligned: false, sl: 1, tp: 2, issues: [] }), /does NOT support/)
  assert.match(summarize({ did: 'risk_audit', riskUsd: 50, capUsd: 10, rr: 2, issues: ['risk $50 exceeds your 1.0% cap ($10)'] }), /exceeds/)
  assert.match(summarize({ did: 'risk_audit', riskUsd: 5, capUsd: 10, rr: 2, issues: [] }), /Within your risk limits/)
})
