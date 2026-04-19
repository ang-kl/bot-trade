// Bottom status ribbon — Word-style persistent bar. Polls the Railway agent
// every 30s for armed-state + health. Stays visible on every route so the
// operator always knows whether autopilot is on, how many positions are live,
// and whether the backend is reachable.
// Also shows cTrader connection state with inline connect/disconnect.

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { agentGet, agentConfigured } from '../lib/agent-api.js'
import { useStrategy } from '../lib/strategy-store.js'
import { fmtAgo } from '../lib/time.js'

const POLL_MS = 30_000

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

export default function StatusRibbon() {
  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)
  const [positions, setPositions] = useState([])
  const [reachable, setReachable] = useState(true)
  const { state, dispatch } = useStrategy()
  const { accessToken, accounts, linkedAccountId } = state.ctrader
  const isConnected = !!accessToken
  const [ctraderExpanded, setCtraderExpanded] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)
  const [ctraderError, setCtraderError] = useState(null)

  useEffect(() => {
    if (!agentConfigured) return
    let live = true
    async function poll() {
      try {
        const [h, c, p] = await Promise.all([
          agentGet('/health').catch(() => null),
          agentGet('/state/config').catch(() => null),
          agentGet('/state/positions').catch(() => ({ positions: [] })),
        ])
        if (!live) return
        setHealth(h)
        setConfig(c)
        setPositions(p?.positions || [])
        setReachable(Boolean(h))
      } catch {
        if (live) setReachable(false)
      }
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { live = false; clearInterval(id) }
  }, [])

  const onConnectCtrader = useCallback(async () => {
    setOauthBusy(true); setCtraderError(null)
    try {
      const { url } = await callCtrader('auth-url')
      if (url) window.open(url, '_blank', 'noopener')
    } catch (e) {
      setCtraderError(e.message)
    } finally {
      setOauthBusy(false)
    }
  }, [])

  const onDisconnectCtrader = useCallback(() => {
    if (!window.confirm('Disconnect cTrader? You will need to re-authenticate.')) return
    dispatch({ type: 'CTRADER_SET_TOKENS', accessToken: '', refreshToken: '' })
    dispatch({ type: 'CTRADER_SET_ACCOUNTS', accounts: [] })
    dispatch({ type: 'CTRADER_LINK_ACCOUNT', accountId: null })
    setCtraderExpanded(false)
  }, [dispatch])

  const linkedAccount = accounts?.find(a => a.accountId === linkedAccountId)
  const accountCount = accounts?.length || 0

  if (!agentConfigured) {
    return (
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] text-[var(--color-muted)] px-3 py-1 flex items-center gap-3">
        <span>Agent backend not configured</span>
      </div>
    )
  }

  const autotradeOn = config?.autotrade_enabled === true
  const scanOn = config?.scan_enabled !== false
  const analyzeOn = config?.analyze_enabled !== false
  const openCount = positions.length
  const circuitBreaker = health?.circuitBreaker
  const dotClass = !reachable
    ? 'bg-[var(--color-down)]'
    : circuitBreaker
      ? 'bg-[var(--color-down)] animate-pulse'
      : autotradeOn
        ? 'bg-[var(--color-up)] animate-pulse'
        : (scanOn || analyzeOn)
          ? 'bg-[var(--color-accent)]'
          : 'bg-[var(--color-muted)]'

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Main status row */}
      <div
        className="text-[10px] text-[var(--color-text-sub)] px-3 py-1 flex items-center gap-3 whitespace-nowrap overflow-x-auto"
        role="status"
        aria-live="polite"
      >
        <span className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
          <Link to="/agent" className="font-bold hover:underline">
            {!reachable ? 'OFFLINE' : circuitBreaker ? 'CIRCUIT BREAKER' : autotradeOn ? 'AUTO-TRADE ON' : analyzeOn ? 'ANALYZING' : scanOn ? 'SCANNING' : 'ALL OFF'}
          </Link>
        </span>
        <span className="text-[var(--color-muted)]">·</span>
        <span>
          <span className="text-[var(--color-muted)]">Positions</span>{' '}
          <b>{openCount}</b>
        </span>
        <span className="text-[var(--color-muted)]">·</span>
        <span>
          <span className="text-[var(--color-muted)]">Loop</span>{' '}
          <b>{health?.loopCount ?? '—'}</b>
        </span>
        <span className="text-[var(--color-muted)]">·</span>
        <span>
          <span className="text-[var(--color-muted)]">Last scan</span>{' '}
          <b>{health?.lastScanAt ? fmtAgo(health.lastScanAt) : '—'}</b>
        </span>
        {health?.errorsToday > 0 && (
          <>
            <span className="text-[var(--color-muted)]">·</span>
            <span className="text-[var(--color-down)]">
              <span className="text-[var(--color-muted)]">Errors</span>{' '}
              <b>{health.errorsToday}</b>
            </span>
          </>
        )}
        {health?.dbSizeMB > 0 && (
          <>
            <span className="text-[var(--color-muted)]">·</span>
            <span>
              <span className="text-[var(--color-muted)]">DB</span>{' '}
              <b>{health.dbSizeMB}MB</b>
            </span>
          </>
        )}

        <span className="text-[var(--color-muted)]">·</span>

        {/* cTrader status toggle */}
        <button
          type="button"
          onClick={() => setCtraderExpanded(prev => !prev)}
          className="flex items-center gap-1 font-bold hover:underline underline-offset-2 cursor-pointer"
        >
          <span className={`inline-block h-2 w-2 rounded-full ${isConnected ? 'bg-[var(--color-up)]' : 'bg-[var(--color-down)]'}`} />
          <span className={isConnected ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>
            cTrader {isConnected ? 'ON' : 'OFF'}
          </span>
          <span className="text-[var(--color-muted)]">{ctraderExpanded ? '▼' : '▶'}</span>
        </button>

        <span className="flex-1" />
        <Link to="/workshop" className="text-[var(--color-accent)] hover:underline">
          Workshop →
        </Link>
      </div>

      {/* Collapsible cTrader panel */}
      {ctraderExpanded && (
        <div className="border-t border-[var(--color-border)] px-3 py-2 text-[11px] flex items-center gap-3 flex-wrap bg-[var(--color-bg)]">
          {isConnected ? (
            <>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-up)]" />
                <span className="font-bold text-[var(--color-up)]">Connected</span>
              </span>
              {linkedAccount && (
                <span className="text-[var(--color-text-sub)]">
                  #{linkedAccount.accountNumber || linkedAccount.accountId}
                  {' '}
                  <span className={linkedAccount.isLive ? 'text-[var(--color-down)] font-bold' : 'text-[var(--color-accent)]'}>
                    {linkedAccount.isLive ? 'LIVE' : 'DEMO'}
                  </span>
                </span>
              )}
              {accountCount > 0 && (
                <span className="text-[var(--color-muted)]">{accountCount} account{accountCount !== 1 ? 's' : ''}</span>
              )}
              <Link to="/settings" className="text-[var(--color-accent)] hover:underline">
                Manage →
              </Link>
              <button
                type="button"
                onClick={onDisconnectCtrader}
                className="text-[var(--color-down)] hover:underline cursor-pointer"
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-down)]" />
                <span className="font-bold text-[var(--color-muted)]">Not connected</span>
              </span>
              <button
                type="button"
                onClick={onConnectCtrader}
                disabled={oauthBusy}
                className="px-2 py-0.5 rounded-[5px] bg-[var(--color-accent)] text-white font-bold hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                {oauthBusy ? 'Opening…' : 'Connect cTrader'}
              </button>
              <Link to="/settings" className="text-[var(--color-accent)] hover:underline">
                Settings →
              </Link>
            </>
          )}
          {ctraderError && (
            <span className="text-[var(--color-down)]">{ctraderError}</span>
          )}
        </div>
      )}
    </div>
  )
}
