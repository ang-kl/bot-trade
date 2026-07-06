// ---------------------------------------------------------------------------
// agent/lib/ctrader-auth.js — OAuth access-token refresh.
//
// cTrader access tokens expire (typically ~30 days). Without refresh, an
// unattended bot silently loses broker access mid-flight. This refreshes
// proactively (loop calls maybeRefreshCtraderToken daily) and reactively
// (callers may invoke refreshCtraderToken() after an auth error).
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { ctraderEnv } from './ctrader-env.js'

const CTRADER_API = 'https://openapi.ctrader.com'
const REFRESH_EVERY_MS = 24 * 3600_000

/**
 * Exchange the stored refresh token for a fresh access token and persist
 * both. Throws on failure. Returns the new access token.
 */
export async function refreshCtraderToken(db) {
  const refreshToken = getState(db, 'ctrader_refresh_token') || ctraderEnv('refreshToken')
  const clientId = ctraderEnv('clientId')
  const clientSecret = ctraderEnv('clientSecret')
  if (!refreshToken) throw new Error('no refresh token stored')
  if (!clientId || !clientSecret) throw new Error('cTrader app credentials not configured')

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  })
  const res = await fetch(`${CTRADER_API}/apps/token?${params}`)
  const d = await res.json()
  if (d.error || d.errorCode) {
    throw new Error(`token refresh rejected: ${d.errorDescription || d.description || d.error || d.errorCode}`)
  }
  const accessToken = d.accessToken ?? d.access_token
  if (!accessToken) throw new Error('token refresh returned no access token')

  setState(db, 'ctrader_access_token', accessToken)
  // Spotware rotates the refresh token — keep the newest; fall back to the
  // old one if the response omits it.
  setState(db, 'ctrader_refresh_token', d.refreshToken ?? d.refresh_token ?? refreshToken)
  setState(db, 'ctrader_token_refreshed_at', new Date().toISOString())
  return accessToken
}

/**
 * Proactive daily refresh. No-op when no refresh token exists or the last
 * refresh is recent. Never throws — records the failure in state instead
 * (the current access token may still be valid for weeks).
 */
export async function maybeRefreshCtraderToken(db, log = () => {}) {
  const hasToken = getState(db, 'ctrader_refresh_token') || ctraderEnv('refreshToken')
  if (!hasToken) return false
  const last = getState(db, 'ctrader_token_refreshed_at')
  if (last && Date.now() - new Date(last).getTime() < REFRESH_EVERY_MS) return false
  try {
    await refreshCtraderToken(db)
    setState(db, 'ctrader_token_refresh_error', '')
    log('cTrader access token refreshed')
    return true
  } catch (err) {
    setState(db, 'ctrader_token_refresh_error', `${new Date().toISOString()} ${err.message}`)
    log(`cTrader token refresh failed: ${err.message}`)
    return false
  }
}
