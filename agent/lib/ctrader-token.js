// Keeps Railway's cTrader access token fresh without any browser involvement.
// Reads accessToken/refreshToken/expiresAt from SQLite, refreshes via
// /apps/token when the access token is within REFRESH_MARGIN_MS of expiry,
// persists the new tokens, and returns the latest access token.
//
// Every place in the agent that used to call getState(db, 'ctrader_access_token')
// should go through getFreshAccessToken() instead so the loop keeps running
// through token rotations, laptop-closed days, and 30-day expiries.

const REFRESH_MARGIN_MS = 5 * 60 * 1000
const CTRADER_API = 'https://openapi.ctrader.com'

// Single-flight guard: multiple concurrent callers share one refresh.
let inflight = null

export async function getFreshAccessToken(db, getState, setState) {
  const accessToken = getState(db, 'ctrader_access_token')
  const refreshToken = getState(db, 'ctrader_refresh_token')
  const expiresAtRaw = getState(db, 'ctrader_token_expires_at')
  const expiresAt = expiresAtRaw ? parseInt(expiresAtRaw, 10) : 0
  const clientId = process.env.CTRADER_CLIENT_ID
  const clientSecret = process.env.CTRADER_CLIENT_SECRET

  if (!accessToken) return null

  // Can't refresh if we don't know expiry and we don't have a refresh
  // token — just return whatever we have and let the call fail.
  const needsRefresh = expiresAt > 0 && (expiresAt - Date.now() < REFRESH_MARGIN_MS)
  if (!needsRefresh || !refreshToken || !clientId || !clientSecret) {
    return accessToken
  }

  if (inflight) return inflight
  inflight = (async () => {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      })
      const res = await fetch(`${CTRADER_API}/apps/token?${params}`)
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !(d.accessToken || d.access_token)) {
        console.error('[ctrader-token] refresh failed:', d.errorDescription || d.error || `HTTP ${res.status}`)
        return accessToken
      }
      const newAccess = d.accessToken || d.access_token
      const newRefresh = d.refreshToken || d.refresh_token || refreshToken
      const newExpiresIn = d.expiresIn || d.expires_in || 2592000
      setState(db, 'ctrader_access_token', newAccess)
      setState(db, 'ctrader_refresh_token', newRefresh)
      setState(db, 'ctrader_token_expires_at', String(Date.now() + newExpiresIn * 1000))
      console.log('[ctrader-token] refreshed, new expiry in', Math.round(newExpiresIn / 86400), 'days')
      return newAccess
    } catch (err) {
      console.error('[ctrader-token] refresh error:', err.message)
      return accessToken
    } finally {
      inflight = null
    }
  })()
  return inflight
}
