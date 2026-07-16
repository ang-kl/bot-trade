// ---------------------------------------------------------------------------
// agent/lib/contracts.js — instrument contract sizes + account-size tiers
// ---------------------------------------------------------------------------
// Contract size = how many units of the base asset a "1 lot" order represents.
// Used to convert SL distance (price) into USD loss per lot, which drives
// risk-based position sizing.
//
// For USD-quoted instruments, USD loss per lot = priceDistance * contractSize.
// For USD-base pairs (USDJPY, USDCHF etc) the loss lands in the quote currency,
// so it must be divided by the current price to express it in USD — without
// that conversion a JPY-quoted distance overstates the loss ~150× and sizing
// collapses to zero. Crosses (neither leg USD) have no conversion rate
// available here and report unknown, which the risk manager vetoes.
//
// There is NO hardcoded instrument universe. The risk manager decides whether
// a trade is affordable on the user's balance + leverage. The tier label is
// purely informational for the dashboard.
// ---------------------------------------------------------------------------

const CONTRACT_SIZE = {
  // Metals (troy ounces per lot — cTrader convention)
  XAUUSD: 100,
  XAGUSD: 5000,
  XPTUSD: 50,
  XPDUSD: 100,
  // Energies
  SPOTCRUDE: 1000,
  WTI: 1000,
  BRENT: 1000,
  NATGAS: 10000,
  // Softs / agricultural
  COCOA: 10,
  COFFEE: 37500,
  SUGAR: 112000,
  COTTON: 50000,
  WHEAT: 5000,
  CORN: 5000,
  SOYBEAN: 5000,
  // Base metals
  COPPER: 25000,
  // Indices — cTrader typically gives 1 unit = $1/point per lot
  US30: 1, US500: 1, NAS100: 1, GER40: 1, UK100: 1, JPN225: 1,
  FRA40: 1, SPA35: 1, CN50: 1, VIX: 1, SDY: 1, HK50: 1, AUS200: 1,
  // Crypto
  BTCUSD: 1, ETHUSD: 1, XRPUSD: 1, SOLUSD: 1, LTCUSD: 1, ADAUSD: 1,
  DOGEUSD: 1, BNBUSD: 1,
}

const DEFAULT_FX_CONTRACT = 100_000 // 1 lot = 100k units base ccy

// Instrument classification — drives the dynamic-sizing display (each type
// has a wildly different $-per-lot, which is WHY lots must be computed per
// instrument, never set as one global number).
const TYPE_BY_SYMBOL = {
  XAUUSD: 'metal', XAGUSD: 'metal', XPTUSD: 'metal', XPDUSD: 'metal',
  SPOTCRUDE: 'energy', WTI: 'energy', BRENT: 'energy', NATGAS: 'energy',
  COCOA: 'agri', COFFEE: 'agri', SUGAR: 'agri', COTTON: 'agri',
  WHEAT: 'agri', CORN: 'agri', SOYBEAN: 'agri',
  COPPER: 'metal',
  US30: 'index', US500: 'index', NAS100: 'index', GER40: 'index',
  UK100: 'index', JPN225: 'index', FRA40: 'index', SPA35: 'index',
  CN50: 'index', VIX: 'index', SDY: 'index', HK50: 'index', AUS200: 'index',
  BTCUSD: 'crypto', ETHUSD: 'crypto', XRPUSD: 'crypto', SOLUSD: 'crypto',
  LTCUSD: 'crypto', ADAUSD: 'crypto', DOGEUSD: 'crypto', BNBUSD: 'crypto',
}

/**
 * Classify a symbol: metal / energy / agri / index / crypto / equity
 * (broker ".US" suffix) / fx / fx (USD-base) / fx cross / other.
 */
export function instrumentType(symbol) {
  const s = (symbol || '').toUpperCase()
  if (TYPE_BY_SYMBOL[s]) return TYPE_BY_SYMBOL[s]
  if (/\.[A-Z]{2,3}$/.test(s)) return 'equity'
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) {
    if (s.endsWith('USD')) return 'fx'
    if (s.startsWith('USD')) return 'fx (USD-base)'
    return 'fx cross'
  }
  return 'other'
}

/**
 * Lookup the contract size for a symbol. Returns the default FX size for
 * any 6-letter pair not explicitly listed; otherwise 1.
 */
export function contractSize(symbol) {
  const s = (symbol || '').toUpperCase()
  if (CONTRACT_SIZE[s] != null) return CONTRACT_SIZE[s]
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) return DEFAULT_FX_CONTRACT
  return 1
}

/**
 * The quote currency of a 6-letter FX pair, or null for anything else
 * (indices, commodities, single names — all treated as USD-denominated).
 * Known non-FX symbols take priority over the 6-letter pattern — NATGAS,
 * COFFEE and COTTON are 6 uppercase letters but are NOT currency pairs
 * (treating them as crosses vetoed their sizing as usd_per_lot_unknown).
 */
function fxQuoteCurrency(symbol) {
  const s = (symbol || '').toUpperCase()
  if (CONTRACT_SIZE[s] != null) return null
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) return s.slice(3)
  return null
}

/**
 * USD loss per lot given a price-level distance. Exact for USD-quoted symbols
 * (XXXUSD, indices, commodities). For USD-base pairs (USDJPY, USDCHF …) the
 * raw loss is in the quote currency; pass the current `price` so it can be
 * converted back to USD (loss ÷ price). Returns NaN when the conversion is
 * impossible — USD-base without a price, or a cross with no USD leg — so the
 * risk manager vetoes instead of mis-sizing.
 */
export function usdLossPerLot(symbol, priceDistance, price) {
  const quote = fxQuoteCurrency(symbol)
  const lossInQuote = Math.abs(priceDistance) * contractSize(symbol)
  if (quote == null || quote === 'USD') return lossInQuote
  const base = symbol.toUpperCase().slice(0, 3)
  if (base === 'USD' && Number.isFinite(price) && price > 0) {
    return lossInQuote / price
  }
  return NaN
}

/**
 * Notional exposure (USD) for a position. Used to compute margin required:
 *   margin = notional / leverage
 *
 * Exact for USD-quoted (EURUSD, XAUUSD, BTCUSD, US30, etc) and for USD-base
 * pairs (USDJPY etc — notional is simply volume × contract size in USD).
 * Crosses (no USD leg) fall back to quote-currency notional, which is only
 * an approximation for the margin headroom check.
 */
export function notionalUsd(symbol, volumeLots, price) {
  const quote = fxQuoteCurrency(symbol)
  if (quote != null && quote !== 'USD') {
    const base = symbol.toUpperCase().slice(0, 3)
    // 1 lot of USDXXX = contractSize USD of notional, no price term needed.
    if (base === 'USD') return Math.abs(volumeLots) * contractSize(symbol)
  }
  return Math.abs(volumeLots) * contractSize(symbol) * Math.abs(price)
}

// ---------------------------------------------------------------------------
// Account-size tiers — purely informational label for the dashboard. The risk
// manager does NOT gate instruments by tier; affordability is checked via
// the risk budget + margin headroom.
// ---------------------------------------------------------------------------

export const TIERS = [
  { name: 'micro',    maxBalance: 500,       note: 'Tight risk budget — small lots only' },
  { name: 'small',    maxBalance: 2000,      note: 'Modest risk budget' },
  { name: 'standard', maxBalance: 10000,     note: 'Comfortable sizing across products' },
  { name: 'full',     maxBalance: Infinity,  note: 'Full flexibility' },
]

export function tierForBalance(balance) {
  const b = Number(balance) || 0
  for (const t of TIERS) {
    if (b <= t.maxBalance) return t
  }
  return TIERS[TIERS.length - 1]
}
