// OAuth return leg - Spotware redirects here after the user approves
// the app. The URL carries a one-shot `code` query param that we trade
// for access/refresh tokens via api/ctrader exchange-token, then stash
// the result in the strategy store and bounce back to Settings.

import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Card from '../components/common/Card.jsx'
import { useStrategy } from '../lib/strategy-store.js'

export default function LinkUp() {
  const [params] = useSearchParams()
  const { dispatch } = useStrategy()
  const [status, setStatus] = useState('exchanging') // exchanging | done | error
  const [error, setError] = useState(null)
  // React 18 StrictMode fires effects twice in dev, which would burn the
  // one-shot OAuth code. Guard so we only hit exchange-token once.
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const code = params.get('code')
    const errParam = params.get('error') || params.get('errorDescription')
    if (errParam) {
      setStatus('error')
      setError(errParam)
      return
    }
    if (!code) {
      setStatus('error')
      setError('Missing authorisation code in callback URL')
      return
    }

    // The redirect URI passed to exchange-token must match the one we
    // sent to /apps/auth exactly, origin and path inclusive.
    const redirectUri = `${window.location.origin}/link-up`

    ;(async () => {
      try {
        const res = await fetch('/api/ctrader', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'exchange-token', code, redirectUri }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `exchange-token ${res.status}`)
        dispatch({
          type: 'CTRADER_SET_TOKENS',
          accessToken: data.accessToken || '',
          refreshToken: data.refreshToken || '',
          expiresIn: data.expiresIn || 2592000,
        })
        setStatus('done')
      } catch (e) {
        setStatus('error')
        setError(e.message)
      }
    })()
  }, [params, dispatch])

  return (
    <section className="max-w-md mx-auto">
      <h1 className="text-xl t-label mb-4">cTrader link-up</h1>
      <Card>
        {status === 'exchanging' && (
          <p className="t-sub">Exchanging authorisation code for tokens...</p>
        )}
        {status === 'done' && (
          <>
            <p className="t-sub mb-3">
              Tokens saved. You can now fetch your cTrader accounts from the
              Settings tab.
            </p>
            <Link
              to="/settings"
              className="t-sub underline text-[var(--color-up)]"
            >
              Back to Settings →
            </Link>
          </>
        )}
        {status === 'error' && (
          <>
            <p className="t-sub text-[var(--color-down)] mb-2">
              Link-up failed: {error}
            </p>
            <Link
              to="/settings"
              className="t-sub underline text-[var(--color-up)]"
            >
              Back to Settings →
            </Link>
          </>
        )}
      </Card>
    </section>
  )
}
