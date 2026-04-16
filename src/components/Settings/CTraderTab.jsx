// Trading Platform - cTrader OAuth + account linker.
// When connected: shows a header with status, active account with balance,
// accounts list, and a collapsed disconnect footer.
// When disconnected: shows the OAuth card prominently.

import { useState, useCallback } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import Badge from '../common/Badge.jsx'
import { useStrategy } from '../../lib/strategy-store.js'

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

function formatBalance(balance, currency) {
  if (balance == null) return '-'
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
  }).format(balance)
  return formatted
}

export default function CTraderTab() {
  const { state, dispatch } = useStrategy()
  const { accessToken, refreshToken, accounts, linkedAccountId } = state.ctrader
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [balances, setBalances] = useState({})

  const isConnected = !!accessToken

  const setTokens = (patch) => dispatch({ type: 'CTRADER_SET_TOKENS', ...patch })

  const onOpenOAuth = async () => {
    setBusy('oauth'); setError(null)
    try {
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

  const fetchBalance = useCallback(async (accountId, isLive) => {
    if (!accessToken) return
    try {
      const data = await callCtrader('account-info', {
        accessToken,
        accountId,
        isLive,
      })
      setBalances(prev => ({ ...prev, [accountId]: data }))
    } catch {
      // Silently skip - balance just won't show
    }
  }, [accessToken])

  const onRefreshAccounts = async () => {
    await onFetchAccounts()
    // Fetch balances for all accounts after loading them
    for (const a of state.ctrader.accounts) {
      fetchBalance(a.accountId, a.isLive)
    }
  }

  const onDisconnect = () => {
    if (!window.confirm('Disconnect will clear the access token and require re-authentication.')) return
    dispatch({ type: 'CTRADER_SET_TOKENS', accessToken: '', refreshToken: '' })
    dispatch({ type: 'CTRADER_SET_ACCOUNTS', accounts: [] })
    dispatch({ type: 'CTRADER_LINK_ACCOUNT', accountId: null })
    setBalances({})
  }

  const linkedAccount = accounts.find(a => a.accountId === linkedAccountId)
  const linkedBalance = linkedAccountId ? balances[linkedAccountId] : null

  // --- Connected state ---
  if (isConnected) {
    return (
      <div className="space-y-4">
        {/* Connected header */}
        <Card className="border-l-4 border-l-[var(--color-accent)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[8px] bg-[var(--color-accent)] flex items-center justify-center text-white font-bold t-body">
              &#9889;
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="t-label">cTrader (Spotware)</h2>
              <p className="t-meta text-[var(--color-text-sub)]">
                Connected - select an account below for live data and trading
              </p>
            </div>
            <Badge tone="up" pill>Connected</Badge>
          </div>
        </Card>

        {/* Active account summary */}
        {linkedAccount && (
          <Card className="bg-[var(--color-accent-soft)]">
            <p className="t-meta text-[var(--color-text-sub)] mb-1">Active Account for Charts and Trading</p>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-[var(--color-accent)]" />
              <div className="flex-1 min-w-0">
                <p className="t-label">
                  Pepperstone #{linkedAccount.accountNumber ?? linkedAccount.accountId}
                </p>
                <p className="t-meta text-[var(--color-text-sub)]">
                  ID: {linkedAccount.accountId} - {linkedAccount.isLive ? 'LIVE' : 'DEMO'}
                </p>
                {linkedBalance && (
                  <p className="t-body font-medium mt-1">
                    Balance: {formatBalance(linkedBalance.balance, linkedBalance.currency || linkedAccount.currency)}
                  </p>
                )}
              </div>
              <Button size="sm" onClick={() => {
                // Navigate to Feed - placeholder for start bot flow
              }}>
                Test Bot &rarr;
              </Button>
            </div>
          </Card>
        )}

        {/* Accounts list */}
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="t-section-label flex-1">YOUR ACCOUNTS</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={onRefreshAccounts}
              disabled={busy === 'accounts'}
            >
              {busy === 'accounts' ? 'Loading...' : '&#8635; Refresh'}
            </Button>
          </div>
          {error && (
            <Card className="mb-3 border-l-4 border-l-[var(--color-down)] bg-[color-mix(in_srgb,var(--color-down)_8%,var(--color-surface))]">
              <p className="t-label text-[var(--color-down)] mb-1">Failed to load accounts</p>
              <p className="t-meta text-[var(--color-text-sub)]">{error}</p>
              <button
                className="t-meta text-[var(--color-accent)] underline mt-1"
                onClick={onRefreshAccounts}
              >
                Retry
              </button>
            </Card>
          )}
          {accounts.length === 0 && !error ? (
            <p className="t-sub text-[var(--color-text-sub)]">No accounts loaded yet. Click Refresh to fetch your accounts.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {accounts.map((a) => {
                const id = a.accountId
                const linked = linkedAccountId === id
                const info = balances[id]
                return (
                  <li
                    key={id}
                    className={`py-3 flex items-center gap-3 px-2 rounded-[8px] ${
                      linked ? 'bg-[var(--color-accent-soft)] border border-[var(--color-accent)]' : ''
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-[6px] flex items-center justify-center text-sm ${
                      linked
                        ? 'bg-[var(--color-accent)] text-white'
                        : a.isLive
                          ? 'bg-[color-mix(in_srgb,var(--color-down)_12%,var(--color-surface))] text-[var(--color-down)]'
                          : 'bg-[var(--color-bg)] text-[var(--color-text-sub)]'
                    }`}>
                      &#9889;
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="t-sub font-medium">
                          {a.brokerTitle || 'Pepperstone'} #{a.accountNumber ?? id}
                        </span>
                        {linked && <span className="text-[var(--color-accent)]">&#10003;</span>}
                      </div>
                      <span className="t-meta text-[var(--color-text-sub)]">
                        ID: {id} - {a.isLive ? 'LIVE' : 'DEMO'}
                        {info?.balance != null && ` - ${formatBalance(info.balance, info.currency || a.currency)}`}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant={linked ? 'subtle' : 'ghost'}
                      onClick={() => {
                        dispatch({ type: 'CTRADER_LINK_ACCOUNT', accountId: linked ? null : id })
                        if (!linked && !balances[id]) fetchBalance(id, a.isLive)
                      }}
                    >
                      {linked ? '-' : 'Link'}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {/* Disconnect footer */}
        <div className="flex items-center justify-between pt-2 px-1">
          <p className="t-meta text-[var(--color-muted)]">
            Disconnect will clear the access token and require re-authentication.
          </p>
          <Button size="sm" variant="ghost" onClick={onDisconnect}>
            &#8635; Disconnect
          </Button>
        </div>
      </div>
    )
  }

  // --- Disconnected state ---
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="t-label mb-2">Connect to cTrader</h2>
        <p className="t-sub text-[var(--color-text-sub)] mb-3">
          Link your cTrader (Spotware) account to enable live data and trading. Use OAuth or paste tokens directly.
        </p>
        <div className="flex gap-2 mb-4">
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
        {error && <p className="t-sub text-[var(--color-down)] mt-2">{error}</p>}
      </Card>
    </div>
  )
}
