// ---------------------------------------------------------------------------
// agent/routes/ctrader-oauth.js — the cTrader OAuth exchange, moved off Vercel.
//
// WHY THIS EXISTS. `api/ctrader.js` ran as a Vercel serverless function and was
// the only thing standing between the Connect page and a linked account: the
// browser called /api/ctrader for the auth URL and then to swap the returned
// code for a token. Decommissioning Vercel (owner, 17-08-2026: "I am paying a
// lot at vercel") takes that with it, so the three REST endpoints move here.
//
// WHAT IS AND IS NOT AT RISK. The agent refreshes its OWN access token directly
// against Spotware in lib/ctrader-auth.js and has never called the Vercel
// function to do it — checked before planning this, because if refresh HAD
// lived there, deleting the project would have severed the broker connection
// silently, whenever the current token happened to expire. It does not. Only
// the INITIAL link (and a re-link after a lost refresh token) needs these.
//
// PUBLIC BY NECESSITY, exactly as on Vercel. The browser calls these BEFORE it
// holds any credential — obtaining one is the point — so they mount ahead of
// authMiddleware. They are safe to expose because they carry no secret in and
// hand back only what the user's own cTrader login authorises: the client
// secret stays server-side and is never echoed.
//
// THE REDIRECT URI IS DERIVED FROM THE REQUEST, not configured. Spotware
// matches it exactly against the app's registered URI, so it has to be the
// origin the browser actually used. Moving hosts therefore ALSO needs the new
// origin registered in the cTrader app settings at Spotware — that is a manual
// step outside this repo, and OAuth fails with a redirect_uri mismatch until
// it is done.
// ---------------------------------------------------------------------------

import express from 'express'
import { ctraderEnv } from '../lib/ctrader-env.js'

const CTRADER_API = 'https://openapi.ctrader.com'

/**
 * The origin the browser used, from the proxy headers Railway injects.
 *
 * Not `req.headers.origin`: browsers omit it on same-origin GETs, which is
 * precisely the shape of the auth-url call. x-forwarded-* is what survives a
 * reverse proxy, and Railway sets both.
 */
export function resolveOrigin(req) {
  const explicit = String(req.headers?.origin || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').trim()
  if (!host) return null
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    // Localhost is the one place http is the honest default; everywhere else a
    // missing proto behind a proxy means https, and guessing http would build
    // a redirect_uri Spotware rejects.
    || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https')
  return `${proto}://${host}`
}

/** Spotware reports failures in several shapes; surface whichever arrived. */
export const tokenError = (d) =>
  d?.errorDescription || d?.description || d?.error || d?.errorCode || null

/** Shared token POST for both grant types — identical apart from the params. */
async function tokenExchange(params, deps = {}) {
  const doFetch = deps.fetch ?? fetch
  const res = await doFetch(`${CTRADER_API}/apps/token?${params}`)
  const d = await res.json()
  const err = tokenError(d)
  if (err) return { ok: false, error: String(err) }
  const accessToken = d.accessToken ?? d.access_token
  if (!accessToken) return { ok: false, error: 'token exchange returned no access token' }
  return {
    ok: true,
    accessToken,
    refreshToken: d.refreshToken ?? d.refresh_token ?? null,
    expiresIn: d.expiresIn ?? d.expires_in ?? null,
  }
}

/** Router mounted at /api/ctrader, matching the Vercel path so the UI is unchanged. */
export default function ctraderOauthRouter(deps = {}) {
  const router = express.Router()
  const creds = () => ({ clientId: ctraderEnv('clientId'), clientSecret: ctraderEnv('clientSecret') })

  router.get('/', (req, res) => {
    if (req.query.action !== 'auth-url') return res.status(400).json({ error: 'unknown action' })
    const { clientId } = creds()
    if (!clientId) return res.status(500).json({ error: 'CTRADER_CLIENT_ID not configured' })
    const origin = resolveOrigin(req)
    if (!origin) return res.status(400).json({ error: 'unable to resolve request origin' })
    const redirectUri = `${origin}/link-up`
    const url = `${CTRADER_API}/apps/auth?client_id=${clientId}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=trading`
    // redirectUri is returned so the caller can pass the SAME string back to
    // exchange-token — Spotware compares them literally, and re-deriving it
    // there would break the moment a header differed between the two calls.
    return res.json({ url, redirectUri })
  })

  router.post('/', async (req, res) => {
    const b = req.body || {}
    const { clientId, clientSecret } = creds()
    if (b.action !== 'exchange-token' && b.action !== 'refresh-token') {
      return res.status(400).json({ error: 'unknown action' })
    }
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    const params = b.action === 'exchange-token'
      ? new URLSearchParams({
        grant_type: 'authorization_code',
        code: b.code ?? '',
        redirect_uri: b.redirectUri ?? '',
        client_id: clientId,
        client_secret: clientSecret,
      })
      : new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: b.refreshToken ?? '',
        client_id: clientId,
        client_secret: clientSecret,
      })

    try {
      const out = await tokenExchange(params, deps)
      if (!out.ok) return res.status(400).json({ error: out.error })
      return res.json({
        accessToken: out.accessToken,
        // On refresh, Spotware may omit the rotated token — keep the one the
        // caller sent rather than handing back null and losing it.
        refreshToken: out.refreshToken ?? (b.action === 'refresh-token' ? b.refreshToken ?? null : null),
        expiresIn: out.expiresIn,
      })
    } catch (err) {
      return res.status(500).json({ error: err?.message ?? String(err) })
    }
  })

  return router
}
