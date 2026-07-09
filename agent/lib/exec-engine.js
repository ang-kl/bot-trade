// ---------------------------------------------------------------------------
// agent/lib/exec-engine.js — order-path delegator. Default ('js') is a thin
// passthrough to ctrader-ws.js so behaviour stays byte-identical; EXEC_ENGINE
// =cpp routes the same four calls to the C++ sidecar over HTTP. loop.js
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

export async function placeOrder(creds, orderPayload) {
  if (execEngineMode() === 'cpp') {
    return sidecar('POST', '/order', orderPayload)
  }
  const m = await ws()
  return m.wsPlaceOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, orderPayload)
}

export async function amendPosition(creds, args) {
  if (execEngineMode() === 'cpp') {
    return sidecar('POST', '/amend', args)
  }
  const m = await ws()
  return m.wsAmendPosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
}

export async function closePosition(creds, args) {
  if (execEngineMode() === 'cpp') {
    return sidecar('POST', '/close', args)
  }
  const m = await ws()
  return m.wsClosePosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
}

export async function reconcile(creds) {
  if (execEngineMode() === 'cpp') {
    return sidecar('GET', '/positions')
  }
  const m = await ws()
  return m.wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
}
