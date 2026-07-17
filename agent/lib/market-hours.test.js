// node --test agent/lib/market-hours.test.js
//
// Session-model regressions from the owner's 2026-07-17 report: CORN was
// missing from every category (treated as a NYSE stock → falsely vetoed all
// night while CBOT was open) and COCOA was treated as 24/5 FX (orders sent
// overnight → broker rejections). Exchange windows now modelled per class.

import test from 'node:test'
import assert from 'node:assert/strict'
import { categoriseSymbol, isSymbolMarketOpen, isWeekend } from './sessions.js'

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

test('isWeekend: true only Fri 21:00 → Sun 22:00 UTC, NOT the weekday NY→Sydney lull', () => {
  // The bug: the ~1h gap between NY close (21:00) and Sydney open (22:00)
  // on a WEEKDAY read as "market closed" → NatGas got WEEKEND:HOLD midweek.
  assert.equal(isWeekend(wed(21, 30)), false, 'Wed 21:30 is a weekday lull, NOT the weekend')
  assert.equal(isWeekend(new Date(Date.UTC(2026, 6, 17, 20, 0))), false) // Fri 20:00 — still open
  assert.equal(isWeekend(new Date(Date.UTC(2026, 6, 17, 21, 30))), true)  // Fri 21:30 — weekend begun
  assert.equal(isWeekend(sat(12)), true)                                  // Saturday
  assert.equal(isWeekend(new Date(Date.UTC(2026, 6, 19, 21, 0))), true)   // Sun 21:00 — still closed
  assert.equal(isWeekend(new Date(Date.UTC(2026, 6, 19, 22, 30))), false) // Sun 22:30 — reopened
})

test('unchanged behaviour: FX 24/5, indices NYSE window, crypto always', () => {
  assert.equal(isSymbolMarketOpen('EURUSD', wed(3, 0)).open, true)
  assert.equal(isSymbolMarketOpen('EURUSD', sat(12)).open, false)
  assert.equal(isSymbolMarketOpen('US30', wed(15, 0)).open, true)
  assert.equal(isSymbolMarketOpen('US30', wed(3, 0)).open, false)
  assert.equal(isSymbolMarketOpen('BTCUSD', sat(3)).open, true)
})
