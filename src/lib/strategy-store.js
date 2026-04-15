// Strategy store — pure reducer + localStorage helpers + React context handle.
// The provider component lives in strategy-store.jsx so this file can run
// under node-env vitest without jsdom. Same split as theme.js / theme.jsx.

import { createContext, useContext } from 'react'

export const STORAGE_KEY = 'bot-trade:strategy'

export const BRIEFING_WINDOWS = ['morning', 'noon', 'adhoc']
export const SOURCE_OPTIONS = ['osinet', 'reuters', 'bloomberg', 'ft']
export const SUB_AGENTS = ['news', 'technical', 'macro', 'history']

export const DEFAULT_AGENTS = { news: true, technical: true, macro: true, history: true }

// Category buckets mirrored from the v1 abot project so the default seed
// renders in the same order the user already knows.
export const WATCHLIST_CATEGORIES = [
  'Futures',
  'Metals',
  'Indices',
  'Stocks',
  'Currencies',
  'Crypto',
]

// Default 39-entry watchlist ported from v1. Every row lands disabled so the
// user (or the agent) explicitly picks which handful to trade each session.
function seed(symbol, label, category) {
  return { symbol, label, category, enabled: false, agents: { ...DEFAULT_AGENTS } }
}

export const DEFAULT_WATCHLIST = [
  // Futures
  seed('NATGAS', 'Natural Gas', 'Futures'),
  seed('COCOA', 'Cocoa Cash', 'Futures'),
  seed('ALUMINIUM', 'Aluminium', 'Futures'),
  seed('STLD', 'Steel Dynamics', 'Futures'),
  seed('COFFEE', 'Coffee Cash', 'Futures'),
  seed('COPPER', 'CFDs on Copper', 'Futures'),
  seed('SOYBEANS', 'Soybeans Cash', 'Futures'),
  seed('SPOTCRUDE', 'WTI Cash', 'Futures'),
  // Metals
  seed('XAGUSD', 'Silver / USD', 'Metals'),
  seed('XAUUSD', 'Gold Spot / USD', 'Metals'),
  seed('XPTUSD', 'Platinum / USD', 'Metals'),
  seed('USDX', 'US Dollar Index', 'Metals'),
  // Indices
  seed('VIX', 'Volatility S&P 500', 'Indices'),
  seed('JPN225', 'Nikkei 225', 'Indices'),
  seed('US500', 'US 500 Index', 'Indices'),
  seed('US30', 'Dow Jones Index', 'Indices'),
  seed('NAS100', 'NASDAQ 100', 'Indices'),
  seed('GER40', 'German 40 Index', 'Indices'),
  seed('SDY', 'SPDR S&P Dividend', 'Indices'),
  // Stocks
  seed('MSFT', 'Microsoft Corp.', 'Stocks'),
  seed('NVDA', 'NVIDIA Corp', 'Stocks'),
  seed('AAPL', 'Apple Inc.', 'Stocks'),
  seed('GOOGL', 'Alphabet Inc', 'Stocks'),
  seed('CRWD', 'CrowdStrike', 'Stocks'),
  seed('WDC', 'Western Digital', 'Stocks'),
  seed('WST', 'West Pharmaceutical', 'Stocks'),
  seed('GLW', 'Corning Inc.', 'Stocks'),
  seed('AVY', 'Avery Dennison', 'Stocks'),
  seed('GEV', 'GE Vernova', 'Stocks'),
  seed('MU', 'Micron Technology', 'Stocks'),
  seed('TSLA', 'Tesla Inc', 'Stocks'),
  seed('COPX', 'Global X Copper Miners', 'Stocks'),
  seed('VRTX', 'Vertex Pharmaceuticals', 'Stocks'),
  seed('AMAT', 'Applied Materials', 'Stocks'),
  // Currencies
  seed('EURUSD', 'Euro / USD', 'Currencies'),
  seed('USDJPY', 'USD / JPY', 'Currencies'),
  seed('AUDJPY', 'AUD / JPY', 'Currencies'),
  // Crypto (CN50 lives here in v1's grouping)
  seed('BTCUSD', 'Bitcoin / USD', 'Crypto'),
  seed('ETHUSD', 'Ethereum / USD', 'Crypto'),
  seed('CN50', 'China 50 Index', 'Crypto'),
]

export const INITIAL_STATE = {
  ctrader: {
    linkedAccountId: null,
    accessToken: '',
    refreshToken: '',
    accounts: [],
  },
  watchlist: DEFAULT_WATCHLIST,
  news: {
    briefingWindow: 'morning',
    sources: ['osinet'],
    structure: null,
    latestRundown: null,
    lastGeneratedAt: null,
  },
  risk: {
    armed: false,
    perTradePct: 1,
    dailyMaxLossPct: 3,
    maxTradesPerDay: 10,
  },
}

// A variant of INITIAL_STATE with no seeded watchlist — used by tests that
// drive the watchlist reducer from a clean slate.
export const EMPTY_STATE = { ...INITIAL_STATE, watchlist: [] }

function clampNum(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

function normalizeSymbol(s) {
  return typeof s === 'string' ? s.trim().toUpperCase() : ''
}

export function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return action.payload || state

    case 'CTRADER_SET_TOKENS': {
      const next = { ...state.ctrader }
      if (typeof action.accessToken === 'string') next.accessToken = action.accessToken
      if (typeof action.refreshToken === 'string') next.refreshToken = action.refreshToken
      return { ...state, ctrader: next }
    }
    case 'CTRADER_SET_ACCOUNTS':
      return { ...state, ctrader: { ...state.ctrader, accounts: Array.isArray(action.accounts) ? action.accounts : [] } }
    case 'CTRADER_LINK_ACCOUNT':
      return { ...state, ctrader: { ...state.ctrader, linkedAccountId: action.accountId ?? null } }

    case 'WATCHLIST_ADD': {
      const sym = normalizeSymbol(action.symbol)
      if (!sym || state.watchlist.some(w => w.symbol === sym)) return state
      const row = { symbol: sym, enabled: true, agents: { ...DEFAULT_AGENTS } }
      if (typeof action.label === 'string' && action.label) row.label = action.label
      if (typeof action.category === 'string' && action.category) row.category = action.category
      return { ...state, watchlist: [...state.watchlist, row] }
    }
    case 'WATCHLIST_REMOVE': {
      const sym = normalizeSymbol(action.symbol)
      return { ...state, watchlist: state.watchlist.filter(w => w.symbol !== sym) }
    }
    case 'WATCHLIST_MOVE': {
      const sym = normalizeSymbol(action.symbol)
      const i = state.watchlist.findIndex(w => w.symbol === sym)
      if (i < 0) return state
      const j = i + (action.delta | 0)
      if (j < 0 || j >= state.watchlist.length) return state
      const next = state.watchlist.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return { ...state, watchlist: next }
    }
    case 'WATCHLIST_TOGGLE_ENABLED': {
      const sym = normalizeSymbol(action.symbol)
      return {
        ...state,
        watchlist: state.watchlist.map(w => w.symbol === sym ? { ...w, enabled: !w.enabled } : w),
      }
    }
    case 'WATCHLIST_TOGGLE_AGENT': {
      const sym = normalizeSymbol(action.symbol)
      if (!SUB_AGENTS.includes(action.agent)) return state
      return {
        ...state,
        watchlist: state.watchlist.map(w => {
          if (w.symbol !== sym) return w
          return { ...w, agents: { ...w.agents, [action.agent]: !w.agents[action.agent] } }
        }),
      }
    }

    case 'NEWS_SET_WINDOW':
      if (!BRIEFING_WINDOWS.includes(action.window)) return state
      return { ...state, news: { ...state.news, briefingWindow: action.window } }
    case 'NEWS_TOGGLE_SOURCE': {
      if (!SOURCE_OPTIONS.includes(action.source)) return state
      const has = state.news.sources.includes(action.source)
      const sources = has ? state.news.sources.filter(s => s !== action.source) : [...state.news.sources, action.source]
      return { ...state, news: { ...state.news, sources } }
    }
    case 'NEWS_SET_STRUCTURE':
      return { ...state, news: { ...state.news, structure: typeof action.structure === 'string' ? action.structure : null } }
    case 'NEWS_SET_RUNDOWN':
      return {
        ...state,
        news: {
          ...state.news,
          latestRundown: typeof action.rundown === 'string' ? action.rundown : null,
          lastGeneratedAt: action.at || new Date().toISOString(),
        },
      }

    case 'RISK_SET': {
      const r = { ...state.risk }
      if (action.perTradePct != null) r.perTradePct = clampNum(action.perTradePct, 0, 100)
      if (action.dailyMaxLossPct != null) r.dailyMaxLossPct = clampNum(action.dailyMaxLossPct, 0, 100)
      if (action.maxTradesPerDay != null) r.maxTradesPerDay = clampNum(action.maxTradesPerDay, 0, 1000)
      return { ...state, risk: r }
    }
    case 'RISK_TOGGLE_ARMED':
      return { ...state, risk: { ...state.risk, armed: !state.risk.armed } }

    default:
      return state
  }
}

export function sanitize(raw, fallback = INITIAL_STATE) {
  if (!raw || typeof raw !== 'object') return fallback
  const watchlist = Array.isArray(raw.watchlist)
    ? raw.watchlist
        .filter(w => w && typeof w.symbol === 'string')
        .map(w => {
          const row = {
            symbol: normalizeSymbol(w.symbol),
            enabled: !!w.enabled,
            agents: { ...DEFAULT_AGENTS, ...(w.agents && typeof w.agents === 'object' ? w.agents : {}) },
          }
          if (typeof w.label === 'string' && w.label) row.label = w.label
          if (typeof w.category === 'string' && WATCHLIST_CATEGORIES.includes(w.category)) row.category = w.category
          return row
        })
    : []
  const news = { ...fallback.news, ...(raw.news && typeof raw.news === 'object' ? raw.news : {}) }
  if (!BRIEFING_WINDOWS.includes(news.briefingWindow)) news.briefingWindow = fallback.news.briefingWindow
  news.sources = Array.isArray(news.sources) ? news.sources.filter(s => SOURCE_OPTIONS.includes(s)) : fallback.news.sources
  return {
    ctrader: { ...fallback.ctrader, ...(raw.ctrader && typeof raw.ctrader === 'object' ? raw.ctrader : {}), accounts: Array.isArray(raw.ctrader?.accounts) ? raw.ctrader.accounts : [] },
    watchlist,
    news,
    risk: {
      ...fallback.risk,
      ...(raw.risk && typeof raw.risk === 'object' ? raw.risk : {}),
      perTradePct: clampNum(raw.risk?.perTradePct ?? fallback.risk.perTradePct, 0, 100),
      dailyMaxLossPct: clampNum(raw.risk?.dailyMaxLossPct ?? fallback.risk.dailyMaxLossPct, 0, 100),
      maxTradesPerDay: clampNum(raw.risk?.maxTradesPerDay ?? fallback.risk.maxTradesPerDay, 0, 1000),
      armed: !!raw.risk?.armed,
    },
  }
}

export function readStored(storage, fallback = INITIAL_STATE) {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return fallback
    return sanitize(JSON.parse(raw), fallback)
  } catch {
    return fallback
  }
}

export function writeStored(storage, state) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export const StrategyContext = createContext({ state: INITIAL_STATE, dispatch: () => {} })

export function useStrategy() {
  return useContext(StrategyContext)
}
