// Thin client for the agent backend.
// Connection is configured at runtime on the Connect page (stored in
// localStorage) and falls back to build-time VITE_ env vars so existing
// deployments keep working without touching the UI.

const LS_URL = 'agent_url'
const LS_SECRET = 'agent_secret'

function normalizeBase(url) {
  if (!url) return ''
  let u = url.trim().replace(/\/+$/, '')
  if (u.startsWith('http://') && typeof window !== 'undefined' && window.location?.protocol === 'https:') {
    u = 'https://' + u.slice(7)
  }
  return u
}

export function getAgentConn() {
  const lsUrl = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_URL) : ''
  const lsSecret = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_SECRET) : ''
  return {
    base: normalizeBase(lsUrl || import.meta.env.VITE_AGENT_URL_AUTOPILOT || import.meta.env.VITE_AGENT_URL || ''),
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
  const res = await fetch(`${c.base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${c.secret}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `${method} ${path} ${res.status}`
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) {
      try { const j = await res.json(); if (j.error) msg = j.error } catch { /* keep default */ }
    }
    throw new Error(msg)
  }
  return res.json()
}

export const agentGet = (path) => request('GET', path)
export const agentPost = (path, body) => request('POST', path, body)
