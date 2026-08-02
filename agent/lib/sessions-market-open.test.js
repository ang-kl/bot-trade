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

// ---------------------------------------------------------------------------
// FX RECOGNISED BY SHAPE, NOT BY LIST (owner 02-08-2026: "some of the forex
// are in the single stock"). categoriseSymbol knew exactly ten pairs and
// everything else fell through to 'stock' — which gates to the New York
// session. Every cross outside those ten was refused ~17½ hours a day.
// ---------------------------------------------------------------------------
import { categoriseSymbol, isFxPair } from './sessions.js'

test('THE BUG: crosses this bot actually trades were classified as stocks', () => {
  // All six appear in production; AUDPLN and EURGBP are in today's veto log.
  for (const sym of ['AUDPLN', 'EURGBP', 'USDPLN', 'GBPAUD', 'USDSGD', 'USDIDR']) {
    assert.equal(categoriseSymbol(sym), 'fx', `${sym} must be fx, not ${categoriseSymbol(sym)}`)
  }
  // And the consequence that made it more than a label: Wednesday 08:00 UTC is
  // outside the NY session, so as a 'stock' every one of these was closed.
  const wed0800 = at('2026-07-08T08:00:00Z')
  for (const sym of ['AUDPLN', 'EURGBP', 'USDPLN']) {
    assert.equal(isSymbolMarketOpen(sym, wed0800).open, true, `${sym} should trade 24/5`)
  }
})

test('the original ten still classify as fx', () => {
  for (const sym of ['EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'USDCHF', 'USDCAD',
    'NZDUSD', 'AUDJPY', 'EURJPY', 'GBPJPY']) {
    assert.equal(categoriseSymbol(sym), 'fx')
  }
})

test('metals win over the pair test — XAU/XAG/XPT are ISO-4217 codes too', () => {
  // Without the ordering, XAUUSD parses as a currency pair and loses its own
  // session rules. XAGUSD/XPTUSD/XPDUSD are the same trap.
  for (const sym of ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD']) {
    assert.equal(categoriseSymbol(sym), 'metal', `${sym} must stay a metal`)
  }
})

test('non-pairs are not swept into fx', () => {
  assert.equal(isFxPair('MSFT.US'), false)
  assert.equal(isFxPair('US500'), false)
  assert.equal(isFxPair('BTCUSD'), false, 'BTC is not ISO-4217')
  assert.equal(isFxPair('USDUSD'), false, 'a pair against itself is not an instrument')
  assert.equal(isFxPair('EURUS'), false, 'five letters is not a pair')
  assert.equal(isFxPair(''), false)
  assert.equal(isFxPair(null), false)
  assert.equal(isFxPair(undefined), false)
  // Crypto keeps its own class (and its 24/7 weekend exemption).
  assert.equal(categoriseSymbol('DOGEUSD'), 'crypto')
  assert.equal(categoriseSymbol('CORN'), 'grain')
  assert.equal(categoriseSymbol('MSFT.US'), 'stock')
})

test('an unrecognised symbol still defaults to stock — the CONSERVATIVE choice', () => {
  // Defaulting unknowns to 24/5 would fire market orders into closed
  // exchanges. The fix was to stop FX being unknown, not to loosen the
  // fallback.
  assert.equal(categoriseSymbol('SOMETHINGNEW'), 'stock')
  assert.equal(isSymbolMarketOpen('SOMETHINGNEW', at('2026-07-08T08:00:00Z')).open, false)
})
