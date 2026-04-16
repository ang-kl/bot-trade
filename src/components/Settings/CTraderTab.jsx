// cTrader OAuth + account linker. Thin client over api/ctrader.js.
// Users either go through the OAuth popup or paste a token directly.

import { useState } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import Badge from '../common/Badge.jsx'
import { useStrategy } from '../../lib/strategy-store.js'

// The v1-ported api/ctrader.js handler only serves `auth-url` via GET with
// query params. Every other action reads its args from the JSON body, so we
// POST for those. Keep this split in one helper so callers stay simple.
async function callCtrader(action, params = {}) {
  const init = action === 'auth-url'
    ? { method: 'GET' }
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...params }),
      }
  const url = action === 'auth-url'
    ? `/api/ctrader?action=${encodeURIComponent(action)}`
    : '/api/ctrader'
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `ctrader ${action} ${res.status}`)
  return data
}

export default function CTraderTab() {
  const { state, dispatch } = useStrategy()
  const { accessToken, refreshToken, accounts, linkedAccountId } = state.ctrader
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const setTokens = (patch) => dispatch({ type: 'CTRADER_SET_TOKENS', ...patch })

  const onOpenOAuth = async () => {
    setBusy('oauth'); setError(null)
    try {
      // v1 api/ctrader.js returns { url, redirectUri } for auth-url.
      const { url } = await callCtrader('auth-url')
      if (url && typeof window !== 'undefined') window.open(url, '_blank', 'noopener')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const onFetchAccounts = async () => {
    if (!accessToken) return
    setBusy('accounts'); setError(null)
    try {
      const data = await callCtrader('accounts', { accessToken })
      dispatch({ type: 'CTRADER_SET_ACCOUNTS', accounts: data.accounts || [] })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="t-label mb-2">OAuth connection</h2>
        <p className="t-sub text-[var(--color-text-sub)] mb-3">
          Connect your cTrader account via OAuth. If you already have a token from the callback, paste it below.
        </p>
        <div className="flex gap-2 mb-3">
          <Button onClick={onOpenOAuth} size="sm" disabled={busy === 'oauth'}>
            {busy === 'oauth' ? 'Opening...' : 'Open cTrader OAuth'}
          </Button>
        </div>
        <label className="block t-meta mb-1" htmlFor="ctrader-access">Access token</label>
        <Input
          id="ctrader-access"
          value={accessToken}
          onChange={(e) => setTokens({ accessToken: e.target.value })}
          placeholder="eyJ..."
          className="mb-3"
        />
        <label className="block t-meta mb-1" htmlFor="ctrader-refresh">Refresh token</label>
        <Input
          id="ctrader-refresh"
          value={refreshToken}
          onChange={(e) => setTokens({ refreshToken: e.target.value })}
          placeholder="eyJ..."
        />
      </Card>

      <Card>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="t-label flex-1">Accounts</h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={onFetchAccounts}
            disabled={!accessToken || busy === 'accounts'}
          >
            {busy === 'accounts' ? 'Fetching...' : 'Fetch'}
          </Button>
        </div>
        {error && <p className="t-sub text-[var(--color-down)] mb-2">{error}</p>}
        {accounts.length === 0 ? (
          <p className="t-sub text-[var(--color-text-sub)]">No accounts loaded. Paste a token and click Fetch.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {accounts.map((a) => {
              // v1 api/ctrader.js flattens each account to:
              //   { accountId, accountNumber, brokerTitle, isLive, balance, currency }
              const id = a.accountId
              const linked = linkedAccountId === id
              return (
                <li key={id} className="py-2 flex items-center gap-2">
                  <span className="t-sub flex-1 truncate">
                    #{a.accountNumber ?? id} · {a.brokerTitle || 'cTrader'} · {a.currency || '-'}
                  </span>
                  {a.isLive ? <Badge tone="down">LIVE</Badge> : <Badge>demo</Badge>}
                  <Button
                    size="sm"
                    variant={linked ? 'primary' : 'ghost'}
                    onClick={() => dispatch({ type: 'CTRADER_LINK_ACCOUNT', accountId: linked ? null : id })}
                  >
                    {linked ? 'Linked' : 'Link'}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
