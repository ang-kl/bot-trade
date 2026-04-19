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
  // Local drafts so typing doesn't dispatch on every keystroke (which
  // triggers the auto-push to Railway and can race with token refresh).
  const [draftAccess, setDraftAccess] = useState(accessToken)
  const [draftRefresh, setDraftRefresh] = useState(refreshToken)
  // Sync drafts when store changes from outside (OAuth callback, cross-tab)
  useEffect(() => { setDraftAccess(accessToken) }, [accessToken])
  useEffect(() => { setDraftRefresh(refreshToken) }, [refreshToken])

  const applyTokens = () => {
    dispatch({ type: 'CTRADER_SET_TOKENS', accessToken: draftAccess, refreshToken: draftRefresh })
  }

  const testConnection = useCallback(async () => {
    // Commit drafts to store before testing
    dispatch({ type: 'CTRADER_SET_TOKENS', accessToken: draftAccess, refreshToken: draftRefresh })
    if (!draftAccess) return
    setBusy(true); setTestResult(null)
    try {
      const res = await fetch('/api/ctrader', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'accounts', accessToken: draftAccess }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `${res.status}`)
      const list = data.accounts || []
      dispatch({ type: 'CTRADER_SET_ACCOUNTS', accounts: list })
      setTestResult({ ok: true, message: `Connected \u2014 ${list.length} account(s) found` })
      dispatch({ type: 'ADMIN_LOCK', service: 'ctrader' })
    } catch (e) {
      setTestResult({ ok: false, message: e.message })
    } finally {
      setBusy(false)
    }
  }, [draftAccess, draftRefresh, dispatch])

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
              value={draftAccess}
              onChange={(e) => setDraftAccess(e.target.value)}
              onBlur={applyTokens}
              placeholder="Filled by OAuth — or paste manually"
            />
          </div>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-ct-refresh">Refresh token</label>
            <Input
              id="admin-ct-refresh"
              value={draftRefresh}
              onChange={(e) => setDraftRefresh(e.target.value)}
              onBlur={applyTokens}
              placeholder="Filled by OAuth — or paste manually"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onOpenOAuth}>Open cTrader OAuth</Button>
            <Button size="sm" variant="primary" onClick={testConnection} disabled={!draftAccess || busy}>
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
        action: 'send-test',
        botToken,
        chatId,
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

// ── Massive data preview ──

const PREVIEW_SYMBOLS = [
  // Stocks (covered by Stocks plan)
  { ticker: 'AAPL', market: 'stocks', label: 'Apple', plan: 'Stocks' },
  { ticker: 'MSFT', market: 'stocks', label: 'Microsoft', plan: 'Stocks' },
  { ticker: 'NVDA', market: 'stocks', label: 'NVIDIA', plan: 'Stocks' },
  // Forex (requires Currencies plan)
  { ticker: 'C:EURUSD', market: 'forex', label: 'EUR/USD', plan: 'Currencies' },
  { ticker: 'C:USDJPY', market: 'forex', label: 'USD/JPY', plan: 'Currencies' },
  { ticker: 'C:AUDJPY', market: 'forex', label: 'AUD/JPY', plan: 'Currencies' },
  // Crypto (requires Currencies plan)
  { ticker: 'X:BTCUSD', market: 'crypto', label: 'BTC/USD', plan: 'Currencies' },
  { ticker: 'X:ETHUSD', market: 'crypto', label: 'ETH/USD', plan: 'Currencies' },
  // Indices (requires Indices plan)
  { ticker: 'I:SPX', market: 'stocks', label: 'S&P 500', plan: 'Indices' },
  { ticker: 'I:VIX', market: 'stocks', label: 'VIX', plan: 'Indices' },
  { ticker: 'I:NDX', market: 'stocks', label: 'NASDAQ 100', plan: 'Indices' },
  // Commodities / Futures (coverage unclear)
  { ticker: 'C:XAUUSD', market: 'forex', label: 'Gold spot', plan: 'Currencies?' },
  { ticker: 'C:XAGUSD', market: 'forex', label: 'Silver spot', plan: 'Currencies?' },
]

function DataPreview({ apiKey }) {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  const runPreview = useCallback(async () => {
    if (!apiKey) return
    setLoading(true)
    setResults([])
    const out = []
    for (const sym of PREVIEW_SYMBOLS) {
      try {
        // Fetch prev close for quick snapshot
        const res = await apiPost('/api/massive', {
          action: 'prev-close',
          ticker: sym.ticker,
          apiKey,
        })
        out.push({
          ...sym,
          ok: true,
          close: res.close,
          open: res.open,
          high: res.high,
          low: res.low,
          volume: res.volume,
          vwap: res.vwap,
        })
      } catch (e) {
        out.push({ ...sym, ok: false, error: e.message })
      }
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 250))
    }

    // Also test aggs (OHLCV bars) for AAPL
    try {
      const today = new Date().toISOString().slice(0, 10)
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
      const aggs = await apiPost('/api/massive', {
        action: 'aggs',
        ticker: 'AAPL',
        multiplier: 1,
        timespan: 'day',
        from: weekAgo,
        to: today,
        apiKey,
      })
      out.push({
        ticker: 'AAPL (7d bars)',
        label: `OHLCV bars test`,
        ok: true,
        barCount: aggs.count || aggs.bars?.length || 0,
        bars: aggs.bars?.slice(0, 3),
      })
    } catch (e) {
      out.push({ ticker: 'AAPL (7d bars)', label: 'OHLCV bars test', ok: false, error: e.message })
    }

    // Test news
    try {
      const news = await apiPost('/api/massive', {
        action: 'news',
        ticker: 'AAPL',
        limit: 3,
        apiKey,
      })
      out.push({
        ticker: 'News',
        label: 'Ticker news test',
        ok: true,
        articleCount: news.count || news.articles?.length || 0,
        headlines: (news.articles || []).map(a => a.title).slice(0, 3),
      })
    } catch (e) {
      out.push({ ticker: 'News', label: 'Ticker news test', ok: false, error: e.message })
    }

    setResults(out)
    setLoading(false)
  }, [apiKey])

  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="t-label text-[var(--color-text)]">Data Preview</span>
        <Button size="sm" variant="ghost" onClick={runPreview} disabled={loading || !apiKey}>
          {loading ? 'Fetching...' : '\u21BB Fetch Sample Data'}
        </Button>
      </div>
      {loading && (
        <p className="t-meta text-[var(--color-muted)] animate-pulse">Testing data access across asset classes...</p>
      )}
      {results.length > 0 && (
        <div className="space-y-1 mt-2">
          {/* Summary */}
          {(() => {
            const ok = results.filter(r => r.ok && r.close != null)
            const fail = results.filter(r => !r.ok)
            const planNeeded = {}
            for (const r of fail) {
              if (r.plan && r.error?.includes('not entitled')) {
                planNeeded[r.plan] = (planNeeded[r.plan] || 0) + 1
              }
            }
            return (ok.length > 0 || fail.length > 0) && (
              <div className="mb-2 p-2 rounded-[5px] bg-[var(--color-bg)] text-[11px]">
                <span className="text-[var(--color-up)] font-bold">{ok.length} accessible</span>
                {fail.length > 0 && <span className="text-[var(--color-down)] font-bold ml-2">{fail.length} need upgrade</span>}
                {Object.keys(planNeeded).length > 0 && (
                  <span className="text-[var(--color-muted)] ml-2">
                    Plans needed: {Object.entries(planNeeded).map(([p, n]) => `${p} (${n})`).join(', ')}
                  </span>
                )}
              </div>
            )
          })()}
          {results.map((r, i) => {
            const entitled = r.ok && (r.close != null || r.barCount != null || r.articleCount != null)
            const needsPlan = !r.ok && r.error?.includes('not entitled')
            return (
              <div key={i} className={`flex items-start gap-2 py-1.5 px-2 rounded-[5px] text-[11px] ${entitled ? 'bg-[var(--color-bg)]' : needsPlan ? 'bg-[color-mix(in_srgb,var(--color-warning-text)_6%,var(--color-surface))]' : !r.ok ? 'bg-[color-mix(in_srgb,var(--color-down)_8%,var(--color-surface))]' : 'bg-[var(--color-bg)]'}`}>
                <span className={`shrink-0 ${entitled ? 'text-[var(--color-up)]' : needsPlan ? 'text-[var(--color-warning-text)]' : !r.ok ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'}`}>
                  {entitled ? '\u2713' : needsPlan ? '\uD83D\uDD12' : !r.ok ? '\u2717' : '\u25CB'}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="font-bold text-[var(--color-text)]">{r.ticker}</span>
                  <span className="text-[var(--color-muted)] ml-1">{r.label}</span>
                  {r.plan && (
                    <span className={`ml-1 px-1 py-0 rounded-[3px] text-[9px] font-bold ${entitled ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-[var(--color-border)] text-[var(--color-muted)]'}`}>
                      {r.plan}
                    </span>
                  )}
                  {entitled && r.close != null && (
                    <span className="ml-2 font-mono text-[var(--color-text-sub)]">
                      C:{r.close} O:{r.open} H:{r.high} L:{r.low}
                      {r.volume != null && <> V:{Number(r.volume).toLocaleString()}</>}
                      {r.vwap != null && <> VWAP:{r.vwap}</>}
                    </span>
                  )}
                  {r.ok && r.barCount != null && (
                    <span className="ml-2 text-[var(--color-text-sub)]">{r.barCount} bars returned</span>
                  )}
                  {r.ok && r.articleCount != null && (
                    <span className="ml-2 text-[var(--color-text-sub)]">{r.articleCount} articles</span>
                  )}
                  {r.ok && r.headlines && r.headlines.length > 0 && (
                    <div className="mt-0.5 text-[var(--color-muted)] italic">
                      {r.headlines.map((h, j) => <div key={j} className="truncate">{h}</div>)}
                    </div>
                  )}
                  {r.ok && r.bars && r.bars.length > 0 && (
                    <div className="mt-0.5 font-mono text-[var(--color-muted)]">
                      {r.bars.map((b, j) => (
                        <div key={j}>{new Date(b.t).toISOString().slice(0, 10)} O:{b.o} H:{b.h} L:{b.l} C:{b.c} V:{Number(b.v).toLocaleString()}</div>
                      ))}
                    </div>
                  )}
                  {needsPlan && <span className="ml-2 text-[var(--color-warning-text)]">Needs {r.plan} plan</span>}
                  {!r.ok && !needsPlan && <span className="ml-2 text-[var(--color-down)]">{r.error}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Massive section ──

function MassiveAdmin({ locked }) {
  const { state, dispatch } = useStrategy()
  const { apiKey, s3AccessKeyId, s3Endpoint, s3Bucket } = state.massive
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const setMassive = (patch) => dispatch({ type: 'MASSIVE_SET', ...patch })

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
          {s3AccessKeyId && (
            <div className="flex items-center gap-2">
              <span className="t-meta text-[var(--color-muted)] w-28">S3 Access Key</span>
              <span className="t-sub font-mono text-[var(--color-text-sub)]">{maskValue(s3AccessKeyId)}</span>
            </div>
          )}
          {s3Endpoint && (
            <div className="flex items-center gap-2">
              <span className="t-meta text-[var(--color-muted)] w-28">S3 Endpoint</span>
              <span className="t-sub font-mono text-[var(--color-text-sub)]">{s3Endpoint}</span>
            </div>
          )}
          {s3Bucket && (
            <div className="flex items-center gap-2">
              <span className="t-meta text-[var(--color-muted)] w-28">S3 Bucket</span>
              <span className="t-sub font-mono text-[var(--color-text-sub)]">{s3Bucket}</span>
            </div>
          )}
          <p className="t-meta text-[var(--color-muted)]">
            REST API: real-time + recent history. S3: bulk historical data for backtesting.
          </p>
          <DataPreview apiKey={apiKey} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="t-meta text-[var(--color-accent)] font-bold mb-2">REST API (required)</p>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-massive-key">API key</label>
            <Input
              id="admin-massive-key"
              value={apiKey}
              onChange={(e) => setMassive({ apiKey: e.target.value })}
              placeholder="paste your Massive API key..."
            />
          </div>
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

          <div className="border-t border-[var(--color-border)] pt-3 mt-3">
            <p className="t-meta text-[var(--color-accent)] font-bold mb-2">S3 Flat Files (optional \u2014 for backtesting)</p>
            <p className="t-meta text-[var(--color-muted)] mb-2">
              Bulk historical data (OHLCV back to 2003). Used by the Backtest page for long-term analysis.
            </p>
            <div className="space-y-2">
              <div>
                <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-massive-s3key">Access Key ID</label>
                <Input
                  id="admin-massive-s3key"
                  value={s3AccessKeyId}
                  onChange={(e) => setMassive({ s3AccessKeyId: e.target.value })}
                  placeholder="AKIA..."
                />
              </div>
              <div>
                <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-massive-s3ep">S3 Endpoint</label>
                <Input
                  id="admin-massive-s3ep"
                  value={s3Endpoint}
                  onChange={(e) => setMassive({ s3Endpoint: e.target.value })}
                  placeholder="https://files.polygon.io"
                />
              </div>
              <div>
                <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="admin-massive-s3bucket">Bucket</label>
                <Input
                  id="admin-massive-s3bucket"
                  value={s3Bucket}
                  onChange={(e) => setMassive({ s3Bucket: e.target.value })}
                  placeholder="flatfiles"
                />
              </div>
            </div>
          </div>
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
