// Trading Platform - cTrader OAuth + account linker.
// When connected: shows a header with status, active account with balance,
// accounts list, and a collapsed disconnect footer.
// When disconnected: shows the OAuth card prominently.

import { useState, useCallback, useEffect } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import Badge from '../common/Badge.jsx'
import { useStrategy } from '../../lib/strategy-store.js'
import { agentPost, agentConfigured, ROLES } from '../../lib/agent-api.js'

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
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
  }).format(balance)
}

function maskToken(token) {
  if (!token || token.length < 8) return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
  return token.slice(0, 4) + '\u2022'.repeat(Math.min(20, token.length - 4))
}

export default function CTraderTab() {
  const { state, dispatch } = useStrategy()
  const { accessToken, refreshToken, accounts, linkedAccountId, accountRoles } = state.ctrader
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [balances, setBalances] = useState({})

  const roleOf = (id) => accountRoles[String(id)] || { autopilot: false, copilot: false }

  const syncRolesToBackend = useCallback(async (nextRoles) => {
    if (!accessToken) return
    const rolesArray = accounts.map(a => {
      const r = nextRoles[String(a.accountId)] || { autopilot: false, copilot: false }
      return { accountId: a.accountId, isLive: a.isLive, autopilot: r.autopilot, copilot: r.copilot }
    })
    // Fan out to every wired Railway service so autopilot + copilot both
    // hold the current access token and account roles. If either one is
    // down, the other still gets updated.
    const targets = ROLES.filter(r => agentConfigured(r))
    if (targets.length === 0) return
    await Promise.all(targets.map(async (r) => {
      try {
        await agentPost('/actions/ctrader-config', { accessToken, accounts: rolesArray }, r)
      } catch (e) {
        console.warn(`[CTraderTab] ${r} backend sync failed:`, e.message)
      }
    }))
  }, [accessToken, accounts])

  const toggleRole = (accountId, field) => {
    const id = String(accountId)
    const prev = roleOf(id)
    const next = { ...prev, [field]: !prev[field] }
    dispatch({ type: 'CTRADER_SET_ACCOUNT_ROLE', accountId: id, [field]: next[field] })
    const nextRoles = { ...accountRoles, [id]: next }
    syncRolesToBackend(nextRoles)
    if (field === 'copilot' && !next.copilot && linkedAccountId === accountId) {
      dispatch({ type: 'CTRADER_LINK_ACCOUNT', accountId: null })
    }
  }

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

  const onFetchAccounts = useCallback(async () => {
    if (!accessToken) return
    setBusy('accounts'); setError(null)
    try {
      const data = await callCtrader('accounts', { accessToken })
      const list = data.accounts || []
      dispatch({ type: 'CTRADER_SET_ACCOUNTS', accounts: list })
      return list
    } catch (e) {
      setError(e.message)
      return []
    } finally {
      setBusy(null)
    }
  }, [accessToken, dispatch])

  const fetchBalance = useCallback(async (accountId, isLive) => {
    if (!accessToken) return
    try {
      const data = await callCtrader('account-info', { accessToken, accountId, isLive })
      setBalances(prev => ({ ...prev, [accountId]: data }))
    } catch {
      // Silently skip - balance just won't show
    }
  }, [accessToken])

  const fetchAllBalances = useCallback(async (accts) => {
    const list = accts || accounts
    for (const a of list) {
      fetchBalance(a.accountId, a.isLive)
    }
  }, [accounts, fetchBalance])

  // Auto-fetch accounts and balances when connected with no accounts loaded
  useEffect(() => {
    if (isConnected && accounts.length === 0) {
      onFetchAccounts().then(list => {
        if (list && list.length > 0) fetchAllBalances(list)
      })
    } else if (isConnected && accounts.length > 0 && Object.keys(balances).length === 0) {
      fetchAllBalances()
    }
  }, [isConnected]) // eslint-disable-line react-hooks/exhaustive-deps

  const onRefreshAccounts = async () => {
    const list = await onFetchAccounts()
    if (list && list.length > 0) fetchAllBalances(list)
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
              {'\u26A1'}
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
        {linkedAccount && (() => {
          const lr = roleOf(linkedAccountId)
          return (
            <Card className="bg-[var(--color-accent-soft)]">
              <p className="t-meta text-[var(--color-text-sub)] mb-1">Active Account for Charts and Trading</p>
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-[var(--color-accent)]" />
                <div className="flex-1 min-w-0">
                  <p className="t-label">
                    {linkedAccount.brokerTitle || 'Pepperstone'} #{linkedAccount.accountNumber ?? linkedAccount.accountId}
                    {lr.autopilot && <Badge tone="info" className="text-[8px] px-1 ml-2">AUTOPILOT</Badge>}
                    {lr.copilot && <Badge tone="special" className="text-[8px] px-1 ml-1">COPILOT</Badge>}
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
              </div>
            </Card>
          )
        })()}

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
              {busy === 'accounts' ? 'Loading...' : '\u21BB Refresh'}
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
                      {'\u26A1'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="t-sub font-medium">
                          {a.brokerTitle || 'Pepperstone'} #{a.accountNumber ?? id}
                        </span>
                        {linked && <span className="text-[var(--color-accent)]">{'\u2713'}</span>}
                      </div>
                      <span className="t-meta text-[var(--color-text-sub)]">
                        ID: {id} - {a.isLive ? 'LIVE' : 'DEMO'}
                        {info?.balance != null && ` - ${formatBalance(info.balance, info.currency || a.currency)}`}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border transition-colors ${
                          roleOf(id).autopilot
                            ? 'bg-[var(--color-info-bg)] text-[var(--color-info-text)] border-[var(--color-info-border)]'
                            : 'bg-transparent text-[var(--color-muted)] border-[var(--color-border)]'
                        }`}
                        onClick={() => toggleRole(id, 'autopilot')}
                        title="Toggle autopilot (bot auto-trades this account)"
                      >
                        AUTO
                      </button>
                      <button
                        className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border transition-colors ${
                          roleOf(id).copilot
                            ? 'bg-[var(--color-special-bg)] text-[var(--color-special-text)] border-[var(--color-special-border)]'
                            : 'bg-transparent text-[var(--color-muted)] border-[var(--color-border)]'
                        }`}
                        onClick={() => toggleRole(id, 'copilot')}
                        title="Toggle copilot (you trade this account via Feed)"
                      >
                        COPILOT
                      </button>
                      <Button
                        size="sm"
                        variant={linked ? 'subtle' : 'ghost'}
                        disabled={!roleOf(id).copilot && !linked}
                        onClick={() => {
                          dispatch({ type: 'CTRADER_LINK_ACCOUNT', accountId: linked ? null : id })
                          if (!linked && !balances[id]) fetchBalance(id, a.isLive)
                        }}
                        title={!roleOf(id).copilot && !linked ? 'Enable copilot first' : ''}
                      >
                        {linked ? '-' : 'View'}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {/* Manage credentials in Admin */}
        <div className="flex items-center justify-between pt-2 px-1">
          <p className="t-meta text-[var(--color-muted)]">
            API credentials are managed in <a href="/admin" className="text-[var(--color-accent)] underline">Admin</a>.
          </p>
        </div>
      </div>
    )
  }

  // --- Disconnected state ---
  return (
    <div className="space-y-4">
      <Card className="border-l-4 border-l-[var(--color-warning-text)]">
        <h2 className="t-label mb-2">Not connected</h2>
        <p className="t-sub text-[var(--color-text-sub)] mb-3">
          Configure your cTrader credentials in the <strong>Admin</strong> page, then return here to manage accounts and trading.
        </p>
        <a href="/admin" className="inline-block">
          <Button size="sm">Go to Admin</Button>
        </a>
      </Card>
    </div>
  )
}
