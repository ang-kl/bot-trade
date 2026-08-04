// ---------------------------------------------------------------------------
// src/lib/instrument-matrix.js — 1,900 instruments on one screen, as a 4 × 7
// grid of session × character.
//
// Owner, 04-08-2026: "All 1900+ from Pepperstone should be categorised into
// quick groups buttons, in a collapsible table" — four columns
// (Risk-On/High Beta Growth · Defensive/Cash Flow/Yield · Commodity/Hard Asset
// Linked · Global Regional Exchanges) crossed with seven session blocks,
// sized to a half-screen iPad Pro split with no page overflow.
//
// TWO INDEPENDENT AXES, WHICH IS WHY IT IS A GRID AND NOT A LIST. The row says
// WHEN an instrument trades — that comes from exchange-regions.js, the same
// leaf module the market-hours gate reads, so a cell can never claim a session
// the engine disagrees with. The column says WHAT KIND of exposure it is,
// which no broker field carries and which is therefore the part that has to be
// asserted here.
//
// AND THE PART THAT IS ASSERTED IS ALLOWED TO SAY "I DON'T KNOW". A US equity
// whose sector we cannot establish is NOT quietly dropped into the biggest
// cell to make the counts look complete — `cellFor` returns null and the
// caller reports the remainder as an explicit unclassified tally. This file's
// whole job is to make 1,900 instruments legible; a confidently wrong cell in
// a trading UI is worse than a named gap, and a silent one is worse still
// (the same rule the veto breakdown and the disposition sweep already follow).
// ---------------------------------------------------------------------------

import { categoriseSymbol, isFxPair, isSymbolMarketOpen } from '../../agent/lib/sessions.js'
import { regionOf, bareTicker } from '../../agent/lib/symbol-taxonomy.js'

/** The four columns, left to right. `hint` is the owner's own size estimate. */
export const MATRIX_COLUMNS = Object.freeze([
  { key: 'growth', label: 'Risk-On / High Beta Growth', short: 'Risk-On', hint: 450 },
  { key: 'defensive', label: 'Defensive / Cash Flow / Yield', short: 'Defensive', hint: 350 },
  { key: 'commodity', label: 'Commodity / Hard Asset Linked', short: 'Commodity', hint: 300 },
  { key: 'regional', label: 'Global Regional Exchanges', short: 'Regional', hint: 800 },
])

/** The seven rows, top to bottom. `session` keys the open/closed toggle. */
export const MATRIX_ROWS = Object.freeze([
  { key: 'continuous', label: '24/5 Continuous Liquidity', short: '24/5', session: 'fx' },
  { key: 'asia', label: 'Asian Session Blocks', short: 'Asia', session: 'asia' },
  { key: 'europe', label: 'European Session Blocks', short: 'Europe', session: 'europe' },
  { key: 'us_tech', label: 'US RTH: Tech & Semiconductor Herd', short: 'US Tech & Semis', session: 'us' },
  { key: 'us_value', label: 'US RTH: Financials, Cyclicals & Value', short: 'US Financials', session: 'us' },
  { key: 'us_defensive', label: 'US RTH: Defensives, Energy & Industrials', short: 'US Defensives', session: 'us' },
  { key: 'thematic', label: 'Global Thematic & Cross-Asset ETFs', short: 'Thematic ETFs', session: 'us' },
])

export const COLUMN_KEYS = MATRIX_COLUMNS.map(c => c.key)
export const ROW_KEYS = MATRIX_ROWS.map(r => r.key)

/** Region → session row. Regions the grid has no row for fall to `regional`. */
const REGION_ROW = Object.freeze({
  japan: 'asia', hongkong: 'asia', china: 'asia', singapore: 'asia', australia: 'asia',
  germany: 'europe', uk: 'europe', france: 'europe', spain: 'europe', italy: 'europe',
  netherlands: 'europe', switzerland: 'europe', nordics: 'europe',
})

/**
 * Currencies whose pairs are a commodity bet in disguise (CAD/oil, AUD/iron,
 * NOK/Brent, ZAR/gold) and the two the desk buys when it wants to hide.
 */
const COMMODITY_CCY = new Set(['AUD', 'NZD', 'CAD', 'NOK', 'ZAR', 'BRL', 'MXN', 'CLP', 'RUB'])
const HAVEN_CCY = new Set(['JPY', 'CHF'])

/** US index CFDs, placed by what they actually track rather than by region. */
const INDEX_CELL = Object.freeze({
  NAS100: ['growth', 'us_tech'],
  US2000: ['growth', 'us_value'],
  US500: ['defensive', 'us_value'],
  US30: ['defensive', 'us_defensive'],
  VIX: ['defensive', 'us_defensive'],
  SDY: ['defensive', 'thematic'],
})

/**
 * Sector → [column, row]. The column names are the owner's; the mapping from a
 * sector to one of them is the judgement call this table makes explicit so it
 * can be argued with instead of being buried in a chain of ifs.
 */
const SECTOR_CELL = Object.freeze({
  tech: ['growth', 'us_tech'],
  semis: ['growth', 'us_tech'],
  software: ['growth', 'us_tech'],
  internet: ['growth', 'us_tech'],
  cyclical: ['growth', 'us_value'],
  financial: ['defensive', 'us_value'],     // cash flow and yield, by nature
  staples: ['defensive', 'us_defensive'],
  health: ['defensive', 'us_defensive'],
  utility: ['defensive', 'us_defensive'],
  telecom: ['defensive', 'us_defensive'],
  industrial: ['defensive', 'us_defensive'],
  energy: ['commodity', 'us_defensive'],
  materials: ['commodity', 'us_defensive'],
  etf: ['defensive', 'thematic'],
})

/**
 * Curated sector for the US names this desk is most likely to hold. Partial by
 * construction and honestly so — see the header. `sectorFromDescription` picks
 * up a good deal of the tail from the broker's own long names, and whatever
 * neither reaches is reported rather than guessed.
 */
const TICKER_SECTOR = Object.freeze({
  // Semiconductors
  NVDA: 'semis', AMD: 'semis', INTC: 'semis', AVGO: 'semis', QCOM: 'semis',
  TXN: 'semis', MU: 'semis', AMAT: 'semis', LRCX: 'semis', KLAC: 'semis',
  ADI: 'semis', NXPI: 'semis', ON: 'semis', MRVL: 'semis', TSM: 'semis', ASML: 'semis',
  // Tech / software / internet
  AAPL: 'tech', MSFT: 'software', GOOGL: 'internet', GOOG: 'internet', META: 'internet',
  AMZN: 'internet', NFLX: 'internet', ORCL: 'software', CRM: 'software', ADBE: 'software',
  NOW: 'software', SNOW: 'software', PLTR: 'software', UBER: 'internet', ABNB: 'internet',
  SHOP: 'internet', SQ: 'software', PYPL: 'software', INTU: 'software', IBM: 'tech',
  CSCO: 'tech', DELL: 'tech', HPQ: 'tech', SMCI: 'tech', ANET: 'tech', PANW: 'software',
  CRWD: 'software', ZS: 'software', DDOG: 'software', NET: 'software', MDB: 'software',
  // Cyclicals — autos, retail, travel, leisure
  TSLA: 'cyclical', RIVN: 'cyclical', LCID: 'cyclical', F: 'cyclical', GM: 'cyclical',
  NKE: 'cyclical', SBUX: 'cyclical', MCD: 'cyclical', HD: 'cyclical', LOW: 'cyclical',
  TGT: 'cyclical', DIS: 'cyclical', BKNG: 'cyclical', MAR: 'cyclical', DAL: 'cyclical',
  UAL: 'cyclical', AAL: 'cyclical', CCL: 'cyclical', RCL: 'cyclical', LULU: 'cyclical',
  // Financials
  JPM: 'financial', BAC: 'financial', WFC: 'financial', C: 'financial', GS: 'financial',
  MS: 'financial', SCHW: 'financial', BLK: 'financial', AXP: 'financial', V: 'financial',
  MA: 'financial', BRK: 'financial', USB: 'financial', PNC: 'financial', TFC: 'financial',
  COF: 'financial', SPGI: 'financial', CME: 'financial', ICE: 'financial', AIG: 'financial',
  MET: 'financial', PRU: 'financial', ALL: 'financial', TRV: 'financial', CB: 'financial',
  COIN: 'financial', HOOD: 'financial',
  // Staples / health / utilities / telecom — the yield end
  PG: 'staples', KO: 'staples', PEP: 'staples', WMT: 'staples', COST: 'staples',
  PM: 'staples', MO: 'staples', CL: 'staples', KMB: 'staples', GIS: 'staples',
  MDLZ: 'staples', KHC: 'staples', STZ: 'staples', KR: 'staples',
  JNJ: 'health', PFE: 'health', MRK: 'health', ABBV: 'health', LLY: 'health',
  UNH: 'health', TMO: 'health', ABT: 'health', BMY: 'health', AMGN: 'health',
  GILD: 'health', CVS: 'health', MDT: 'health', ISRG: 'health', VRTX: 'health',
  NEE: 'utility', DUK: 'utility', SO: 'utility', D: 'utility', AEP: 'utility',
  EXC: 'utility', SRE: 'utility', XEL: 'utility',
  T: 'telecom', VZ: 'telecom', TMUS: 'telecom', CMCSA: 'telecom',
  // Industrials
  BA: 'industrial', CAT: 'industrial', DE: 'industrial', HON: 'industrial', GE: 'industrial',
  GEV: 'industrial', MMM: 'industrial', UPS: 'industrial', FDX: 'industrial', LMT: 'industrial',
  RTX: 'industrial', NOC: 'industrial', GD: 'industrial', UNP: 'industrial', CSX: 'industrial',
  EMR: 'industrial', ETN: 'industrial', ITW: 'industrial', PH: 'industrial',
  // Energy and materials — the hard-asset column
  XOM: 'energy', CVX: 'energy', COP: 'energy', SLB: 'energy', EOG: 'energy',
  PSX: 'energy', MPC: 'energy', VLO: 'energy', OXY: 'energy', HAL: 'energy',
  KMI: 'energy', WMB: 'energy', DVN: 'energy', FANG: 'energy',
  FCX: 'materials', NEM: 'materials', GOLD: 'materials', AA: 'materials', NUE: 'materials',
  DOW: 'materials', LIN: 'materials', APD: 'materials', SHW: 'materials', VALE: 'materials',
  RIO: 'materials', BHP: 'materials', CLF: 'materials', X: 'materials', MOS: 'materials',
})

/**
 * Well-known ETF tickers. Kept separate from TICKER_SECTOR because an ETF's
 * row is the thematic one regardless of what it holds — that is the whole
 * point of the seventh row.
 */
const ETF_TICKERS = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'EEM', 'EFA', 'VEA', 'VWO',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC',
  'GLD', 'SLV', 'USO', 'UNG', 'TLT', 'IEF', 'HYG', 'LQD', 'AGG', 'TIP',
  'ARKK', 'SMH', 'SOXX', 'XBI', 'IBB', 'KRE', 'ITB', 'JETS', 'TAN', 'ICLN',
  'VNQ', 'SCHD', 'VIG', 'DVY', 'EWJ', 'EWZ', 'EWG', 'EWU', 'FXI', 'MCHI', 'INDA',
])

/**
 * Sector from the broker's own description, for the tail the curated table
 * cannot reach. Ordered most specific first — "Semiconductor" must beat
 * "Technology", and "Bank" must not be swallowed by a later generic match.
 */
const DESCRIPTION_SECTOR = Object.freeze([
  [/semiconduct|microchip|foundr/i, 'semis'],
  [/software|cloud|cyber|internet|e-?commerce|social/i, 'software'],
  [/technolog|electronic|computer|hardware/i, 'tech'],
  [/bank|insur|financ|capital|asset manage|brokerage|exchange holding|reinsur/i, 'financial'],
  [/pharma|biotech|health|medical|hospital|therapeut|diagnost|life science/i, 'health'],
  [/oil|gas|petroleum|energy|drilling|refin|pipeline/i, 'energy'],
  [/mining|miner|steel|copper|gold|silver|aluminium|aluminum|chemical|fertiliz|cement|paper/i, 'materials'],
  [/utilit|electric power|water compan/i, 'utility'],
  [/telecom|wireless|communicat|broadcast/i, 'telecom'],
  [/aerospace|defen[cs]e|machinery|industrial|railroad|airline|logistic|constructi|engineering/i, 'industrial'],
  [/beverage|food|tobacco|household|consumer staple|supermarket|grocer/i, 'staples'],
  [/retail|apparel|automobile|automotive|hotel|restaurant|leisure|travel|casino|luxury/i, 'cyclical'],
  [/\bETF\b|index fund|trust fund/i, 'etf'],
])

/** The sector a broker description implies, or null. */
export function sectorFromDescription(description) {
  const d = String(description || '')
  if (!d) return null
  for (const [re, sector] of DESCRIPTION_SECTOR) if (re.test(d)) return sector
  return null
}

/** Which column an FX pair belongs to — the trade it actually expresses. */
function fxColumn(s) {
  const legs = [s.slice(0, 3), s.slice(3)]
  if (legs.some(c => COMMODITY_CCY.has(c))) return 'commodity'
  if (legs.some(c => HAVEN_CCY.has(c))) return 'defensive'
  return 'growth'
}

/**
 * Where does this instrument sit in the grid?
 *
 * @param {string} symbol
 * @param {Object<string,string>} [descriptions] broker long names, for the tail
 * @returns {{col: string, row: string, why: string}|null} null = UNPLACED, and
 *   the caller must SAY SO rather than pick a cell for it.
 */
export function cellFor(symbol, descriptions = null) {
  const s = String(symbol || '').toUpperCase()
  if (!s) return null
  const cls = categoriseSymbol(s)
  const region = regionOf(s)
  const ticker = bareTicker(s)

  // 1. Crypto — the row the owner named explicitly, and the risk-on column by
  //    construction: nothing else on this book moves like it.
  if (cls === 'crypto') return { col: 'growth', row: 'continuous', why: 'crypto' }

  // 2. FX — always continuous; the column is what the pair is a bet ON.
  if (cls === 'fx') {
    return { col: isFxPair(s) ? fxColumn(s) : 'growth', row: 'continuous', why: 'fx' }
  }

  // 3. Metals, energies, softs, grains — the hard-asset column, and continuous
  //    enough that a session row would be a distinction without a difference.
  if (cls === 'metal' || cls === 'commodity' || cls === 'soft' || cls === 'grain') {
    return { col: 'commodity', row: 'continuous', why: cls }
  }

  // 4. Indices. Non-US ones ARE the regional column — that is what a foreign
  //    index CFD is. US ones are placed by what they track.
  if (cls === 'index') {
    const sessionRow = REGION_ROW[region]
    if (sessionRow) return { col: 'regional', row: sessionRow, why: 'foreign index' }
    const hit = INDEX_CELL[s]
    if (hit) return { col: hit[0], row: hit[1], why: 'us index' }
    return { col: 'regional', row: 'thematic', why: 'index' }
  }

  // 5. ETFs — the seventh row exists for these, whatever they hold.
  if (ETF_TICKERS.has(ticker)) {
    return { col: 'defensive', row: 'thematic', why: 'etf' }
  }

  // 6. Equities on a non-US exchange — regional, by their own session.
  const sessionRow = REGION_ROW[region]
  if (sessionRow) return { col: 'regional', row: sessionRow, why: 'foreign listing' }

  // 7. US equities — sector, curated first, then the broker's own description.
  const sector = TICKER_SECTOR[ticker] || sectorFromDescription(descriptions?.[s])
  const cell = sector ? SECTOR_CELL[sector] : null
  if (cell) return { col: cell[0], row: cell[1], why: sector }

  // 8. UNPLACED, and said out loud. See the header for why this is not a
  //    fallback into the biggest cell.
  return null
}

/**
 * Build the whole grid.
 *
 * @returns {{cells: Map<string, string[]>, unplaced: string[], total: number,
 *            placed: number}} cells keyed `col|row`, each holding sorted
 *   symbols. `unplaced` is the honest remainder, never folded into a cell.
 */
export function buildMatrix(symbols, descriptions = null) {
  const cells = new Map()
  for (const c of COLUMN_KEYS) for (const r of ROW_KEYS) cells.set(`${c}|${r}`, [])
  const unplaced = []
  const seen = new Set()

  for (const raw of symbols || []) {
    const s = String(raw || '').toUpperCase()
    if (!s || seen.has(s)) continue        // the catalogue can repeat a name
    seen.add(s)
    const hit = cellFor(s, descriptions)
    if (!hit) { unplaced.push(s); continue }
    cells.get(`${hit.col}|${hit.row}`).push(s)
  }
  for (const arr of cells.values()) arr.sort()
  unplaced.sort()
  return { cells, unplaced, total: seen.size, placed: seen.size - unplaced.length }
}

/** The cell key both the grid and the open-state store agree on. */
export const cellKey = (col, row) => `${col}|${row}`

/**
 * A TradingView chart URL for a symbol. Pepperstone tickers carry the broker's
 * dot suffix, which TradingView does not use, so the bare ticker is what goes
 * on the wire — a link to `AMD.US` resolves to nothing.
 */
export function tradingViewUrl(symbol) {
  const s = String(symbol || '').toUpperCase()
  const cls = categoriseSymbol(s)
  const bare = bareTicker(s)
  if (cls === 'crypto') return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`BINANCE:${bare}T`)}`
  if (cls === 'fx' || cls === 'metal') return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`FX:${bare}`)}`
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(bare)}`
}

/**
 * Is a row's session open right now? Drives the All / Active Now / Closed
 * toggle. Reuses the gate's own answer through a representative symbol rather
 * than re-deriving hours here — a filter that disagreed with the engine about
 * what is open would be worse than no filter.
 */
export function rowMatchesSessionFilter(rowKey, filter, isOpenFn = rowOpenNow) {
  if (filter === 'all') return true
  const open = isOpenFn(rowKey)
  return filter === 'open' ? open : !open
}

/**
 * One symbol per row that stands for the row's hours. `isSymbolMarketOpen` is
 * the authority — asking it about a representative instrument is how the
 * filter stays married to the gate instead of growing a second clock.
 */
const ROW_PROXY = Object.freeze({
  continuous: 'EURUSD',    // the FX week: Sun 22:00 → Fri 21:00 UTC
  asia: 'JPN225',
  europe: 'GER40',
  us_tech: 'NAS100',
  us_value: 'US500',
  us_defensive: 'US30',
  thematic: 'US500',       // US-listed ETFs keep US RTH
})

/** Is the row's session open at `now`? */
export function rowOpenNow(rowKey, now = new Date()) {
  const proxy = ROW_PROXY[rowKey]
  if (!proxy) return true
  return isSymbolMarketOpen(proxy, now).open
}
