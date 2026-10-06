// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { accountSymbolMapKey, accountSymbolMapIsFresh, credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { readMomentumTimedQuote } from './momentum-timed-quote.js'
import { freshBrokerStamp } from './momentum-broker-evidence.js'

// Reuse the timestamped reader's five-second freshness contract. Receipt
// time never renews a broker quote, and scan prices are not position quotes.
const HELD_QUOTE_MAX_AGE_MS = 5000

function positionCreatedAt(pos) {
  if (typeof pos.created_at !== 'string' || !pos.created_at.trim()) return NaN
  const text = pos.created_at.trim().replace(' ', 'T')
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : `${text}Z`)
}

/** Fresh account-owned quotes for the main monitor, without map refreshes. */
export async function refreshHeldPositionPrices(db, positions, { readQuote = readMomentumTimedQuote, now = Date.now, concurrency = 4 } = {}) {
  const requests = new Map(), receipts = new Map()
  for (const pos of positions) {
    const accountId = pos.account_id == null ? null : String(pos.account_id)
    const symbol = String(pos.symbol || '').toUpperCase()
    if (!accountId || !symbol) continue
    const key = `${accountId}|${symbol}`
    if (requests.has(key)) continue
    try {
      const creds = credsForRegisteredAccount(db, accountId)
      if (!creds?.ready) continue
      const own = JSON.parse(getState(db, accountSymbolMapKey(accountId)) || 'null')
      const built = Date.parse(own?.builtAt)
      const at = now()
      if (String(own?.accountId) !== accountId || !own?.map || typeof own.map !== 'object' || Array.isArray(own.map)
        || !Number.isFinite(built) || built > at || !accountSymbolMapIsFresh(own, at)) continue
      const symbolId = own.map[symbol]
      if (!Number.isSafeInteger(Number(symbolId)) || Number(symbolId) <= 0) continue
      requests.set(key, { creds, symbolId, symbol })
    } catch { /* absent/unreadable ownership: no quote and no primary fallback */ }
  }
  const pending = [...requests.entries()]
  const width = Math.max(1, Math.min(4, Math.floor(Number(concurrency)) || 4))
  for (let i = 0; i < pending.length; i += width) {
    await Promise.all(pending.slice(i, i + width).map(async ([key, { creds, symbolId, symbol }]) => {
      try {
        const quote = await readQuote(creds, symbolId, { now, maxAgeMs: HELD_QUOTE_MAX_AGE_MS })
        receipts.set(key, { host: creds.host, accountId: String(creds.accountId), symbolId: String(symbolId), symbol, quote })
      } catch { /* failed read: keep existing metrics and broker protection */ }
    }))
  }
  return receipts
}

/** Recheck age at consumption, including time spent reading other symbols. */
export function heldPositionPrice(pos, receipts, { now = Date.now } = {}) {
  const accountId = pos.account_id == null ? null : String(pos.account_id)
  const symbol = String(pos.symbol || '').toUpperCase()
  const receipt = receipts?.get?.(`${accountId}|${symbol}`)
  const q = receipt?.quote
  const createdAt = positionCreatedAt(pos)
  if (!q || receipt.accountId !== accountId || receipt.symbol !== symbol
    || String(q.ctidTraderAccountId) !== accountId || String(q.symbolId) !== receipt.symbolId
    || !Number.isFinite(createdAt) || q.timestamp < createdAt
    || !freshBrokerStamp(q.timestamp, { nowMs: now(), maxAgeMs: HELD_QUOTE_MAX_AGE_MS })
    || !Number.isSafeInteger(q.bid) || q.bid <= 0 || !Number.isSafeInteger(q.ask) || q.ask < q.bid) return null
  // The shared timestamped reader returns cTrader's integer price points.
  return (q.bid + q.ask) / (2 * 100000)
}
// agent/services/held-prices.js — cheap current-price refresh for OPEN
// positions, decoupled from the heavy new-setup scan.
//
// The main-loop monitor now uses the account-owned timestamped path above.
// The legacy symbol refresh below is retained for its other callers.
// The deterministic rules (break-even, trailing, partials) need a current
// price. That price used to
// come "for free" from the full fib scan — which is why held symbols were
// force-scanned every loop, crowding out coverage of new candidates once the
// book filled. This module supplies those prices the cheap way: a single spot
// quote per held symbol (one lightweight subscribe/read, NOT a 150-bar ×
// multi-timeframe fetch + signal compute), so monitoring never competes with
// hunting for the scan budget.
//
// Best-effort per symbol: a failed quote leaves that symbol out of the map and
// the monitor holds it that cycle (the broker-resident SL/TP is the real
// backstop between loops). getSpot is injectable for tests.
// ---------------------------------------------------------------------------

/**
 * @param {{host,clientId,clientSecret,accessToken,accountId}} creds
 * @param {Record<string, number|string>} symbolMap  UPPER symbol → symbolId
 * @param {string[]} symbols  held-position symbols
 * @param {{ getSpot?: (symbolId)=>Promise<{bid:number,ask:number}|null>, concurrency?: number }} [opts]
 * @returns {Promise<Record<string, number>>}  UPPER symbol → mid price
 */
export async function refreshHeldPrices(creds, symbolMap, symbols, opts = {}) {
  const uniq = [...new Set((symbols || []).map(s => String(s).toUpperCase()))]
  if (uniq.length === 0) return {}

  let getSpot = opts.getSpot
  if (!getSpot) {
    const { wsGetSpotOnce } = await import('../lib/ctrader-ws.js')
    getSpot = (symbolId) => wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
  }
  const concurrency = Math.max(1, Number(opts.concurrency) || 4)

  const out = {}
  for (let i = 0; i < uniq.length; i += concurrency) {
    const chunk = uniq.slice(i, i + concurrency)
    await Promise.all(chunk.map(async (sym) => {
      const id = symbolMap[sym]
      if (id == null) return
      try {
        const q = await getSpot(id)
        const mid = midPrice(q)
        if (mid != null) out[sym] = mid
      } catch { /* best-effort — a failed quote just holds the position */ }
    }))
  }
  return out
}

/** Mid of a {bid,ask} quote; tolerates one side missing. null when unusable. */
export function midPrice(q) {
  if (!q) return null
  const bid = Number(q.bid)
  const ask = Number(q.ask)
  const okBid = Number.isFinite(bid)
  const okAsk = Number.isFinite(ask)
  if (okBid && okAsk) return (bid + ask) / 2
  if (okBid) return bid
  if (okAsk) return ask
  return null
}
