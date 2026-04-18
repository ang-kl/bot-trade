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
  const now = new Date()
  const utcDay = now.getUTCDay()   // 0=Sun, 6=Sat
  const utcHour = now.getUTCHours()

  const is247 = hours === H24 || (hours.length === 1 && hours[0].open === 0 && hours[0].close === 24)
  if (is247) return true

  // FX / metals / indices / stocks — weekly closure from Fri 22:00 UTC to Sun ~22:00 UTC.
  if (utcDay === 6) return false
  if (utcDay === 0) return utcHour >= 22
  if (utcDay === 5 && utcHour >= 22) return false

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
  // FX Majors — OTC (interbank), traded via Pepperstone as CFDs
  { symbol: 'EURUSD', label: 'Euro / USD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDJPY', label: 'USD / JPY', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'GBPUSD', label: 'GBP / USD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'AUDUSD', label: 'AUD / USD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDCHF', label: 'USD / CHF', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDCAD', label: 'USD / CAD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'NZDUSD', label: 'NZD / USD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  // FX Crosses
  { symbol: 'AUDJPY', label: 'AUD / JPY', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'EURJPY', label: 'EUR / JPY', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'GBPJPY', label: 'GBP / JPY', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'EURGBP', label: 'EUR / GBP', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'EURAUD', label: 'EUR / AUD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'EURCHF', label: 'EUR / CHF', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'GBPAUD', label: 'GBP / AUD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'AUDNZD', label: 'AUD / NZD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'CADJPY', label: 'CAD / JPY', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'CHFJPY', label: 'CHF / JPY', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'NZDJPY', label: 'NZD / JPY', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDSGD', label: 'USD / SGD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDHKD', label: 'USD / HKD', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDCNH', label: 'USD / CNH', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDZAR', label: 'USD / ZAR', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDMXN', label: 'USD / MXN', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  { symbol: 'USDTRY', label: 'USD / TRY', category: 'Currencies', class: 'fx', exchange: 'OTC' },
  // Crypto — 24/7 OTC
  { symbol: 'BTCUSD', label: 'Bitcoin / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  { symbol: 'ETHUSD', label: 'Ethereum / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  { symbol: 'XRPUSD', label: 'Ripple / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  { symbol: 'SOLUSD', label: 'Solana / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  { symbol: 'LTCUSD', label: 'Litecoin / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  { symbol: 'BCHUSD', label: 'Bitcoin Cash / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  { symbol: 'DOTUSD', label: 'Polkadot / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  { symbol: 'ADAUSD', label: 'Cardano / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  { symbol: 'DOGEUSD', label: 'Dogecoin / USD', category: 'Crypto', class: 'crypto', exchange: 'Crypto' },
  // Indices
  { symbol: 'US500', label: 'US 500 Index (S&P)', category: 'Indices', class: 'index', exchange: 'CME' },
  { symbol: 'US30', label: 'Dow Jones Index', category: 'Indices', class: 'index', exchange: 'CME' },
  { symbol: 'NAS100', label: 'NASDAQ 100', category: 'Indices', class: 'index', exchange: 'CME' },
  { symbol: 'GER40', label: 'German 40 (DAX)', category: 'Indices', class: 'index', exchange: 'EUREX' },
  { symbol: 'JPN225', label: 'Nikkei 225', category: 'Indices', class: 'index', exchange: 'JPX' },
  { symbol: 'UK100', label: 'UK 100 (FTSE)', category: 'Indices', class: 'index', exchange: 'LSE' },
  { symbol: 'FRA40', label: 'France 40 (CAC)', category: 'Indices', class: 'index', exchange: 'EURONEXT' },
  { symbol: 'AUS200', label: 'Australia 200', category: 'Indices', class: 'index', exchange: 'ASX' },
  { symbol: 'HK50', label: 'Hong Kong 50', category: 'Indices', class: 'index', exchange: 'HKEX' },
  { symbol: 'CN50', label: 'China 50 Index', category: 'Indices', class: 'index', exchange: 'SGX' },
  { symbol: 'EUSTX50', label: 'Euro Stoxx 50', category: 'Indices', class: 'index', exchange: 'EUREX' },
  { symbol: 'VIX', label: 'Volatility S&P 500', category: 'Indices', class: 'index', exchange: 'CBOE' },
  { symbol: 'SDY', label: 'SPDR S&P Dividend', category: 'Indices', class: 'index', exchange: 'NYSE' },
  // Metals
  { symbol: 'XAUUSD', label: 'Gold Spot / USD', category: 'Metals', class: 'metal', exchange: 'COMEX' },
  { symbol: 'XAGUSD', label: 'Silver / USD', category: 'Metals', class: 'metal', exchange: 'COMEX' },
  { symbol: 'XPTUSD', label: 'Platinum / USD', category: 'Metals', class: 'metal', exchange: 'COMEX' },
  { symbol: 'XPDUSD', label: 'Palladium / USD', category: 'Metals', class: 'metal', exchange: 'COMEX' },
  { symbol: 'USDX', label: 'US Dollar Index', category: 'Metals', class: 'metal', exchange: 'ICE' },
  // Energy
  { symbol: 'SPOTCRUDE', label: 'WTI Crude Oil', category: 'Futures', class: 'commodity', exchange: 'NYMEX' },
  { symbol: 'SPOTBRENT', label: 'Brent Crude Oil', category: 'Futures', class: 'commodity', exchange: 'ICE' },
  { symbol: 'NATGAS', label: 'Natural Gas', category: 'Futures', class: 'commodity', exchange: 'NYMEX' },
  // Soft Commodities
  { symbol: 'COCOA', label: 'Cocoa Cash', category: 'Futures', class: 'commodity', exchange: 'ICE US' },
  { symbol: 'COFFEE', label: 'Coffee Cash', category: 'Futures', class: 'commodity', exchange: 'ICE US' },
  { symbol: 'COPPER', label: 'CFDs on Copper', category: 'Futures', class: 'commodity', exchange: 'COMEX' },
  { symbol: 'ALUMINIUM', label: 'Aluminium', category: 'Futures', class: 'commodity', exchange: 'LME' },
  { symbol: 'SOYBEANS', label: 'Soybeans Cash', category: 'Futures', class: 'commodity', exchange: 'CBOT' },
  { symbol: 'SUGAR', label: 'Sugar Cash', category: 'Futures', class: 'commodity', exchange: 'ICE US' },
  { symbol: 'COTTON', label: 'Cotton Cash', category: 'Futures', class: 'commodity', exchange: 'ICE US' },
  { symbol: 'WHEAT', label: 'Wheat Cash', category: 'Futures', class: 'commodity', exchange: 'CBOT' },
  { symbol: 'CORN', label: 'Corn Cash', category: 'Futures', class: 'commodity', exchange: 'CBOT' },
  // US Stocks (all NYSE/NASDAQ)
  { symbol: 'AAPL', label: 'Apple Inc.', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'MSFT', label: 'Microsoft Corp.', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'NVDA', label: 'NVIDIA Corp', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'GOOGL', label: 'Alphabet Inc', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'META', label: 'Meta Platforms', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'AMZN', label: 'Amazon.com Inc', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'TSLA', label: 'Tesla Inc', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'AMD', label: 'Advanced Micro', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'INTC', label: 'Intel Corp', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'CRM', label: 'Salesforce Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'ORCL', label: 'Oracle Corp', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'ADBE', label: 'Adobe Inc', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'NFLX', label: 'Netflix Inc', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'CRWD', label: 'CrowdStrike', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'AMAT', label: 'Applied Materials', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'MU', label: 'Micron Technology', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  // US Stocks - Finance
  { symbol: 'JPM', label: 'JPMorgan Chase', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'BAC', label: 'Bank of America', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'GS', label: 'Goldman Sachs', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'MS', label: 'Morgan Stanley', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'V', label: 'Visa Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'MA', label: 'Mastercard', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  // US Stocks - Healthcare
  { symbol: 'JNJ', label: 'Johnson & Johnson', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'UNH', label: 'UnitedHealth', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'PFE', label: 'Pfizer Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'ABBV', label: 'AbbVie Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'VRTX', label: 'Vertex Pharmaceuticals', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  // US Stocks - Industrial/Other
  { symbol: 'WDC', label: 'Western Digital', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'WST', label: 'West Pharmaceutical', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'GLW', label: 'Corning Inc.', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'AVY', label: 'Avery Dennison', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'GEV', label: 'GE Vernova', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'COPX', label: 'Global X Copper Miners', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'STLD', label: 'Steel Dynamics', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'BA', label: 'Boeing Co', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'CAT', label: 'Caterpillar Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'XOM', label: 'Exxon Mobil', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'CVX', label: 'Chevron Corp', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'KO', label: 'Coca-Cola Co', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'PG', label: 'Procter & Gamble', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'DIS', label: 'Walt Disney Co', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'NKE', label: 'Nike Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'WMT', label: 'Walmart Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'HD', label: 'Home Depot', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'COST', label: 'Costco Wholesale', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'SBUX', label: 'Starbucks Corp', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'PYPL', label: 'PayPal Holdings', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'SQ', label: 'Block Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'COIN', label: 'Coinbase Global', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'PLTR', label: 'Palantir Tech', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'SNOW', label: 'Snowflake Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'UBER', label: 'Uber Technologies', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'ABNB', label: 'Airbnb Inc', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'SHOP', label: 'Shopify Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'SPOT', label: 'Spotify Technology', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'SNAP', label: 'Snap Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'PINS', label: 'Pinterest Inc', category: 'Stocks', class: 'stock', exchange: 'NYSE' },
  { symbol: 'RIVN', label: 'Rivian Automotive', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
  { symbol: 'LCID', label: 'Lucid Group', category: 'Stocks', class: 'stock', exchange: 'NASDAQ' },
]

// Quick lookup by symbol
const CATALOG_MAP = Object.fromEntries(PEPPERSTONE_CATALOG.map(c => [c.symbol, c]))

// Alias map: common names → Pepperstone symbols
const ALIASES = {
  GAS: 'NATGAS', NATURALGAS: 'NATGAS',
  OIL: 'SPOTCRUDE', CRUDE: 'SPOTCRUDE', WTI: 'SPOTCRUDE',
  BRENT: 'SPOTBRENT', GOLD: 'XAUUSD', SILVER: 'XAGUSD',
  PLATINUM: 'XPTUSD', PALLADIUM: 'XPDUSD', DOLLAR: 'USDX',
  DAX: 'GER40', NIKKEI: 'JPN225', DOW: 'US30', SPX: 'US500', SPY: 'US500',
  NASDAQ: 'NAS100', QQQ: 'NAS100', FTSE: 'UK100', CAC: 'FRA40',
  BTC: 'BTCUSD', ETH: 'ETHUSD', XRP: 'XRPUSD', SOL: 'SOLUSD',
  DOGE: 'DOGEUSD', ADA: 'ADAUSD', DOT: 'DOTUSD', LTC: 'LTCUSD',
  FB: 'META', FACEBOOK: 'META', GOOGLE: 'GOOGL', AMAZON: 'AMZN',
  APPLE: 'AAPL', MICROSOFT: 'MSFT', NVIDIA: 'NVDA', TESLA: 'TSLA',
  BITCOIN: 'BTCUSD', ETHEREUM: 'ETHUSD',
  RIPPLE: 'XRPUSD', SOLANA: 'SOLUSD', CARDANO: 'ADAUSD',
  SP500: 'US500', SNP500: 'US500', SNP: 'US500',
  DOWJONES: 'US30', DJ30: 'US30',
  NSDQ: 'NAS100', NDX: 'NAS100',
  COPPER: 'COPPER', WHEAT: 'WHEAT', CORN: 'CORN',
  CACAO: 'COCOA', SOYBEAN: 'SOYBEANS', SOY: 'SOYBEANS',
  BOEING: 'BA', DISNEY: 'DIS', NIKE: 'NKE',
  WALMART: 'WMT', STARBUCKS: 'SBUX', COINBASE: 'COIN',
  PALANTIR: 'PLTR', UBER: 'UBER', AIRBNB: 'ABNB',
  SHOPIFY: 'SHOP', SPOTIFY: 'SPOT', RIVIAN: 'RIVN',
  PAYPAL: 'PYPL', CROWDSTRIKE: 'CRWD',
}

export function lookupSymbol(query) {
  const q = query.toUpperCase().trim()
  if (CATALOG_MAP[q]) return CATALOG_MAP[q]
  if (ALIASES[q] && CATALOG_MAP[ALIASES[q]]) return CATALOG_MAP[ALIASES[q]]
  return null
}

export function searchCatalog(query, limit = 20) {
  const q = query.toUpperCase().trim()
  if (!q) return []

  // Check for alias match first
  const aliasTarget = ALIASES[q]
  const aliasEntry = aliasTarget && CATALOG_MAP[aliasTarget]

  // Score every catalog entry for relevance
  const scored = []
  for (const c of PEPPERSTONE_CATALOG) {
    let score = 0
    if (c.symbol === q) score = 100                        // exact symbol
    else if (c.symbol.startsWith(q)) score = 80            // symbol prefix
    else if (c.symbol.includes(q)) score = 60              // symbol contains
    else {
      // Check label words (split on space, slash, parens)
      const words = c.label.toUpperCase().split(/[\s/()]+/)
      if (words.some(w => w === q)) score = 50             // exact word in label
      else if (words.some(w => w.startsWith(q))) score = 35 // word prefix in label
      else if (c.label.toUpperCase().includes(q)) score = 15 // label substring
    }
    if (score > 0) scored.push({ ...c, _score: score })
  }
  scored.sort((a, b) => b._score - a._score)

  // Build results — alias match goes to the very top with a tag
  const results = []
  if (aliasEntry) {
    results.push({ ...aliasEntry, _score: 110, _aliasFrom: q })
    // Remove duplicate from scored list
    const idx = scored.findIndex(s => s.symbol === aliasEntry.symbol)
    if (idx !== -1) scored.splice(idx, 1)
  }

  for (const s of scored) {
    if (results.length >= limit) break
    results.push(s)
  }

  return results.slice(0, limit)
}
