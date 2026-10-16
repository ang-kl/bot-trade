// Claude · № 15,144 16-Oct (owner: "B priorities class … C·2 build class-aware
// routing" after § 15,128; claude-builder). node --test agent/lib/asset-class.test.js
//
// Expected classes come from the BROKER'S catalogue: the class and category
// names below are copied from the production instrument tree cached on 15-10
// (GET /actions/instrument-tree, builtAt 2026-10-15T06:40:32Z, 1,730
// instruments) — not from this module's own mapping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { getState } from '../db.js'
import {
  canonicalClass, primeAssetClasses, initAssetClasses, classOfSymbol, assetClassStatus,
  _resetAssetClassesForTests, TREE_STATE_KEY, ASSET_CLASSES,
} from './asset-class.js'

const TREE = {
  builtAt: '2026-10-15T06:40:32.557Z',
  total: 16,
  classes: [
    { name: 'US Equities (CFDs)', count: 2, categories: [{ name: 'US Equities', count: 1, symbols: ['AAPL.US'] }, { name: 'US Equities - 24 Hour', count: 1, symbols: ['TSLA.US-24'] }] },
    { name: 'Forex (Spot)', count: 2, categories: [{ name: 'FX Majors', count: 1, symbols: ['EURUSD'] }, { name: 'FX Exotics', count: 1, symbols: ['USDTRY'] }] },
    { name: 'Crypto Currency (Spot)', count: 1, categories: [{ name: 'Default Category', count: 1, symbols: ['BTCUSD'] }] },
    { name: 'Indices (Spot)', count: 2, categories: [{ name: 'Default Category', count: 2, symbols: ['AUS200', 'GER40'] }] },
    { name: 'Metals (Spot)', count: 2, categories: [{ name: 'Default Category', count: 2, symbols: ['COPPER', 'XAUUSD'] }] },
    { name: 'Forwards', count: 1, categories: [{ name: 'Indices', count: 1, symbols: ['US500-F'] }] },
    { name: 'Commodities (Cash)', count: 1, categories: [{ name: 'Default Category', count: 1, symbols: ['COCOA'] }] },
    { name: 'Forwards - Treasuries', count: 1, categories: [{ name: 'Default Category', count: 1, symbols: ['EUBUND-F'] }] },
    { name: 'Energies (Spot)', count: 1, categories: [{ name: 'Default Category', count: 1, symbols: ['NATGAS'] }] },
    { name: 'Currency Index (Spot)', count: 1, categories: [{ name: 'Default Category', count: 1, symbols: ['USDX'] }] },
    { name: 'Perpetual Index', count: 1, categories: [{ name: 'Default Category', count: 1, symbols: ['NAS100-PERP'] }] },
    { name: 'ETFs', count: 1, categories: [{ name: 'Default Category', count: 1, symbols: ['SPY.US'] }] },
  ],
}

test('canonicalClass: every broker class name of the production tree maps to one canonical key', () => {
  const expect = {
    'US Equities (CFDs)': 'equity', 'AU Equities (CFDs)': 'equity', 'HK Equities (CFDs)': 'equity',
    'Forex (Spot)': 'fx', 'Crypto Currency (Spot)': 'crypto', 'Indices (Spot)': 'index', 'Metals (Spot)': 'metal',
    'Forwards': 'forward', 'Forwards - Treasuries': 'treasury', 'Commodities (Cash)': 'commodity',
    'Energies (Spot)': 'energy', 'Currency Index (Spot)': 'fx_index', 'Perpetual Index': 'perpetual',
    'Perpetual Stock': 'perpetual', 'Perpetual Commodity': 'perpetual', 'ETFs': 'etf', 'Other': 'other', '': 'other',
  }
  for (const [name, cls] of Object.entries(expect)) assert.equal(canonicalClass(name), cls, name)
  for (const cls of Object.values(expect)) assert.ok(ASSET_CLASSES.includes(cls), `${cls} is a declared class`)
})

test('primed from the tree: the class, its source and the broker names travel with the answer', () => {
  _resetAssetClassesForTests()
  assert.deepEqual(primeAssetClasses(TREE), { symbols: 16, builtAt: TREE.builtAt })
  const cases = {
    NATGAS: 'energy', COCOA: 'commodity', XAUUSD: 'metal', COPPER: 'metal', GER40: 'index', AUS200: 'index',
    EURUSD: 'fx', USDTRY: 'fx', BTCUSD: 'crypto', 'AAPL.US': 'equity', 'TSLA.US-24': 'equity', USDX: 'fx_index',
    'US500-F': 'forward', 'NAS100-PERP': 'perpetual', 'EUBUND-F': 'treasury', 'SPY.US': 'etf',
  }
  for (const [sym, cls] of Object.entries(cases)) {
    const r = classOfSymbol(sym)
    assert.equal(r.cls, cls, sym)
    assert.equal(r.source, 'broker_tree', sym)
  }
  assert.equal(classOfSymbol('eurusd').treeClass, 'Forex (Spot)')
  assert.equal(classOfSymbol('EURUSD').category, 'FX Majors')
  assert.deepEqual(assetClassStatus(), { primed: true, symbols: 16, builtAt: TREE.builtAt })
})

test('fallback without a tree: categoriseSymbol where it knows the symbol, the exchange suffix for equities, unknown otherwise', () => {
  _resetAssetClassesForTests()
  assert.deepEqual(classOfSymbol('GER40'), { cls: 'index', source: 'heuristic' })
  assert.deepEqual(classOfSymbol('BTCUSD'), { cls: 'crypto', source: 'heuristic' })
  assert.deepEqual(classOfSymbol('CORN'), { cls: 'commodity', source: 'heuristic' })
  assert.deepEqual(classOfSymbol('NATGAS'), { cls: 'energy', source: 'heuristic' })
  assert.deepEqual(classOfSymbol('EURUSD'), { cls: 'fx', source: 'heuristic' })
  assert.deepEqual(classOfSymbol('AAPL.US'), { cls: 'equity', source: 'heuristic' })
  assert.deepEqual(classOfSymbol('TSLA.US-24'), { cls: 'equity', source: 'heuristic' })
  // AUS200 is an index the broker lists and categoriseSymbol does not: the
  // heuristic's 'stock' fallback is NOT taken as a class — it reads unknown.
  assert.deepEqual(classOfSymbol('AUS200'), { cls: 'other', source: 'unknown' })
  assert.deepEqual(classOfSymbol(''), { cls: 'other', source: 'unknown' })
  assert.deepEqual(classOfSymbol(null), { cls: 'other', source: 'unknown' })
  // COPPER: categoriseSymbol files it with the energies; the broker files it
  // under Metals — the tree wins once primed.
  assert.equal(classOfSymbol('COPPER').cls, 'energy')
  primeAssetClasses(TREE)
  assert.equal(classOfSymbol('COPPER').cls, 'metal')
  assert.equal(classOfSymbol('AUS200').source, 'broker_tree')
})

test('boot wiring: initAssetClasses reads the cached tree from the database; no cache → heuristic until one exists', (t) => {
  _resetAssetClassesForTests()
  const db = initDB(':memory:'); t.after(() => db.close())
  assert.equal(initAssetClasses(db, getState), null, 'nothing cached yet')
  assert.deepEqual(classOfSymbol('AUS200'), { cls: 'other', source: 'unknown' })
  setState(db, TREE_STATE_KEY, JSON.stringify(TREE))
  const primed = initAssetClasses(db, getState)
  assert.deepEqual(primed, { symbols: 16, builtAt: TREE.builtAt })
  assert.equal(classOfSymbol('AUS200').source, 'broker_tree')
  // A newer tree in the cache is picked up on the next forced read; the same
  // builtAt is not re-parsed.
  assert.equal(initAssetClasses(db, getState), null, 'same builtAt → no re-prime')
  const newer = { ...TREE, builtAt: '2026-10-16T00:00:00.000Z', classes: [...TREE.classes, { name: 'Indices (Spot)', count: 1, categories: [{ name: 'Default Category', count: 1, symbols: ['HK50'] }] }] }
  setState(db, TREE_STATE_KEY, JSON.stringify(newer))
  assert.deepEqual(initAssetClasses(db, getState), { symbols: 17, builtAt: newer.builtAt })
  assert.equal(classOfSymbol('HK50').cls, 'index')
  // An unreadable cache keeps the last good map.
  setState(db, TREE_STATE_KEY, '{not json')
  assert.equal(initAssetClasses(db, getState), null)
  assert.equal(classOfSymbol('HK50').cls, 'index')
  _resetAssetClassesForTests()
})
