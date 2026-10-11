// node --test agent/lib/contracts-crypto.test.js
//
// Claude · № 13,126 11-Oct (ordered № 13,125; claude-builder). The crypto
// name test the exposure guard's leg split reads. Measured 11-10 on demo
// 47790949: BTCUSD/XRPUSD/BCHUSD/DOTUSD/UNIUSD/XLMUSD were read as FX pairs
// (a USD leg each) and DOGEUSD/AVAXUSD as single units, so two crypto longs
// tripped `overexposed_USD` for every further 6-letter crypto while a
// 7-letter one passed. This pins the name test itself; the leg split's own
// behaviour is pinned in services/crypto-exposure-legs.test.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isCryptoSymbol, instrumentType, contractSize, CRYPTO_BASES } from './contracts.js'

test('isCryptoSymbol — every broker crypto CFD, 6 or 7 letters, against any fiat quote', () => {
  for (const s of ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'BNBUSD', 'ADAUSD', 'LTCUSD', 'DOGEUSD', 'AVAXUSD', 'LINKUSD', 'DOTUSD', 'BCHUSD', 'XLMUSD', 'UNIUSD', 'TRXUSD', 'MATICUSD', 'BTCEUR', 'ETHGBP', 'BTCAUD']) {
    assert.equal(isCryptoSymbol(s), true, s)
  }
  assert.equal(isCryptoSymbol('btcusd'), true, 'case-insensitive')
  assert.equal(isCryptoSymbol(' dogeusd '), true, 'trimmed')
})

test('isCryptoSymbol — FX, metals, indices, perps, dotted listings and empties are not crypto', () => {
  for (const s of ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD', 'US30', 'NAS100', 'NATGAS', 'BTC-PERP', 'SOL.AU', 'SOLV.US', 'AAPL.US', '', null, undefined]) {
    assert.equal(isCryptoSymbol(s), false, String(s))
  }
})

test('isCryptoSymbol — the name list is the one exported, and it changes neither instrumentType nor contractSize', () => {
  assert.ok(CRYPTO_BASES.includes('DOGE') && CRYPTO_BASES.includes('DOT') && CRYPTO_BASES.includes('BTC'))
  assert.ok(Object.isFrozen(CRYPTO_BASES))
  // The sizing table is deliberately untouched by this change: a crypto not
  // in TYPE_BY_SYMBOL still classifies and sizes exactly as before.
  assert.equal(instrumentType('BTCUSD'), 'crypto')
  assert.equal(instrumentType('EURUSD'), 'fx')
  assert.equal(instrumentType('DOTUSD'), 'fx', 'unchanged by the name list (sizing table is separate)')
  assert.equal(contractSize('DOTUSD'), contractSize('EURUSD'), 'contract size unchanged by the name list')
})
