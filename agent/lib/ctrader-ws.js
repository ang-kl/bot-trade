// ---------------------------------------------------------------------------
// agent/lib/ctrader-ws.js
//
// Minimal cTrader Open API WebSocket client used by the Railway keeper.
// Exposes three broker-touching helpers:
//
//   wsPlaceOrder   — opens a new position
//   wsAmendPosition — modifies SL/TP on an OPEN position (absolute prices)
//   wsClosePosition — closes full or partial volume of an OPEN position
//
// Each helper opens a fresh WebSocket, runs the three-step sequence
// (app-auth → account-auth → action), waits for the response, and closes.
// No connection pooling: broker actions are rare (few per loop at most) and
// a fresh connection keeps error paths simple.
//
// All three helpers throw on failure. `wsAmendPosition` and `wsClosePosition`
// recognise POSITION_NOT_FOUND as a benign race — the caller gets an
// `alreadyClosed: true` marker and can update local state without scaring
// the operator.
//
// The WS JSON shapes are documented in api/ctrader.js (handler). That file
// runs on Vercel for browser-side cockpit calls; this module is the same
// protocol for the server-side keeper.
// ---------------------------------------------------------------------------

import WebSocket from 'ws'
import { parseTimeframe, fetchPlan, aggregateBars } from './timeframes.js'

// Payload type constants — from github.com/spotware/openapi-proto-messages
export const PT = Object.freeze({
  HEARTBEAT:               51,
  APP_AUTH_REQ:            2100,
  APP_AUTH_RES:            2101,
  ACCOUNT_AUTH_REQ:        2102,
  ACCOUNT_AUTH_RES:        2103,
  NEW_ORDER_REQ:           2106,
  CANCEL_ORDER_REQ:        2108,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ:      2111,
  ASSET_LIST_REQ:          2112,
  ASSET_LIST_RES:          2113,
  SYMBOLS_LIST_REQ:        2114,
  SYMBOLS_LIST_RES:        2115,
  SYMBOL_BY_ID_REQ:        2116,
  SYMBOL_BY_ID_RES:        2117,
  TRADER_REQ:              2121,
  TRADER_RES:              2122,
  ASSET_CLASS_LIST_REQ:    2153,
  ASSET_CLASS_LIST_RES:    2154,
  SYMBOL_CATEGORY_REQ:     2160,
  SYMBOL_CATEGORY_RES:     2161,
  GET_ACCOUNTS_BY_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_TOKEN_RES: 2150,
  RECONCILE_REQ:           2124,
  RECONCILE_RES:           2125,
  EXECUTION_EVENT:         2126,
  SUBSCRIBE_SPOTS_REQ:     2127,
  SUBSCRIBE_SPOTS_RES:     2128,
  UNSUBSCRIBE_SPOTS_REQ:   2129,
  UNSUBSCRIBE_SPOTS_RES:   2130,
  SPOT_EVENT:              2131,
  ORDER_ERROR_EVENT:       2132,
  DEAL_LIST_REQ:           2133,
  DEAL_LIST_RES:           2134,
  GET_TRENDBARS_REQ:       2137,
  GET_TRENDBARS_RES:       2138,
  ERROR_RES:               2142,
})

// ProtoOATrendbarPeriod enum codes + bar durations, one table so a period
// can never exist in one map but not the other (a missing duration would
// silently produce a NaN fromTimestamp).
// Codes from github.com/spotware/openapi-proto-messages.
export const TRENDBAR_PERIODS = Object.freeze({
  '1m':  { code: 1,  ms: 60_000 },
  '2m':  { code: 2,  ms: 120_000 },
  '3m':  { code: 3,  ms: 180_000 },
  '4m':  { code: 4,  ms: 240_000 },
  '5m':  { code: 5,  ms: 300_000 },
  '10m': { code: 6,  ms: 600_000 },
  '15m': { code: 7,  ms: 900_000 },
  '30m': { code: 8,  ms: 1_800_000 },
  '1h':  { code: 9,  ms: 3_600_000 },
  '4h':  { code: 10, ms: 14_400_000 },
  '12h': { code: 11, ms: 43_200_000 },
  '1d':  { code: 12, ms: 86_400_000 },
  '1w':  { code: 13, ms: 604_800_000 },
  '1mo': { code: 14, ms: 2_592_000_000 },
})

// ---------------------------------------------------------------------------
// Generic request/response runner
// ---------------------------------------------------------------------------

/**
 * Open a WS, run an ordered list of { send, expect } steps, resolve with the
 * final step's payload. Times out at `timeoutMs`. Surfaces cTrader ERROR_RES
 * and ORDER_ERROR_EVENT as rejections with their errorCode + description.
 *
 * With `collectAll: true`, resolves with the array of every step's response
 * payload (in step order) instead of only the last one — used to batch many
 * requests over a single authenticated connection.
 *
 * @param {string} host — e.g. 'demo.ctraderapi.com'
 * @param {Array<{send: {payloadType: number, payload: any}, expect: number}>} steps
 * @param {number} [timeoutMs=20000]
 * @param {boolean} [collectAll=false]
 * @returns {Promise<any>}
 */
function wsRun(host, steps, timeoutMs = 20_000, collectAll = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:5036`)
    let hb, timer, stepIdx = 0
    const seen = []
    const collected = []

    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(hb)
      if (ws.readyState === WebSocket.OPEN) ws.close()
    }

    timer = setTimeout(() => {
      cleanup()
      const pending = steps[stepIdx]
      const label = pending
        ? `expecting ${pending.expect} after sending ${pending.send.payloadType}`
        : 'unknown step'
      const seenStr = seen.length ? ` received=[${seen.join(',')}]` : ''
      reject(new Error(`cTrader WS timeout after ${timeoutMs}ms — ${label}${seenStr}`))
    }, timeoutMs)

    const sendStep = (i) => {
      const step = steps[i]
      ws.send(JSON.stringify({
        clientMsgId: `step_${i}`,
        payloadType: step.send.payloadType,
        payload: step.send.payload,
      }))
    }

    ws.on('open', () => {
      hb = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ payloadType: PT.HEARTBEAT }))
        }
      }, 9000)
      sendStep(0)
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.payloadType === PT.HEARTBEAT) return
      seen.push(msg.payloadType)

      if (msg.payloadType === PT.ERROR_RES) {
        cleanup()
        const e = msg.payload || {}
        reject(new Error(`cTrader error: ${e.errorCode || 'unknown'} — ${e.description || ''}`))
        return
      }
      if (msg.payloadType === PT.ORDER_ERROR_EVENT) {
        cleanup()
        const e = msg.payload || {}
        const posRef = e.positionId ? ` positionId=${e.positionId}` : ''
        reject(new Error(`cTrader order rejected: ${e.errorCode || 'unknown'} — ${e.description || ''}${posRef}`))
        return
      }

      const expected = steps[stepIdx]?.expect
      if (msg.payloadType === expected) {
        if (collectAll) collected.push(msg.payload || {})
        stepIdx++
        if (stepIdx >= steps.length) {
          cleanup()
          resolve(collectAll ? collected : (msg.payload || {}))
        } else {
          sendStep(stepIdx)
        }
      }
    })

    ws.on('error', (err) => {
      cleanup()
      reject(new Error(`cTrader WS error: ${err.message}`))
    })
  })
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

function authSteps(clientId, clientSecret, accessToken, accountId) {
  return [
    { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
    { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
  ]
}

async function withRetry(fn, maxRetries = 2, label = 'ws') {
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err.message || ''
      if (msg.includes('order rejected') || msg.includes('POSITION_NOT_FOUND')) throw err
      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 2000
        console.log(`[${label}] retry ${attempt + 1}/${maxRetries} in ${delay}ms — ${msg}`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw lastErr
}

/**
 * Place a new order. `orderPayload` must already contain the full NEW_ORDER_REQ
 * shape (ctidTraderAccountId, symbolId, tradeSide, volume, orderType, SL/TP,
 * label, …). Returns the EXECUTION_EVENT payload.
 */
export function wsPlaceOrder(host, clientId, clientSecret, accessToken, accountId, orderPayload, timeoutMs = 20_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.NEW_ORDER_REQ, payload: orderPayload }, expect: PT.EXECUTION_EVENT },
  ], timeoutMs), 2, 'wsPlaceOrder')
}

/**
 * Modify an open position's SL and/or TP (absolute prices, not distances).
 * Either stopLoss or takeProfit (or both) must be provided.
 *
 * Resolves with `{ executionType, position, alreadyClosed? }`.
 * - On POSITION_NOT_FOUND: `{ alreadyClosed: true, reason, rawError }` — the
 *   position was closed between our snapshot and the amend request.
 * - On any other broker error: throws.
 */
export async function wsAmendPosition(host, clientId, clientSecret, accessToken, accountId, { positionId, stopLoss, takeProfit }, timeoutMs = 15_000) {
  if (!positionId) throw new Error('wsAmendPosition: positionId required')
  const hasSl = typeof stopLoss === 'number' && stopLoss > 0
  const hasTp = typeof takeProfit === 'number' && takeProfit > 0
  if (!hasSl && !hasTp) throw new Error('wsAmendPosition: stopLoss or takeProfit required')

  const payload = { ctidTraderAccountId: parseInt(accountId), positionId: parseInt(positionId) }
  if (hasSl) payload.stopLoss = Number(stopLoss)
  if (hasTp) payload.takeProfit = Number(takeProfit)

  try {
    const exec = await wsRun(host, [
      ...authSteps(clientId, clientSecret, accessToken, accountId),
      { send: { payloadType: PT.AMEND_POSITION_SLTP_REQ, payload }, expect: PT.EXECUTION_EVENT },
    ], timeoutMs)
    return {
      executionType: exec.executionType,
      position: exec.position || {},
    }
  } catch (err) {
    const msg = err.message || ''
    if (msg.includes('POSITION_NOT_FOUND') || msg.includes('Position not found')) {
      return { alreadyClosed: true, reason: 'position closed before amend reached broker', rawError: msg }
    }
    throw err
  }
}

/**
 * Close an open position, full or partial. `volume` is in cTrader units
 * (10000 = 1 lot) — the caller must convert from lots.
 *
 * Resolves with `{ executionType, deal, position, alreadyClosed? }`. On
 * POSITION_NOT_FOUND the promise resolves (not rejects) with
 * `alreadyClosed: true` — from the keeper's view the outcome is identical.
 */
export async function wsClosePosition(host, clientId, clientSecret, accessToken, accountId, { positionId, volume }, timeoutMs = 20_000) {
  if (!positionId) throw new Error('wsClosePosition: positionId required')
  if (typeof volume !== 'number' || volume <= 0) {
    throw new Error(`wsClosePosition: volume must be a positive number, got ${volume}`)
  }

  const payload = {
    ctidTraderAccountId: parseInt(accountId),
    positionId: parseInt(positionId),
    volume: Math.round(volume),
  }

  try {
    const exec = await wsRun(host, [
      ...authSteps(clientId, clientSecret, accessToken, accountId),
      { send: { payloadType: PT.CLOSE_POSITION_REQ, payload }, expect: PT.EXECUTION_EVENT },
    ], timeoutMs)
    return {
      executionType: exec.executionType,
      deal: exec.deal || {},
      position: exec.position || {},
    }
  } catch (err) {
    const msg = err.message || ''
    if (msg.includes('POSITION_NOT_FOUND') || msg.includes('Position not found')) {
      return { alreadyClosed: true, reason: 'position already closed when CLOSE_POSITION_REQ reached broker', rawError: msg }
    }
    throw err
  }
}

/**
 * Cancel a PENDING order (limit/stop) via CANCEL_ORDER_REQ. Only orders that
 * have not filled can be cancelled — filled orders are positions and must go
 * through wsClosePosition.
 *
 * Resolves with `{ executionType, order, alreadyGone? }`. An ORDER_NOT_FOUND
 * (or already-filled/cancelled) rejection from the broker resolves with
 * `{ alreadyGone: true, reason, rawError }` — either way the resting order no
 * longer exists, which is all the pending-order keeper needs to know.
 */
export async function wsCancelOrder(host, clientId, clientSecret, accessToken, accountId, { orderId }, timeoutMs = 20_000) {
  if (!orderId) throw new Error('wsCancelOrder: orderId required')

  const payload = {
    ctidTraderAccountId: parseInt(accountId),
    orderId: parseInt(orderId),
  }

  try {
    const exec = await wsRun(host, [
      ...authSteps(clientId, clientSecret, accessToken, accountId),
      { send: { payloadType: PT.CANCEL_ORDER_REQ, payload }, expect: PT.EXECUTION_EVENT },
    ], timeoutMs)
    return {
      executionType: exec.executionType,
      order: exec.order || {},
    }
  } catch (err) {
    const msg = err.message || ''
    // Broker wordings vary (ORDER_NOT_FOUND, "Order not found", already
    // filled/cancelled) — all mean the resting order is gone.
    if (/ORDER_NOT_FOUND|Order not found|order not found|ALREADY_FILLED|ORDER_ALREADY/i.test(msg)) {
      return { alreadyGone: true, reason: 'order already gone when CANCEL_ORDER_REQ reached broker', rawError: msg }
    }
    throw err
  }
}

/**
 * Fetch all open positions and pending orders for an account via RECONCILE_REQ.
 * Returns the raw RECONCILE_RES payload: `{ position: [...], order: [...] }`.
 */
export function wsReconcile(host, clientId, clientSecret, accessToken, accountId, timeoutMs = 25_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.RECONCILE_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } }, expect: PT.RECONCILE_RES },
  ], timeoutMs), 2, 'wsReconcile')
}

/**
 * Deal history over a time window — the broker's own record of every fill.
 * The ground truth a local trades row must match to count as a real trade.
 * cTrader caps the window at 1 week per request; callers page if needed.
 * Returns the raw payload: { deal: [{ dealId, positionId, symbolId, volume,
 * tradeSide, executionPrice, executionTimestamp, dealStatus, ... }] }
 */
export function wsGetDeals(host, clientId, clientSecret, accessToken, accountId, fromTimestamp, toTimestamp, timeoutMs = 25_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.DEAL_LIST_REQ, payload: {
      ctidTraderAccountId: parseInt(accountId),
      fromTimestamp: Math.floor(fromTimestamp),
      toTimestamp: Math.floor(toTimestamp),
      maxRows: 500,
    } }, expect: PT.DEAL_LIST_RES },
  ], timeoutMs), 2, 'wsGetDeals')
}

/**
 * Resolve an array of numeric symbolIds to their metadata (symbolName, etc.)
 * via SYMBOL_BY_ID_REQ. Returns `{ symbol: [{ symbolId, symbolName, ... }] }`.
 */
export function wsSymbolsByIds(host, clientId, clientSecret, accessToken, accountId, symbolIds, timeoutMs = 20_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.SYMBOL_BY_ID_REQ, payload: { ctidTraderAccountId: parseInt(accountId), symbolId: symbolIds.map(id => parseInt(id)) } }, expect: PT.SYMBOL_BY_ID_RES },
  ], timeoutMs), 2, 'wsSymbolsByIds')
}

// cTrader stores trendbar OHLC in raw points where 1 point = 10^-5 of the
// quoted price, for every symbol regardless of its digits — same fixed scale
// api/ctrader.js uses (POINTS_PER_PRICE). Do NOT scale by symbol digits.
const POINTS_PER_PRICE = 100_000

/**
 * Decode a raw GET_TRENDBARS_RES payload into ascending {t,o,h,l,c,v} bars.
 * Bars missing the `low` anchor field are dropped (they would decode to NaN,
 * and NaN survives every downstream comparison silently).
 */
export function decodeTrendbars(payload) {
  return (payload?.trendbar || [])
    .filter(b => b.low != null)
    .map(b => ({
      t: (b.utcTimestampInMinutes || 0) * 60_000,
      o: (b.low + (b.deltaOpen || 0)) / POINTS_PER_PRICE,
      h: (b.low + (b.deltaHigh || 0)) / POINTS_PER_PRICE,
      l: b.low / POINTS_PER_PRICE,
      c: (b.low + (b.deltaClose || 0)) / POINTS_PER_PRICE,
      v: b.volume || 0,
    }))
    .sort((a, b) => a.t - b.t)
}

/**
 * Fetch historical OHLC trendbars for a symbol across one or more periods
 * over a SINGLE authenticated connection (one WS + one app/account auth for
 * the whole batch, instead of one per period).
 *
 * @param {string[]} periods - TRENDBAR_PERIODS keys, e.g. ['1d','4h','1h']
 * @returns {Promise<Record<string, Array<{t,o,h,l,c,v}>>>} bars keyed by period
 */
export function wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolId, periods, count = 150, timeoutMs = 30_000, endTime = 0) {
  // endTime anchors the window's right edge for HISTORICAL charts (a past
  // trade's period); 0/omitted = now, exactly as before.
  const now = endTime || Date.now()
  // Custom (non-native) periods are synthesised: fetch the largest native
  // period that divides them, then aggregate. Base fetch is capped at 3,000
  // bars, so high factors return fewer target bars rather than failing —
  // e.g. 1,000 requested 6h bars = 6,000 1h bars → capped to 500 × 6h.
  const plans = periods.map(period => {
    const spec = TRENDBAR_PERIODS[period]
    if (spec) return { period, code: spec.code, ms: spec.ms, fetchCount: count, factor: 1 }
    const parsed = parseTimeframe(period)
    const plan = parsed && fetchPlan(parsed.ms)
    if (!plan) throw new Error(`wsGetTrendbarsBatch: unknown period "${period}"`)
    const baseSpec = TRENDBAR_PERIODS[plan.base]
    return {
      period, code: baseSpec.code, ms: baseSpec.ms,
      fetchCount: Math.min(count * plan.factor, 3000), factor: plan.factor,
    }
  })
  const steps = plans.map(p => ({
    send: {
      payloadType: PT.GET_TRENDBARS_REQ,
      payload: {
        ctidTraderAccountId: parseInt(accountId),
        symbolId: parseInt(symbolId),
        period: p.code,
        fromTimestamp: now - p.ms * (p.fetchCount + 5),
        toTimestamp: now,
        count: p.fetchCount,
      },
    },
    expect: PT.GET_TRENDBARS_RES,
  }))

  return withRetry(async () => {
    const payloads = await wsRun(host, [
      ...authSteps(clientId, clientSecret, accessToken, accountId),
      ...steps,
    ], timeoutMs, true)
    // collectAll returns auth payloads too — the trendbar responses are the
    // last `periods.length` entries, in request order.
    const barPayloads = payloads.slice(-plans.length)
    const out = {}
    plans.forEach((p, i) => {
      const bars = decodeTrendbars(barPayloads[i])
      out[p.period] = p.factor === 1 ? bars : aggregateBars(bars, p.factor).slice(-count)
    })
    return out
  }, 2, 'wsGetTrendbarsBatch')
}

/**
 * List every trading account an access token can operate, via
 * GET_ACCOUNTS_BY_TOKEN (app auth only — no account auth needed).
 * Returns `{ ctidTraderAccount: [{ ctidTraderAccountId, isLive, traderLogin, ... }] }`.
 */
export function wsGetAccountsByToken(host, clientId, clientSecret, accessToken, timeoutMs = 20_000) {
  return withRetry(() => wsRun(host, [
    { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
    { send: { payloadType: PT.GET_ACCOUNTS_BY_TOKEN_REQ, payload: { accessToken } }, expect: PT.GET_ACCOUNTS_BY_TOKEN_RES },
  ], timeoutMs), 2, 'wsGetAccountsByToken')
}

/**
 * Fetch the full light symbol list for an account via SYMBOLS_LIST_REQ.
 * Returns `{ symbol: [{ symbolId, symbolName, ... }] }`.
 */
export function wsGetSymbolsList(host, clientId, clientSecret, accessToken, accountId, timeoutMs = 30_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.SYMBOLS_LIST_REQ, payload: { ctidTraderAccountId: parseInt(accountId), includeArchivedSymbols: false } }, expect: PT.SYMBOLS_LIST_RES },
  ], timeoutMs), 2, 'wsGetSymbolsList')
}

/**
 * Asset classes (Forex, Metals, Indices, …) and symbol categories (the
 * broker's sub-classification under each class). Together with the light
 * symbol list these build the instrument tree: class → category → symbols.
 */
export function wsGetAssetClasses(host, clientId, clientSecret, accessToken, accountId, timeoutMs = 20_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.ASSET_CLASS_LIST_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } }, expect: PT.ASSET_CLASS_LIST_RES },
  ], timeoutMs), 2, 'wsGetAssetClasses')
}

export function wsGetSymbolCategories(host, clientId, clientSecret, accessToken, accountId, timeoutMs = 20_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.SYMBOL_CATEGORY_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } }, expect: PT.SYMBOL_CATEGORY_RES },
  ], timeoutMs), 2, 'wsGetSymbolCategories')
}

/**
 * Fetch account details (balance, leverage) via TRADER_REQ.
 * Returns the ProtoOATrader: `{ balance, leverageInCents, moneyDigits, ... }`.
 * Use `traderBalance(trader)` to decode the balance — monetary fields are
 * scaled by 10^moneyDigits (2 for most brokers, but not guaranteed).
 */
export async function wsGetTrader(host, clientId, clientSecret, accessToken, accountId, timeoutMs = 20_000) {
  const payload = await withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.TRADER_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } }, expect: PT.TRADER_RES },
  ], timeoutMs), 2, 'wsGetTrader')
  return payload.trader || {}
}

/**
 * Decode a ProtoOATrader's balance honoring moneyDigits (default 2).
 * Returns null when the trader has no balance field.
 */
export function traderBalance(trader) {
  if (trader?.balance == null) return null
  const digits = trader.moneyDigits != null ? trader.moneyDigits : 2
  return trader.balance / Math.pow(10, digits)
}

/**
 * Fetch the account's asset list (assetId → name/displayName), used to
 * resolve the deposit currency. Returns `{ asset: [...] }`.
 */
export function wsGetAssets(host, clientId, clientSecret, accessToken, accountId, timeoutMs = 20_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.ASSET_LIST_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } }, expect: PT.ASSET_LIST_RES },
  ], timeoutMs), 2, 'wsGetAssets')
}

/**
 * Latest close per symbol — one authenticated connection, one 1m-trendbar
 * request per symbolId (collectAll). Returns { [symbolId]: closePrice }.
 */
export function wsGetLastCloses(host, clientId, clientSecret, accessToken, accountId, symbolIds, timeoutMs = 30_000) {
  const now = Date.now()
  const spec = TRENDBAR_PERIODS['1m']
  const steps = symbolIds.map(symbolId => ({
    send: {
      payloadType: PT.GET_TRENDBARS_REQ,
      payload: {
        ctidTraderAccountId: parseInt(accountId),
        symbolId: parseInt(symbolId),
        period: spec.code,
        fromTimestamp: now - spec.ms * 10,
        toTimestamp: now,
        count: 2,
      },
    },
    expect: PT.GET_TRENDBARS_RES,
  }))
  return withRetry(async () => {
    const payloads = await wsRun(host, [
      ...authSteps(clientId, clientSecret, accessToken, accountId),
      ...steps,
    ], timeoutMs, true)
    const barPayloads = payloads.slice(-symbolIds.length)
    const out = {}
    symbolIds.forEach((id, i) => {
      const bars = decodeTrendbars(barPayloads[i])
      if (bars.length > 0) out[id] = bars[bars.length - 1].c
    })
    return out
  }, 2, 'wsGetLastCloses')
}

/**
 * Long-lived spot-price stream. Opens one WS, authenticates, subscribes to
 * the given symbolIds, and calls `onTick({symbolId, bid, ask, t})` for every
 * SPOT_EVENT until `close()` is called or the socket drops (then `onClose`
 * fires with the reason and the caller may reconnect).
 *
 * Spot prices arrive scaled like trendbars (fixed 1e5). Events may carry
 * only bid or only ask — missing sides are null (caller keeps last value).
 *
 * @returns {Promise<{close: () => void}>} resolves once subscribed
 */
export function wsStreamSpots(host, clientId, clientSecret, accessToken, accountId, symbolIds, onTick, onClose = () => {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:5036`)
    let hb, settled = false, closedByUs = false

    const finishClose = (reason) => {
      clearInterval(hb)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
      if (!settled) { settled = true; reject(new Error(reason)) }
      else if (!closedByUs) onClose(reason)
    }

    const steps = [
      { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
      { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
      {
        send: {
          payloadType: PT.SUBSCRIBE_SPOTS_REQ,
          payload: { ctidTraderAccountId: parseInt(accountId), symbolId: symbolIds.map(id => parseInt(id)) },
        },
        expect: PT.SUBSCRIBE_SPOTS_RES,
      },
    ]
    let stepIdx = 0

    ws.on('open', () => {
      hb = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ payloadType: PT.HEARTBEAT }))
      }, 9000)
      ws.send(JSON.stringify({ payloadType: steps[0].send.payloadType, payload: steps[0].send.payload }))
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.payloadType === PT.HEARTBEAT) return

      if (msg.payloadType === PT.ERROR_RES) {
        const e = msg.payload || {}
        finishClose(`cTrader error: ${e.errorCode || 'unknown'} — ${e.description || ''}`)
        return
      }

      if (!settled) {
        if (msg.payloadType === steps[stepIdx].expect) {
          stepIdx++
          if (stepIdx >= steps.length) {
            settled = true
            resolve({
              close: () => { closedByUs = true; clearInterval(hb); if (ws.readyState === WebSocket.OPEN) ws.close() },
            })
          } else {
            ws.send(JSON.stringify({ payloadType: steps[stepIdx].send.payloadType, payload: steps[stepIdx].send.payload }))
          }
        }
        return
      }

      if (msg.payloadType === PT.SPOT_EVENT) {
        const p = msg.payload || {}
        onTick({
          symbolId: p.symbolId,
          bid: p.bid != null ? p.bid / POINTS_PER_PRICE : null,
          ask: p.ask != null ? p.ask / POINTS_PER_PRICE : null,
          t: Date.now(),
        })
      }
    })

    ws.on('error', (err) => finishClose(`cTrader WS error: ${err.message}`))
    ws.on('close', () => finishClose('socket closed'))
  })
}

/**
 * One-shot quote: subscribe to a single symbol's spots, resolve with the
 * first tick that carries BOTH sides (merging bid/ask across ticks), then
 * close. Resolves null on timeout instead of rejecting — callers use this
 * as a best-effort pre-trade check and must fail open.
 *
 * @returns {Promise<{bid: number, ask: number}|null>}
 */
export async function wsGetSpotOnce(host, clientId, clientSecret, accessToken, accountId, symbolId, timeoutMs = 6000) {
  let stream = null
  try {
    return await new Promise((resolve) => {
      const quote = { bid: null, ask: null }
      const timer = setTimeout(() => resolve(null), timeoutMs)
      wsStreamSpots(host, clientId, clientSecret, accessToken, accountId, [symbolId], (tick) => {
        if (tick.bid != null) quote.bid = tick.bid
        if (tick.ask != null) quote.ask = tick.ask
        if (quote.bid != null && quote.ask != null) {
          clearTimeout(timer)
          resolve({ ...quote })
        }
      }, () => { clearTimeout(timer); resolve(null) })
        .then(s => { stream = s })
        .catch(() => { clearTimeout(timer); resolve(null) })
    })
  } finally {
    try { stream?.close() } catch { /* already closed */ }
  }
}

// Exposed for tests that need to stub WebSocket behaviour.
export const _internal = { wsRun }
