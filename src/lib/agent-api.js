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

// D12 (2026-07-27): the build-time default used to fall back to
// VITE_AGENT_SECRET_AUTOPILOT/VITE_AGENT_SECRET — full (money-moving)
// credentials — which meant every fresh browser silently got FULL control
// the moment the page loaded, and that same secret sat in plain view in
// the public JS bundle. The default now only ever grants the READ tier;
// actual control requires an explicit paste into Connect (saved to
// localStorage from then on), same as it always has for a self-hosted
// agent. VITE_AGENT_SECRET/VITE_AGENT_SECRET_AUTOPILOT are intentionally
// NOT read anymore — see README's D12 note before reintroducing them here.
export function getAgentConn() {
  const lsUrl = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_URL) : ''
  const lsSecret = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_SECRET) : ''
  return {
    base: normalizeBase(lsUrl || DEFAULT_AGENT_URL),
    secret: lsSecret || import.meta.env.VITE_AGENT_SECRET_READ || '',
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

// POSTs that only READ. They take no side effect on the account, so it is
// safe to give up waiting on them (and safe for the caller to ask again).
// Everything else — close, arm, amend, config writes — is deliberately NOT
// here: abandoning an order action tells the UI "it failed" for a request the
// agent may still be executing, and a retry could double-submit.
const READ_ONLY_POSTS = new Set([
  '/actions/broker-positions',
  '/actions/broker-history',
  '/actions/ctrader-accounts',
  '/actions/balance',
  '/actions/position-guard-get',
  '/actions/chart',
])

// Generous on purpose: a cold /actions/broker-positions snapshot costs ~6 WS
// handshakes (~20s), and the agent's own loop pass has been measured at 127s
// of synchronous work, during which it answers nothing. This bounds the wait
// so a phone doesn't sit on a dead socket — it is not a latency target.
const READ_TIMEOUT_MS = 45_000

function isIdempotent(method, path) {
  if (method === 'GET') return true
  return READ_ONLY_POSTS.has(String(path).split('?')[0])
}

async function request(method, path, body) {
  const c = getAgentConn()
  if (!c.base || !c.secret) {
    throw new Error('Agent not connected — set the URL and secret on the Connect tab')
  }
  const safe = isIdempotent(method, path)
  const ctrl = safe && typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS) : null
  let res
  try {
    res = await fetch(`${c.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${c.secret}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    })
  } catch {
    // fetch rejects with an opaque "Failed to fetch" for every network-layer
    // failure: agent down, DNS gone, TLS refused, phone off Wi-Fi mid-request,
    // or a reply that never arrived because the agent was mid-loop. We cannot
    // tell those apart from here, so don't claim to — say what we know (no
    // reply from this address) and, for non-idempotent calls, say plainly that
    // the outcome is unknown rather than implying nothing happened.
    if (ctrl?.signal.aborted) {
      throw new Error(`No reply from ${c.base} within ${Math.round(READ_TIMEOUT_MS / 1000)}s (${method} ${path}) — the agent is reachable but busy. Nothing was changed; try again in a moment.`)
    }
    if (safe) {
      throw new Error(`No reply from the agent at ${c.base} (${method} ${path}) — this device couldn't complete the request. Nothing was changed. If it keeps failing, check the URL on the Connect tab and that the agent is running.`)
    }
    throw new Error(`No reply from the agent at ${c.base} — this request may or may not have been carried out. Check the position/ledger before retrying, then verify the URL on the Connect tab and that the agent is running.`)
  } finally {
    if (timer) clearTimeout(timer)
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

// ---------------------------------------------------------------------------
// Stale-while-revalidate for GETs (owner 2026-07-28: "do you need to refresh
// everything ... think harder"). Every successful GET is written through to
// an in-memory + sessionStorage cache; agentGetSWR() hands the caller the
// LAST KNOWN data instantly (any age — stale beats blank) and revalidates in
// the background. Pages paint immediately on mount/navigation and update in
// place when the fresh answer lands; a slow or briefly unreachable agent no
// longer means an empty screen. Large payloads (>200KB) skip sessionStorage
// (quota) but still ride the in-memory cache for the tab's lifetime.
// ---------------------------------------------------------------------------
const swrMem = new Map() // path → { data, at }
function swrRead(path) {
  const m = swrMem.get(path)
  if (m) return m
  try {
    const raw = sessionStorage.getItem(`ag:${path}`)
    if (raw) { const v = JSON.parse(raw); swrMem.set(path, v); return v }
  } catch { /* quota/private mode */ }
  return null
}
function swrWrite(path, data) {
  const v = { data, at: Date.now() }
  swrMem.set(path, v)
  try {
    const raw = JSON.stringify(v)
    if (raw.length <= 200_000) sessionStorage.setItem(`ag:${path}`, raw)
  } catch { /* quota — memory cache still holds it */ }
}

export const agentGet = async (path) => {
  const data = await request('GET', path)
  swrWrite(path, data)
  return data
}

/** Synchronous peek at the last cached copy of a GET (or null). */
export function swrPeek(path) {
  const v = swrRead(path)
  return v ? v.data : null
}

/**
 * Stale-while-revalidate GET: calls `onData(data, { stale })` immediately
 * with the cached copy when one exists (stale: true), then again with the
 * fresh network answer (stale: false). Returns the fresh promise.
 */
export function agentGetSWR(path, onData) {
  const cached = swrRead(path)
  if (cached) { try { onData(cached.data, { stale: true, at: cached.at }) } catch { /* caller's problem */ } }
  return agentGet(path).then(data => { onData(data, { stale: false, at: Date.now() }); return data })
}

// ---------------------------------------------------------------------------
// Tab presence + background-tab throttling (owner 2026-07-28: "monitor the
// number of website open ... more website open means more queries right?").
// Every open tab is an independent polling client, so page poll loops call
// pageHidden() and skip their heavy loads while the tab is in the background
// — the broker/agent stop being queried by tabs nobody is looking at. The
// per-tab id lives in sessionStorage: one id per TAB (not per browser),
// which is exactly the granularity the owner asked to count.
// ---------------------------------------------------------------------------
export const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

// Idle tracking (owner 2026-07-28: sleep a tab after 5 minutes without
// activity). A browser page CANNOT close a tab the user opened — window.close
// is blocked by every browser — so "close" here means SLEEP: all polling
// stops (same zero-load effect as closing) and the roster shows the tab as
// idle. Any click/key/scroll wakes it instantly.
// Sleep-after is a per-device session setting (owner: "can we set to 60
// minutes or 4 hours if i want, there should be session setting") —
// localStorage `tab_idle_minutes`, default 5, picked in the sidebar panel.
export function getIdleMinutes() {
  try {
    const v = Number(localStorage.getItem('tab_idle_minutes'))
    return Number.isFinite(v) && v > 0 ? v : 5
  } catch { return 5 }
}
export function setIdleMinutes(min) {
  try { localStorage.setItem('tab_idle_minutes', String(min)) } catch { /* private mode */ }
}
let lastActivityAt = Date.now()
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(ev, () => { lastActivityAt = Date.now() }, { passive: true, capture: true })
  }
}
export const pageIdle = () => Date.now() - lastActivityAt > getIdleMinutes() * 60_000

// ---------------------------------------------------------------------------
// MANUAL PAUSE (owner 2026-07-30): "Have a capable to pause
// webpage-client-sided-spool/update at the Account details as a button."
//
// Deliberately folded into pageAsleep() rather than given its own gate. Every
// poll loop in the app already calls pageAsleep() before doing work, so one
// extra term here pauses ALL of them at once — a separate flag would have to be
// threaded through a dozen components, and the one that got missed would keep
// polling while the UI claimed to be paused.
//
// Client-side only: this stops THIS BROWSER from asking. The agent keeps
// trading, keeps reconciling and keeps its stops at the broker — pausing a
// screen is not pausing the bot, and the UI says so on the control.
//
// localStorage, so it survives navigation between pages (a pause that forgot
// itself on the next route would be worse than no pause), and per-device like
// tab_idle_minutes.
const PAUSE_KEY = 'poll_paused'
const pauseListeners = new Set()

export function isPollPaused() {
  try { return localStorage.getItem(PAUSE_KEY) === 'true' } catch { return false }
}
export function setPollPaused(on) {
  try { localStorage.setItem(PAUSE_KEY, on ? 'true' : 'false') } catch { /* private mode */ }
  for (const l of pauseListeners) {
    try { l() } catch { /* one bad subscriber must not stop the rest */ }
  }
}
/** Subscribe to pause changes; returns an unsubscribe. For useSyncExternalStore. */
export function subscribePollPaused(cb) {
  pauseListeners.add(cb)
  return () => pauseListeners.delete(cb)
}

/** Polls should skip when the tab is hidden, asleep, or manually paused. */
export const pageAsleep = () => pageHidden() || pageIdle() || isPollPaused()

function tabId() {
  try {
    let id = sessionStorage.getItem('tab_id')
    if (!id) {
      id = 'tab_' + Math.random().toString(36).slice(2, 10)
      sessionStorage.setItem('tab_id', id)
    }
    return id
  } catch { return 'tab_unknown' }
}
export const myTabId = () => tabId()

// The ping response is the live roster — cache it and let the sidebar
// TabsPanel subscribe instead of issuing its own duplicate pings.
let lastSummary = null
const summaryListeners = new Set()
export function onClientSummary(cb) {
  summaryListeners.add(cb)
  if (lastSummary) cb(lastSummary)
  return () => summaryListeners.delete(cb)
}

// ---------------------------------------------------------------------------
// BROWSER LOCATION (owner, 2026-07-31: "ask for location if you don't have
// from the browser when loaded"). One permission prompt, once: the answer —
// coarse coordinates or the refusal — is cached in localStorage so the owner
// is never nagged on every load. Coordinates are rounded to 2 decimals
// (~1 km): enough to answer "was that browser in Singapore or somewhere
// else", which is the security question this panel exists for, without
// logging a street address into agent_state.
//
// No Google Places / geocoding API involved (owner asked): the coords come
// from the browser's own geolocation service, the country from the reported
// IANA timezone, both free and key-less. A place NAME for the coords would
// need a reverse-geocoding call — the seam is here if ever wanted.
// ---------------------------------------------------------------------------
const LOC_KEY = 'browser_loc'          // "1.35,103.82" once granted
const LOC_DENIED_KEY = 'browser_loc_denied'

export function cachedBrowserLoc() {
  try { return localStorage.getItem(LOC_KEY) || null } catch { return null }
}

/** Prompt once for coarse location; cache grant or refusal. */
export function ensureBrowserLocation() {
  try {
    if (cachedBrowserLoc() || localStorage.getItem(LOC_DENIED_KEY) === 'true') return
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        try {
          const v = `${pos.coords.latitude.toFixed(2)},${pos.coords.longitude.toFixed(2)}`
          localStorage.setItem(LOC_KEY, v)
        } catch { /* private mode */ }
      },
      () => { try { localStorage.setItem(LOC_DENIED_KEY, 'true') } catch { /* private mode */ } },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 3_600_000 },
    )
  } catch { /* geolocation unavailable */ }
}

/** One presence heartbeat: tab id, timezone, page, visibility, idle state. */
export async function sendClientPing(page, { closed = false } = {}) {
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'unknown' } })()
  const loc = cachedBrowserLoc()
  const q = new URLSearchParams({
    tab: tabId(), tz, page: page || '/',
    hidden: String(pageHidden()), idle: String(pageIdle()), closed: String(closed),
    ...(loc ? { loc } : {}),
  })
  if (closed) {
    // pagehide: a normal fetch is killed with the page — keepalive survives.
    try {
      const c = getAgentConn()
      fetch(`${c.base}/state/client-ping?${q}`, { keepalive: true, headers: { Authorization: `Bearer ${c.secret}` } })
    } catch { /* best-effort */ }
    return null
  }
  const summary = await request('GET', `/state/client-ping?${q}`)
  lastSummary = summary
  for (const cb of summaryListeners) { try { cb(summary) } catch { /* listener's problem */ } }
  return summary
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { sendClientPing(window.location.pathname, { closed: true }) })
}
// POSTs are user-initiated actions (close, arm, save config…) — failures
// surface as a global toast (sonner) so the click never fails silently,
// in ADDITION to the caller's own error handling, not instead of it.
// GETs stay quiet: pages poll on timers and already render their own
// error states; toasting those would spam a red stack every poll cycle.
// The read-only POSTs above get the same treatment for the same reason —
// several of them fire on page load and on a poll timer (broker-positions,
// ctrader-accounts), so a flaky connection turned them into a recurring
// "agent unreachable" toast for a request no one clicked.
export const agentPost = async (path, body) => {
  try {
    return await request('POST', path, body)
  } catch (e) {
    if (!isIdempotent('POST', path)) {
      const { toast } = await import('sonner')
      toast.error(e.message)
    }
    throw e
  }
}

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
