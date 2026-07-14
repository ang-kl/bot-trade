// node --test agent/services/sizing-preview.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { sizingPreview } from './sizing-preview.js'
import { instrumentType } from '../lib/contracts.js'

function mkDb({ balance = 10_000, watch, prices } = {}) {
  const db = initDB(':memory:')
  if (balance != null) setState(db, 'account_balance_usd', String(balance))
  setState(db, 'watchlist_json', JSON.stringify(watch ?? [{ symbol: 'EURUSD', enabled: true }]))
  if (prices) {
    setState(db, 'last_scan_results', JSON.stringify({
      scans: Object.entries(prices).map(([symbol, price]) => ({ symbol, price })),
    }))
  }
  return db
}

test('instrumentType classifies each family', () => {
  assert.equal(instrumentType('EURUSD'), 'fx')
  assert.equal(instrumentType('USDJPY'), 'fx (USD-base)')
  assert.equal(instrumentType('EURGBP'), 'fx cross')
  assert.equal(instrumentType('XAUUSD'), 'metal')
  assert.equal(instrumentType('NATGAS'), 'energy')
  assert.equal(instrumentType('COCOA'), 'agri')
  assert.equal(instrumentType('NAS100'), 'index')
  assert.equal(instrumentType('BTCUSD'), 'crypto')
  assert.equal(instrumentType('MSFT.US'), 'equity')
  assert.equal(instrumentType('???'), 'other')
})

test('EURUSD auto lots follow the fixed-fractional formula exactly', () => {
  // balance 10k, default risk 1% → $100 budget. minSLDistancePct default 0.15%
  // of 1.10 = 0.00165 distance × 100k = $165/lot → floor(100/165 · 100)/100
  const db = mkDb({ prices: { EURUSD: 1.10 } })
  const out = sizingPreview(db)
  const row = out.rows.find(r => r.symbol === 'EURUSD')
  assert.equal(out.budget, 100)
  assert.ok(row.autoLots > 0)
  const expected = Math.floor((out.budget / row.usdPerLot) * 100) / 100
  assert.equal(row.autoLots, expected)
  assert.equal(row.type, 'fx')
})

test('USDJPY converts the quote-currency loss via price (no 150× blowup)', () => {
  const db = mkDb({ watch: [{ symbol: 'USDJPY', enabled: true }], prices: { USDJPY: 147.5 } })
  const out = sizingPreview(db)
  const row = out.rows.find(r => r.symbol === 'USDJPY')
  assert.ok(row.autoLots > 0, `USDJPY should size, got ${JSON.stringify(row)}`)
  // usd/lot at 0.15% stop: (147.5×0.0015×100000)/147.5 = $150 → 0.66 lots on $100
  assert.ok(Math.abs(row.usdPerLot - 150) < 1, `got ${row.usdPerLot}`)
})

test('missing price or balance degrades to an explanatory note, never a guess', () => {
  const noPrice = sizingPreview(mkDb({}))
  assert.equal(noPrice.rows[0].autoLots, null)
  assert.match(noPrice.rows[0].note, /no scan price/)

  const noBal = sizingPreview(mkDb({ balance: null, prices: { EURUSD: 1.1 } }))
  assert.equal(noBal.rows[0].autoLots, null)
  assert.match(noBal.rows[0].note, /balance unknown/)
})

test('manual cap only ever reduces the auto size', () => {
  const db = mkDb({ watch: [{ symbol: 'EURUSD', enabled: true, maxVolume: 0.05 }], prices: { EURUSD: 1.10 } })
  const row = sizingPreview(db).rows[0]
  assert.equal(row.maxCap, 0.05)
  assert.equal(row.effectiveLots, Math.min(row.autoLots, 0.05))
})

test('negative legacy cap is ignored, not applied', () => {
  const db = mkDb({ watch: [{ symbol: 'EURUSD', enabled: true, maxVolume: -0.02 }], prices: { EURUSD: 1.10 } })
  const row = sizingPreview(db).rows[0]
  assert.equal(row.maxCap, null)
  assert.equal(row.effectiveLots, row.autoLots)
})
