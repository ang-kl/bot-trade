// ---------------------------------------------------------------------------
// agent/lib/exec-engine.js — order-path delegator. Default ('js') is a thin
// passthrough to ctrader-ws.js so behaviour stays byte-identical; EXEC_ENGINE
// =cpp routes the same calls to the C++ sidecar over HTTP. loop.js
// matches on 'order rejected' and 'POSITION_NOT_FOUND' in error messages, so
// sidecar error bodies are surfaced verbatim in thrown Error messages.
// ---------------------------------------------------------------------------

export function execEngineMode() {
  return process.env.EXEC_ENGINE === 'cpp' ? 'cpp' : 'js'
}

// Dynamic import keeps the ws module (and its socket deps) out of the process
// entirely when the sidecar handles execution.
async function ws() {
  return import('../lib/ctrader-ws.js')
}

function execBase() {
  return process.env.EXEC_URL || 'http://127.0.0.1:8091'
}

async function sidecar(method, path, body) {
  const res = await fetch(execBase() + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.EXEC_SECRET || ''}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    // Preserve the sidecar/broker text verbatim — callers match substrings.
    throw new Error(text || `exec sidecar ${res.status} on ${path}`)
  }
  return text ? JSON.parse(text) : null
}

// The sidecar holds no broker credentials of its own — the access token and
// account id live in the keeper's DB. Push them before the first call and
// again whenever they change (token refresh, account switch).
let lastPushedKey = ''
async function ensureSidecarSession(creds) {
  const key = `${creds.host}|${creds.accountId}|${creds.accessToken}`
  if (key === lastPushedKey) return
  await sidecar('POST', '/connect', {
    host: creds.host,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    accessToken: creds.accessToken,
    accountId: creds.accountId,
  })
  lastPushedKey = key
}

// Backtest fast-path: cpp mode POSTs the payload to the sidecar's /backtest
// (no /connect push — the backtester needs no broker session) and returns the
// parsed {trades, stats, wf} body; a non-2xx response throws so the caller
// can decide. js mode returns null WITHOUT any HTTP call — the caller falls
// back to the JS engine.
export async function backtestRemote(payload) {
  if (execEngineMode() !== 'cpp') return null
  return sidecar('POST', '/backtest', payload)
}

// Liveness probe of the C++ engine for the heartbeat monitor. js mode is
// trivially "alive" (execution happens in-process); cpp mode polls the
// sidecar's unauthenticated GET /health, which also reports whether its
// broker session is up and when it last reconciled.
export async function pingSidecar({ timeoutMs = 5_000 } = {}) {
  if (execEngineMode() !== 'cpp') return { ok: true, mode: 'js' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(execBase() + '/health', { signal: ctrl.signal })
    const body = await res.json().catch(() => null)
    return {
      ok: res.ok && body?.ok === true,
      mode: 'cpp',
      connected: body?.connected ?? null,
      hasCredentials: body?.hasCredentials ?? null,
      lastReconcileAt: body?.lastReconcileAt ?? null,
      ...(res.ok ? {} : { error: `health ${res.status}` }),
    }
  } catch (e) {
    return { ok: false, mode: 'cpp', error: String(e?.message || e) }
  } finally {
    clearTimeout(t)
  }
}

// Bracket guarantee, engine-agnostic (item #4). The C++ core enforces this
// too, but the DEFAULT js path went straight to the broker — so this is the
// parity guard: a MARKET order with no stop attached is a naked position and
// is refused here, unless the caller explicitly sets allowNaked. Mirrors
// cpp-exec/src/order_guard.cpp so both engines behave identically.
export function orderHasBracket(p) {
  const num = (k) => Number(p?.[k])
  return num('relativeStopLoss') > 0 || num('stopLoss') > 0
}

// Owner-approved risk-gate change (2026-07-22): several open positions had
// no Take Profit at all — SL-only was never enough to call a trade "managed"
// (owner: "that is dangerous"). Mirrors orderHasBracket's shape exactly.
export function orderHasTarget(p) {
  const num = (k) => Number(p?.[k])
  return num('relativeTakeProfit') > 0 || num('takeProfit') > 0
}

export function validateOrderBracket(p) {
  const type = (p?.orderType || 'MARKET')
  const isMarket = type === 'MARKET' || type === 'MARKET_RANGE'
  if (isMarket && p?.allowNaked !== true) {
    if (!orderHasBracket(p)) {
      return { ok: false, reason: 'guard_naked_order: market order has no stop loss attached (set allowNaked to override)' }
    }
    if (!orderHasTarget(p)) {
      return { ok: false, reason: 'guard_no_target: market order has no take profit attached (set allowNaked to override)' }
    }
  }
  return { ok: true }
}

export async function placeOrder(creds, orderPayload) {
  const v = validateOrderBracket(orderPayload)
  if (!v.ok) throw new Error(v.reason)
  if (execEngineMode() === 'cpp') {
    await ensureSidecarSession(creds)
    return sidecar('POST', '/order', orderPayload)
  }
  const m = await ws()
  return m.wsPlaceOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, orderPayload)
}

/** Push the atomic guard config to the C++ sidecar (#3). No-op in js mode. */
export async function setExecGuard(creds, cfg) {
  if (execEngineMode() !== 'cpp') return { ok: true, mode: 'js' }
  await ensureSidecarSession(creds)
  return sidecar('POST', '/config', cfg)
}

export async function amendPosition(creds, args) {
  if (execEngineMode() === 'cpp') {
    await ensureSidecarSession(creds)
    return sidecar('POST', '/amend', args)
  }
  const m = await ws()
  return m.wsAmendPosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
}

export async function closePosition(creds, args) {
  if (execEngineMode() === 'cpp') {
    await ensureSidecarSession(creds)
    return sidecar('POST', '/close', args)
  }
  const m = await ws()
  return m.wsClosePosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
}

export async function cancelOrder(creds, { orderId }) {
  if (execEngineMode() === 'cpp') {
    await ensureSidecarSession(creds)
    return sidecar('POST', '/cancel', { ctidTraderAccountId: parseInt(creds.accountId), orderId })
  }
  const m = await ws()
  return m.wsCancelOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, { orderId })
}

export async function reconcile(creds) {
  if (execEngineMode() === 'cpp') {
    // The sidecar's own reconcile loop hasn't completed a single pass yet
    // (just started, reconnecting after a drop, etc) — GET /positions 503s
    // with "no reconcile data yet" the whole time. Owner hit this live:
    // pending-order-manager failed on every tick, and the main loop's own
    // reconcile phase failing before reaching weekend-bank's heartbeat call
    // left it looking STALLED too — one sidecar hiccup took out two
    // unrelated controllers. Fall back to the JS/WS reconcile path instead
    // of hard-failing every caller; the sidecar resumes owning reconcile
    // again the moment it reports data.
    try {
      await ensureSidecarSession(creds)
      return await sidecar('GET', '/positions')
    } catch (err) {
      if (!/no reconcile data yet/.test(err.message)) throw err
      const m = await ws()
      return m.wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
    }
  }
  const m = await ws()
  return m.wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
}
