// Trading hours data — Pepperstone CFD market hours in UTC.
// Each symbol maps to an array of { open, close } ranges (UTC hours 0-23).
// FX and crypto are nearly 24h; stocks/commodities have exchange-specific hours.
// Used by the 24h trading hours bar and session-fit logic.

// Common schedule templates (UTC hours)
const H24 = [{ open: 0, close: 24 }] // 24/7 (crypto)
const FX = [{ open: 0, close: 22 }, { open: 23, close: 24 }] // Sun 22:01 to Fri 22:00, 1h break
const INDEX_US = [{ open: 0, close: 22 }, { open: 23, close: 24 }] // nearly 24h, 1h break 22-23 UTC
const INDEX_EU = [{ open: 0, close: 22 }, { open: 23, close: 24 }] // same pattern, 1h break
const INDEX_ASIA = [{ open: 0, close: 22 }, { open: 23, close: 24 }]
const US_STOCKS = [{ open: 14, close: 21 }] // NYSE regular: 9:30-16:00 ET = 14:30-21:00 UTC (approx)
const METALS = [{ open: 0, close: 22 }, { open: 23, close: 24 }] // nearly 24h
const ENERGY = [{ open: 0, close: 22 }, { open: 23, close: 24 }] // nearly 24h
const SOFTS_NYC = [{ open: 14, close: 23 }] // ICE US: ~9:45-18:00 ET
const GRAINS = [{ open: 1, close: 20 }] // CBOT electronic: ~19:00-13:45 CT

// Per-symbol overrides (Pepperstone CFD hours, UTC)
const SYMBOL_HOURS = {
  // FX (24/5)
  EURUSD: FX, USDJPY: FX, GBPUSD: FX, AUDUSD: FX, USDCHF: FX,
  USDCAD: FX, NZDUSD: FX, AUDJPY: FX, EURJPY: FX, GBPJPY: FX,
  // Crypto (24/7)
  BTCUSD: H24, ETHUSD: H24, XRPUSD: H24, SOLUSD: H24,
  // US Indices
  US500: INDEX_US, US30: INDEX_US, NAS100: INDEX_US,
  VIX: [{ open: 14, close: 21 }], // CBOE hours
  SDY: US_STOCKS,
  // Asia Indices
  JPN225: [{ open: 0, close: 6 }, { open: 7, close: 22 }, { open: 23, close: 24 }], // nearly 24h, breaks at 6-7 and 22-23
  CN50: [{ open: 1, close: 9 }, { open: 10, close: 22 }], // Asia hours + extended
  // EU Indices
  GER40: [{ open: 0, close: 22 }, { open: 23, close: 24 }],
  // Metals
  XAUUSD: METALS, XAGUSD: METALS, XPTUSD: METALS,
  USDX: [{ open: 0, close: 22 }, { open: 23, close: 24 }],
  // Energy
  NATGAS: ENERGY,
  SPOTCRUDE: ENERGY,
  // Soft commodities (ICE/CBOT)
  COCOA: [{ open: 13, close: 19 }], // ICE: ~8:45-14:30 ET
  COFFEE: [{ open: 14, close: 23 }], // ICE: ~9:15-18:00 ET
  COPPER: [{ open: 1, close: 22 }], // COMEX electronic
  ALUMINIUM: [{ open: 1, close: 19 }], // LME: ~01:00-19:00 UTC
  SOYBEANS: GRAINS,
  // US Stocks
  AAPL: US_STOCKS, MSFT: US_STOCKS, NVDA: US_STOCKS, GOOGL: US_STOCKS,
  TSLA: US_STOCKS, CRWD: US_STOCKS, WDC: US_STOCKS, WST: US_STOCKS,
  GLW: US_STOCKS, AVY: US_STOCKS, GEV: US_STOCKS, MU: US_STOCKS,
  COPX: US_STOCKS, VRTX: US_STOCKS, AMAT: US_STOCKS, STLD: US_STOCKS,
}

export function getHoursForSymbol(symbol) {
  return SYMBOL_HOURS[symbol.toUpperCase()] || FX // default to FX hours
}

export function isTradingNow(symbol) {
  const hours = getHoursForSymbol(symbol)
  const utcHour = new Date().getUTCHours()
  return hours.some(h => {
    if (h.open < h.close) return utcHour >= h.open && utcHour < h.close
    return utcHour >= h.open || utcHour < h.close
  })
}

// Returns what % of the day this symbol trades (0-100)
export function tradingCoverage(symbol) {
  const hours = getHoursForSymbol(symbol)
  let total = 0
  for (const h of hours) {
    if (h.open < h.close) total += h.close - h.open
    else total += (24 - h.open) + h.close
  }
  return Math.round((total / 24) * 100)
}

// ── Pepperstone symbol catalog (top ~200 instruments) ──

export const PEPPERSTONE_CATALOG = [
  // FX Majors
  { symbol: 'EURUSD', label: 'Euro / USD', category: 'Currencies', class: 'fx' },
  { symbol: 'USDJPY', label: 'USD / JPY', category: 'Currencies', class: 'fx' },
  { symbol: 'GBPUSD', label: 'GBP / USD', category: 'Currencies', class: 'fx' },
  { symbol: 'AUDUSD', label: 'AUD / USD', category: 'Currencies', class: 'fx' },
  { symbol: 'USDCHF', label: 'USD / CHF', category: 'Currencies', class: 'fx' },
  { symbol: 'USDCAD', label: 'USD / CAD', category: 'Currencies', class: 'fx' },
  { symbol: 'NZDUSD', label: 'NZD / USD', category: 'Currencies', class: 'fx' },
  // FX Crosses
  { symbol: 'AUDJPY', label: 'AUD / JPY', category: 'Currencies', class: 'fx' },
  { symbol: 'EURJPY', label: 'EUR / JPY', category: 'Currencies', class: 'fx' },
  { symbol: 'GBPJPY', label: 'GBP / JPY', category: 'Currencies', class: 'fx' },
  { symbol: 'EURGBP', label: 'EUR / GBP', category: 'Currencies', class: 'fx' },
  { symbol: 'EURAUD', label: 'EUR / AUD', category: 'Currencies', class: 'fx' },
  { symbol: 'EURCHF', label: 'EUR / CHF', category: 'Currencies', class: 'fx' },
  { symbol: 'GBPAUD', label: 'GBP / AUD', category: 'Currencies', class: 'fx' },
  { symbol: 'AUDNZD', label: 'AUD / NZD', category: 'Currencies', class: 'fx' },
  { symbol: 'CADJPY', label: 'CAD / JPY', category: 'Currencies', class: 'fx' },
  { symbol: 'CHFJPY', label: 'CHF / JPY', category: 'Currencies', class: 'fx' },
  { symbol: 'NZDJPY', label: 'NZD / JPY', category: 'Currencies', class: 'fx' },
  { symbol: 'USDSGD', label: 'USD / SGD', category: 'Currencies', class: 'fx' },
  { symbol: 'USDHKD', label: 'USD / HKD', category: 'Currencies', class: 'fx' },
  { symbol: 'USDCNH', label: 'USD / CNH', category: 'Currencies', class: 'fx' },
  { symbol: 'USDZAR', label: 'USD / ZAR', category: 'Currencies', class: 'fx' },
  { symbol: 'USDMXN', label: 'USD / MXN', category: 'Currencies', class: 'fx' },
  { symbol: 'USDTRY', label: 'USD / TRY', category: 'Currencies', class: 'fx' },
  // Crypto
  { symbol: 'BTCUSD', label: 'Bitcoin / USD', category: 'Crypto', class: 'crypto' },
  { symbol: 'ETHUSD', label: 'Ethereum / USD', category: 'Crypto', class: 'crypto' },
  { symbol: 'XRPUSD', label: 'Ripple / USD', category: 'Crypto', class: 'crypto' },
  { symbol: 'SOLUSD', label: 'Solana / USD', category: 'Crypto', class: 'crypto' },
  { symbol: 'LTCUSD', label: 'Litecoin / USD', category: 'Crypto', class: 'crypto' },
  { symbol: 'BCHUSD', label: 'Bitcoin Cash / USD', category: 'Crypto', class: 'crypto' },
  { symbol: 'DOTUSD', label: 'Polkadot / USD', category: 'Crypto', class: 'crypto' },
  { symbol: 'ADAUSD', label: 'Cardano / USD', category: 'Crypto', class: 'crypto' },
  { symbol: 'DOGEUSD', label: 'Dogecoin / USD', category: 'Crypto', class: 'crypto' },
  // Indices
  { symbol: 'US500', label: 'US 500 Index (S&P)', category: 'Indices', class: 'index' },
  { symbol: 'US30', label: 'Dow Jones Index', category: 'Indices', class: 'index' },
  { symbol: 'NAS100', label: 'NASDAQ 100', category: 'Indices', class: 'index' },
  { symbol: 'GER40', label: 'German 40 (DAX)', category: 'Indices', class: 'index' },
  { symbol: 'JPN225', label: 'Nikkei 225', category: 'Indices', class: 'index' },
  { symbol: 'UK100', label: 'UK 100 (FTSE)', category: 'Indices', class: 'index' },
  { symbol: 'FRA40', label: 'France 40 (CAC)', category: 'Indices', class: 'index' },
  { symbol: 'AUS200', label: 'Australia 200', category: 'Indices', class: 'index' },
  { symbol: 'HK50', label: 'Hong Kong 50', category: 'Indices', class: 'index' },
  { symbol: 'CN50', label: 'China 50 Index', category: 'Indices', class: 'index' },
  { symbol: 'EUSTX50', label: 'Euro Stoxx 50', category: 'Indices', class: 'index' },
  { symbol: 'VIX', label: 'Volatility S&P 500', category: 'Indices', class: 'index' },
  { symbol: 'SDY', label: 'SPDR S&P Dividend', category: 'Indices', class: 'index' },
  // Metals
  { symbol: 'XAUUSD', label: 'Gold Spot / USD', category: 'Metals', class: 'metal' },
  { symbol: 'XAGUSD', label: 'Silver / USD', category: 'Metals', class: 'metal' },
  { symbol: 'XPTUSD', label: 'Platinum / USD', category: 'Metals', class: 'metal' },
  { symbol: 'XPDUSD', label: 'Palladium / USD', category: 'Metals', class: 'metal' },
  { symbol: 'USDX', label: 'US Dollar Index', category: 'Metals', class: 'metal' },
  // Energy
  { symbol: 'SPOTCRUDE', label: 'WTI Crude Oil', category: 'Futures', class: 'commodity' },
  { symbol: 'SPOTBRENT', label: 'Brent Crude Oil', category: 'Futures', class: 'commodity' },
  { symbol: 'NATGAS', label: 'Natural Gas', category: 'Futures', class: 'commodity' },
  // Soft Commodities
  { symbol: 'COCOA', label: 'Cocoa Cash', category: 'Futures', class: 'commodity' },
  { symbol: 'COFFEE', label: 'Coffee Cash', category: 'Futures', class: 'commodity' },
  { symbol: 'COPPER', label: 'CFDs on Copper', category: 'Futures', class: 'commodity' },
  { symbol: 'ALUMINIUM', label: 'Aluminium', category: 'Futures', class: 'commodity' },
  { symbol: 'SOYBEANS', label: 'Soybeans Cash', category: 'Futures', class: 'commodity' },
  { symbol: 'SUGAR', label: 'Sugar Cash', category: 'Futures', class: 'commodity' },
  { symbol: 'COTTON', label: 'Cotton Cash', category: 'Futures', class: 'commodity' },
  { symbol: 'WHEAT', label: 'Wheat Cash', category: 'Futures', class: 'commodity' },
  { symbol: 'CORN', label: 'Corn Cash', category: 'Futures', class: 'commodity' },
  // US Stocks - Tech
  { symbol: 'AAPL', label: 'Apple Inc.', category: 'Stocks', class: 'stock' },
  { symbol: 'MSFT', label: 'Microsoft Corp.', category: 'Stocks', class: 'stock' },
  { symbol: 'NVDA', label: 'NVIDIA Corp', category: 'Stocks', class: 'stock' },
  { symbol: 'GOOGL', label: 'Alphabet Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'META', label: 'Meta Platforms', category: 'Stocks', class: 'stock' },
  { symbol: 'AMZN', label: 'Amazon.com Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'TSLA', label: 'Tesla Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'AMD', label: 'Advanced Micro', category: 'Stocks', class: 'stock' },
  { symbol: 'INTC', label: 'Intel Corp', category: 'Stocks', class: 'stock' },
  { symbol: 'CRM', label: 'Salesforce Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'ORCL', label: 'Oracle Corp', category: 'Stocks', class: 'stock' },
  { symbol: 'ADBE', label: 'Adobe Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'NFLX', label: 'Netflix Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'CRWD', label: 'CrowdStrike', category: 'Stocks', class: 'stock' },
  { symbol: 'AMAT', label: 'Applied Materials', category: 'Stocks', class: 'stock' },
  { symbol: 'MU', label: 'Micron Technology', category: 'Stocks', class: 'stock' },
  // US Stocks - Finance
  { symbol: 'JPM', label: 'JPMorgan Chase', category: 'Stocks', class: 'stock' },
  { symbol: 'BAC', label: 'Bank of America', category: 'Stocks', class: 'stock' },
  { symbol: 'GS', label: 'Goldman Sachs', category: 'Stocks', class: 'stock' },
  { symbol: 'MS', label: 'Morgan Stanley', category: 'Stocks', class: 'stock' },
  { symbol: 'V', label: 'Visa Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'MA', label: 'Mastercard', category: 'Stocks', class: 'stock' },
  // US Stocks - Healthcare
  { symbol: 'JNJ', label: 'Johnson & Johnson', category: 'Stocks', class: 'stock' },
  { symbol: 'UNH', label: 'UnitedHealth', category: 'Stocks', class: 'stock' },
  { symbol: 'PFE', label: 'Pfizer Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'ABBV', label: 'AbbVie Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'VRTX', label: 'Vertex Pharmaceuticals', category: 'Stocks', class: 'stock' },
  // US Stocks - Industrial/Other
  { symbol: 'WDC', label: 'Western Digital', category: 'Stocks', class: 'stock' },
  { symbol: 'WST', label: 'West Pharmaceutical', category: 'Stocks', class: 'stock' },
  { symbol: 'GLW', label: 'Corning Inc.', category: 'Stocks', class: 'stock' },
  { symbol: 'AVY', label: 'Avery Dennison', category: 'Stocks', class: 'stock' },
  { symbol: 'GEV', label: 'GE Vernova', category: 'Stocks', class: 'stock' },
  { symbol: 'COPX', label: 'Global X Copper Miners', category: 'Stocks', class: 'stock' },
  { symbol: 'STLD', label: 'Steel Dynamics', category: 'Stocks', class: 'stock' },
  { symbol: 'BA', label: 'Boeing Co', category: 'Stocks', class: 'stock' },
  { symbol: 'CAT', label: 'Caterpillar Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'XOM', label: 'Exxon Mobil', category: 'Stocks', class: 'stock' },
  { symbol: 'CVX', label: 'Chevron Corp', category: 'Stocks', class: 'stock' },
  { symbol: 'KO', label: 'Coca-Cola Co', category: 'Stocks', class: 'stock' },
  { symbol: 'PG', label: 'Procter & Gamble', category: 'Stocks', class: 'stock' },
  { symbol: 'DIS', label: 'Walt Disney Co', category: 'Stocks', class: 'stock' },
  { symbol: 'NKE', label: 'Nike Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'WMT', label: 'Walmart Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'HD', label: 'Home Depot', category: 'Stocks', class: 'stock' },
  { symbol: 'COST', label: 'Costco Wholesale', category: 'Stocks', class: 'stock' },
  { symbol: 'SBUX', label: 'Starbucks Corp', category: 'Stocks', class: 'stock' },
  { symbol: 'PYPL', label: 'PayPal Holdings', category: 'Stocks', class: 'stock' },
  { symbol: 'SQ', label: 'Block Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'COIN', label: 'Coinbase Global', category: 'Stocks', class: 'stock' },
  { symbol: 'PLTR', label: 'Palantir Tech', category: 'Stocks', class: 'stock' },
  { symbol: 'SNOW', label: 'Snowflake Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'UBER', label: 'Uber Technologies', category: 'Stocks', class: 'stock' },
  { symbol: 'ABNB', label: 'Airbnb Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'SHOP', label: 'Shopify Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'SPOT', label: 'Spotify Technology', category: 'Stocks', class: 'stock' },
  { symbol: 'SNAP', label: 'Snap Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'PINS', label: 'Pinterest Inc', category: 'Stocks', class: 'stock' },
  { symbol: 'RIVN', label: 'Rivian Automotive', category: 'Stocks', class: 'stock' },
  { symbol: 'LCID', label: 'Lucid Group', category: 'Stocks', class: 'stock' },
]

// Quick lookup by symbol
const CATALOG_MAP = Object.fromEntries(PEPPERSTONE_CATALOG.map(c => [c.symbol, c]))

export function lookupSymbol(query) {
  const q = query.toUpperCase().trim()
  // Direct match
  if (CATALOG_MAP[q]) return CATALOG_MAP[q]
  // Alias resolution (common misnames)
  const aliases = {
    GAS: 'NATGAS', OIL: 'SPOTCRUDE', CRUDE: 'SPOTCRUDE', WTI: 'SPOTCRUDE',
    BRENT: 'SPOTBRENT', GOLD: 'XAUUSD', SILVER: 'XAGUSD',
    PLATINUM: 'XPTUSD', PALLADIUM: 'XPDUSD', DOLLAR: 'USDX',
    DAX: 'GER40', NIKKEI: 'JPN225', DOW: 'US30', SPX: 'US500', SPY: 'US500',
    NASDAQ: 'NAS100', QQQ: 'NAS100', FTSE: 'UK100', CAC: 'FRA40',
    BTC: 'BTCUSD', ETH: 'ETHUSD', XRP: 'XRPUSD', SOL: 'SOLUSD',
    DOGE: 'DOGEUSD', ADA: 'ADAUSD', DOT: 'DOTUSD', LTC: 'LTCUSD',
    FB: 'META', FACEBOOK: 'META', GOOGLE: 'GOOGL', AMAZON: 'AMZN',
    APPLE: 'AAPL', MICROSOFT: 'MSFT', NVIDIA: 'NVDA', TESLA: 'TSLA',
    BITCOIN: 'BTCUSD', ETHEREUM: 'ETHUSD',
  }
  if (aliases[q] && CATALOG_MAP[aliases[q]]) return CATALOG_MAP[aliases[q]]
  return null
}

export function searchCatalog(query, limit = 20) {
  const q = query.toUpperCase().trim()
  if (!q) return []
  return PEPPERSTONE_CATALOG
    .filter(c =>
      c.symbol.includes(q) ||
      c.label.toUpperCase().includes(q)
    )
    .slice(0, limit)
}
