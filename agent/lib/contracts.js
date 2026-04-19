// ---------------------------------------------------------------------------
// agent/lib/contracts.js — instrument contract sizes + account-size tiers
// ---------------------------------------------------------------------------
// Contract size = how many units of the base asset a "1 lot" order represents.
// Used to convert SL distance (price) into USD loss per lot, which drives
// risk-based position sizing.
//
// For USD-quoted instruments, USD loss per lot = priceDistance * contractSize.
// For USD-base crosses (USDJPY, USDCHF etc) the exact formula needs the current
// price, but for risk *budgeting* the approximation is fine — we oversize
// marginally which is the conservative direction.
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
 * Estimate USD loss per lot given a price-level distance. Exact for USD-quoted
 * symbols (XXXUSD) and indices, approximate for USD-base (USDXXX) and crosses.
 */
export function usdLossPerLot(symbol, priceDistance) {
  return Math.abs(priceDistance) * contractSize(symbol)
}

/**
 * Notional exposure (USD) for a position. Used to compute margin required:
 *   margin = notional / leverage
 *
 * Exact for USD-quoted (EURUSD, XAUUSD, BTCUSD, US30, etc).
 * For non-USD quote (USDJPY, crosses) this is expressed in the quote currency
 * — good enough for a conservative margin headroom check.
 */
export function notionalUsd(symbol, volumeLots, price) {
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
