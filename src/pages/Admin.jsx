// Admin — API credentials and service connections.
// Each service: cTrader, Telegram, Massive.
// Test button per service, auto-lock on success, explicit unlock to edit.

import { useState, useCallback } from 'react'
import Card from '../components/common/Card.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import Badge from '../components/common/Badge.jsx'
import { useStrategy } from '../lib/strategy-store.js'

function maskValue(val) {
  if (!val || val.length < 6) return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
  return val.slice(0, 4) + '\u2022'.repeat(Math.min(16, val.length - 8)) + val.slice(-4)
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
}

// ── Service Card wrapper ──

function ServiceCard({ id, title, icon, locked, onLock, onUnlock, status, children }) {
  return (
    <Card className={locked ? 'border-l-4 border-l-[var(--color-accent)]' : ''}>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-[8px] bg-[var(--color-accent-soft)] flex items-center justify-center text-lg">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="t-label">{title}</h2>
          <p className="t-meta text-[var(--color-muted)]">
            {locked ? 'Locked \u2014 credentials verified and saved' : 'Enter credentials and test the connection'}
          </p>
        </div>
        {status === 'connected' && <Badge tone="up" pill>Connected</Badge>}
        {status === 'failed' && <Badge tone="down" pill>Failed</Badge>}
        {status === 'untested' && <Badge tone="neutral" pill>Not tested</Badge>}
        {locked ? (
          <Button size="sm" variant="ghost" onClick={onUnlock}>
            {'\uD83D\uDD13'} Unlock
          </Button>
        ) : (
          <Button size="sm" variant="subtle" onClick={onLock} disabled={status !== 'connected'}>
            {'\uD83D\uDD12'} Lock
          </Button>
        )}
      </div>
      {children}
    </Card>
  )
}

// ── cTrader section ──

function CTraderAdmin({ locked }) {
  const { state, dispatch } = useStrategy()
  const { accessToken, refreshToken, linkedAccountId, accounts } = state.ctrader
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const setTokens = (patch) => dispatch({ type: 'CTRADER_SET_TOKENS', ...patch })

  const testConnection = useCallback(async () => {
    if (!accessToken) return
    setBusy(true); setTestResult(null)
    try {
      const res = await fetch('/api/ctrader', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'accounts', accessToken }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `${res.status}`)
      const list = data.accounts || []
      dispatch({ type: 'CTRADER_SET_ACCOUNTS', accounts: list })
      setTestResult({ ok: true, message: `Connected \u2014 ${list.length} account(s) found` })
      // Auto-lock on success
      dispatch({ type: 'ADMIN_LOCK', service: 'ctrader' })
    } catch (e) {
      setTestResult({ ok: false, message: e.message })
    } finally {
      setBusy(false)
    }
  }, [accessToken, dispatch])

  const onOpenOAuth = async () => {
    try {
      const res = await fetch('/api/ctrader?action=auth-url')
      const data = await res.json()
      if (data.url) window.open(data.url, '_blank', 'noopener')
    } catch { /* ignore */ }
  }

  const status = testResult?.ok ? 'connected' : testResult ? 'failed' : (accessToken ? 'untested' : 'untested')

  return (
    <ServiceCard
      id="ctrader"
      title="cTrader (Spotware)"
      icon={'\u26A1'}
      locked={locked}
      onLock={() => dispatch({ type: 'ADMIN_LOCK', service: 'ctrader' })}
      onUnlock={() => dispatch({ type: 'ADMIN_UNLOCK', service: 'ctrader' })}
      status={status}
    >
      {locked ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="t-meta text-[var(--color-muted)] w-28">Access token</span>
            <span className="t-sub font-mono text-[var(--color-text-sub)]">{maskValue(accessToken)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="t-meta text-[var(--color-muted)] w-28">Refresh token</span>
            <span className="t-sub font-mono text-[var(--color-text-sub)]">{maskValue(refreshToken)}</span>
          </div>
          {linkedAccountId && (
            <div className="flex items-center gap-2">
              <span className="t-meta text-[var(--color-muted)] w-28">Linked account</span>
              <span className="t-sub font-mono text-[var(--color-text-sub)]">{linkedAccountId}</span>
            </div>
          )}
          {accounts.length > 0 && (
            <p className="t-meta text-[var(--color-muted)]">{accounts.length} account(s) available</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-ct-access">Access token</label>
            <Input
              id="admin-ct-access"
              value={accessToken}
              onChange={(e) => setTokens({ accessToken: e.target.value })}
              placeholder="eyJ..."
            />
          </div>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-ct-refresh">Refresh token</label>
            <Input
              id="admin-ct-refresh"
              value={refreshToken}
              onChange={(e) => setTokens({ refreshToken: e.target.value })}
              placeholder="eyJ..."
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onOpenOAuth}>Open cTrader OAuth</Button>
            <Button size="sm" variant="primary" onClick={testConnection} disabled={!accessToken || busy}>
              {busy ? 'Testing...' : '\u25B6 Test Connection'}
            </Button>
          </div>
          {testResult && (
            <p className={`t-sub ${testResult.ok ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
              {testResult.message}
            </p>
          )}
        </div>
      )}
    </ServiceCard>
  )
}

// ── Telegram section ──

function TelegramAdmin({ locked }) {
  const { state, dispatch } = useStrategy()
  const { botToken, chatId, enabled } = state.telegram
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const setTelegram = (patch) => dispatch({ type: 'TELEGRAM_SET', ...patch })

  const testConnection = useCallback(async () => {
    if (!botToken || !chatId) return
    setBusy(true); setTestResult(null)
    try {
      await apiPost('/api/telegram', {
        action: 'send-alert',
        alertType: 'test',
        botToken,
        chatId,
        message: 'bot-trade Admin: connection test successful \u2705',
      })
      setTestResult({ ok: true, message: 'Test message sent to Telegram' })
      setTelegram({ enabled: true })
      dispatch({ type: 'ADMIN_LOCK', service: 'telegram' })
    } catch (e) {
      setTestResult({ ok: false, message: e.message })
    } finally {
      setBusy(false)
    }
  }, [botToken, chatId, dispatch]) // eslint-disable-line react-hooks/exhaustive-deps

  const status = testResult?.ok ? 'connected' : testResult ? 'failed' : (botToken && chatId ? 'untested' : 'untested')

  return (
    <ServiceCard
      id="telegram"
      title="Telegram Bot"
      icon={'\uD83D\uDCF1'}
      locked={locked}
      onLock={() => dispatch({ type: 'ADMIN_LOCK', service: 'telegram' })}
      onUnlock={() => dispatch({ type: 'ADMIN_UNLOCK', service: 'telegram' })}
      status={status}
    >
      {locked ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="t-meta text-[var(--color-muted)] w-28">Bot token</span>
            <span className="t-sub font-mono text-[var(--color-text-sub)]">{maskValue(botToken)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="t-meta text-[var(--color-muted)] w-28">Chat ID</span>
            <span className="t-sub font-mono text-[var(--color-text-sub)]">{maskValue(chatId)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="t-meta text-[var(--color-muted)] w-28">Alerts</span>
            <Badge tone={enabled ? 'up' : 'neutral'} pill>{enabled ? 'Enabled' : 'Disabled'}</Badge>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-tg-token">Bot token</label>
            <Input
              id="admin-tg-token"
              value={botToken}
              onChange={(e) => setTelegram({ botToken: e.target.value })}
              placeholder="123456:ABC-DEF..."
            />
          </div>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-tg-chat">Chat ID</label>
            <Input
              id="admin-tg-chat"
              value={chatId}
              onChange={(e) => setTelegram({ chatId: e.target.value })}
              placeholder="-1001234567890"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setTelegram({ enabled: e.target.checked })}
                className="w-4 h-4"
              />
              <span className="t-sub text-[var(--color-text-sub)]">Enable alerts</span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={testConnection} disabled={!botToken || !chatId || busy}>
              {busy ? 'Sending...' : '\u25B6 Test Connection'}
            </Button>
            <span className="t-meta text-[var(--color-muted)]">Sends a test message to your chat</span>
          </div>
          {testResult && (
            <p className={`t-sub ${testResult.ok ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
              {testResult.message}
            </p>
          )}
        </div>
      )}
    </ServiceCard>
  )
}

// ── Massive section ──

function MassiveAdmin({ locked }) {
  const { state, dispatch } = useStrategy()
  const { apiKey } = state.massive
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const testConnection = useCallback(async () => {
    if (!apiKey) return
    setBusy(true); setTestResult(null)
    try {
      const res = await fetch(`/api/massive?action=test&apiKey=${encodeURIComponent(apiKey)}`)
      const data = await res.json().catch(() => ({}))
      if (data.ok) {
        setTestResult({ ok: true, message: 'Massive API connected \u2014 data access verified' })
        dispatch({ type: 'ADMIN_LOCK', service: 'massive' })
      } else {
        setTestResult({ ok: false, message: data.error || 'Connection failed' })
      }
    } catch (e) {
      setTestResult({ ok: false, message: e.message })
    } finally {
      setBusy(false)
    }
  }, [apiKey, dispatch])

  const status = testResult?.ok ? 'connected' : testResult ? 'failed' : (apiKey ? 'untested' : 'untested')

  return (
    <ServiceCard
      id="massive"
      title="Massive (Market Data)"
      icon={'\uD83D\uDCCA'}
      locked={locked}
      onLock={() => dispatch({ type: 'ADMIN_LOCK', service: 'massive' })}
      onUnlock={() => dispatch({ type: 'ADMIN_UNLOCK', service: 'massive' })}
      status={status}
    >
      {locked ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="t-meta text-[var(--color-muted)] w-28">API key</span>
            <span className="t-sub font-mono text-[var(--color-text-sub)]">{maskValue(apiKey)}</span>
          </div>
          <p className="t-meta text-[var(--color-muted)]">
            Covers: US stocks, forex, crypto, futures, indices. Real volume, fundamentals, news.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-massive-key">API key</label>
            <Input
              id="admin-massive-key"
              value={apiKey}
              onChange={(e) => dispatch({ type: 'MASSIVE_SET', apiKey: e.target.value })}
              placeholder="paste your Massive API key..."
            />
          </div>
          <p className="t-meta text-[var(--color-muted)]">
            Massive (formerly Polygon.io) provides real-time and historical market data for stocks, forex, crypto, futures, and indices.
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={testConnection} disabled={!apiKey || busy}>
              {busy ? 'Testing...' : '\u25B6 Test Connection'}
            </Button>
          </div>
          {testResult && (
            <p className={`t-sub ${testResult.ok ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
              {testResult.message}
            </p>
          )}
        </div>
      )}
    </ServiceCard>
  )
}

// ── Main Admin page ──

export default function Admin() {
  const { state } = useStrategy()
  const locks = state.adminLocks

  const allLocked = locks.ctrader && locks.telegram && locks.massive
  const connectedCount = [locks.ctrader, locks.telegram, locks.massive].filter(Boolean).length

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl t-label flex-1">Admin</h1>
        <span className="t-meta text-[var(--color-muted)]">
          {connectedCount}/3 services connected
        </span>
        {allLocked && <Badge tone="up" pill>All Locked</Badge>}
      </div>

      <p className="t-sub text-[var(--color-text-sub)] mb-4">
        Configure API credentials for external services. Test each connection, then lock to prevent accidental changes.
        Locked credentials are masked and read-only.
      </p>

      <div className="space-y-4">
        <CTraderAdmin locked={locks.ctrader} />
        <TelegramAdmin locked={locks.telegram} />
        <MassiveAdmin locked={locks.massive} />
      </div>
    </section>
  )
}
