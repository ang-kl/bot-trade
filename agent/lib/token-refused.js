// ---------------------------------------------------------------------------
// agent/lib/token-refused.js — the accounts the broker token was REFUSED for.
//
// B2 (18-09-2026) taught the heartbeat that a sidecar which tried an account
// and was refused (CH_ACCESS_TOKEN_INVALID on an EXTRA account) is not roster
// drift, and recorded the set per sidecar side under
// `<side>_refused_accounts_json`. B7 makes the rest of the agent read it:
//
// - the cross-side equity sweep must not keep asking the broker about an
//   account the token does not cover (every ask was refused, every refusal
//   fired the reactive token refresh, every refresh re-pushed credentials to
//   both sidecars — measured 18-09-2026: ~20 OAuth refreshes an hour and the
//   live broker session torn down every ~3 minutes);
// - the reactive refresh must not read such a refusal as a rotated token.
//
// Small and db-only so ctrader-ws.js (db-free by design) and the equity
// sweep can both consult it without pulling the heartbeat in.
// ---------------------------------------------------------------------------
import { getState } from '../db.js'

/** State key holding the accounts a sidecar's token was refused for (B2). */
export const refusedKeyFor = (sideName) => `${sideName}_refused_accounts_json`

/** Every sidecar side the heartbeat can record a refusal for. */
export const REFUSED_SIDES = Object.freeze(['cpp_exec', 'cpp_exec_demo'])

/**
 * The union of refused account ids across the sidecar sides, as strings.
 * An unreadable or absent key contributes nothing — "not marked" is the
 * safe reading, because the callers only ever use this to do LESS.
 *
 * @returns {Set<string>}
 */
export function tokenRefusedAccounts(db, sides = REFUSED_SIDES) {
  const out = new Set()
  if (!db) return out
  for (const side of sides) {
    let raw = null
    try { raw = getState(db, refusedKeyFor(side)) } catch { raw = null }
    if (!raw) continue
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) for (const id of arr) if (id != null && id !== '') out.add(String(id))
    } catch { /* unreadable → not marked */ }
  }
  return out
}
