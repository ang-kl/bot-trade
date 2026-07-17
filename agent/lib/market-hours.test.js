// node --test agent/lib/market-hours.test.js
//
// Session-model regressions from the owner's 2026-07-17 report: CORN was
// missing from every category (treated as a NYSE stock → falsely vetoed all
// night while CBOT was open) and COCOA was treated as 24/5 FX (orders sent
// overnight → broker rejections). Exchange windows now modelled per class.

import test from 'node:test'
import assert from 'node:assert/strict'
import { categoriseSymbol, isSymbolMarketOpen } from './sessions.js'

// Wed 2026-07-15 at hh:mm UTC.
const wed = (h, m = 0) => new Date(Date.UTC(2026, 6, 15, h, m))
const sat = (h) => new Date(Date.UTC(2026, 6, 18, h))

test('categorise: CORN is a grain, COCOA a soft — never "stock"', () => {
  assert.equal(categoriseSymbol('CORN'), 'grain')
  assert.equal(categoriseSymbol('WHEAT'), 'grain')
  assert.equal(categoriseSymbol('COCOA'), 'soft')
  assert.equal(categoriseSymbol('COFFEE'), 'soft')
  assert.equal(categoriseSymbol('NATGAS'), 'commodity')
})

test('CORN: open in the CBOT overnight session (03:49 UTC) — the false veto', () => {
  assert.equal(isSymbolMarketOpen('CORN', wed(3, 49)).open, true)
})

test('CORN: closed in the midday break, open in the day session, closed evening', () => {
  assert.equal(isSymbolMarketOpen('CORN', wed(13, 0)).open, false)  // break
  assert.equal(isSymbolMarketOpen('CORN', wed(15, 0)).open, true)   // day session
  assert.equal(isSymbolMarketOpen('CORN', wed(19, 0)).open, false)  // after close
})

test('COCOA: CLOSED overnight (03:49 UTC) — the broker-rejection window', () => {
  const r = isSymbolMarketOpen('COCOA', wed(3, 49))
  assert.equal(r.open, false)
  assert.match(r.reason, /ICE daytime/)
})

test('COCOA: open in the ICE daytime window, closed weekends', () => {
  assert.equal(isSymbolMarketOpen('COCOA', wed(12, 0)).open, true)
  assert.equal(isSymbolMarketOpen('COCOA', sat(12)).open, false)
})

test('NATGAS: daily 21:00–22:00 settlement break, otherwise 24/5', () => {
  assert.equal(isSymbolMarketOpen('NATGAS', wed(21, 30)).open, false)
  assert.equal(isSymbolMarketOpen('NATGAS', wed(20, 30)).open, true)
  assert.equal(isSymbolMarketOpen('NATGAS', wed(2, 0)).open, true)
})

test('unchanged behaviour: FX 24/5, indices NYSE window, crypto always', () => {
  assert.equal(isSymbolMarketOpen('EURUSD', wed(3, 0)).open, true)
  assert.equal(isSymbolMarketOpen('EURUSD', sat(12)).open, false)
  assert.equal(isSymbolMarketOpen('US30', wed(15, 0)).open, true)
  assert.equal(isSymbolMarketOpen('US30', wed(3, 0)).open, false)
  assert.equal(isSymbolMarketOpen('BTCUSD', sat(3)).open, true)
})
