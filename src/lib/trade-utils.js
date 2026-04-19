// ---------------------------------------------------------------------------
// trade-utils.js — shared trading utilities
// ---------------------------------------------------------------------------
// Extracted from Agent.jsx and AccountPanel.jsx to eliminate duplication.
// Every export here is consumed by pipeline step components as well as the
// original pages/components that used to define these inline.
// ---------------------------------------------------------------------------

import { fmtAgo } from '../lib/time.js'
import { parseLabel } from '../../agent/lib/trade-labels.js'

// Re-export so consumers can pull everything from one place.
export { fmtAgo, parseLabel }

// Map parsed label source -> badge tone + display label. Unknown / null
// source falls through and the row just shows the raw label string.
export const SOURCE_BADGE = {
  autopilot: { tone: 'info',    text: 'AUTOPILOT' },
  copilot:   { tone: 'special', text: 'COPILOT'   },
  manual:    { tone: 'neutral', text: 'MANUAL'    },
  external:  { tone: 'warning', text: 'EXTERNAL'  },
}

export const PIP_SIZE = {
  XAUUSD: 0.01, XAGUSD: 0.001,
  USDJPY: 0.01, EURJPY: 0.01, GBPJPY: 0.01, AUDJPY: 0.01, CADJPY: 0.01, CHFJPY: 0.01, NZDJPY: 0.01,
}

export function pipDist(from, to, symbol) {
  if (from == null || to == null) return null
  const size = PIP_SIZE[symbol] ?? (symbol?.match(/^(US|NAS|GER|UK|JPN|FRA|SPA|HK|AUS)/) ? 1 : 0.0001)
  return (to - from) / size
}

const SCAN_CACHE_KEY = 'bot-trade:scan-cache'
export function readPriceCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY)
    if (!raw) return {}
    return JSON.parse(raw).massiveMetrics || {}
  } catch { return {} }
}

export function computePnl(position, priceCache) {
  const mm = priceCache[position.symbolName] || {}
  const currentPrice = mm.currentPrice ?? mm.price ?? mm.vwap ?? null
  if (!currentPrice || !position.openPrice || !position.volume) return null
  const volLots = position.volume / 10000
  const direction = position.side === 'BUY' ? 1 : -1
  const sym = position.symbolName || ''
  const contractSize = sym.startsWith('XAU') ? 100
    : sym.startsWith('XAG') ? 5000
    : sym.match(/^(US|NAS|GER|UK|JPN|FRA|SPA|HK|AUS)/) ? 1
    : 100000
  return direction * (currentPrice - position.openPrice) * volLots * contractSize
}

export function fmtMoney(v, digits = 2) {
  return v != null && Number.isFinite(v)
    ? Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'
}
