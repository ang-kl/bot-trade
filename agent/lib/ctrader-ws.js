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

// Payload type constants — from github.com/spotware/openapi-proto-messages
export const PT = Object.freeze({
  HEARTBEAT:               51,
  APP_AUTH_REQ:            2100,
  APP_AUTH_RES:            2101,
  ACCOUNT_AUTH_REQ:        2102,
  ACCOUNT_AUTH_RES:        2103,
  NEW_ORDER_REQ:           2106,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ:      2111,
  SYMBOL_BY_ID_REQ:        2116,
  SYMBOL_BY_ID_RES:        2117,
  RECONCILE_REQ:           2124,
  RECONCILE_RES:           2125,
  EXECUTION_EVENT:         2126,
  ORDER_ERROR_EVENT:       2132,
  GET_TRENDBARS_REQ:       2137,
  GET_TRENDBARS_RES:       2138,
  ERROR_RES:               2142,
})

// ProtoOATrendbarPeriod enum — from github.com/spotware/openapi-proto-messages
export const TRENDBAR_PERIOD = Object.freeze({
  '1m': 1, '2m': 2, '3m': 3, '4m': 4, '5m': 5, '10m': 6,
  '15m': 7, '30m': 8, '1h': 9, '4h': 10, '12h': 11,
  '1d': 12, '1w': 13, '1mo': 14,
})

const TRENDBAR_DURATION_MS = Object.freeze({
  '1m': 60_000, '2m': 120_000, '3m': 180_000, '4m': 240_000, '5m': 300_000,
  '10m': 600_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000,
  '4h': 14_400_000, '12h': 43_200_000, '1d': 86_400_000,
  '1w': 604_800_000, '1mo': 2_592_000_000,
})

// ---------------------------------------------------------------------------
// Generic request/response runner
// ---------------------------------------------------------------------------

/**
 * Open a WS, run an ordered list of { send, expect } steps, resolve with the
 * final step's payload. Times out at `timeoutMs`. Surfaces cTrader ERROR_RES
 * and ORDER_ERROR_EVENT as rejections with their errorCode + description.
 *
 * @param {string} host — e.g. 'demo.ctraderapi.com'
 * @param {Array<{send: {payloadType: number, payload: any}, expect: number}>} steps
 * @param {number} [timeoutMs=20000]
 * @returns {Promise<any>}
 */
function wsRun(host, steps, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:5036`)
    let hb, timer, stepIdx = 0
    const seen = []

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
        stepIdx++
        if (stepIdx >= steps.length) {
          cleanup()
          resolve(msg.payload || {})
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
 * Resolve an array of numeric symbolIds to their metadata (symbolName, etc.)
 * via SYMBOL_BY_ID_REQ. Returns `{ symbol: [{ symbolId, symbolName, ... }] }`.
 */
export function wsSymbolsByIds(host, clientId, clientSecret, accessToken, accountId, symbolIds, timeoutMs = 20_000) {
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.SYMBOL_BY_ID_REQ, payload: { ctidTraderAccountId: parseInt(accountId), symbolId: symbolIds.map(id => parseInt(id)) } }, expect: PT.SYMBOL_BY_ID_RES },
  ], timeoutMs), 2, 'wsSymbolsByIds')
}

/**
 * Fetch historical OHLC trendbars for a symbol via GET_TRENDBARS_REQ.
 * `period` is one of the TRENDBAR_PERIOD keys (e.g. '1h', '4h', '1d').
 * Returns the raw GET_TRENDBARS_RES payload: `{ trendbar: [...] }` — use
 * `convertTrendbars` (agent/services/fib-strategy.js) to turn it into
 * plain `{t,o,h,l,c,v}` bars.
 */
export function wsGetTrendbars(host, clientId, clientSecret, accessToken, accountId, symbolId, period, count = 150, timeoutMs = 20_000) {
  const periodCode = TRENDBAR_PERIOD[period]
  if (!periodCode) throw new Error(`wsGetTrendbars: unknown period "${period}"`)
  const durationMs = TRENDBAR_DURATION_MS[period]
  const toTimestamp = Date.now()
  const fromTimestamp = toTimestamp - durationMs * (count + 5)

  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    {
      send: {
        payloadType: PT.GET_TRENDBARS_REQ,
        payload: {
          ctidTraderAccountId: parseInt(accountId),
          symbolId: parseInt(symbolId),
          period: periodCode,
          fromTimestamp,
          toTimestamp,
          count,
        },
      },
      expect: PT.GET_TRENDBARS_RES,
    },
  ], timeoutMs), 2, 'wsGetTrendbars')
}

// Exposed for tests that need to stub WebSocket behaviour.
export const _internal = { wsRun }
