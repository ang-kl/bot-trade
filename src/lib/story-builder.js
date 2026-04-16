// Pure (position, execState) -> story card data model. The Feed page
// renders whatever this returns; the shape is the visual contract and is
// pinned by story-builder.test.js.

import { POSITION_STATES } from './ctrader-client.js'

const SIDE_GLYPH = { long: '\u25B2', short: '\u25BC' } // ▲ / ▼
const SIDE_VERB = { long: 'BOUGHT', short: 'SOLD' }

export function normalizeSide(raw) {
  if (raw == null) return 'long'
  const s = String(raw).toLowerCase()
  if (['sell', 'short', 's', '\u25BC', 'down'].includes(s)) return 'short'
  return 'long'
}

function formatPrice(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '—'
  if (Math.abs(p) >= 100) return p.toFixed(2)
  if (Math.abs(p) >= 1) return p.toFixed(4)
  return p.toFixed(5)
}

function formatVolume(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  const s = v.toFixed(2)
  return s.endsWith('.00') ? s.slice(0, -3) : s
}

export function computePnl(side, entry, current, volume = 1) {
  if (typeof entry !== 'number' || typeof current !== 'number') return 0
  if (!Number.isFinite(entry) || !Number.isFinite(current)) return 0
  const diff = current - entry
  const dir = side === 'short' ? -1 : 1
  return dir * diff * (volume || 0)
}

export function computeProgressToTP(side, entry, current, tp) {
  if (![entry, current, tp].every(v => typeof v === 'number' && Number.isFinite(v))) return 0
  const total = side === 'short' ? entry - tp : tp - entry
  if (total === 0) return 0
  const moved = side === 'short' ? entry - current : current - entry
  const raw = moved / total
  if (!Number.isFinite(raw)) return 0
  return Math.max(0, Math.min(1, raw))
}

function clampConfidence(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(10, Math.round(n)))
}

function pickNumber(...candidates) {
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

export function actionsForState(state) {
  switch (state) {
    case 'WATCHING': return ['why', 'dismiss']
    case 'PENDING': return ['cancel', 'why']
    case 'LIVE': return ['stop', 'why', 'tighten-sl']
    case 'WON':
    case 'LOST':
    case 'CANCELLED': return ['why']
    default: return []
  }
}

export function buildStory(position, execState) {
  if (!POSITION_STATES.includes(execState)) {
    throw new Error(`Unknown execState: ${execState}`)
  }
  if (!position || typeof position !== 'object') {
    throw new Error('position required')
  }

  const side = normalizeSide(position.side ?? position.tradeSide)
  const symbol = position.symbol || position.symbolName || 'UNKNOWN'
  const volume = Number(position.volume ?? position.lots ?? 0) || 0
  const entryPrice = pickNumber(position.entryPrice, position.avgPrice, position.openPrice)
  const currentPrice = pickNumber(position.currentPrice, position.bid, position.ask, entryPrice)
  const stopLoss = pickNumber(position.stopLoss, position.stopLossPrice)
  const takeProfit = pickNumber(position.takeProfit, position.takeProfitPrice)

  const pnl = computePnl(side, entryPrice, currentPrice, volume)
  const pnlPct = entryPrice && volume ? (pnl / (Math.abs(entryPrice) * volume)) * 100 : 0
  const progressToTP = computeProgressToTP(side, entryPrice, currentPrice, takeProfit)

  const headline = `${SIDE_GLYPH[side]} ${SIDE_VERB[side]} ${formatVolume(volume)} ${symbol} at $${formatPrice(entryPrice)}`
  const reasoning = typeof position.reasoning === 'string'
    ? position.reasoning
    : (position.reasoning?.why || position.thesis || '')
  const confidence = clampConfidence(position.confidence ?? position.reasoning?.confidence)
  const timestamp = position.openTimestamp || position.timestamp || null

  return {
    id: position.positionId || position.id || `${symbol}-${timestamp || 'now'}`,
    state: execState,
    side,
    symbol,
    volume,
    entryPrice,
    currentPrice,
    stopLoss,
    takeProfit,
    pnl,
    pnlPct,
    progressToTP,
    headline,
    reasoning,
    confidence,
    timestamp,
    actions: actionsForState(execState),
  }
}
