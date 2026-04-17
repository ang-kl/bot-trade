// AI Agent — monitoring dashboard showing what the system is watching and when it started.

import { useState, useEffect } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
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
  scout: { label: 'Scout', desc: 'Scans all symbols for bias + conviction' },
  analyst: { label: 'Analyst', desc: 'Deep-dives hot symbols with sub-agents' },
  trader: { label: 'Trader', desc: 'Executes orders on linked trading platform' },
  monitor: { label: 'Monitor', desc: 'Tracks open positions for SL/TP/exit signals' },
  massive: { label: 'Massive', desc: 'Computes real metrics from Polygon.io market data' },
}

const STATE_TONE = { running: 'accent', done: 'up', idle: 'neutral' }
const STATE_ICON = { running: '\u25CF', done: '\u2713', idle: '\u2014' }

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

      {/* Agent states */}
      <Card>
        <p className="t-label mb-2">Agent Status</p>
        <div className="space-y-1.5">
          {Object.entries(AGENT_ROLES).map(([key, role]) => {
            const s = agentStates[key] || 'idle'
            const calls = agentCalls[key] || 0
            const tokens = agentTokens[key] || 0
            return (
              <div key={key} className="flex items-center gap-2 px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)]">
                <span className={`text-[12px] text-[var(--color-${STATE_TONE[s] || 'muted'})]`}>
                  {STATE_ICON[s] || '\u2014'}
                </span>
                <span className="text-[12px] font-bold text-[var(--color-text)] w-[70px]">{role.label}</span>
                <span className="text-[11px] text-[var(--color-text-sub)] flex-1">{role.desc}</span>
                <Badge tone={STATE_TONE[s] || 'neutral'} className="text-[8px] px-1.5">
                  {s.toUpperCase()}
                </Badge>
                {calls > 0 && (
                  <span className="text-[9px] text-[var(--color-muted)] min-w-[50px] text-right">
                    {calls} calls
                  </span>
                )}
                {tokens > 0 && (
                  <span className="text-[9px] text-[var(--color-muted)] min-w-[50px] text-right">
                    {tokens.toLocaleString()} tok
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      {/* Monitoring symbols */}
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
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
            {enabledSymbols.map(w => {
              const scan = scans[w.symbol]
              const bias = scan?.bias
              const conf = scan?.confidence
              const biasColor = bias === 'long' ? 'var(--color-up)' : bias === 'short' ? 'var(--color-down)' : 'var(--color-muted)'
              const arrow = bias === 'long' ? '\u25B2' : bias === 'short' ? '\u25BC' : ''
              return (
                <div
                  key={w.symbol}
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)] border border-[var(--color-border)]"
                >
                  <span className="text-[11px] font-bold" style={{ color: biasColor }}>
                    {arrow} {w.symbol}
                  </span>
                  <span className="text-[9px] text-[var(--color-muted)] truncate flex-1">
                    {w.label || w.category || ''}
                  </span>
                  {conf != null && (
                    <span className="text-[9px] font-mono font-bold" style={{ color: biasColor }}>
                      {conf}/10
                    </span>
                  )}
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

      {/* Monitored trades */}
      {monitoredTrades.length > 0 && (
        <Card>
          <p className="t-label mb-2">Active Trades ({monitoredTrades.length})</p>
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
