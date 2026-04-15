// cTrader position monitor for the abot live server.
//
// Owns the always-on side of the Wealth Advisor monitor loop. The browser
// registers a position (positionId + account context + monitorUntil
// timestamp) via POST /api/ctrader/monitor. This server holds the record
// in memory and, every 10 seconds, checks whether any tracked position's
// monitorUntil has elapsed. Expired positions get closed via a cTrader
// Open API WebSocket call and the record transitions to 'closed'.
//
// State is in-memory only in v1. A restart drops all tracked positions,
// at which point the server returns 404 for unknown IDs and the browser
// falls back to showing an "unmonitored" badge. This is acceptable for a
// first version - SQLite persistence is a logical next step but out of
// scope until the browser loop is actually retired.
//
// WebSocket speaks raw JSON framing over TLS per the Spotware Open API
// protocol. Only the payload types needed for authenticate + close are
// implemented here. Reference:
//   https://help.ctrader.com/open-api/

import { WebSocket } from 'ws'

const CLIENT_ID = process.env.CTRADER_CLIENT_ID || ''
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || ''

// Payload type constants (subset from api/ctrader.js in the frontend repo)
const PT = {
  APP_AUTH_REQ:       2100,
  APP_AUTH_RES:       2101,
  ACCOUNT_AUTH_REQ:   2102,
  ACCOUNT_AUTH_RES:   2103,
  CLOSE_POSITION_REQ: 2111,
  EXECUTION_EVENT:    2126,
  ERROR_RES:          2142,
}

// ── Low-level WS helper ─────────────────────────────────────────────────────
// Runs a linear [send -> expect] sequence on a fresh WebSocket and resolves
// to the array of matching payload responses. Times out after `timeoutMs`.
function wsQuery(host, sequence, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const url = `wss://${host}:5036`
    const ws = new WebSocket(url)
    const results = []
    let step = 0
    let finished = false
    let msgId = 1

    const finish = (err, value) => {
      if (finished) return
      finished = true
      try { ws.close() } catch { /* ignore */ }
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value)
    }

    const timer = setTimeout(() => finish(new Error(`wsQuery timed out after ${timeoutMs}ms`)), timeoutMs)

    ws.on('open', () => {
      const next = sequence[step]
      if (next) ws.send(JSON.stringify({ ...next.send, clientMsgId: String(msgId++) }))
    })

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      const current = sequence[step]
      if (!current) return
      if (msg.payloadType === PT.ERROR_RES) {
        const payload = msg.payload || {}
        return finish(new Error(`${payload.errorCode || 'ERROR'}: ${payload.description || 'unknown'}`))
      }
      if (msg.payloadType !== current.expect) return
      results.push(msg.payload || {})
      step += 1
      const nextStep = sequence[step]
      if (!nextStep) return finish(null, results)
      ws.send(JSON.stringify({ ...nextStep.send, clientMsgId: String(msgId++) }))
    })

    ws.on('error', (err) => finish(err))
    ws.on('close', () => {
      if (!finished) finish(new Error('WebSocket closed before sequence completed'))
    })
  })
}

// ── High-level close-position ───────────────────────────────────────────────
async function closeCtraderPosition({ accessToken, accountId, positionId, volume, isLive }) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET not set on server')
  }
  const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  const sequence = [
    { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } }, expect: PT.APP_AUTH_RES },
    { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
    { send: { payloadType: PT.CLOSE_POSITION_REQ, payload: { ctidTraderAccountId: parseInt(accountId), positionId: parseInt(positionId), volume } }, expect: PT.EXECUTION_EVENT },
  ]
  const results = await wsQuery(host, sequence, 20_000)
  return results[2]
}

// ── State + loop ────────────────────────────────────────────────────────────
// Map<positionId, record> where record is:
//   { positionId, accountId, accessToken, isLive, volume,
//     symbol, monitorUntil, registeredAt, status, closeReason, closedAt }
const tracked = new Map()
let intervalHandle = null
let onEvent = () => {}

function recordList() {
  return [...tracked.values()].map(r => ({
    positionId: r.positionId,
    accountId: r.accountId,
    symbol: r.symbol,
    monitorUntil: r.monitorUntil,
    registeredAt: r.registeredAt,
    status: r.status,
    closeReason: r.closeReason || null,
    closedAt: r.closedAt || null,
    remainingMs: Math.max(0, r.monitorUntil - Date.now()),
  }))
}

async function processTick() {
  const now = Date.now()
  for (const [positionId, rec] of tracked) {
    if (rec.status !== 'monitoring') continue
    if (now < rec.monitorUntil) continue
    rec.status = 'closing'
    onEvent({ type: 'ctrader-monitor-closing', positionId, symbol: rec.symbol })
    try {
      await closeCtraderPosition(rec)
      rec.status = 'closed'
      rec.closedAt = Date.now()
      rec.closeReason = 'monitor-expired'
      onEvent({ type: 'ctrader-monitor-closed', positionId, symbol: rec.symbol })
    } catch (err) {
      rec.status = 'failed'
      rec.closedAt = Date.now()
      rec.closeReason = err.message
      onEvent({ type: 'ctrader-monitor-failed', positionId, symbol: rec.symbol, error: err.message })
    }
  }
  // Purge records closed more than 10 minutes ago so the list does not grow
  // unbounded. Clients that want history should persist their own copy.
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [positionId, rec] of tracked) {
    if ((rec.status === 'closed' || rec.status === 'failed') && rec.closedAt && rec.closedAt < cutoff) {
      tracked.delete(positionId)
    }
  }
}

function startLoop() {
  if (intervalHandle) return
  intervalHandle = setInterval(() => {
    processTick().catch(err => console.error('[ctrader-monitor] tick error:', err?.message))
  }, 10_000)
}

function stopLoop() {
  if (intervalHandle) clearInterval(intervalHandle)
  intervalHandle = null
}

// ── Public API ──────────────────────────────────────────────────────────────
export function registerMonitor({ positionId, accountId, accessToken, isLive, volume, symbol, monitorMinutes }) {
  if (!positionId) throw new Error('positionId required')
  if (!accountId) throw new Error('accountId required')
  if (!accessToken) throw new Error('accessToken required')
  const minutes = Math.max(1, Math.min(1440, Number(monitorMinutes) || 60))
  const now = Date.now()
  const rec = {
    positionId: String(positionId),
    accountId,
    accessToken,
    isLive: isLive === true,
    volume: Number(volume) || 0,
    symbol: symbol || null,
    monitorUntil: now + minutes * 60 * 1000,
    registeredAt: now,
    monitorMinutes: minutes,
    status: 'monitoring',
  }
  tracked.set(rec.positionId, rec)
  startLoop()
  return {
    positionId: rec.positionId,
    monitorUntil: rec.monitorUntil,
    status: rec.status,
    remainingMs: Math.max(0, rec.monitorUntil - now),
  }
}

export function cancelMonitor(positionId) {
  const rec = tracked.get(String(positionId))
  if (!rec) return { ok: false, reason: 'not-tracked' }
  if (rec.status === 'monitoring') {
    rec.status = 'cancelled'
    rec.closedAt = Date.now()
    rec.closeReason = 'user-cancelled'
  }
  return { ok: true, status: rec.status }
}

export function listMonitors() {
  return recordList()
}

export function getMonitor(positionId) {
  const rec = tracked.get(String(positionId))
  return rec
    ? {
        positionId: rec.positionId,
        symbol: rec.symbol,
        monitorUntil: rec.monitorUntil,
        status: rec.status,
        closeReason: rec.closeReason || null,
        closedAt: rec.closedAt || null,
        remainingMs: Math.max(0, rec.monitorUntil - Date.now()),
      }
    : null
}

export function setMonitorEventHandler(fn) {
  onEvent = typeof fn === 'function' ? fn : () => {}
}

export function stopMonitor() {
  stopLoop()
  tracked.clear()
}
