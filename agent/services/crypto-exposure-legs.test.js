// node --test agent/services/crypto-exposure-legs.test.js
//
// Claude · № 13,126 11-Oct (ordered № 13,125; claude-builder). The exposure
// guard counts net currency legs across held positions plus the proposal.
// Its leg split read any 6-letter symbol as an FX pair, so a crypto CFD
// quoted in USD became a short-USD leg (BTCUSD, XRPUSD, BCHUSD, DOTUSD,
// UNIUSD, XLMUSD) while a 7-letter one did not (DOGEUSD, AVAXUSD, LINKUSD).
// Measured 11-10 on demo 47790949: XRPUSD and DOGEUSD held, every further
// 6-letter crypto long refused `overexposed_USD=-2`. A crypto CFD is one
// instrument, like an index or a commodity quoted in USD. Red before the fix
// (BTCUSD split into BTC/USD legs), green after.
import test from 'node:test'
import assert from 'node:assert/strict'
import { currencyLegs, netExposure, exposureVerdict } from './risk.js'

test('currencyLegs — a crypto CFD is one leg whatever its name length', () => {
  assert.deepEqual(currencyLegs('BTCUSD', 'long'), { BTCUSD: 1 })
  assert.deepEqual(currencyLegs('XRPUSD', 'BUY'), { XRPUSD: 1 })
  assert.deepEqual(currencyLegs('DOGEUSD', 'BUY'), { DOGEUSD: 1 })
  assert.deepEqual(currencyLegs('DOTUSD', 'SELL'), { DOTUSD: -1 })
  assert.deepEqual(currencyLegs('BTCEUR', 'short'), { BTCEUR: -1 })
})

test('currencyLegs — FX and metals keep the base/quote split', () => {
  assert.deepEqual(currencyLegs('EURUSD', 'long'), { EUR: 1, USD: -1 })
  assert.deepEqual(currencyLegs('XAUUSD', 'short'), { XAU: -1, USD: 1 })
  assert.deepEqual(currencyLegs('USDJPY', 'long'), { USD: 1, JPY: -1 })
  assert.deepEqual(currencyLegs('EURGBP', 'short'), { EUR: -1, GBP: 1 })
  assert.deepEqual(currencyLegs('US30', 'long'), { US30: 1 })
})

test('currencyLegs — a six-letter symbol whose halves are not both currency codes is one leg (Codex P2 on #1317)', () => {
  // broker crypto outside any name list, and commodity CFDs named like pairs
  for (const s of ['ETCUSD', 'SUIUSD', 'TONUSD', 'APTUSD', 'XBRUSD', 'XTIUSD', 'XNGUSD']) {
    assert.deepEqual(currencyLegs(s, 'long'), { [s]: 1 }, s)
  }
})

test('exposure — crypto longs beside an FX long do not accumulate a USD leg', () => {
  const held = [{ symbol: 'XRPUSD', side: 'BUY' }, { symbol: 'DOGEUSD', side: 'BUY' }, { symbol: 'EURUSD', side: 'BUY' }]
  const exposure = netExposure(held, { symbol: 'BCHUSD', side: 'BUY' })
  assert.equal(exposure.USD, -1, 'only the FX long is a USD leg')
  assert.equal(exposure.XRPUSD, 1); assert.equal(exposure.DOGEUSD, 1); assert.equal(exposure.BCHUSD, 1)
  const v = exposureVerdict(held, { symbol: 'BCHUSD', side: 'BUY' }, { maxCurrencyExposure: 2 })
  assert.equal(v.block, false)
  assert.equal(v.reason, null)
})

test('exposure — the FX rule still bites at the same limit', () => {
  const held = [{ symbol: 'EURUSD', side: 'BUY' }, { symbol: 'GBPUSD', side: 'BUY' }, { symbol: 'AUDUSD', side: 'BUY' }]
  const v = exposureVerdict(held, { symbol: 'NZDUSD', side: 'BUY' }, { maxCurrencyExposure: 2 })
  assert.equal(v.block, true)
  assert.equal(v.reason, 'overexposed_USD=-4')
})

test('exposure — three longs on one crypto symbol still count against that symbol', () => {
  const held = [{ symbol: 'BTCUSD', side: 'BUY' }, { symbol: 'BTCUSD', side: 'BUY' }, { symbol: 'BTCUSD', side: 'BUY' }]
  const v = exposureVerdict(held, { symbol: 'BTCUSD', side: 'BUY' }, { maxCurrencyExposure: 2 })
  assert.equal(v.block, true)
  assert.equal(v.reason, 'overexposed_BTCUSD=4')
})
