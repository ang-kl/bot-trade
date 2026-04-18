// Thin client for the Railway-hosted agent backend.
// Reads VITE_AGENT_URL + VITE_AGENT_SECRET from Vite env at build time.

const BASE = import.meta.env.VITE_AGENT_URL || ''
const SECRET = import.meta.env.VITE_AGENT_SECRET || ''

export const agentConfigured = Boolean(BASE && SECRET)

async function request(method, path, body) {
  if (!agentConfigured) throw new Error('Agent backend not configured')
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SECRET}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `${method} ${path} ${res.status}`
    try { const j = await res.json(); if (j.error) msg = j.error } catch {}
    throw new Error(msg)
  }
  return res.json()
}

export const agentGet = (path) => request('GET', path)
export const agentPost = (path, body) => request('POST', path, body)
