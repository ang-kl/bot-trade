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

// Payload-type constants live in their own module so ctrader-session.js can
// share them without an import cycle. Re-exported here so existing importers
// are unaffected.
export { PT } from './ctrader-payload-types.js'
import { PT } from './ctrader-payload-types.js'
import { poolEnabled, pooledRun, poolStatus } from './ctrader-session.js'

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
// ---------------------------------------------------------------------------
// HISTORICAL-REQUEST RATE LIMITER (incident 2026-07-28)
//
// cTrader Open API allows 50 req/s per connection for normal requests but
// only **5 req/s for HISTORICAL ones** (trendbars, deal list). Nothing in
// this process enforced that. The scan phase fans out over SCAN_CONCURRENCY
// (default 6) symbols with Promise.all, and each of those connections
// pipelines one trendbar request per stale timeframe back to back — so ~6
// historical requests stayed in flight for the whole scan, i.e. 20-40/s at
// typical RTT, four to eight times the allowance. The broker throttled us,
// each request stretched to ~29s, withRetry re-sent them, and the scan ran
// 7+ minutes while /health starved. We were gating ourselves.
//
// A single process-wide token bucket now paces every historical step. It is
// deliberately GLOBAL, not per-connection: the limit is per account, and
// concurrent ephemeral sockets all spend from the same allowance. Normal
// requests (auth, reconcile, spot, trader) are untouched.
// ---------------------------------------------------------------------------
const HISTORICAL_PAYLOADS = new Set([PT.GET_TRENDBARS_REQ, PT.DEAL_LIST_REQ])
// 4/s against a documented 5/s: headroom for clock skew and for the broker
// counting arrival rather than send time. Override for probes/tests.
const HIST_RATE_PER_SEC = Math.max(1, Number(process.env.CTRADER_HIST_RATE_PER_SEC) || 4)

/**
 * Token bucket. `take()` resolves with the milliseconds it made the caller
 * wait (0 = immediate), so a caller can credit that time back to its own
 * timeout. Exported as a factory so the pacing is unit-testable without a
 * broker; the module keeps one shared instance below.
 * `deps.now` / `deps.setTimeout` are injectable for deterministic tests.
 */
export function createRateBucket(perSec, deps = {}) {
  const now = deps.now ?? (() => Date.now())
  const delay = deps.setTimeout ?? setTimeout
  let tokens = perSec
  let last = now()
  let waiting = 0
  const refill = () => {
    const t = now()
    const gained = ((t - last) / 1000) * perSec
    if (gained > 0) { tokens = Math.min(perSec, tokens + gained); last = t }
  }
  return {
    take() {
      refill()
      // The `waiting === 0` term preserves arrival order: a newcomer must not
      // jump a queue of callers already parked on the same bucket.
      if (tokens >= 1 && waiting === 0) { tokens -= 1; return Promise.resolve(0) }
      waiting++
      const startedAt = now()
      return new Promise((resolve) => {
        const attempt = () => {
          refill()
          if (tokens >= 1) {
            tokens -= 1
            waiting--
            resolve(now() - startedAt)
            return
          }
          // Sleep exactly as long as the next token needs, not a fixed poll.
          delay(attempt, Math.max(10, Math.ceil(((1 - tokens) / perSec) * 1000)))
        }
        delay(attempt, 10)
      })
    },
    // Refill before reporting: tokens accrue with elapsed time, and a status
    // read that skipped this showed an idle bucket as permanently empty.
    status: () => {
      refill()
      return { perSec, queued: waiting, tokens: Math.round(tokens * 100) / 100 }
    },
  }
}

const histBucket = createRateBucket(HIST_RATE_PER_SEC)
const takeHistoricalToken = () => histBucket.take()

/** Observability: current limiter pressure, surfaced on /health. */
export function historicalRateStatus() {
  return { ...histBucket.status(), pool: poolEnabled() ? poolStatus() : null }
}

function wsRun(host, steps, timeoutMs = 20_000, collectAll = false) {
  // POOLED PATH (2026-07-28, CTRADER_WS_POOL=1). Every helper below builds its
  // steps as [APP_AUTH_REQ, ACCOUNT_AUTH_REQ, ...the actual request], so the
  // auth prefix is peeled off here and satisfied once per socket instead of
  // once per call — ~1.8s of measured fixed cost, plus the connect/auth
  // failures that cost production 46 scans on 2026-07-28.
  //
  // Peeled here rather than at the 19 call sites so no helper can be missed,
  // and so a helper that does NOT start with the auth pair (there are none
  // today) silently keeps the legacy path instead of losing its auth.
  if (poolEnabled() && steps.length > 2 &&
      steps[0]?.send?.payloadType === PT.APP_AUTH_REQ &&
      steps[1]?.send?.payloadType === PT.ACCOUNT_AUTH_REQ) {
    return pooledRun(host, steps[0].send.payload, steps[1].send.payload, steps.slice(2), timeoutMs, collectAll, {
      takeHistoricalToken,
      isHistorical: (t) => HISTORICAL_PAYLOADS.has(t),
    })
  }
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

    const onTimeout = () => {
      cleanup()
      const pending = steps[stepIdx]
      const label = pending
        ? `expecting ${pending.expect} after sending ${pending.send.payloadType}`
        : 'unknown step'
      const seenStr = seen.length ? ` received=[${seen.join(',')}]` : ''
      reject(new Error(`cTrader WS timeout after ${timeoutMs}ms — ${label}${seenStr}`))
    }
    timer = setTimeout(onTimeout, timeoutMs)

    const sendStep = async (i) => {
      const step = steps[i]
      // Historical steps queue behind the shared token bucket. Time spent
      // WAITING is added back to the timeout — otherwise a request that
      // queued 3s would fail on a budget it never got to use, and the retry
      // would put the very load back on the broker we are pacing away.
      if (HISTORICAL_PAYLOADS.has(step.send.payloadType)) {
        const waited = await takeHistoricalToken()
        if (ws.readyState !== WebSocket.OPEN) return // closed while queued
        if (waited > 0) {
          clearTimeout(timer)
          timer = setTimeout(onTimeout, timeoutMs)
        }
      }
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
      sendStep(0).catch(err => { cleanup(); reject(err) })
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
          sendStep(stepIdx).catch(err => { cleanup(); reject(err) })
        }
      }
    })

    ws.on('error', (err) => {
      cleanup()
      // Step context so callers can tell a pre-submission failure from one
      // AFTER a non-idempotent request went out (see wsPlaceOrder's noRetry).
      const sent = steps[stepIdx]?.send.payloadType
      reject(new Error(`cTrader WS error: ${err.message}${sent != null && stepIdx > 0 ? ` — after sending ${sent}` : ''}`))
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

/**
 * Is this failure the broker telling us to slow down?
 *
 * cTrader answers a breached rate limit with an explicit error rather than a
 * silent drop, and the strings differ by which limiter tripped. Matching a
 * family of markers rather than one exact code, because a miss here is not a
 * cosmetic bug: retrying a throttle at the SAME cadence that caused it is how
 * a brief limit turns into a sustained one.
 *
 * Exported so a caller can ask the same question the retry policy asks.
 */
export function isThrottleError(err) {
  return /throttl|rate.?limit|too.?many.?request|TOO_MANY|REQUEST_FREQUENCY|\b429\b/i.test(err?.message || '')
}

/** Seconds the broker asked us to wait, when it says so. Null when it does not. */
export function retryAfterMs(err) {
  // The gap class excludes '-' on purpose. With [^0-9] it swallowed the sign,
  // so "retry after -5s" parsed as a five-second wait — a negative hint is
  // malformed input and must be refused, not silently made positive. Caught by
  // retry-backoff.test.js on the first run.
  const m = /retry[ -]?after[^0-9-]{0,6}(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?/i.exec(err?.message || '')
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (m[2] || 's').toLowerCase()
  const ms = unit.startsWith('ms') ? n : n * 1000
  // Cap: a malformed or hostile value must not park a management call for an
  // hour. Two minutes is longer than any real broker backoff and short enough
  // that a stuck call still surfaces within one management cycle.
  return Math.min(ms, 120_000)
}

/**
 * #123: THROTTLE-AWARE. The old policy was a flat linear ramp — 2s then 4s,
 * the same for a dropped socket and for a breached rate limit. Those need
 * opposite responses: a dropped socket wants a prompt retry, while a rate
 * limit wants real distance, and retrying it on a 2s beat feeds the limiter
 * that produced it.
 *
 * So: connection failures keep the linear ramp they always had, while a
 * throttle gets exponential backoff with jitter, and an explicit retry-after
 * from the broker wins over both — it is the only number in the exchange that
 * comes from the side actually enforcing the limit.
 *
 * JITTER MATTERS MORE THAN THE CURVE HERE. Several controllers share one
 * broker session (fast monitor, profit keeper, loss cap, the reconciler); an
 * undithered backoff re-synchronises them onto the same instant and the
 * second attempt arrives as one burst, exactly like the first.
 */
export const THROTTLE_BASE_MS = 5_000
export const THROTTLE_MAX_MS = 60_000

export function backoffMs(attempt, err, rand = Math.random) {
  const explicit = retryAfterMs(err)
  if (explicit != null) return explicit
  if (!isThrottleError(err)) return (attempt + 1) * 2000     // unchanged for ordinary faults
  const exp = Math.min(THROTTLE_MAX_MS, THROTTLE_BASE_MS * (2 ** attempt))
  return Math.round(exp * (0.5 + rand() * 0.5))              // full-ish jitter, never below half
}

export async function withRetry(fn, maxRetries = 2, label = 'ws', noRetry = null) {
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err.message || ''
      if (msg.includes('order rejected') || msg.includes('POSITION_NOT_FOUND')) throw err
      if (noRetry && noRetry(err)) throw err
      if (attempt < maxRetries) {
        const delay = backoffMs(attempt, err)
        const why = isThrottleError(err) ? ' (throttled — backing off)' : ''
        console.log(`[${label}] retry ${attempt + 1}/${maxRetries} in ${delay}ms${why} — ${msg}`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw lastErr
}

/**
 * Did this failure happen AFTER the order request went out?
 *
 * The distinction is the whole of L3's idempotency story. A connect/auth
 * failure provably happened BEFORE submission — nothing reached the broker,
 * so a retry is safe and no position can exist. A failure carrying the
 * "after sending <NEW_ORDER_REQ>" marker that wsRun stamps on is AMBIGUOUS:
 * the broker may well have filled it and only the EXECUTION_EVENT was lost.
 *
 * Exported because the caller needs the same verdict the retry policy uses —
 * an ambiguous submission must be recorded as "a position may exist", not as
 * a plain failure (audit F-L4-01).
 */
export function isAmbiguousSubmitError(err) {
  return (err?.message || '').includes(`after sending ${PT.NEW_ORDER_REQ}`)
}

/**
 * Place a new order. `orderPayload` must already contain the full NEW_ORDER_REQ
 * shape (ctidTraderAccountId, symbolId, tradeSide, volume, orderType, SL/TP,
 * label, …). Returns the EXECUTION_EVENT payload.
 */
export function wsPlaceOrder(host, clientId, clientSecret, accessToken, accountId, orderPayload, timeoutMs = 20_000) {
  // L3: NEW_ORDER_REQ is NOT idempotent. A timeout or socket drop AFTER the
  // request went out is ambiguous — the broker may well have filled it, only
  // the EXECUTION_EVENT was lost — and blindly resubmitting is exactly how
  // duplicate positions happen (the 4x USDIDR incident). Retry only failures
  // that provably occurred BEFORE the order request was sent (connect/auth).
  const orderSent = isAmbiguousSubmitError
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.NEW_ORDER_REQ, payload: orderPayload }, expect: PT.EXECUTION_EVENT },
  ], timeoutMs), 2, 'wsPlaceOrder', orderSent)
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
 *
 * The broker's symbol catalogue is effectively static (names/ids don't churn
 * hour to hour), but every account snapshot was re-fetching it from scratch
 * — a full WS auth handshake each time, and the dominant cost when the
 * Accounts page snapshots several accounts (owner: "loading accounts is
 * very very slow"). Cache the in-flight/resolved promise per host for a
 * while; a failure is never cached so a bad fetch retries next call.
 */
const symbolsListCache = new Map() // host -> { at, promise }
const SYMBOLS_LIST_TTL_MS = 6 * 60 * 60 * 1000
export function wsGetSymbolsList(host, clientId, clientSecret, accessToken, accountId, timeoutMs = 30_000) {
  const cached = symbolsListCache.get(host)
  if (cached && Date.now() - cached.at < SYMBOLS_LIST_TTL_MS) return cached.promise
  const promise = withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.SYMBOLS_LIST_REQ, payload: { ctidTraderAccountId: parseInt(accountId), includeArchivedSymbols: false } }, expect: PT.SYMBOLS_LIST_RES },
  ], timeoutMs), 2, 'wsGetSymbolsList')
  symbolsListCache.set(host, { at: Date.now(), promise })
  promise.catch(() => { if (symbolsListCache.get(host)?.promise === promise) symbolsListCache.delete(host) })
  return promise
}

/**
 * Full symbol details (incl. the trading `schedule` — the authoritative
 * per-symbol open/closed intervals) for a batch of symbolIds via
 * SYMBOL_BY_ID_REQ. Returns `{ symbol: [ProtoOASymbol...] }`, each with
 * `schedule: [{ startSecond, endSecond }]` measured from the week start in
 * the symbol's schedule timezone, plus `scheduleTimeZone`.
 */
export function wsGetSymbolById(host, clientId, clientSecret, accessToken, accountId, symbolIds, timeoutMs = 30_000) {
  const ids = (Array.isArray(symbolIds) ? symbolIds : [symbolIds]).map(Number).filter(Number.isFinite)
  return withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.SYMBOL_BY_ID_REQ, payload: { ctidTraderAccountId: parseInt(accountId), symbolId: ids } }, expect: PT.SYMBOL_BY_ID_RES },
  ], timeoutMs), 2, 'wsGetSymbolById')
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
 * Broker-truth unrealized P&L per open position (ProtoOAGetPositionUnrealizedPnLReq).
 * Returns { [positionId]: { gross, net } } in the DEPOSIT currency, decoded
 * with the response's moneyDigits — exact for every asset class, unlike any
 * client-side price-move estimate (owner: JPY-quoted JPN225 showed yen as
 * dollars). Older API servers without 2187 → caller falls back to estimates.
 */
export async function wsGetUnrealizedPnl(host, clientId, clientSecret, accessToken, accountId, timeoutMs = 20_000) {
  const payload = await withRetry(() => wsRun(host, [
    ...authSteps(clientId, clientSecret, accessToken, accountId),
    { send: { payloadType: PT.GET_POSITION_UNREALIZED_PNL_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } }, expect: PT.GET_POSITION_UNREALIZED_PNL_RES },
  ], timeoutMs), 2, 'wsGetUnrealizedPnl')
  const digits = payload.moneyDigits != null ? payload.moneyDigits : 2
  const div = Math.pow(10, digits)
  const out = {}
  for (const r of (payload.positionUnrealizedPnL || [])) {
    out[String(r.positionId)] = {
      gross: r.grossUnrealizedPnL != null ? r.grossUnrealizedPnL / div : null,
      net: r.netUnrealizedPnL != null ? r.netUnrealizedPnL / div : null,
    }
  }
  return out
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
 * Latest DAILY bar per symbol — same single-connection batch shape as
 * wsGetLastCloses, but returning the full OHLCV of the most recent 1d
 * trendbar: { [symbolId]: {t,o,h,l,c,v} }. For a closed market this is the
 * last session's bar — the caller labels it, never fakes a fresher one.
 * `v` is the broker's tick volume for the bar.
 */
export function wsGetDailyOhlcv(host, clientId, clientSecret, accessToken, accountId, symbolIds, timeoutMs = 30_000) {
  const now = Date.now()
  const spec = TRENDBAR_PERIODS['1d']
  const steps = symbolIds.map(symbolId => ({
    send: {
      payloadType: PT.GET_TRENDBARS_REQ,
      payload: {
        ctidTraderAccountId: parseInt(accountId),
        symbolId: parseInt(symbolId),
        period: spec.code,
        fromTimestamp: now - spec.ms * 10, // covers weekends/holiday gaps
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
      if (bars.length > 0) out[id] = bars[bars.length - 1]
    })
    return out
  }, 2, 'wsGetDailyOhlcv')
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
