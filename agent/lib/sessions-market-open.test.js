// node --test agent/lib/sessions-market-open.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { isSymbolMarketOpen } from './sessions.js'

const at = (iso) => new Date(iso)

test('stocks/indices: open inside the NY session, closed outside', () => {
  assert.equal(isSymbolMarketOpen('MSFT.US', at('2026-07-08T15:00:00Z')).open, true)  // Wed 15:00 UTC
  assert.equal(isSymbolMarketOpen('MSFT.US', at('2026-07-08T08:00:00Z')).open, false) // Wed 08:00 UTC
  assert.equal(isSymbolMarketOpen('US30', at('2026-07-11T15:00:00Z')).open, false)    // Saturday
  assert.match(isSymbolMarketOpen('US30', at('2026-07-08T08:00:00Z')).reason, /New York session/)
})

test('fx/metals: open midweek, closed over the weekend window', () => {
  assert.equal(isSymbolMarketOpen('EURUSD', at('2026-07-08T08:00:00Z')).open, true)   // Wed
  assert.equal(isSymbolMarketOpen('EURUSD', at('2026-07-10T22:00:00Z')).open, false)  // Fri 22:00
  assert.equal(isSymbolMarketOpen('XAUUSD', at('2026-07-11T12:00:00Z')).open, false)  // Sat
  assert.equal(isSymbolMarketOpen('EURUSD', at('2026-07-12T21:00:00Z')).open, false)  // Sun 21:00
  assert.equal(isSymbolMarketOpen('EURUSD', at('2026-07-12T23:00:00Z')).open, true)   // Sun 23:00
})

test('crypto is always open', () => {
  assert.equal(isSymbolMarketOpen('BTCUSD', at('2026-07-11T03:00:00Z')).open, true)   // Saturday
})
