// ---------------------------------------------------------------------------
// agent/lib/auth-tiers.js — D12: split read access from money-moving access
// behind two independent credentials instead of one shared bearer token.
//
// GET is the READ tier — state/dashboard routes. Every other method (POST/
// PUT/PATCH/DELETE) is the FULL tier: orders, amendments, closes, and every
// config write that changes trading behavior. The read-only token NEVER
// authorizes a non-GET request, even if AGENT_SECRET_READ happens to equal
// something else by coincidence.
//
// Backward compatible by construction: AGENT_SECRET_READ is optional. When
// it is unset, every route behaves exactly as it did with one shared
// secret — this module changes nothing until the owner opts in by setting
// the second env var.
//
// A device session (Telegram login, index.js's addSession) already required
// proving control of the owner's Telegram account to obtain — that IS a
// second factor, so a valid session grants the FULL tier, same as today.
// ---------------------------------------------------------------------------

/** True when this HTTP method needs the full (money-moving) tier. */
export function requiresFullTier(method) {
  return String(method || '').toUpperCase() !== 'GET'
}

/**
 * Classify a bearer token against the two secrets + device-session check.
 * Returns 'full' | 'read' | null (unauthenticated / unrecognized).
 */
export function classifyToken(token, { agentSecret, agentSecretRead, isValidSession } = {}) {
  if (!token) return null
  if (agentSecret && token === agentSecret) return 'full'
  if (typeof isValidSession === 'function' && isValidSession(token)) return 'full'
  if (agentSecretRead && token === agentSecretRead) return 'read'
  return null
}

/** True when this (tier, method) combination is authorized. */
export function tierAuthorizes(tier, method) {
  if (tier === 'full') return true
  if (tier === 'read') return !requiresFullTier(method)
  return false
}
