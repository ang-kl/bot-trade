// Claude · № 15,144 16-Oct (owner: "B priorities class that are profitable as
// first to trade … C·2 Policy, build class-aware routing" after § 15,128;
// claude-builder).
//
// The asset class of a symbol, from the BROKER'S OWN catalogue: the cTrader
// asset classes that GET /actions/instrument-tree fetches and caches as
// `instrument_tree_json` (lib/instrument-tree.js). lib/sessions.js
// categoriseSymbol is the fallback — a hand-written list of eight indices and
// fifteen cryptos that falls through to 'stock' for anything it does not know,
// which is the wrong answer for 14 of the 22 indices on the watchlist. Every
// answer carries its SOURCE, so a routing decision can always say where the
// class came from, and a class that came from the heuristic is visible as such
// in GET /state/class-routing rather than passing for the broker's word.
//
// The map lives in this module (primed at boot from the cached tree, refreshed
// from the database at most every ten minutes, re-primed when the tree route
// refreshes the catalogue) because the scan (services/fib-strategy.js) has no
// database handle of its own and loop.js — which does — is a protected file.
import { categoriseSymbol } from './sessions.js'

export const ASSET_CLASSES = Object.freeze([
  'fx', 'index', 'metal', 'crypto', 'energy', 'commodity', 'fx_index',
  'treasury', 'forward', 'perpetual', 'etf', 'equity', 'other',
])
export const TREE_STATE_KEY = 'instrument_tree_json'
const REFRESH_MS = 10 * 60_000

/** The broker's class name → the canonical key the routing policy is written in. */
export function canonicalClass(treeClassName) {
  const n = String(treeClassName || '').trim()
  if (!n) return 'other'
  if (/^Forex\b/i.test(n)) return 'fx'
  if (/^Indices\b/i.test(n)) return 'index'
  if (/^Metals\b/i.test(n)) return 'metal'
  if (/^Crypto/i.test(n)) return 'crypto'
  if (/^Energies\b/i.test(n)) return 'energy'
  if (/^Commodities\b/i.test(n)) return 'commodity'
  if (/^Currency Index/i.test(n)) return 'fx_index'
  // "Forwards - Treasuries" before the plain "Forwards" test, or bonds read as index/metal forwards.
  if (/Treasur/i.test(n)) return 'treasury'
  if (/^Forwards\b/i.test(n)) return 'forward'
  if (/^Perpetual\b/i.test(n)) return 'perpetual'
  if (/^ETFs?$/i.test(n)) return 'etf'
  if (/Equities/i.test(n)) return 'equity'
  return 'other'
}

// categoriseSymbol's vocabulary → the canonical keys. Its 'commodity' list is
// the energies (NATGAS, SPOTCRUDE, WTI, BRENT, plus COPPER/ALUMINIUM, which
// the broker files under Metals — the tree wins whenever it is primed).
const HEURISTIC = { crypto: 'crypto', metal: 'metal', index: 'index', fx: 'fx', soft: 'commodity', grain: 'commodity', commodity: 'energy' }
const EQUITY_TICKER = /\.[A-Z]{2}(-24)?$/

let MAP = null
let BUILT_AT = null
let DB = null
let GET_STATE = null
let LAST_READ = 0

/** Build the symbol → class map from a parsed instrument tree. Returns what was primed. */
export function primeAssetClasses(tree) {
  const map = new Map()
  for (const cls of tree?.classes || []) {
    const key = canonicalClass(cls?.name)
    for (const cat of cls?.categories || []) {
      for (const s of cat?.symbols || []) {
        const name = String(s || '').toUpperCase().trim()
        if (name && !map.has(name)) map.set(name, { cls: key, treeClass: cls?.name ?? null, category: cat?.name ?? null })
      }
    }
  }
  MAP = map
  BUILT_AT = tree?.builtAt || null
  LAST_READ = Date.now()
  return { symbols: map.size, builtAt: BUILT_AT }
}

/** Boot wiring: keep the handle, prime from the cached tree now, refresh lazily later. */
export function initAssetClasses(db, getState) {
  DB = db
  GET_STATE = typeof getState === 'function' ? getState : null
  LAST_READ = 0
  return refreshFromDb(true)
}

function refreshFromDb(force) {
  if (!DB || !GET_STATE) return null
  if (!force && Date.now() - LAST_READ < REFRESH_MS) return null
  LAST_READ = Date.now()
  try {
    const raw = GET_STATE(DB, TREE_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (MAP && parsed?.builtAt && parsed.builtAt === BUILT_AT) return null
    return primeAssetClasses(parsed)
  } catch {
    return null // an unreadable cache keeps the last good map, or the heuristic
  }
}

/**
 * The class of one symbol, with its source: 'broker_tree' (the catalogue),
 * 'heuristic' (categoriseSymbol recognised it, or the ticker has an exchange
 * suffix), or 'unknown' (nothing recognised it → 'other'). Never throws.
 */
export function classOfSymbol(symbol) {
  refreshFromDb(false)
  const name = String(symbol || '').toUpperCase().trim()
  if (!name) return { cls: 'other', source: 'unknown' }
  const hit = MAP?.get(name)
  if (hit) return { cls: hit.cls, source: 'broker_tree', treeClass: hit.treeClass, category: hit.category }
  const h = HEURISTIC[categoriseSymbol(name)]
  if (h) return { cls: h, source: 'heuristic' }
  if (EQUITY_TICKER.test(name)) return { cls: 'equity', source: 'heuristic' }
  return { cls: 'other', source: 'unknown' }
}

export function assetClassStatus() {
  return { primed: !!MAP, symbols: MAP ? MAP.size : 0, builtAt: BUILT_AT }
}

export function _resetAssetClassesForTests() {
  MAP = null; BUILT_AT = null; DB = null; GET_STATE = null; LAST_READ = 0
}
