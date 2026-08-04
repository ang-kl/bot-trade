// ---------------------------------------------------------------------------
// agent/lib/symbol-taxonomy.js — what an instrument IS, in one place.
//
// Owner, 04-08-2026, on the Tune watchlist: "Many symbols are categorised
// wrongly… Like JPN225 is Japanese Index trade at Tokyo market hours. GER40 is
// Germany. Crypto is 24 hours."
//
// WHY A THIRD MODULE IS THE FIX AND NOT THE PROBLEM. Before this file there
// were already three answers to "what is this symbol":
//
//   sessions.js  categoriseSymbol()  → fx | crypto | index | metal | commodity
//                                      | soft | grain | stock  (drives HOURS)
//   contracts.js instrumentType()    → metal | energy | agri | index | crypto
//                                      | equity | fx | fx cross | other
//                                      (drives the SIZING display)
//   the broker's own instrument tree → class › category (drives BROWSE)
//
// They disagree — `commodity` vs `energy`, `stock` vs `equity`, and neither
// local one knows a country. That disagreement is exactly what the owner is
// looking at: a watchlist banded by categoriseSymbol, labelled by
// instrumentType, over a browse tree that uses neither.
//
// This module does NOT add a fourth opinion about the coarse class — it
// DEFERS to categoriseSymbol for that, for the same reason asset-class.js
// does: the tree must not disagree with the engine about what an instrument
// is. What it adds is the axis none of the three had — WHERE the instrument
// trades — and a sub-group derived from it. Region is the thing that makes
// "JPN225 is Japanese" expressible at all.
//
// DERIVED, NOT ENUMERATED, wherever the shape allows it. sessions.js records
// the lesson three times over: a hardcoded list with a permissive-looking
// fallback silently mis-handled CORN, then LTC/ADA/DOGE, then every FX cross
// outside a list of ten. Equity region comes from the broker's own dot suffix
// (.US, .DE, .HK) — 1,900 symbols cannot be enumerated and do not need to be.
// Only the index set is listed, because an index ticker like GER40 carries no
// structural clue to its exchange and there are ~20 of them, not 1,900.
// ---------------------------------------------------------------------------

import { categoriseSymbol, isFxPair } from './sessions.js'
import { REGIONS, regionFor, bareTicker, symbolSuffix } from './exchange-regions.js'

export { REGIONS, bareTicker, symbolSuffix }

/** The seven majors, by convention — every other USD pair is a minor. */
const MAJOR_PAIRS = new Set([
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD',
])

/** Reserve/G10 currencies. A pair of two of these is a cross, not an exotic. */
const G10 = new Set(['USD', 'EUR', 'JPY', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'NOK', 'SEK'])

/**
 * Curated descriptions for the instruments with no readable ticker. The
 * broker's own `description` field is the primary source (see
 * instrument-tree.js) — this is the FALLBACK, so the column is never blank on
 * a fresh install or for a symbol the catalogue refresh has not reached.
 * Deliberately short: the column is ten characters wide.
 */
export const SYMBOL_DESCRIPTION = Object.freeze({
  XAUUSD: 'Gold', XAGUSD: 'Silver', XPTUSD: 'Platinum', XPDUSD: 'Palladium',
  USDX: 'Dollar Index', COPPER: 'Copper',
  SPOTCRUDE: 'WTI Crude', WTI: 'WTI Crude', BRENT: 'Brent Crude', NATGAS: 'Natural Gas',
  COCOA: 'Cocoa', COFFEE: 'Coffee', SUGAR: 'Sugar', COTTON: 'Cotton', OJUICE: 'Orange Juice',
  CORN: 'Corn', WHEAT: 'Wheat', SOYBEAN: 'Soybeans', SOYBEANS: 'Soybeans',
  OATS: 'Oats', RICE: 'Rice',
  US30: 'Dow Jones 30', US500: 'S&P 500', NAS100: 'Nasdaq 100', US2000: 'Russell 2000',
  VIX: 'Volatility Index', SDY: 'S&P Dividend',
  JPN225: 'Nikkei 225', GER40: 'DAX 40', GER30: 'DAX 30', UK100: 'FTSE 100',
  FRA40: 'CAC 40', SPA35: 'IBEX 35', ITA40: 'FTSE MIB', NETH25: 'AEX 25',
  SWI20: 'SMI 20', EUSTX50: 'Euro Stoxx 50', HK50: 'Hang Seng',
  CN50: 'China A50', CHINA50: 'China A50', SG30: 'Straits Times', AUS200: 'ASX 200',
  BTCUSD: 'Bitcoin', ETHUSD: 'Ethereum', XRPUSD: 'XRP', SOLUSD: 'Solana',
  LTCUSD: 'Litecoin', ADAUSD: 'Cardano', DOGEUSD: 'Dogecoin', BCHUSD: 'Bitcoin Cash',
  BNBUSD: 'BNB', DOTUSD: 'Polkadot', LINKUSD: 'Chainlink', XLMUSD: 'Stellar',
  AVAXUSD: 'Avalanche', UNIUSD: 'Uniswap', MATICUSD: 'Polygon',
})

/** Currency-code → full name, so an FX row reads "Euro / US Dollar". */
const CCY_NAME = Object.freeze({
  USD: 'US Dollar', EUR: 'Euro', JPY: 'Yen', GBP: 'Sterling', AUD: 'Aussie',
  NZD: 'Kiwi', CAD: 'Loonie', CHF: 'Franc', CNH: 'Yuan', CNY: 'Yuan',
  HKD: 'HK Dollar', SGD: 'SG Dollar', SEK: 'Krona', NOK: 'Krone', DKK: 'Krone',
  PLN: 'Zloty', CZK: 'Koruna', HUF: 'Forint', TRY: 'Lira', ZAR: 'Rand',
  MXN: 'Peso', BRL: 'Real', INR: 'Rupee', IDR: 'Rupiah', THB: 'Baht',
  KRW: 'Won', TWD: 'TW Dollar', ILS: 'Shekel', RUB: 'Rouble',
})

/**
 * Which region does this instrument trade in?
 *
 * Crypto is its own region because "24 hours" is a property of the market, not
 * of a country — the owner named it in the same breath as Japan and Germany
 * and it belongs on the same axis. The mapping itself lives in the leaf module
 * the trading gate also reads, so the watchlist band and the market-hours
 * check can never disagree about where JPN225 trades.
 */
export const regionOf = (symbol) => regionFor(symbol, categoriseSymbol(symbol))

/** FX sub-group: majors / crosses / exotics — the desk's own vocabulary. */
function fxSubGroup(s) {
  if (MAJOR_PAIRS.has(s)) return 'FX majors'
  const base = s.slice(0, 3), quote = s.slice(3)
  if (G10.has(base) && G10.has(quote)) return 'FX crosses'
  return 'FX exotics'
}

/**
 * The middle level of the watchlist tree: a human sub-group a symbol always
 * has, so nothing lands in a bucket called "Ungrouped" again.
 */
export function subGroupOf(symbol) {
  const s = String(symbol || '').toUpperCase()
  const cls = categoriseSymbol(s)
  const region = regionOf(s)
  const label = REGIONS[region]?.label || 'Global'
  switch (cls) {
    case 'fx': return isFxPair(s) ? fxSubGroup(s) : 'FX other'
    case 'crypto': return 'Crypto 24/7'
    case 'index': return `${label} indices`
    case 'stock': return `${label} equities`
    case 'metal': return 'Precious metals'
    case 'commodity': return 'Energy'
    case 'soft': return 'Softs (ICE)'
    case 'grain': return 'Grains (CBOT)'
    default: return 'Other'
  }
}

/**
 * A short human description — "XAUUSD is Gold, AMD.US is AMD, GEV is GE
 * Vernova" (owner). `brokerDescriptions` is the catalogue map when the caller
 * has it; the curated table and then the bare ticker are the fallbacks. An
 * equity's ticker IS its description at ten characters, which is why AMD.US
 * resolving to "AMD" is the right answer and not a missing one.
 */
export function describeInstrument(symbol, brokerDescriptions = null) {
  const s = String(symbol || '').toUpperCase()
  const broker = brokerDescriptions?.[s]
  if (broker) return String(broker)
  if (SYMBOL_DESCRIPTION[s]) return SYMBOL_DESCRIPTION[s]
  if (isFxPair(s)) {
    const a = CCY_NAME[s.slice(0, 3)], b = CCY_NAME[s.slice(3)]
    if (a && b) return `${a}/${b}`
  }
  return bareTicker(s)
}

/**
 * Everything the UI needs about one instrument, in one call.
 *
 * @returns {{symbol, cls, subGroup, region, regionLabel, flag, tz, session,
 *            alwaysOpen, description}}
 */
export function describeSymbol(symbol, brokerDescriptions = null) {
  const s = String(symbol || '').toUpperCase()
  const cls = categoriseSymbol(s)
  const region = regionOf(s)
  const r = REGIONS[region] || REGIONS.global
  return {
    symbol: s,
    cls,
    subGroup: subGroupOf(s),
    region,
    regionLabel: r.label,
    flag: r.flag,
    tz: r.tz,
    session: r.session,
    alwaysOpen: cls === 'crypto',
    description: describeInstrument(s, brokerDescriptions),
  }
}
