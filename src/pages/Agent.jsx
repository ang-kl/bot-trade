// AI Agent — monitoring dashboard showing what the system is watching and when it started.

import { useState, useEffect, useCallback } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import { useStrategy } from '../lib/strategy-store.js'

const MONITOR_KEY = 'bot-trade:agent-monitor'
const SCAN_CACHE_KEY = 'bot-trade:scan-cache'

function readMonitor() {
  try {
    const raw = localStorage.getItem(MONITOR_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function readScanCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

const AGENT_ROLES = {
  scout: { label: 'Scout', desc: 'Scans all symbols — bias, conviction, session fit', icon: '🔍', minions: 0 },
  analyst: { label: 'Analyst', desc: 'Deep-dives hot symbols with 4-6 parallel minions', icon: '🧠', minions: 6 },
  trader: { label: 'Trader', desc: 'Executes orders on cTrader — market, limit, stop', icon: '⚡', minions: 0 },
  monitor: { label: 'Monitor', desc: 'Probes open positions — hold, tighten SL, scale out, exit', icon: '📡', minions: 0 },
  quant: { label: 'Quant', desc: 'Regime detection, risk metrics, performance snapshots', icon: '📊', minions: 0 },
}

const STATE_TONE = { running: 'accent', done: 'up', idle: 'neutral', sleeping: 'warning', error: 'down' }
const STATE_ICON = { running: '\u25CF', done: '\u2713', idle: '\u2014', sleeping: '\u23F8', error: '\u2717' }

const SCAN_CACHE_KEY_AGENT = 'bot-trade:scan-cache'
function readPriceCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY_AGENT)
    if (!raw) return {}
    return JSON.parse(raw).massiveMetrics || {}
  } catch { return {} }
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h === 0) return `${m}m ${s % 60}s`
  return `${h}h ${m % 60}m`
}

function fmtTime(ts) {
  if (!ts) return '\u2014'
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

function fmtAgo(ts) {
  if (!ts) return ''
  const ago = Date.now() - ts
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
  return `${Math.floor(ago / 3_600_000)}h ${Math.floor((ago % 3_600_000) / 60_000)}m ago`
}

function fmtMoney(v, digits = 2) {
  return v != null ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—'
}

async function fetchAccountInfo(accessToken, accountId, isLive) {
  const res = await fetch('/api/ctrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'account-info', accessToken, accountId, isLive }),
  })
  return res.ok ? res.json() : null
}

async function fetchOpenPositions(accessToken, accountId, isLive) {
  const res = await fetch('/api/ctrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'open-positions', accessToken, accountId, isLive }),
  })
  return res.ok ? res.json() : null
}

function AccountPanel({ ctrader }) {
  const [info, setInfo] = useState(null)
  const [positions, setPositions] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const linked = ctrader.accounts.find(a => a.accountId === ctrader.linkedAccountId)
  const isLive = linked?.isLive ?? false

  const refresh = useCallback(async () => {
    if (!ctrader.linkedAccountId || !ctrader.accessToken) return
    setLoading(true)
    setError(null)
    try {
      const [inf, pos] = await Promise.all([
        fetchAccountInfo(ctrader.accessToken, ctrader.linkedAccountId, isLive),
        fetchOpenPositions(ctrader.accessToken, ctrader.linkedAccountId, isLive),
      ])
      setInfo(inf)
      setPositions(pos)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [ctrader.accessToken, ctrader.linkedAccountId, isLive])

  useEffect(() => { refresh() }, [refresh])

  // Auto-refresh every 60s to keep equity + positions current
  useEffect(() => {
    const iv = setInterval(refresh, 60_000)
    return () => clearInterval(iv)
  }, [refresh])

  if (!ctrader.linkedAccountId) {
    return (
      <Card>
        <p className="t-label mb-1">Trading Account</p>
        <p className="t-sub text-[var(--color-muted)]">
          No account linked. Go to Settings → cTrader to connect your Pepperstone account.
        </p>
      </Card>
    )
  }

  const equityPct = info?.balance && info?.equity
    ? ((info.equity - info.balance) / info.balance) * 100
    : null

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <p className="t-label">Trading Account</p>
          <Badge tone={isLive ? 'down' : 'accent'} pill>{isLive ? 'LIVE' : 'DEMO'}</Badge>
          {linked && (
            <span className="text-[10px] text-[var(--color-muted)]">
              #{linked.accountNumber || ctrader.linkedAccountId}
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading} className="!px-1.5 !py-0.5 text-[10px]">
          {loading ? '…' : '↻'}
        </Button>
      </div>

      {error && (
        <p className="text-[10px] text-[var(--color-down)] mb-2">{error}</p>
      )}

      {info && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <div>
            <p className="t-meta text-[var(--color-muted)]">Balance</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">
              {fmtMoney(info.balance)}
            </p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Equity</p>
            <p className={`text-[15px] font-bold ${
              equityPct == null ? 'text-[var(--color-text)]'
              : equityPct > 0 ? 'text-[var(--color-up)]'
              : equityPct < 0 ? 'text-[var(--color-down)]'
              : 'text-[var(--color-text)]'
            }`}>
              {fmtMoney(info.equity)}
              {equityPct != null && (
                <span className="text-[10px] font-normal ml-1">
                  ({equityPct > 0 ? '+' : ''}{equityPct.toFixed(2)}%)
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Leverage</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">
              {info.leverage ? `1:${info.leverage}` : '—'}
            </p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Open Trades</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">
              {positions?.count ?? '—'}
            </p>
          </div>
        </div>
      )}

      {positions?.positions?.length > 0 && (
        <div>
          <p className="t-meta text-[var(--color-muted)] mb-1">Open Positions</p>
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {positions.positions.map((p, i) => (
              <div key={p.positionId || i} className="flex items-center gap-2 px-2 py-1 rounded-[4px] bg-[var(--color-bg)] text-[11px]">
                <span className={`font-bold w-[12px] ${p.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                  {p.side === 'BUY' ? '▲' : '▼'}
                </span>
                <span className="font-bold text-[var(--color-text)]">
                  {p.symbolName || `#${p.symbolId}`}
                </span>
                {p.label && (
                  <span className="text-[9px] text-[var(--color-muted)] italic truncate max-w-[80px]">{p.label}</span>
                )}
                <span className="text-[var(--color-muted)] flex-1">
                  @ {p.openPrice?.toFixed(5) ?? '—'} · {p.volume != null ? (p.volume / 10000).toFixed(2) : '—'} lots
                </span>
                {p.usedMargin != null && (
                  <span className="text-[9px] text-[var(--color-muted)]">
                    margin {fmtMoney(p.usedMargin)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && !info && !error && (
        <p className="t-sub text-[var(--color-muted)]">Loading account data…</p>
      )}
    </Card>
  )
}

export default function Agent() {
  const { state } = useStrategy()
  const [monitor, setMonitor] = useState(readMonitor)
  const [scanCache, setScanCache] = useState(readScanCache)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const iv = setInterval(() => {
      setMonitor(readMonitor())
      setScanCache(readScanCache())
      setNow(Date.now())
    }, 2000)
    return () => clearInterval(iv)
  }, [])

  const enabledSymbols = state.watchlist.filter(w => w.enabled)
  const armed = state.risk.armed
  const sessionStart = monitor?.sessionStart
  const uptime = sessionStart ? now - sessionStart : 0
  const lastScanAt = monitor?.lastScanAt || scanCache?.lastScanAt
  const agentStates = monitor?.agentStates || {}
  const tokenCount = monitor?.tokenCount || 0
  const agentTokens = monitor?.agentTokens || {}
  const agentCalls = monitor?.agentCalls || {}
  const monitoredTrades = monitor?.monitoredTrades || []
  const scans = scanCache?.scanResults || {}

  const hasSession = !!sessionStart
  const isActive = hasSession && (armed || Object.values(agentStates).some(s => s === 'running'))

  return (
    <section className="space-y-3">
      {/* Status overview */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className={`text-[18px] ${isActive ? 'animate-pulse text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}`}>
              {isActive ? '\u25CF' : '\u25CB'}
            </span>
            <h1 className="t-label text-lg">AI Agent Monitor</h1>
          </div>
          <Badge tone={armed ? 'up' : 'neutral'} pill>
            {armed ? 'ARMED' : 'DISARMED'}
          </Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <p className="t-meta text-[var(--color-muted)]">Session Started</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{fmtTime(sessionStart)}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Uptime</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{hasSession ? fmtDuration(uptime) : '\u2014'}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Last Scan</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">
              {lastScanAt ? fmtAgo(lastScanAt) : '\u2014'}
            </p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Tokens Used</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{tokenCount.toLocaleString()}</p>
          </div>
        </div>
      </Card>

      {/* Pepperstone / cTrader account */}
      <AccountPanel ctrader={state.ctrader} />

      {/* Agent states — 5 core agents */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <p className="t-label">Agent Fleet</p>
          <span className="text-[9px] text-[var(--color-muted)]">
            {Object.values(agentStates).filter(s => s === 'running').length} active
          </span>
        </div>
        <div className="space-y-1">
          {Object.entries(AGENT_ROLES).map(([key, role]) => {
            const s = agentStates[key] || 'idle'
            const calls = agentCalls[key] || 0
            const tokens = agentTokens[key] || 0
            return (
              <div key={key} className="flex items-center gap-2 px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)]">
                <span className="text-[14px]">{role.icon}</span>
                <span className={`text-[10px] w-[8px] ${s === 'running' ? 'animate-pulse' : ''} text-[var(--color-${STATE_TONE[s] || 'muted'})]`}>
                  {STATE_ICON[s] || '\u2014'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-bold text-[var(--color-text)]">{role.label}</span>
                    <Badge tone={STATE_TONE[s] || 'neutral'} className="text-[7px] px-1">
                      {s.toUpperCase()}
                    </Badge>
                    {role.minions > 0 && (
                      <span className="text-[8px] text-[var(--color-accent)]">{role.minions} minions</span>
                    )}
                  </div>
                  <span className="text-[9px] text-[var(--color-text-sub)]">{role.desc}</span>
                </div>
                <div className="text-right shrink-0">
                  {calls > 0 && (
                    <div className="text-[9px] text-[var(--color-muted)]">{calls} calls</div>
                  )}
                  {tokens > 0 && (
                    <div className="text-[9px] text-[var(--color-muted)]">{tokens.toLocaleString()} tok</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="mt-2 pt-2 border-t border-[var(--color-border)] flex items-center justify-between">
          <span className="text-[9px] text-[var(--color-muted)]">
            Total: {tokenCount.toLocaleString()} tokens · ${((tokenCount / 1000) * 0.015).toFixed(2)} est.
          </span>
          <span className="text-[9px] text-[var(--color-muted)]">
            Refresh: 15 min cycle
          </span>
        </div>
      </Card>

      {/* Monitoring symbols — with live prices from MASSIVE */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <p className="t-label flex-1">Monitoring {enabledSymbols.length} Symbols</p>
          {lastScanAt && (
            <span className="t-meta text-[var(--color-muted)]">
              scanned {fmtAgo(lastScanAt)}
            </span>
          )}
        </div>
        {enabledSymbols.length === 0 ? (
          <p className="t-sub text-[var(--color-muted)] py-4 text-center">
            No symbols enabled. Go to Watchlist to enable symbols for monitoring.
          </p>
        ) : (
          <div className="space-y-0.5">
            {enabledSymbols.map(w => {
              const scan = scans[w.symbol]
              const prices = readPriceCache()
              const mm = prices[w.symbol] || {}
              const bias = scan?.bias
              const conf = scan?.confidence
              const biasColor = bias === 'long' ? 'var(--color-up)' : bias === 'short' ? 'var(--color-down)' : 'var(--color-muted)'
              const arrow = bias === 'long' ? '\u25B2' : bias === 'short' ? '\u25BC' : ''
              const price = mm.price || scan?.price
              const changePct = mm.change_pct
              const ema = mm.ema_stack?.stack
              return (
                <div
                  key={w.symbol}
                  className="flex items-center gap-2 px-2 py-1 rounded-[4px] bg-[var(--color-bg)] text-[11px]"
                >
                  <span className="font-bold w-[65px] shrink-0" style={{ color: biasColor }}>
                    {arrow} {w.symbol}
                  </span>
                  <span className="font-mono font-semibold text-[var(--color-text)] w-[70px] text-right shrink-0">
                    {price ? fmtMoney(price, price < 10 ? 4 : 2) : '—'}
                  </span>
                  {changePct != null && (
                    <span className={`text-[9px] font-bold w-[45px] shrink-0 ${changePct > 0 ? 'text-[var(--color-up)]' : changePct < 0 ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'}`}>
                      {changePct > 0 ? '+' : ''}{changePct.toFixed(2)}%
                    </span>
                  )}
                  {ema && (
                    <span className={`text-[8px] w-[16px] shrink-0 ${ema.startsWith('Bull') ? 'text-[var(--color-up)]' : ema.startsWith('Bear') ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'}`}>
                      {ema.startsWith('Bull') ? '▲' : ema.startsWith('Bear') ? '▼' : '—'}
                    </span>
                  )}
                  {conf != null && (
                    <span className="text-[9px] font-mono font-bold shrink-0" style={{ color: biasColor }}>
                      {conf}/10
                    </span>
                  )}
                  <span className="text-[8px] text-[var(--color-muted)] truncate flex-1 text-right">
                    {scan?.thesis ? scan.thesis.slice(0, 40) : w.label || ''}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Latest scan results */}
      {Object.keys(scans).length > 0 && (
        <Card>
          <p className="t-label mb-2">Latest Scan Results</p>
          <div className="space-y-1 max-h-[400px] overflow-y-auto">
            {Object.entries(scans)
              .sort((a, b) => (b[1].confidence || 0) - (a[1].confidence || 0))
              .map(([sym, s]) => {
                const bias = s.bias || 'neutral'
                const sideColor = bias === 'long' ? 'text-[var(--color-up)]' : bias === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'
                return (
                  <div key={sym} className="flex items-start gap-2 px-2 py-1.5 rounded-[5px] hover:bg-[var(--color-bg)]">
                    <span className={`text-[12px] font-bold w-[70px] shrink-0 ${sideColor}`}>
                      {bias === 'long' ? '\u25B2' : bias === 'short' ? '\u25BC' : '\u25CF'} {sym}
                    </span>
                    <span className="text-[11px] font-mono font-bold w-[35px] shrink-0" style={{
                      color: (s.confidence || 0) >= 7 ? 'var(--color-up)' : (s.confidence || 0) >= 4 ? 'var(--color-accent)' : 'var(--color-muted)'
                    }}>
                      {s.confidence || 0}/10
                    </span>
                    <span className="text-[11px] text-[var(--color-text-sub)] flex-1 line-clamp-2">
                      {s.thesis || 'No thesis'}
                    </span>
                  </div>
                )
              })}
          </div>
        </Card>
      )}

      {/* Monitored trades — bot-tracked only, NOT synced with cTrader */}
      {monitoredTrades.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <p className="t-label flex-1">Orders History ({monitoredTrades.length})</p>
            <span className="text-[9px] text-[var(--color-muted)] italic">placed via bot — verify in Trading Account</span>
          </div>
          <div className="space-y-1">
            {monitoredTrades.map((t, i) => (
              <div key={t.symbol || i} className="flex items-center gap-2 px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)]">
                <span className={`text-[12px] font-bold ${t.side === 'SELL' ? 'text-[var(--color-down)]' : 'text-[var(--color-up)]'}`}>
                  {t.side === 'SELL' ? '\u25BC' : '\u25B2'} {t.symbol}
                </span>
                <span className="text-[10px] text-[var(--color-muted)] flex-1">
                  Entry {t.entry} | SL {t.sl} | TP {t.tp}
                </span>
                <span className="text-[9px] text-[var(--color-muted)]">
                  {fmtAgo(t.placedAt)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* No session fallback */}
      {!hasSession && Object.keys(scans).length === 0 && (
        <Card>
          <div className="text-center py-8">
            <p className="text-[14px] font-bold text-[var(--color-text)] mb-1">No Active Session</p>
            <p className="t-sub text-[var(--color-muted)]">
              Go to Feed and arm the system to start monitoring. The agent will scan your enabled symbols every 5 minutes.
            </p>
          </div>
        </Card>
      )}
    </section>
  )
}
