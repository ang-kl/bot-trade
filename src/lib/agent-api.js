// Thin client for the agent backend.
// Connection is configured at runtime on the Connect page (stored in
// localStorage) and falls back to build-time VITE_ env vars so existing
// deployments keep working without touching the UI.

const LS_URL = 'agent_url'
const LS_SECRET = 'agent_secret'

// Self-configuring link: opening the app with
//   #agent=https://your-agent-host&secret=your-agent-secret
// saves the connection to localStorage and strips the fragment from the
// address bar. The hash never leaves the browser (not sent to servers or
// logs), so this is a safe one-tap setup link — but anyone who has the
// full link can operate the agent, so share it like a password.
function initConnFromHash() {
  if (typeof window === 'undefined' || !window.location?.hash) return
  try {
    const raw = window.location.hash.slice(1)
    let url = null
    let secret = null
    if (raw.includes('=')) {
      const params = new URLSearchParams(raw)
      url = params.get('agent')
      secret = params.get('secret')
    } else if (raw) {
      // Shorthand: the entire hash IS the secret (e.g. site.app/#123).
      // Agent URL comes from what's already saved or the VITE_ default.
      secret = decodeURIComponent(raw)
    }
    if (url) localStorage.setItem(LS_URL, url.trim())
    if (secret) localStorage.setItem(LS_SECRET, secret.trim())
    if (url || secret) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  } catch { /* malformed hash — ignore */ }
}
initConnFromHash()

function normalizeBase(url) {
  if (!url) return ''
  let u = url.trim().replace(/\/+$/, '')
  // Upgrade http -> https when the UI itself is on https (mixed content is
  // blocked), EXCEPT for localhost — browsers exempt it from mixed-content
  // rules and a local agent has no TLS.
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/.test(u)
  if (!isLocal && u.startsWith('http://') && typeof window !== 'undefined' && window.location?.protocol === 'https:') {
    u = 'https://' + u.slice(7)
  }
  return u
}

// The agent's canonical home. Hardcoded on purpose: a stale VITE_AGENT_URL
// baked into old Vercel builds kept resurfacing wrong hosts — the address is
// stable now, and localStorage still overrides for anyone self-hosting.
const DEFAULT_AGENT_URL = 'https://sg-trade.up.railway.app'

export function getAgentConn() {
  const lsUrl = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_URL) : ''
  const lsSecret = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_SECRET) : ''
  return {
    base: normalizeBase(lsUrl || DEFAULT_AGENT_URL),
    secret: lsSecret || import.meta.env.VITE_AGENT_SECRET_AUTOPILOT || import.meta.env.VITE_AGENT_SECRET || '',
    fromLocalStorage: Boolean(lsUrl),
  }
}

export function setAgentConn({ url, secret }) {
  if (url != null) localStorage.setItem(LS_URL, url.trim())
  if (secret != null) localStorage.setItem(LS_SECRET, secret.trim())
}

export function clearAgentConn() {
  localStorage.removeItem(LS_URL)
  localStorage.removeItem(LS_SECRET)
}

export function agentConfigured() {
  const c = getAgentConn()
  return Boolean(c.base && c.secret)
}

async function request(method, path, body) {
  const c = getAgentConn()
  if (!c.base || !c.secret) {
    throw new Error('Agent not connected — set the URL and secret on the Connect tab')
  }
  let res
  try {
    res = await fetch(`${c.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${c.secret}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    // fetch rejects with an opaque "Failed to fetch" — say WHERE it tried,
    // so a stale VITE_AGENT_URL (or down agent) is diagnosable from the UI.
    throw new Error(`Agent unreachable at ${c.base} — check the URL on the Connect tab and that the agent is running`)
  }
  if (!res.ok) {
    let msg = `${method} ${path} ${res.status}`
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) {
      try { const j = await res.json(); if (j.error) msg = j.error } catch { /* keep default */ }
    }
    if (res.status === 401) {
      msg = 'Login expired — go to the Connect tab and log in again (Telegram code or secret). This happens when the agent redeploys without a persistent Volume.'
    }
    throw new Error(msg)
  }
  return res.json()
}

export const agentGet = (path) => request('GET', path)
export const agentPost = (path, body) => request('POST', path, body)

/**
 * Live tick stream over server-sent events. EventSource can't set an
 * Authorization header, so this reads the SSE body via fetch streaming.
 * Returns { close() }; onTick gets {symbol, bid, ask, t}; onEnd gets a
 * reason string when the server or network drops the stream.
 */
export function agentStreamPrices(symbols, onTick, onEnd = () => {}) {
  const c = getAgentConn()
  const ctrl = new AbortController()
  ;(async () => {
    try {
      const res = await fetch(`${c.base}/actions/stream-prices?symbols=${encodeURIComponent(symbols.join(','))}`, {
        headers: { authorization: `Bearer ${c.secret}` },
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        let msg = `stream ${res.status}`
        try { const j = await res.json(); if (j.error) msg = j.error } catch { /* keep default */ }
        return onEnd(msg)
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return onEnd('stream ended')
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
          if (!dataLine || frame.startsWith(':')) continue
          if (frame.startsWith('event: end')) return onEnd('server closed stream')
          if (frame.startsWith('event: hello')) continue
          try { onTick(JSON.parse(dataLine.slice(6))) } catch { /* skip bad frame */ }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') onEnd(e.message)
    }
  })()
  return { close: () => ctrl.abort() }
}
