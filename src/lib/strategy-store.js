// Strategy store — pure reducer + localStorage helpers + React context handle.
// The provider component lives in strategy-store.jsx so this file can run
// under node-env vitest without jsdom. Same split as theme.js / theme.jsx.

import { createContext, useContext } from 'react'

export const STORAGE_KEY = 'bot-trade:strategy'

// Persisted schema version. Bump this whenever INITIAL_STATE gains a new
// seeded default (like the v1 watchlist pool) that returning visitors with
// stale localStorage should be migrated into.
export const SCHEMA_VERSION = 2

export const SOURCE_OPTIONS = ['osinet', 'reuters', 'bloomberg', 'ft', 'telegram', 'x', 'rss', 'forexfactory']
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
  return { symbol, label, category, enabled: false, agents: { ...DEFAULT_AGENTS }, autoTradeThreshold: 8, maxVolume: 0.01 }
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
  // Crypto
  seed('BTCUSD', 'Bitcoin / USD', 'Crypto'),
  seed('ETHUSD', 'Ethereum / USD', 'Crypto'),
  // Indices
  seed('CN50', 'China 50 Index', 'Indices'),
]

export const INITIAL_STATE = {
  schemaVersion: SCHEMA_VERSION,
  ctrader: {
    linkedAccountId: null,
    accessToken: '',
    refreshToken: '',
    tokenExpiresAt: null,
    accounts: [],
    accountRoles: {},
  },
  watchlist: DEFAULT_WATCHLIST,
  news: {
    sources: ['osinet'],
    telegramChannels: [],
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
  telegram: {
    botToken: '',
    chatId: '',
    enabled: false,
    alertOnScan: true,
    alertOnTrade: true,
    minConfidence: 5,
  },
  massive: {
    apiKey: '',
    s3AccessKeyId: '',
    s3Endpoint: '',
    s3Bucket: '',
  },
  adminLocks: {
    ctrader: false,
    telegram: false,
    massive: false,
  },
  alertLog: [],
  symbolStats: {},
  aiPicks: {
    picks: [],
    rationale: '',
    index: '',
    scanned: 0,
    lastPickedAt: null,
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
      if (action.expiresIn != null) next.tokenExpiresAt = Date.now() + Number(action.expiresIn) * 1000
      return { ...state, ctrader: next }
    }
    case 'CTRADER_SET_ACCOUNTS':
      return { ...state, ctrader: { ...state.ctrader, accounts: Array.isArray(action.accounts) ? action.accounts : [] } }
    case 'CTRADER_LINK_ACCOUNT':
      return { ...state, ctrader: { ...state.ctrader, linkedAccountId: action.accountId ?? null } }
    case 'CTRADER_SET_ACCOUNT_ROLE': {
      const id = String(action.accountId)
      const prev = state.ctrader.accountRoles[id] || { autopilot: false, copilot: false }
      const next = { ...prev }
      if (typeof action.autopilot === 'boolean') next.autopilot = action.autopilot
      if (typeof action.copilot === 'boolean') next.copilot = action.copilot
      return {
        ...state,
        ctrader: {
          ...state.ctrader,
          accountRoles: { ...state.ctrader.accountRoles, [id]: next },
        },
      }
    }

    case 'WATCHLIST_ADD': {
      const sym = normalizeSymbol(action.symbol)
      if (!sym || state.watchlist.some(w => w.symbol === sym)) return state
      const row = { symbol: sym, enabled: true, agents: { ...DEFAULT_AGENTS }, autoTradeThreshold: 8, maxVolume: 0.01 }
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

    case 'WATCHLIST_SET_THRESHOLD': {
      const sym = normalizeSymbol(action.symbol)
      const threshold = clampNum(action.threshold, 1, 11)
      return {
        ...state,
        watchlist: state.watchlist.map(w => w.symbol === sym ? { ...w, autoTradeThreshold: threshold } : w),
      }
    }
    case 'WATCHLIST_SET_VOLUME': {
      const sym = normalizeSymbol(action.symbol)
      const vol = clampNum(action.volume, 0.01, 100)
      return {
        ...state,
        watchlist: state.watchlist.map(w => w.symbol === sym ? { ...w, maxVolume: vol } : w),
      }
    }

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

    case 'NEWS_ADD_TELEGRAM_CHANNEL': {
      const ch = {
        id: action.id || `tg-${Date.now()}`,
        name: action.name || '',
        username: action.username || '',
        enabled: action.enabled !== false,
      }
      if (!ch.name && !ch.username) return state
      // No duplicates by username
      if (ch.username && state.news.telegramChannels.some(c => c.username === ch.username)) return state
      return { ...state, news: { ...state.news, telegramChannels: [...state.news.telegramChannels, ch] } }
    }
    case 'NEWS_REMOVE_TELEGRAM_CHANNEL':
      return {
        ...state,
        news: { ...state.news, telegramChannels: state.news.telegramChannels.filter(c => c.id !== action.id) },
      }
    case 'NEWS_TOGGLE_TELEGRAM_CHANNEL':
      return {
        ...state,
        news: {
          ...state.news,
          telegramChannels: state.news.telegramChannels.map(c =>
            c.id === action.id ? { ...c, enabled: !c.enabled } : c,
          ),
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

    case 'TELEGRAM_SET': {
      const tg = { ...state.telegram }
      if (typeof action.botToken === 'string') tg.botToken = action.botToken
      if (typeof action.chatId === 'string') tg.chatId = action.chatId
      if (action.enabled != null) tg.enabled = !!action.enabled
      if (action.alertOnScan != null) tg.alertOnScan = !!action.alertOnScan
      if (action.alertOnTrade != null) tg.alertOnTrade = !!action.alertOnTrade
      if (action.minConfidence != null) tg.minConfidence = clampNum(action.minConfidence, 1, 10)
      return { ...state, telegram: tg }
    }

    case 'ALERT_LOG_ADD': {
      const entry = {
        id: action.id || `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        symbol: normalizeSymbol(action.symbol),
        type: action.alertType || 'info',
        message: action.message || '',
        details: action.details || '',
        status: action.status || 'alive',
        agent: action.agent || '',
        tokens: action.tokens || 0,
        timestamp: action.timestamp || Date.now(),
      }
      return { ...state, alertLog: [...(state.alertLog || []), entry] }
    }
    case 'ALERT_LOG_UPDATE_STATUS': {
      if (!action.id || !action.status) return state
      return {
        ...state,
        alertLog: (state.alertLog || []).map(a =>
          a.id === action.id ? { ...a, status: action.status } : a,
        ),
      }
    }
    case 'ALERT_LOG_CLEAR':
      return { ...state, alertLog: [] }

    case 'MASSIVE_SET': {
      const m = { ...state.massive }
      if (typeof action.apiKey === 'string') m.apiKey = action.apiKey
      if (typeof action.s3AccessKeyId === 'string') m.s3AccessKeyId = action.s3AccessKeyId
      if (typeof action.s3Endpoint === 'string') m.s3Endpoint = action.s3Endpoint
      if (typeof action.s3Bucket === 'string') m.s3Bucket = action.s3Bucket
      return { ...state, massive: m }
    }

    case 'ADMIN_LOCK': {
      const svc = action.service
      if (!svc || !(svc in state.adminLocks)) return state
      return { ...state, adminLocks: { ...state.adminLocks, [svc]: true } }
    }
    case 'ADMIN_UNLOCK': {
      const svc = action.service
      if (!svc || !(svc in state.adminLocks)) return state
      return { ...state, adminLocks: { ...state.adminLocks, [svc]: false } }
    }

    case 'AI_PICKS_SET': {
      const picks = Array.isArray(action.picks) ? action.picks : []
      return {
        ...state,
        aiPicks: {
          picks,
          rationale: action.rationale || '',
          index: action.index || '',
          scanned: action.scanned || 0,
          lastPickedAt: action.at || new Date().toISOString(),
        },
      }
    }
    case 'AI_PICKS_CLEAR':
      return { ...state, aiPicks: { ...INITIAL_STATE.aiPicks } }
    case 'AI_PICKS_REMOVE': {
      const ticker = normalizeSymbol(action.ticker)
      return {
        ...state,
        aiPicks: {
          ...state.aiPicks,
          picks: state.aiPicks.picks.filter(p => normalizeSymbol(p.ticker) !== ticker),
        },
      }
    }

    case 'SYMBOL_STATS_UPDATE': {
      // Merge per-symbol stats: { statsMap: { EURUSD: { trend: true, ... }, ... } }
      const map = action.statsMap
      if (!map || typeof map !== 'object') return state
      return { ...state, symbolStats: { ...state.symbolStats, ...map } }
    }
    case 'SYMBOL_STATS_CLEAR':
      return { ...state, symbolStats: {} }

    default:
      return state
  }
}

export function sanitize(raw, fallback = INITIAL_STATE) {
  if (!raw || typeof raw !== 'object') return fallback
  const rawVersion = Number(raw.schemaVersion) || 0
  const needsWatchlistMigration = rawVersion < SCHEMA_VERSION
  const storedWatchlist = Array.isArray(raw.watchlist)
    ? raw.watchlist
        .filter(w => w && typeof w.symbol === 'string')
        .map(w => {
          const row = {
            symbol: normalizeSymbol(w.symbol),
            enabled: !!w.enabled,
            agents: { ...DEFAULT_AGENTS, ...(w.agents && typeof w.agents === 'object' ? w.agents : {}) },
            autoTradeThreshold: clampNum(w.autoTradeThreshold ?? 8, 1, 11),
            maxVolume: clampNum(w.maxVolume ?? 0.01, 0.01, 100),
          }
          if (typeof w.label === 'string' && w.label) row.label = w.label
          if (typeof w.category === 'string' && WATCHLIST_CATEGORIES.includes(w.category)) row.category = w.category
          return row
        })
    : null
  // v1 → v2 migration: if the stored watchlist is missing or empty, seed it
  // with the new default pool. Users who deliberately trimmed a v2 watchlist
  // down to zero rows are preserved because their rawVersion already equals
  // SCHEMA_VERSION.
  const watchlist = (needsWatchlistMigration && (!storedWatchlist || storedWatchlist.length === 0))
    ? fallback.watchlist
    : (storedWatchlist || [])
  const news = { ...fallback.news, ...(raw.news && typeof raw.news === 'object' ? raw.news : {}) }
  delete news.briefingWindow // removed in v3
  news.sources = Array.isArray(news.sources) ? news.sources.filter(s => SOURCE_OPTIONS.includes(s)) : fallback.news.sources
  news.telegramChannels = Array.isArray(news.telegramChannels) ? news.telegramChannels : []
  return {
    schemaVersion: SCHEMA_VERSION,
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
    telegram: {
      ...fallback.telegram,
      ...(raw.telegram && typeof raw.telegram === 'object' ? raw.telegram : {}),
    },
    massive: {
      ...fallback.massive,
      ...(raw.massive && typeof raw.massive === 'object' ? raw.massive : {}),
    },
    adminLocks: {
      ...fallback.adminLocks,
      ...(raw.adminLocks && typeof raw.adminLocks === 'object' ? raw.adminLocks : {}),
    },
    alertLog: Array.isArray(raw.alertLog) ? raw.alertLog : [],
    symbolStats: raw.symbolStats && typeof raw.symbolStats === 'object' ? raw.symbolStats : {},
    aiPicks: raw.aiPicks && typeof raw.aiPicks === 'object'
      ? {
          picks: Array.isArray(raw.aiPicks.picks) ? raw.aiPicks.picks : [],
          rationale: raw.aiPicks.rationale || '',
          index: raw.aiPicks.index || '',
          scanned: raw.aiPicks.scanned || 0,
          lastPickedAt: raw.aiPicks.lastPickedAt || null,
        }
      : { ...fallback.aiPicks },
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
