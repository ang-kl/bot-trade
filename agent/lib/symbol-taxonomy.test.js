// node --test agent/lib/symbol-taxonomy.test.js
//
// The owner named three cases by hand — "JPN225 is Japanese Index trade at
// Tokyo market hours. GER40 is Germany. Crypto is 24 hours." — so those three
// are pinned literally. The rest guards the property that made the old
// classification wrong: a fallback that silently swallows everything it does
// not recognise.

import test from 'node:test'
import assert from 'node:assert/strict'
import { categoriseSymbol, isSymbolMarketOpen } from './sessions.js'
import { REGIONS, SESSION_WINDOWS, regionFor, inWindow } from './exchange-regions.js'
import {
  describeSymbol, describeInstrument, regionOf, subGroupOf, bareTicker, symbolSuffix,
} from './symbol-taxonomy.js'

// A Wednesday, so every weekday window is reachable from one base date.
const wed = (h, m = 0) => new Date(Date.UTC(2026, 7, 5, h, m))

// ---------------------------------------------------------------------------
// The three the owner named
// ---------------------------------------------------------------------------

test('JPN225 is a Japanese index and trades the Tokyo window', () => {
  assert.equal(categoriseSymbol('JPN225'), 'index')
  assert.equal(regionOf('JPN225'), 'japan')
  assert.equal(subGroupOf('JPN225'), 'Japan indices')
  assert.equal(REGIONS.japan.tz, 'Asia/Tokyo')
  // 02:00 UTC is 11:00 in Tokyo — the middle of the cash session, and the
  // exact time the old New-York-only gate refused it.
  assert.equal(isSymbolMarketOpen('JPN225', wed(2)).open, true)
  // 18:00 UTC is 03:00 next-day Tokyo. The old gate called this OPEN.
  assert.equal(isSymbolMarketOpen('JPN225', wed(18)).open, false)
})

test('GER40 is Germany', () => {
  assert.equal(regionOf('GER40'), 'germany')
  assert.equal(subGroupOf('GER40'), 'Germany indices')
  assert.equal(describeInstrument('GER40'), 'DAX 40')
  assert.equal(isSymbolMarketOpen('GER40', wed(10)).open, true)   // 12:00 Berlin
  assert.equal(isSymbolMarketOpen('GER40', wed(2)).open, false)   // 04:00 Berlin
})

test('crypto is 24 hours, every hour of every day', () => {
  for (const h of [0, 3, 9, 15, 21, 23]) {
    for (const d of [0, 3, 6]) {          // Sunday, Wednesday, Saturday
      const at = new Date(Date.UTC(2026, 7, 2 + d, h))
      assert.equal(isSymbolMarketOpen('BTCUSD', at).open, true, `BTCUSD closed at ${at.toISOString()}`)
    }
  }
  assert.equal(subGroupOf('ETHUSD'), 'Crypto 24/7')
  assert.equal(describeSymbol('SOLUSD').alwaysOpen, true)
})

test('US indices keep the New York window they always had', () => {
  // The change must not have moved the ones that were already right.
  assert.equal(regionOf('NAS100'), 'us')
  assert.equal(isSymbolMarketOpen('NAS100', wed(16)).open, true)
  assert.equal(isSymbolMarketOpen('NAS100', wed(2)).open, false)
})

// ---------------------------------------------------------------------------
// Region, derived where it can be
// ---------------------------------------------------------------------------

test('an equity takes its region from the broker suffix, not from a list', () => {
  assert.equal(symbolSuffix('0066.HK'), 'HK')
  assert.equal(regionOf('0066.HK'), 'hongkong')
  assert.equal(regionOf('AMD.DE'), 'germany')
  assert.equal(regionOf('BARC.UK'), 'uk')
  assert.equal(regionOf('BHP.AU'), 'australia')
  // The point of deriving: a ticker nobody has ever added still lands right.
  assert.equal(regionOf('NEVERSEEN.HK'), 'hongkong')
})

test('a suffixless equity is a US listing — the broker default', () => {
  assert.equal(categoriseSymbol('GEV'), 'stock')
  assert.equal(regionOf('GEV'), 'us')
  assert.equal(subGroupOf('GEV'), 'United States equities')
})

test('a Hong Kong equity trades Hong Kong hours, not New York hours', () => {
  // 0066.HK is one of the nine duplicate positions from #179 — it was being
  // gated to a window in which its exchange is shut.
  assert.equal(isSymbolMarketOpen('0066.HK', wed(3)).open, true)    // 11:00 HKT
  assert.equal(isSymbolMarketOpen('0066.HK', wed(16)).open, false)  // 00:00 HKT
})

test('FX, metals and energies stay global — no country is claimed for them', () => {
  for (const s of ['EURUSD', 'XAUUSD', 'NATGAS', 'CORN', 'COFFEE']) {
    assert.equal(regionOf(s), 'global', `${s} should be global`)
  }
})

// ---------------------------------------------------------------------------
// Sub-groups — the level that replaces "Ungrouped"
// ---------------------------------------------------------------------------

test('FX splits into majors, crosses and exotics', () => {
  assert.equal(subGroupOf('EURUSD'), 'FX majors')
  assert.equal(subGroupOf('USDJPY'), 'FX majors')
  assert.equal(subGroupOf('EURGBP'), 'FX crosses')
  assert.equal(subGroupOf('AUDNZD'), 'FX crosses')
  assert.equal(subGroupOf('USDZAR'), 'FX exotics')
  assert.equal(subGroupOf('AUDPLN'), 'FX exotics')
})

test('every class produces a sub-group and none of them is "Ungrouped"', () => {
  const sample = [
    'EURUSD', 'USDPLN', 'BTCUSD', 'JPN225', 'GER40', 'NAS100', 'XAUUSD',
    'NATGAS', 'COFFEE', 'CORN', 'AMD.US', '0066.HK', 'GEV', 'WHATISTHIS',
  ]
  for (const s of sample) {
    const g = subGroupOf(s)
    assert.ok(g && g !== 'Ungrouped' && g !== '', `${s} → ${g}`)
  }
})

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

test('the descriptions the owner named by hand', () => {
  assert.equal(describeInstrument('XAUUSD'), 'Gold')
  assert.equal(describeInstrument('AMD.US'), 'AMD')
  // "GEV is GE Vernova" — the broker catalogue carries the long name; without
  // it the bare ticker is the honest answer at ten characters.
  assert.equal(describeInstrument('GEV', { GEV: 'GE Vernova' }), 'GE Vernova')
  assert.equal(describeInstrument('GEV'), 'GEV')
})

test('the broker catalogue wins over the curated table', () => {
  // The curated table is a fallback for a fresh install, never an override —
  // the broker knows its own instruments and we do not.
  assert.equal(describeInstrument('XAUUSD', { XAUUSD: 'Gold vs US Dollar' }), 'Gold vs US Dollar')
})

test('an FX pair describes itself from its two currency codes', () => {
  assert.equal(describeInstrument('EURUSD'), 'Euro/US Dollar')
  assert.equal(describeInstrument('GBPJPY'), 'Sterling/Yen')
  // An exotic with no name for one leg falls back rather than printing
  // "undefined/US Dollar".
  assert.equal(describeInstrument('USDVND'), 'USDVND')
})

test('bareTicker strips only a real exchange suffix', () => {
  assert.equal(bareTicker('AMD.US'), 'AMD')
  assert.equal(bareTicker('0066.HK'), '0066')
  assert.equal(bareTicker('EURUSD'), 'EURUSD')
  assert.equal(symbolSuffix('EURUSD'), '')
})

// ---------------------------------------------------------------------------
// The window helper itself
// ---------------------------------------------------------------------------

test('a wrapping window puts Sunday evening in-session and Friday evening out', () => {
  const syd = SESSION_WINDOWS.sydney            // 23:00 → 05:00, wraps midnight
  assert.equal(inWindow(syd, 0, 23 * 60 + 30), true, 'Sunday 23:30 opens the week')
  assert.equal(inWindow(syd, 5, 23 * 60 + 30), false, 'Friday 23:30 is the weekend')
  assert.equal(inWindow(syd, 3, 2 * 60), true, 'Wednesday 02:00 is mid-session')
  assert.equal(inWindow(syd, 6, 2 * 60), false, 'Saturday is closed')
  assert.equal(inWindow(undefined, 3, 600), false)
})

test('every region names a session window that actually exists', () => {
  // The failure this prevents: adding a region with a session key nobody
  // implemented, which silently falls back to New York hours — the exact bug
  // being fixed here, reintroduced by a typo.
  for (const [key, r] of Object.entries(REGIONS)) {
    if (r.session === 'fx' || r.session === 'always') continue   // not windowed
    assert.ok(SESSION_WINDOWS[r.session], `region ${key} names missing window ${r.session}`)
  }
})

test('regionFor takes the class it is given and does not re-derive it', () => {
  // sessions.js calls this having already computed the class. Passing a
  // different one must change the answer — otherwise the two would drift.
  assert.equal(regionFor('JPN225', 'index'), 'japan')
  assert.equal(regionFor('JPN225', 'fx'), 'global')
})

test('describeSymbol is the whole row in one call', () => {
  const d = describeSymbol('JPN225')
  assert.equal(d.symbol, 'JPN225')
  assert.equal(d.cls, 'index')
  assert.equal(d.region, 'japan')
  assert.equal(d.regionLabel, 'Japan')
  assert.equal(d.tz, 'Asia/Tokyo')
  assert.equal(d.description, 'Nikkei 225')
  assert.equal(d.alwaysOpen, false)
})
