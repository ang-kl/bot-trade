// Thin client for the Railway-hosted agent backends.
// Supports two roles running on separate Railway services:
//   - autopilot → VITE_AGENT_URL_AUTOPILOT + VITE_AGENT_SECRET_AUTOPILOT
//   - copilot   → VITE_AGENT_URL_COPILOT   + VITE_AGENT_SECRET_COPILOT
// Legacy VITE_AGENT_URL / VITE_AGENT_SECRET still work — they map to autopilot
// so single-service deployments keep running without a redeploy.

function normalizeBase(url) {
  if (!url) return ''
  let u = url.trim().replace(/\/+$/, '')
  if (u.startsWith('http://') && typeof window !== 'undefined' && window.location?.protocol === 'https:') {
    u = 'https://' + u.slice(7)
  }
  return u
}

const CONFIG = {
  autopilot: {
    base:   normalizeBase(import.meta.env.VITE_AGENT_URL_AUTOPILOT    || import.meta.env.VITE_AGENT_URL    || ''),
    secret: import.meta.env.VITE_AGENT_SECRET_AUTOPILOT || import.meta.env.VITE_AGENT_SECRET || '',
  },
  copilot: {
    base:   normalizeBase(import.meta.env.VITE_AGENT_URL_COPILOT    || ''),
    secret: import.meta.env.VITE_AGENT_SECRET_COPILOT || '',
  },
}

export const ROLES = ['autopilot', 'copilot']

export function agentConfigured(role = 'autopilot') {
  const c = CONFIG[role]
  return Boolean(c && c.base && c.secret)
}

export function agentBase(role = 'autopilot') {
  return CONFIG[role]?.base || ''
}

async function request(role, method, path, body) {
  const c = CONFIG[role]
  if (!c || !c.base || !c.secret) {
    const upper = String(role).toUpperCase()
    throw new Error(`${role} agent not configured — set VITE_AGENT_URL_${upper} + VITE_AGENT_SECRET_${upper} in Vercel env vars`)
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
      try { const j = await res.json(); if (j.error) msg = j.error } catch {}
    } else if (res.status === 405) {
      msg = `${method} ${path} 405 — VITE_AGENT_URL_${String(role).toUpperCase()} may be pointing at Vercel instead of the Railway agent`
    }
    throw new Error(msg)
  }
  return res.json()
}

export const agentGet  = (path, role = 'autopilot')       => request(role, 'GET',  path)
export const agentPost = (path, body, role = 'autopilot') => request(role, 'POST', path, body)
