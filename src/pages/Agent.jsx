// Trade Window — live observation cockpit for the autonomous bot.
// The Railway loop runs Scout → Analyst → Monitor autonomously; this page
// surfaces what it's doing and gives you the kill switches.
// Deep drill-down into minion reports lives on /workshop to keep this lean.

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import { useStrategy } from '../lib/strategy-store.js'
import { agentGet, agentPost, agentConfigured, ROLES } from '../lib/agent-api.js'
import { fmtAgo } from '../lib/time.js'
import { parseLabel } from '../../agent/lib/trade-labels.js'
import { dispatch as dispatchMinions, MINIONS } from '../../agent/lib/minions.js'
import { isTradingNow, msUntilOpen, fmtDuration } from '../lib/trading-hours.js'

// Map parsed label source → badge tone + display label. Unknown / null
// source falls through and the row just shows the raw label string.
const SOURCE_BADGE = {
  autopilot: { tone: 'info',    text: 'AUTOPILOT' },
  copilot:   { tone: 'special', text: 'COPILOT'   },
  manual:    { tone: 'neutral', text: 'MANUAL'    },
}

const SCAN_CACHE_KEY = 'bot-trade:scan-cache'
function readPriceCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY)
    if (!raw) return {}
    return JSON.parse(raw).massiveMetrics || {}
  } catch { return {} }
}

const PIP_SIZE = {
  XAUUSD: 0.01, XAGUSD: 0.001,
  USDJPY: 0.01, EURJPY: 0.01, GBPJPY: 0.01, AUDJPY: 0.01, CADJPY: 0.01, CHFJPY: 0.01, NZDJPY: 0.01,
}
function pipDist(from, to, symbol) {
  if (from == null || to == null) return null
  const size = PIP_SIZE[symbol] ?? (symbol?.match(/^(US|NAS|GER|UK|JPN|FRA|SPA|HK|AUS)/) ? 1 : 0.0001)
  return (to - from) / size
}

function computePnl(position, priceCache) {
  const mm = priceCache[position.symbolName] || {}
  const currentPrice = mm.currentPrice ?? mm.price ?? mm.vwap ?? null
  if (!currentPrice || !position.openPrice || !position.volume) return null
  const volLots = position.volume / 10000
  const direction = position.side === 'BUY' ? 1 : -1
  const sym = position.symbolName || ''
  const contractSize = sym.startsWith('XAU') ? 100
    : sym.startsWith('XAG') ? 5000
    : sym.match(/^(US|NAS|GER|UK|JPN|FRA|SPA|HK|AUS)/) ? 1
    : 100000
  return direction * (currentPrice - position.openPrice) * volLots * contractSize
}

function fmtMoney(v, digits = 2) {
  return v != null && Number.isFinite(v)
    ? Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'
}

// ---------------------------------------------------------------------------
// PanelFrame — S/M/L size toggle + collapse, persisted to localStorage
// ---------------------------------------------------------------------------

const PANEL_PREFS_KEY = 'bot-trade:panel-prefs'
function readPanelPrefs() {
  try { return JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || '{}') } catch { return {} }
}
function writePanelPref(id, prefs) {
  try {
    const all = readPanelPrefs()
    all[id] = { ...all[id], ...prefs }
    localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(all))
  } catch {}
}

function PanelFrame({ id, title, defaultSize = 'L', defaultCollapsed = false, children, badge, onExpand }) {
  const [prefs, setPrefs] = useState(() => {
    const saved = readPanelPrefs()[id]
    return { size: saved?.size || defaultSize, collapsed: saved?.collapsed ?? defaultCollapsed }
  })

  const updatePref = (patch) => {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      writePanelPref(id, next)
      if (patch.collapsed === false && onExpand) onExpand()
      return next
    })
  }

  const sizeClass = prefs.size === 'S' ? 'max-w-[320px]' : prefs.size === 'M' ? 'max-w-[600px]' : ''

  return (
    <div className={sizeClass}>
      <Card className="!p-0 overflow-hidden">
        <button
          type="button"
          onClick={() => updatePref({ collapsed: !prefs.collapsed })}
          className="w-full h-9 px-3 flex items-center gap-2 bg-[var(--color-bg)] border-b border-[var(--color-border)] hover:opacity-80 cursor-pointer select-none"
        >
          <span className="text-[11px] text-[var(--color-muted)] w-3">{prefs.collapsed ? '▸' : '▾'}</span>
          <span className="text-[13px] font-semibold text-[var(--color-text)] flex-1 text-left truncate">{title}</span>
          {badge}
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            {['S','M','L'].map(s => (
              <button key={s} type="button" onClick={() => updatePref({ size: s })}
                className={`w-5 h-5 rounded text-[11px] ${prefs.size === s ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'}`}
              >{s}</button>
            ))}
          </div>
        </button>
        {!prefs.collapsed && <div className="p-3">{children}</div>}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Risk Dashboard — Sharpe, drawdown, PF, daily P&L, risk limits
// ---------------------------------------------------------------------------

function RiskDashboard({ role }) {
  const [metrics, setMetrics] = useState(null)
  const [riskCfg, setRiskCfg] = useState(null)
  const [exposure, setExposure] = useState(null)
  const [riskEvents, setRiskEvents] = useState([])
  const [showEvents, setShowEvents] = useState(false)

  useEffect(() => {
    if (!agentConfigured(role)) return
    const load = () => {
      agentGet('/state/metrics', role).then(r => setMetrics(r)).catch(() => {})
      agentGet('/state/risk-config', role).then(r => setRiskCfg(r)).catch(() => {})
      agentGet('/state/risk-exposure', role).then(r => setExposure(r?.exposure)).catch(() => {})
      agentGet('/state/risk-events?limit=5', role).then(r => setRiskEvents(r?.events || [])).catch(() => {})
    }
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [role])

  if (!metrics && !riskCfg) return null

  const m = metrics || {}
  const cfg = riskCfg?.effective || riskCfg || {}
  const derived = riskCfg?.derived || {}
  const ex = exposure || {}

  const dailyUsedPct = ex.daily_loss_used_pct ?? 0
  const maxPositions = cfg.maxOpenPositions || 5
  const openPositions = ex.total_positions || 0
  const marginCapPct = cfg.maxMarginUsagePct || 0.5

  function barColor(pct) {
    if (pct > 0.9) return 'bg-[var(--color-down)]'
    if (pct > 0.66) return 'bg-[var(--color-warning-text)]'
    return 'bg-[var(--color-accent)]'
  }

  function ProgressBar({ value, max, label }) {
    const pct = max > 0 ? Math.min(value / max, 1) : 0
    return (
      <div>
        <div className="flex items-center justify-between text-[11px] mb-0.5">
          <span className="text-[var(--color-muted)]">{label}</span>
          <span className="font-mono text-[var(--color-text)]">{(pct * 100).toFixed(0)}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
          <div className={`h-full rounded-full ${barColor(pct)}`} style={{ width: `${pct * 100}%` }} />
        </div>
      </div>
    )
  }

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <p className="t-label">Risk Dashboard</p>
        {ex.limit_breached && <Badge tone="down" pill>LIMIT BREACHED</Badge>}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-3">
        <div>
          <p className="t-meta text-[var(--color-muted)]">Sharpe</p>
          <p className="text-[15px] font-bold font-mono text-[var(--color-text)]">{m.sharpe_ratio != null ? m.sharpe_ratio.toFixed(2) : '—'}</p>
        </div>
        <div>
          <p className="t-meta text-[var(--color-muted)]">Max DD</p>
          <p className={`text-[15px] font-bold font-mono ${m.max_drawdown_pct > 5 ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>
            {m.max_drawdown_pct != null ? `${m.max_drawdown_pct.toFixed(1)}%` : '—'}
          </p>
        </div>
        <div>
          <p className="t-meta text-[var(--color-muted)]">Profit Factor</p>
          <p className="text-[15px] font-bold font-mono text-[var(--color-text)]">{m.profit_factor != null ? m.profit_factor.toFixed(2) : '—'}</p>
        </div>
        <div>
          <p className="t-meta text-[var(--color-muted)]">Win Rate</p>
          <p className="text-[15px] font-bold font-mono text-[var(--color-text)]">{m.win_rate != null ? `${(m.win_rate * 100).toFixed(0)}%` : '—'}</p>
        </div>
        <div>
          <p className="t-meta text-[var(--color-muted)]">Daily P&L</p>
          <p className={`text-[15px] font-bold font-mono ${(ex.daily_pnl || 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
            {ex.daily_pnl != null ? `${ex.daily_pnl >= 0 ? '+' : ''}${fmtMoney(ex.daily_pnl)}` : '—'}
          </p>
        </div>
        <div>
          <p className="t-meta text-[var(--color-muted)]">Total P&L</p>
          <p className={`text-[15px] font-bold font-mono ${(m.total_pnl || 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
            {m.total_pnl != null ? `${m.total_pnl >= 0 ? '+' : ''}${fmtMoney(m.total_pnl)}` : '—'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-2">
        <ProgressBar value={dailyUsedPct} max={1} label={`Daily loss (cap ${derived.daily_cap_usd ? '$' + fmtMoney(derived.daily_cap_usd) : (cfg.dailyLossPct * 100) + '%'})`} />
        <ProgressBar value={openPositions} max={maxPositions} label={`Positions (${openPositions}/${maxPositions})`} />
        <ProgressBar value={dailyUsedPct > 0 ? marginCapPct * dailyUsedPct : 0} max={marginCapPct} label={`Margin usage (cap ${(marginCapPct * 100).toFixed(0)}%)`} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px] text-[var(--color-muted)]">
        <div>Avg Win: <span className="font-mono text-[var(--color-text)]">{m.avg_win != null ? fmtMoney(m.avg_win) : '—'}</span></div>
        <div>Avg Loss: <span className="font-mono text-[var(--color-text)]">{m.avg_loss != null ? fmtMoney(m.avg_loss) : '—'}</span></div>
        <div>Avg R:R: <span className="font-mono text-[var(--color-text)]">{m.avg_rr != null ? m.avg_rr.toFixed(2) : '—'}</span></div>
        <div>Trades: <span className="font-mono text-[var(--color-text)]">{m.total_trades ?? '—'}</span></div>
      </div>

      {riskEvents.length > 0 && (
        <>
          <button type="button" onClick={() => setShowEvents(!showEvents)}
            className="mt-2 text-[10px] text-[var(--color-accent)] hover:underline">
            {showEvents ? '▾ Hide' : '▸ Show'} recent risk gate decisions ({riskEvents.length})
          </button>
          {showEvents && (
            <div className="mt-1 space-y-0.5">
              {riskEvents.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px] px-2 py-1 rounded-[4px] bg-[var(--color-bg)]">
                  <Badge tone={e.approved ? 'up' : 'down'} className="text-[10px] px-1">{e.approved ? 'OK' : 'VETO'}</Badge>
                  <span className="font-mono text-[var(--color-text)]">{e.symbol}</span>
                  <span className="text-[var(--color-muted)]">{e.side}</span>
                  <span className="text-[var(--color-muted)] truncate flex-1">{e.veto_reason || '—'}</span>
                  <span className="text-[10px] text-[var(--color-muted)]">{fmtAgo(e.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Market Data Strip — price, VWAP, regime, EMA stack per watchlist symbol
// ---------------------------------------------------------------------------

function MarketDataStrip({ symbols, role }) {
  const [regimes, setRegimes] = useState({})
  const priceCache = readPriceCache()

  useEffect(() => {
    if (!agentConfigured(role)) return
    agentGet('/state/regime', role)
      .then(r => {
        const map = {}
        for (const row of (r?.regimes || [])) map[row.symbol] = row
        setRegimes(map)
      })
      .catch(() => {})
  }, [role])

  if (!symbols || symbols.length === 0) return null

  const REGIME_TONE = { trending: 'accent', volatile: 'warning', ranging: 'neutral', quiet: 'neutral' }

  return (
    <Card>
      <p className="t-label mb-2">Market Data</p>
      <div className="flex flex-wrap gap-1.5">
        {symbols.map(sym => {
          const mm = priceCache[sym] || {}
          const reg = regimes[sym] || {}
          const price = mm.currentPrice ?? mm.price ?? mm.vwap ?? null
          const vwap = mm.vwap_today ?? mm.vwap ?? null
          const vwapDev = price && vwap ? ((price - vwap) / vwap * 100) : null
          const emaStack = mm.ema_stack_label || mm.ema_stack || null

          return (
            <div key={sym} className="px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)] min-w-[120px]">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[11px] font-bold font-mono text-[var(--color-text)]">{sym}</span>
                {reg.regime && (
                  <Badge tone={REGIME_TONE[reg.regime] || 'neutral'} className="text-[10px] px-1">
                    {reg.regime.toUpperCase()}
                  </Badge>
                )}
              </div>
              <div className="text-[12px] font-mono font-semibold text-[var(--color-text)]">
                {price != null ? fmtMoney(price, price > 100 ? 2 : price > 10 ? 4 : 5) : '—'}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-[var(--color-muted)] mt-0.5">
                {vwapDev != null && (
                  <span className={vwapDev > 0 ? 'text-[var(--color-up)]' : vwapDev < 0 ? 'text-[var(--color-down)]' : ''}>
                    VWAP {vwapDev > 0 ? '+' : ''}{vwapDev.toFixed(2)}%
                  </span>
                )}
                {emaStack && (
                  <span>{emaStack.includes('Bull') ? '▲' : emaStack.includes('Bear') ? '▼' : '○'}</span>
                )}
                {reg.atr_pct != null && <span>ATR {reg.atr_pct.toFixed(1)}%</span>}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Attribution Panel — strategy/source/session performance breakdown
// ---------------------------------------------------------------------------

const ATTRIBUTION_TABS = ['strategy', 'source', 'session', 'regime', 'conviction']

function AttributionPanel({ role }) {
  const [tab, setTab] = useState('strategy')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  const [days, setDays] = useState(90)

  useEffect(() => {
    if (!agentConfigured(role)) return
    setLoading(true)
    agentGet(`/state/attribution?groupBy=${tab}&days=${days}`, role)
      .then(r => setData(r))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [role, tab, days])

  const rows = data?.rows || []

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <p className="t-label">Attribution</p>
        <div className="flex items-center gap-0.5 ml-auto">
          {[30, 90, 365].map(d => (
            <button key={d} type="button" onClick={() => setDays(d)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${d === days ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-bold' : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'}`}
            >{d}d</button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-0.5 mb-2 overflow-x-auto scrollbar-none">
        {ATTRIBUTION_TABS.map(t => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`px-2 py-1 rounded-[5px] text-[10px] font-bold uppercase ${
              t === tab
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'
            }`}>{t}</button>
        ))}
      </div>
      {loading && <p className="t-meta text-[var(--color-muted)]">Loading…</p>}
      {!loading && rows.length === 0 && (
        <div className="py-3 text-center">
          <p className="t-meta text-[var(--color-muted)]">No closed trades in {days}-day window.</p>
          <p className="text-[10px] text-[var(--color-muted)] mt-1">Attribution populates after the first round-trip trade. Try widening the window or wait for trades to close.</p>
          {days < 365 && (
            <button type="button" onClick={() => setDays(365)} className="text-[10px] text-[var(--color-accent)] hover:underline mt-1">
              Try 365 days →
            </button>
          )}
        </div>
      )}
      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-[var(--color-muted)] text-left">
                <th className="pb-1 font-medium">{tab}</th>
                <th className="pb-1 font-medium text-right">Trades</th>
                <th className="pb-1 font-medium text-right">Win%</th>
                <th className="pb-1 font-medium text-right">P&L</th>
                <th className="pb-1 font-medium text-right">PF</th>
                <th className="pb-1 font-medium text-right">Avg Win</th>
                <th className="pb-1 font-medium text-right">Avg Loss</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {rows.map((r, i) => (
                <tr key={i} className="text-[var(--color-text)]">
                  <td className="py-1 font-mono font-medium truncate max-w-[100px]">{r.group_key || '—'}</td>
                  <td className="py-1 text-right font-mono">{r.trades}</td>
                  <td className="py-1 text-right font-mono">{r.win_rate != null ? `${(r.win_rate * 100).toFixed(0)}%` : '—'}</td>
                  <td className={`py-1 text-right font-mono font-semibold ${(r.total_pnl || 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                    {r.total_pnl != null ? fmtMoney(r.total_pnl) : '—'}
                  </td>
                  <td className="py-1 text-right font-mono">{r.profit_factor != null ? r.profit_factor.toFixed(2) : '—'}</td>
                  <td className="py-1 text-right font-mono text-[var(--color-up)]">{r.avg_win != null ? fmtMoney(r.avg_win) : '—'}</td>
                  <td className="py-1 text-right font-mono text-[var(--color-down)]">{r.avg_loss != null ? fmtMoney(r.avg_loss) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Equity Curve — simple SVG line chart from performance_snapshots
// ---------------------------------------------------------------------------

function EquityCurve({ role }) {
  const [snapshots, setSnapshots] = useState([])

  useEffect(() => {
    if (!agentConfigured(role)) return
    agentGet('/state/metrics/history?days=90', role)
      .then(r => setSnapshots(r?.snapshots || []))
      .catch(() => {})
  }, [role])

  if (snapshots.length < 2) return null

  const pnls = snapshots.map(s => s.total_pnl || 0)
  const minPnl = Math.min(...pnls)
  const maxPnl = Math.max(...pnls)
  const range = maxPnl - minPnl || 1
  const w = 400
  const h = 120
  const pad = 4

  const points = pnls.map((v, i) => {
    const x = pad + (i / (pnls.length - 1)) * (w - 2 * pad)
    const y = h - pad - ((v - minPnl) / range) * (h - 2 * pad)
    return `${x},${y}`
  }).join(' ')

  const lastPnl = pnls[pnls.length - 1]
  const areaPoints = `${pad},${h - pad} ${points} ${w - pad},${h - pad}`

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <p className="t-label">Equity Curve</p>
        <span className={`text-[15px] font-bold font-mono ${lastPnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
          {lastPnl >= 0 ? '+' : ''}{fmtMoney(lastPnl)}
        </span>
        <span className="text-[10px] text-[var(--color-muted)]">{snapshots.length} snapshots · 90d</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" style={{ maxHeight: '160px' }}>
        <polygon points={areaPoints} fill="var(--color-accent-soft)" opacity="0.5" />
        <polyline points={points} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
        <line x1={pad} y1={h - pad - ((0 - minPnl) / range) * (h - 2 * pad)} x2={w - pad} y2={h - pad - ((0 - minPnl) / range) * (h - 2 * pad)} stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="4" />
      </svg>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Account panel — reads from cTrader directly (serverless /api/ctrader)
// ---------------------------------------------------------------------------

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

function AccountPanel({ ctrader, botPositionsById, onPause, onUnpause }) {
  const [info, setInfo] = useState(null)
  const [positions, setPositions] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [fetched, setFetched] = useState(false)
  const fallbackId = ctrader.linkedAccountId || ctrader.accounts?.[0]?.accountId || null
  const [selectedAccountId, setSelectedAccountId] = useState(fallbackId)
  useEffect(() => {
    if (!selectedAccountId && fallbackId) setSelectedAccountId(fallbackId)
  }, [fallbackId, selectedAccountId])

  const selected = ctrader.accounts?.find(a => a.accountId === selectedAccountId)
  const isLive = selected?.isLive ?? false
  const roles = ctrader.accountRoles || {}
  const selectedRole = roles[String(selectedAccountId)] || {}

  const refresh = useCallback(async () => {
    if (!selectedAccountId || !ctrader.accessToken) return
    setLoading(true); setError(null)
    try {
      const [inf, pos] = await Promise.all([
        fetchAccountInfo(ctrader.accessToken, selectedAccountId, isLive),
        fetchOpenPositions(ctrader.accessToken, selectedAccountId, isLive),
      ])
      setInfo(inf); setPositions(pos); setFetched(true)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [ctrader.accessToken, selectedAccountId, isLive])

  useEffect(() => { if (!fetched) refresh() }, [fetched, refresh])

  if (!selectedAccountId || !ctrader.accounts?.length) {
    return (
      <p className="t-sub text-[var(--color-muted)]">
        No account linked. Go to Settings → cTrader to connect your Pepperstone account.
      </p>
    )
  }

  const equityPct = info?.balance && info?.equity
    ? ((info.equity - info.balance) / info.balance) * 100
    : null

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <p className="t-label">Trading Account</p>
          <Badge tone={isLive ? 'down' : 'accent'} pill>{isLive ? 'LIVE' : 'DEMO'}</Badge>
          {selected && (
            <span className="text-[10px] text-[var(--color-muted)]">
              #{selected.accountNumber || selectedAccountId}
            </span>
          )}
          {selectedRole.autopilot && <Badge tone="info" className="text-[10px] px-1">AUTO</Badge>}
          {selectedRole.copilot && <Badge tone="special" className="text-[10px] px-1">COPILOT</Badge>}
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading} className="!px-1.5 !py-0.5 text-[10px]">
          {loading ? '…' : '↻'}
        </Button>
      </div>

      {ctrader.accounts.length > 1 && (
        <div className="flex items-center gap-1 mb-2 overflow-x-auto scrollbar-none">
          {ctrader.accounts.map(a => {
            const r = roles[String(a.accountId)] || {}
            const active = a.accountId === selectedAccountId
            return (
              <button
                key={a.accountId}
                type="button"
                onClick={() => setSelectedAccountId(a.accountId)}
                className={`px-2 py-1 rounded-[5px] text-[10px] whitespace-nowrap flex items-center gap-1 ${
                  active
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-bold'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]'
                }`}
              >
                <span>#{a.accountNumber || a.accountId}</span>
                <span className="opacity-70">{a.isLive ? 'LIVE' : 'DEMO'}</span>
                {r.autopilot && <span className="text-[10px] text-[var(--color-info)]">A</span>}
                {r.copilot && <span className="text-[10px] text-[var(--color-special)]">C</span>}
              </button>
            )
          })}
        </div>
      )}

      {error && <p className="text-[10px] text-[var(--color-down)] mb-2">{error}</p>}

      {info && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <div>
            <p className="t-meta text-[var(--color-muted)]">Balance</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{fmtMoney(info.balance)}</p>
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
            <p className="text-[15px] font-bold text-[var(--color-text)]">{info.leverage ? `1:${info.leverage}` : '—'}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Open Trades</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{positions?.count ?? '—'}</p>
          </div>
        </div>
      )}

      {positions?.orders?.length > 0 && (() => {
        const oGroups = { autopilot: [], copilot: [], manual: [] }
        for (const o of positions.orders) {
          const parsed = o.label ? parseLabel(o.label) : null
          const src = parsed?.source || 'manual'
          ;(oGroups[src] || oGroups.manual).push(o)
        }
        const ORDER_GROUP_META = {
          autopilot: { label: 'Orders (Auto-Trade)', tone: 'info' },
          copilot:   { label: 'Orders (Copilot)',    tone: 'special' },
          manual:    { label: 'Orders (Manual)',      tone: 'neutral' },
        }
        return (
          <div className="space-y-3 mb-3">
            {['autopilot', 'copilot', 'manual'].map(src => {
              const items = oGroups[src]
              if (!items || items.length === 0) return null
              const meta = ORDER_GROUP_META[src]
              return (
                <div key={src}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <p className="t-meta text-[var(--color-muted)]">{meta.label}</p>
                    <Badge tone={meta.tone} className="text-[10px] px-1">{items.length}</Badge>
                  </div>
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {items.map((o, i) => {
                      const sym = o.symbolName || `#${o.symbolId}`
                      const volLots = o.volume != null ? o.volume / 10000 : null
                      const isGold = (o.symbolName || '').startsWith('XAU')
                      const ozDisplay = isGold && volLots != null ? ` (${(volLots * 100).toFixed(2)} Oz)` : ''
                      const priceDigits = (o.symbolName || '').endsWith('JPY') ? 3 : isGold ? 2 : 5
                      const triggerPrice = o.limitPrice ?? o.stopPrice ?? null
                      const typeLabel = o.orderType?.replace(/^ORDER_TYPE_/, '') || o.orderType || '—'
                      const parsedLabel = o.label ? parseLabel(o.label) : null
                      const sourceBadge = parsedLabel?.source ? SOURCE_BADGE[parsedLabel.source] : null
                      const slPips = pipDist(triggerPrice, o.stopLoss, o.symbolName)
                      const tpPips = pipDist(triggerPrice, o.takeProfit, o.symbolName)
                      return (
                        <div key={o.orderId || i} className="px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)]">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className={`font-bold w-[12px] ${o.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                              {o.side === 'BUY' ? '▲' : '▼'}
                            </span>
                            <span className="font-bold text-[var(--color-text)]">{sym}</span>
                            <Badge tone="neutral" className="text-[10px] px-1">{typeLabel}</Badge>
                            {sourceBadge && (
                              <Badge tone={sourceBadge.tone} className="text-[10px] px-1" title={parsedLabel.raw}>
                                {sourceBadge.text}
                              </Badge>
                            )}
                            <span className="text-[var(--color-muted)]">
                              {volLots != null ? `${volLots.toFixed(2)} lots${ozDisplay}` : '—'}
                            </span>
                            <span className="text-[var(--color-muted)]">
                              @ {triggerPrice != null ? triggerPrice.toFixed(priceDigits) : '—'}
                            </span>
                            <span className="flex-1" />
                            <span className="text-[11px] text-[var(--color-muted)]">
                              {o.utcLastUpdateTimestamp ? fmtAgo(o.utcLastUpdateTimestamp) : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)] mt-0.5 flex-wrap">
                            {o.stopLoss != null && (
                              <span>
                                <span className="text-[var(--color-down)]">SL</span> {o.stopLoss.toFixed(priceDigits)}
                                {slPips != null && <span className="opacity-70"> ({slPips > 0 ? '+' : ''}{slPips.toFixed(1)}p)</span>}
                              </span>
                            )}
                            {o.takeProfit != null && (
                              <span>
                                <span className="text-[var(--color-up)]">TP</span> {o.takeProfit.toFixed(priceDigits)}
                                {tpPips != null && <span className="opacity-70"> ({tpPips > 0 ? '+' : ''}{tpPips.toFixed(1)}p)</span>}
                              </span>
                            )}
                            {o.expirationTimestamp && <span>expires {fmtAgo(o.expirationTimestamp)}</span>}
                            {parsedLabel?.strategy && (
                              <span className="uppercase tracking-wide">
                                {parsedLabel.strategy}
                                {parsedLabel.conviction && <span className="opacity-70"> · {parsedLabel.conviction}</span>}
                                {parsedLabel.session && <span className="opacity-70"> · {parsedLabel.session}</span>}
                              </span>
                            )}
                            {o.label && !sourceBadge && (
                              <span className="italic truncate max-w-[80px]" title={o.label}>{o.label}</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {positions?.positions?.length > 0 && (() => {
        const priceCache = readPriceCache()
        // Group positions by source from label parsing
        const groups = { autopilot: [], copilot: [], manual: [] }
        for (const p of positions.positions) {
          const parsed = p.label ? parseLabel(p.label) : null
          const src = parsed?.source || 'manual'
          ;(groups[src] || groups.manual).push(p)
        }
        const GROUP_META = {
          autopilot: { label: 'Autopilot Positions', tone: 'info', icon: '●' },
          copilot:   { label: 'Copilot Positions',   tone: 'special', icon: '◐' },
          manual:    { label: 'Manual / External',    tone: 'neutral', icon: '○' },
        }
        return (
          <div className="space-y-3">
            {['autopilot', 'copilot', 'manual'].map(src => {
              const items = groups[src]
              if (!items || items.length === 0) return null
              const meta = GROUP_META[src]
              return (
                <div key={src}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[10px]">{meta.icon}</span>
                    <p className="t-meta text-[var(--color-muted)]">{meta.label}</p>
                    <Badge tone={meta.tone} className="text-[10px] px-1">{items.length}</Badge>
                  </div>
                  <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
                    {items.map((p, i) => {
                      const sym = p.symbolName || `#${p.symbolId}`
                      const volLots = p.volume != null ? p.volume / 10000 : null
                      const isGold = (p.symbolName || '').startsWith('XAU')
                      const ozDisplay = isGold && volLots != null ? ` (${(volLots * 100).toFixed(2)} Oz)` : ''
                      const priceDigits = (p.symbolName || '').endsWith('JPY') ? 3 : isGold ? 2 : 5
                      const pnl = computePnl(p, priceCache)
                      const slPips = pipDist(p.openPrice, p.stopLoss, p.symbolName)
                      const tpPips = pipDist(p.openPrice, p.takeProfit, p.symbolName)
                      const fees = (p.swap || 0) + (p.commission || 0)
                      const parsedLabel = p.label ? parseLabel(p.label) : null
                      const sourceBadge = parsedLabel?.source ? SOURCE_BADGE[parsedLabel.source] : null
                      const botPos = botPositionsById[String(p.positionId)]
                      const paused = botPos?.paused === 1
                      const lastCheck = botPos?.last_check_action
                      const lastCheckAt = botPos?.last_check_at
                      return (
                        <div key={p.positionId || i} className="px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)]">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className={`font-bold w-[12px] ${p.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                              {p.side === 'BUY' ? '▲' : '▼'}
                            </span>
                            <span className="font-bold text-[var(--color-text)]">{sym}</span>
                            {sourceBadge && (
                              <Badge tone={sourceBadge.tone} className="text-[10px] px-1" title={parsedLabel.raw}>
                                {sourceBadge.text}
                              </Badge>
                            )}
                            <span className="text-[var(--color-muted)]">
                              {volLots != null ? `${volLots.toFixed(2)} lots${ozDisplay}` : '—'}
                            </span>
                            <span className="text-[var(--color-muted)]">
                              @ {p.openPrice != null ? p.openPrice.toFixed(priceDigits) : '—'}
                            </span>
                            <span className="flex-1" />
                            {pnl != null && (
                              <span className={`font-mono font-semibold ${pnl > 0 ? 'text-[var(--color-up)]' : pnl < 0 ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>
                                {pnl >= 0 ? '+' : ''}{fmtMoney(pnl)}
                                <span className="text-[10px] text-[var(--color-muted)] ml-0.5">est</span>
                              </span>
                            )}
                            {botPos && (paused
                              ? <Button size="sm" variant="ghost" onClick={() => onUnpause(botPos.id)} className="!px-1.5 !py-0.5 text-[10px]">resume</Button>
                              : <Button size="sm" variant="ghost" onClick={() => onPause(botPos.id)} className="!px-1.5 !py-0.5 text-[10px]">pause</Button>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)] mt-0.5 flex-wrap">
                            {p.stopLoss != null && (
                              <span>
                                <span className="text-[var(--color-down)]">SL</span> {p.stopLoss.toFixed(priceDigits)}
                                {slPips != null && <span className="opacity-70"> ({slPips > 0 ? '+' : ''}{slPips.toFixed(1)}p)</span>}
                              </span>
                            )}
                            {p.takeProfit != null && (
                              <span>
                                <span className="text-[var(--color-up)]">TP</span> {p.takeProfit.toFixed(priceDigits)}
                                {tpPips != null && <span className="opacity-70"> ({tpPips > 0 ? '+' : ''}{tpPips.toFixed(1)}p)</span>}
                              </span>
                            )}
                            {p.usedMargin != null && <span>margin {fmtMoney(p.usedMargin)}</span>}
                            {p.openTimestamp && <span>opened {fmtAgo(p.openTimestamp)}</span>}
                            {fees !== 0 && <span>fees {fmtMoney(fees)}</span>}
                            {parsedLabel?.strategy && (
                              <span className="uppercase tracking-wide">
                                {parsedLabel.strategy}
                                {parsedLabel.conviction && <span className="opacity-70"> · {parsedLabel.conviction}</span>}
                                {parsedLabel.session && <span className="opacity-70"> · {parsedLabel.session}</span>}
                              </span>
                            )}
                            {p.label && !sourceBadge && (
                              <span className="italic truncate max-w-[80px]" title={p.label}>{p.label}</span>
                            )}
                          </div>
                          {botPos && (
                            <div className="flex items-center gap-2 text-[11px] mt-0.5">
                              {paused && <Badge tone="warning" className="text-[10px] px-1">PAUSED</Badge>}
                              {lastCheck && (
                                <span className="text-[var(--color-text-sub)]">
                                  <span className="text-[var(--color-muted)]">Monitor:</span> {lastCheck}
                                  {lastCheckAt && <span className="text-[var(--color-muted)]"> · {fmtAgo(lastCheckAt)}</span>}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {!loading && !info && !error && (
        <p className="t-sub text-[var(--color-muted)]">Loading account data…</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Market Status — which watchlist markets are tradeable right now,
// which are closed with next open time, and what the agent is doing
// during closure (crypto continues, rest goes into analysis-only mode).
// ---------------------------------------------------------------------------

const CRYPTO_RE = /^(BTC|ETH|XRP|SOL|LTC|BCH|DOT|ADA|DOGE)USD$/

function MarketStatus({ symbols, activity }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(iv)
  }, [])

  if (!symbols || symbols.length === 0) return null

  const latestAnalysis = {}
  for (const ev of (activity || [])) {
    if (ev.kind === 'analysis' && ev.symbol && !latestAnalysis[ev.symbol]) {
      latestAnalysis[ev.symbol] = ev
    }
  }

  const liveTrading = []
  const analyseOnly = []
  const skipped = []
  const awaiting = []
  for (const sym of symbols) {
    const la = latestAnalysis[sym]
    const bias = la?.v1
    const conv = la?.v2
    const hasAnalysis = la != null && bias != null
    const isSkip = bias === 'skip' || bias === 'neutral' || (conv != null && conv < 4)

    if (!hasAnalysis) {
      awaiting.push({ symbol: sym, msUntil: isTradingNow(sym) ? 0 : msUntilOpen(sym) })
    } else if (isTradingNow(sym)) {
      if (isSkip) skipped.push(sym)
      else liveTrading.push(sym)
    } else {
      if (isSkip) {
        skipped.push(sym)
      } else {
        analyseOnly.push({ symbol: sym, msUntil: msUntilOpen(sym), bias, conv })
      }
    }
  }
  analyseOnly.sort((a, b) => a.msUntil - b.msUntil)

  const nextOpen = analyseOnly[0] || (awaiting.length > 0 ? awaiting[0] : null)
  const cryptoLive = liveTrading.filter(s => CRYPTO_RE.test(s))
  const nonCryptoLive = liveTrading.filter(s => !CRYPTO_RE.test(s))

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <p className="t-label">Market Status</p>
        <Badge tone={liveTrading.length > 0 ? 'up' : 'neutral'} pill>
          {liveTrading.length > 0 ? `${liveTrading.length} LIVE` : 'ALL CLOSED'}
        </Badge>
        {cryptoLive.length > 0 && <Badge tone="special" className="text-[10px] px-1">CRYPTO 24/7</Badge>}
      </div>

      {cryptoLive.length > 0 && (
        <div className="mb-2">
          <p className="t-meta text-[var(--color-muted)] mb-1">
            Analyse + Trade <span className="opacity-60">(crypto — OTC, 24/7)</span>
          </p>
          <div className="flex flex-wrap gap-1">
            {cryptoLive.map(s => (
              <span key={s} className="px-1.5 py-0.5 rounded-[4px] text-[10px] bg-[color-mix(in_srgb,var(--color-up)_15%,transparent)] text-[var(--color-up)] font-mono">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {nonCryptoLive.length > 0 && (
        <div className="mb-2">
          <p className="t-meta text-[var(--color-muted)] mb-1">
            Analyse + Trade <span className="opacity-60">(session open)</span>
          </p>
          <div className="flex flex-wrap gap-1">
            {nonCryptoLive.map(s => (
              <span key={s} className="px-1.5 py-0.5 rounded-[4px] text-[10px] bg-[color-mix(in_srgb,var(--color-up)_15%,transparent)] text-[var(--color-up)] font-mono">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {analyseOnly.length > 0 && (
        <div className="mb-2">
          <p className="t-body text-[var(--color-muted)] mb-1">
            Queued for open ({analyseOnly.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {analyseOnly.map(({ symbol, msUntil, bias, conv }) => (
              <span
                key={symbol}
                className="px-2 py-1 rounded-[4px] text-[11px] bg-[color-mix(in_srgb,var(--color-up)_15%,transparent)] text-[var(--color-up)] font-mono"
                title={`${bias?.toUpperCase() || '?'} ${conv}/10 — opens in ${fmtDuration(msUntil)}`}
              >
                {symbol} <span className="font-semibold">{bias?.toUpperCase() || '?'}</span> <span className="text-[10px]">{conv}/10</span> <span className="opacity-60">{fmtDuration(msUntil)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {awaiting.length > 0 && (
        <div className="mb-2">
          <p className="t-body text-[var(--color-muted)] mb-1">
            Awaiting analysis ({awaiting.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {awaiting.map(({ symbol, msUntil }) => (
              <span key={symbol} className="px-2 py-1 rounded-[4px] text-[11px] bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-mono">
                {symbol} <span className="opacity-60 text-[10px]">{msUntil > 0 ? fmtDuration(msUntil) : 'open'}</span>
              </span>
            ))}
          </div>
          <p className="text-[10px] text-[var(--color-muted)] mt-1">
            These symbols have not been analyzed yet. The agent will scan and assign a bias on the next loop cycle.
          </p>
        </div>
      )}

      {skipped.length > 0 && (
        <div className="mb-2">
          <p className="t-body text-[var(--color-muted)] mb-1">
            Standing aside ({skipped.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {skipped.map(sym => {
              const la = latestAnalysis[sym]
              return (
                <span key={sym} className="px-2 py-1 rounded-[4px] text-[11px] bg-[var(--color-bg)] text-[var(--color-muted)] font-mono">
                  {sym} <span className="opacity-60">{la ? `${la.v2 || 0}/10` : '—'}</span>
                </span>
              )
            })}
          </div>
        </div>
      )}

      {nextOpen && (
        <p className="text-[11px] text-[var(--color-muted)] mt-1">
          Next market open: <span className="text-[var(--color-text)] font-mono">{nextOpen.symbol}</span> in {fmtDuration(nextOpen.msUntil)}
          {cryptoLive.length > 0 && ' — crypto continues uninterrupted'}
        </p>
      )}
      {liveTrading.length === 0 && analyseOnly.length === 0 && awaiting.length === 0 && (
        <p className="text-[11px] text-[var(--color-muted)] mt-1">
          All watchlist markets standing aside. Agent continues scanning — conviction must reach 4/10+ to queue for open.
        </p>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Team Roster Desk — per-symbol agent roster with status + timing
// ---------------------------------------------------------------------------

const ROLE_COLORS = {
  trader:    'text-[var(--color-up)]',
  journalist:'text-[var(--color-info)]',
  researcher:'text-[var(--color-accent)]',
  economist: 'text-[var(--color-warning)]',
  political: 'text-[var(--color-down)]',
}

function agentStatus(minionId, symbol, activity) {
  const analysisEvent = activity.find(r => r.kind === 'analysis' && r.symbol === symbol)
  const scanEvent = activity.find(r => r.kind === 'scan' && r.symbol === symbol)
  const latestEvent = analysisEvent || scanEvent
  if (!latestEvent) return { status: 'idle' }

  const ageMs = Date.now() - new Date(latestEvent.at).getTime()
  const ageMins = Math.round(ageMs / 60000)
  const m = MINIONS[minionId]

  if (ageMins < 3) return { status: 'active', since: ageMins, label: `${ageMins}m ago` }
  if (m?.role === 'trader' || m?.role === 'researcher') {
    return { status: 'waiting', label: 'next cycle' }
  }
  return { status: 'done', label: `${ageMins}m ago` }
}

function TeamRoster({ activity }) {
  const hotSymbols = []
  const seen = new Set()
  for (const row of activity) {
    if (row.kind === 'scan' && row.extra === 'potential' && !seen.has(row.symbol)) {
      seen.add(row.symbol)
      hotSymbols.push(row.symbol)
    }
    if (hotSymbols.length >= 6) break
  }
  for (const row of activity) {
    if (row.kind === 'analysis' && !seen.has(row.symbol)) {
      seen.add(row.symbol)
      hotSymbols.push(row.symbol)
    }
    if (hotSymbols.length >= 6) break
  }

  if (hotSymbols.length === 0) return null

  return (
    <Card>
      <p className="t-label mb-2">Team Roster Desk</p>
      <div className="space-y-2">
        {hotSymbols.map(symbol => {
          const minionIds = dispatchMinions(symbol)
          return (
            <div key={symbol} className="rounded-[5px] bg-[var(--color-bg)] overflow-hidden">
              <div className="px-2 py-1 flex items-center gap-2 border-b border-[var(--color-border)]">
                <span className="text-[12px] font-bold font-mono text-[var(--color-text)]">{symbol}</span>
                <span className="text-[10px] text-[var(--color-muted)]">{minionIds.length} agents</span>
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {minionIds.map(id => {
                  const m = MINIONS[id]
                  if (!m) return null
                  const st = agentStatus(id, symbol, activity)
                  return (
                    <div key={id} className="px-2 py-1 flex items-center gap-2 text-[11px]">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                        st.status === 'active' ? 'bg-[var(--color-up)]'
                        : st.status === 'waiting' ? 'bg-[var(--color-warning-text)]'
                        : st.status === 'done' ? 'bg-[var(--color-muted)]'
                        : 'bg-[var(--color-border)]'
                      }`} />
                      <span className="text-[13px] leading-none">{m.icon}</span>
                      <span className={`font-medium w-28 truncate ${ROLE_COLORS[m.role] || ''}`}>{m.name}</span>
                      <span className="text-[10px] text-[var(--color-muted)] uppercase w-16">{m.role}</span>
                      <span className="ml-auto text-[10px] font-mono text-[var(--color-muted)]">
                        {st.label || st.status}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[10px] text-[var(--color-muted)] mt-2">
        4-6 specialists dispatched per symbol. Hover for focus area.
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Scan Feed — dedicated panel showing scan + analysis results with desk info
// ---------------------------------------------------------------------------

function ScanFeed({ activity }) {
  const scans = activity.filter(r => r.kind === 'scan' || r.kind === 'analysis')
  if (scans.length === 0) return null

  return (
    <Card>
      <p className="t-label mb-2">Scan Feed</p>
      <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
        {scans.map((row, i) => {
          const minionIds = dispatchMinions(row.symbol)
          const deskNames = minionIds.slice(0, 3).map(id => MINIONS[id]?.name).filter(Boolean).join(', ')
          const gradeColor = row.extra === 'potential' ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--color-bg)] text-[var(--color-muted)] border border-[var(--color-border)]'
          const biasColor = (row.v1 === 'long') ? 'text-[var(--color-up)]'
            : (row.v1 === 'short') ? 'text-[var(--color-down)]'
            : 'text-[var(--color-muted)]'
          return (
            <div key={`${row.kind}-${row.id}-${i}`} className="rounded-[5px] bg-[var(--color-bg)] p-2 space-y-1">
              <div className="flex items-center gap-2 text-[11px]">
                {row.kind === 'scan' && (
                  <span className={`w-5 h-5 grid place-items-center rounded text-[10px] font-bold ${gradeColor}`}>
                    {row.extra === 'potential' ? 'A' : row.extra === 'weak' ? 'B' : 'C'}
                  </span>
                )}
                {row.kind === 'analysis' && (
                  <Badge tone="accent" className="text-[10px] px-1">DEEP</Badge>
                )}
                <span className="font-mono font-bold text-[var(--color-text)]">{row.symbol}</span>
                {row.v1 && <span className={`font-semibold ${biasColor}`}>{String(row.v1).toUpperCase()}</span>}
                {row.v2 != null && <span className="text-[10px] text-[var(--color-muted)] font-mono">{row.v2}/10</span>}
                {row.extra === 'potential' && row.kind === 'scan' && <Badge tone="up" className="text-[10px] px-1">TRADEABLE</Badge>}
                <span className="ml-auto text-[10px] text-[var(--color-muted)]">{fmtAgo(row.at)}</span>
              </div>
              {row.note && <p className="text-[10px] text-[var(--color-muted)] truncate">{row.note}</p>}
              <p className="text-[10px] text-[var(--color-muted)]">Desk: {deskNames}</p>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Monitor Agent — shows what the position manager + LLM monitor are doing
// ---------------------------------------------------------------------------

const CHECK_ACTION_TONE = {
  HOLD: 'neutral', 'PM:HOLD': 'neutral',
  EXIT: 'down', 'PM:FULL_EXIT': 'down', FULL_EXIT: 'down',
  TIGHTEN_SL: 'warning', 'PM:MOVE_SL': 'warning', MOVE_SL: 'warning',
  SCALE_OUT: 'info', 'PM:PARTIAL_EXIT': 'info', PARTIAL_EXIT: 'info',
  ADD: 'up',
}

function MonitorAgent({ role }) {
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!agentConfigured(role)) return
    const load = () => {
      agentGet('/state/positions', role)
        .then(r => setPositions(r?.positions || []))
        .catch(() => {})
        .finally(() => setLoading(false))
    }
    load()
    const iv = setInterval(load, 15_000)
    return () => clearInterval(iv)
  }, [role])

  if (loading && positions.length === 0) return null

  const now = Date.now()

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <p className="t-label">Monitor Agent</p>
        <Badge tone={positions.length > 0 ? 'info' : 'neutral'} pill>
          {positions.length} position{positions.length !== 1 ? 's' : ''}
        </Badge>
        <span className="text-[10px] text-[var(--color-muted)]">checks every 5 min</span>
      </div>

      {positions.length === 0 ? (
        <p className="t-sub text-[var(--color-muted)] py-2 text-center">
          No open positions to monitor. The monitor activates when trades are placed.
        </p>
      ) : (
        <div className="space-y-1.5">
          {positions.map(pos => {
            const action = pos.last_check_action || 'HOLD'
            const actionLabel = action.replace('PM:', '')
            const tone = CHECK_ACTION_TONE[action] || 'neutral'
            const lastCheckMs = pos.last_check_at ? now - new Date(pos.last_check_at).getTime() : null
            const stale = lastCheckMs && lastCheckMs > 10 * 60 * 1000
            const mfeR = pos.mfe_r != null ? pos.mfe_r.toFixed(2) : null
            const maeR = pos.mae_r != null ? pos.mae_r.toFixed(2) : null
            const minutesOpen = pos.created_at
              ? Math.round((now - new Date(pos.created_at).getTime()) / 60_000)
              : null

            return (
              <div key={pos.id} className="px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)]">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[11px] font-bold font-mono text-[var(--color-text)]">{pos.symbol}</span>
                  <Badge tone={pos.side === 'BUY' ? 'up' : 'down'} className="text-[10px] px-1">{pos.side}</Badge>
                  <Badge tone={tone} className="text-[10px] px-1">{actionLabel}</Badge>
                  {pos.thesis_status && pos.thesis_status !== 'intact' && (
                    <Badge tone={pos.thesis_status === 'broken' ? 'down' : 'warning'} className="text-[10px] px-1">
                      {pos.thesis_status.toUpperCase()}
                    </Badge>
                  )}
                  {stale && <Badge tone="warning" className="text-[10px] px-1">STALE</Badge>}
                  <span className="flex-1" />
                  {pos.last_check_at && (
                    <span className="text-[10px] text-[var(--color-muted)]">{fmtAgo(pos.last_check_at)}</span>
                  )}
                </div>

                <div className="flex items-center gap-3 text-[11px]">
                  <span className="text-[var(--color-muted)]">
                    Entry <span className="font-mono text-[var(--color-text)]">{pos.entry_price || '—'}</span>
                  </span>
                  <span className="text-[var(--color-muted)]">
                    SL <span className="font-mono text-[var(--color-text)]">{pos.current_sl || '—'}</span>
                  </span>
                  <span className="text-[var(--color-muted)]">
                    TP <span className="font-mono text-[var(--color-text)]">{pos.current_tp || '—'}</span>
                  </span>
                  {minutesOpen != null && (
                    <span className="text-[var(--color-muted)]">
                      {minutesOpen < 60 ? `${minutesOpen}m` : `${(minutesOpen / 60).toFixed(1)}h`} open
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 text-[11px] mt-0.5">
                  {mfeR != null && (
                    <span className="text-[var(--color-muted)]">
                      MFE <span className="font-mono text-[var(--color-up)]">+{mfeR}R</span>
                    </span>
                  )}
                  {maeR != null && (
                    <span className="text-[var(--color-muted)]">
                      MAE <span className="font-mono text-[var(--color-down)]">-{maeR}R</span>
                    </span>
                  )}
                  {pos.be_moved ? <span className="text-[10px] text-[var(--color-accent)]">BE ✓</span> : null}
                  {pos.scaled_out ? <span className="text-[10px] text-[var(--color-accent)]">SCALED ✓</span> : null}
                </div>

                {pos.last_check_reasoning && (
                  <p className="text-[10px] text-[var(--color-text-sub)] mt-1 truncate">
                    {pos.last_check_reasoning}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Planned Orders — analysis board with pre-flight checklist + staleness
// These are ANALYSES (not real orders). Real orders live at cTrader.
// The agent auto-executes when conditions pass; this card shows governance.
// ---------------------------------------------------------------------------

function preFlightChecks(latest, currentPrice, marketOpen) {
  const checks = []
  const bias = latest.consensus_bias
  const conv = latest.overall_conviction || 0
  const entry = latest.entry_price
  const sl = latest.sl_price
  const tp = latest.tp1_price

  checks.push({ label: 'Bias', ok: bias === 'long' || bias === 'short', detail: bias?.toUpperCase() || 'NONE' })
  checks.push({ label: 'Conviction ≥ 8', ok: conv >= 8, detail: `${conv}/10` })
  checks.push({ label: 'Entry price', ok: !!entry, detail: entry ? fmtMoney(entry, entry > 100 ? 2 : 5) : 'missing' })
  checks.push({ label: 'SL set', ok: !!sl, detail: sl ? fmtMoney(sl, sl > 100 ? 2 : 5) : 'missing' })
  checks.push({ label: 'TP set', ok: !!tp, detail: tp ? fmtMoney(tp, tp > 100 ? 2 : 5) : 'missing' })
  checks.push({ label: 'Market open', ok: marketOpen, detail: marketOpen ? 'YES' : 'CLOSED' })

  if (currentPrice && entry && sl) {
    const entryDist = Math.abs(currentPrice - entry)
    const slDist = Math.abs(entry - sl)
    const driftPct = slDist > 0 ? (entryDist / slDist) * 100 : 0
    const stale = driftPct > 50
    checks.push({ label: 'Price drift < 50% of SL', ok: !stale, detail: `${driftPct.toFixed(0)}%`, warn: stale })
  }

  return checks
}

function PlannedOrders({ activity, role }) {
  const [fullAnalyses, setFullAnalyses] = useState([])
  const [actionBusy, setActionBusy] = useState({})

  const loadAnalyses = useCallback(() => {
    if (!agentConfigured(role)) return
    agentGet('/state/analyses/latest', role)
      .then(r => setFullAnalyses(r?.analyses || []))
      .catch(() => {})
  }, [role])

  useEffect(() => {
    loadAnalyses()
    const iv = setInterval(loadAnalyses, 30_000)
    return () => clearInterval(iv)
  }, [loadAnalyses])

  const dismissAnalysis = async (analysisId) => {
    setActionBusy(prev => ({ ...prev, [analysisId]: true }))
    try {
      await agentPost('/actions/dismiss-analysis', { analysisId }, role)
      loadAnalyses()
    } catch (e) { console.error(e) }
    setActionBusy(prev => ({ ...prev, [analysisId]: false }))
  }

  const priceCache = readPriceCache()

  const bySymbol = {}
  for (const a of fullAnalyses) {
    if (!bySymbol[a.symbol]) bySymbol[a.symbol] = []
    bySymbol[a.symbol].push(a)
  }
  const symbols = Object.entries(bySymbol).map(([symbol, rows]) => ({
    symbol,
    rows: rows.slice(0, 15),
    latest: rows[0],
  }))

  if (symbols.length === 0) return null

  const roleLabel = role === 'copilot' ? 'Copilot' : 'Autopilot'
  const activeCount = symbols.filter(s => s.latest.consensus_bias !== 'skip' && s.latest.consensus_bias !== 'neutral').length
  const totalToday = fullAnalyses.length
  const staleCount = symbols.filter(({ symbol, latest }) => {
    const mm = priceCache[symbol] || {}
    const cp = mm.currentPrice ?? mm.price ?? null
    if (!cp || !latest.entry_price || !latest.sl_price) return false
    const drift = Math.abs(cp - latest.entry_price) / Math.abs(latest.entry_price - latest.sl_price)
    return drift > 0.5
  }).length

  return (
    <PanelFrame id={`planned-orders-${role}`} title={`${roleLabel} Planned Orders (Analysis Only — NOT real orders)`} defaultSize="L" badge={
      <span className="flex items-center gap-1.5">
        <Badge tone={role === 'copilot' ? 'special' : 'accent'} className="text-[10px] px-1">{activeCount} active</Badge>
        <Badge tone="neutral" className="text-[10px] px-1">{totalToday} today</Badge>
        {staleCount > 0 && <Badge tone="warning" className="text-[10px] px-1">{staleCount} stale</Badge>}
      </span>
    }>
      <div className="flex items-center gap-3 text-[11px] text-[var(--color-muted)] mb-2 px-1">
        <span>{symbols.length} symbols analyzed</span>
        <span>·</span>
        <span>{totalToday} analyses in 24h</span>
        <span>·</span>
        <span>Max 3 per scan cycle (5 min)</span>
        <span>·</span>
        <span>Auto-executes when all checks pass + autotrade ON</span>
      </div>

      {symbols.map(({ symbol, rows, latest }) => {
        const minionIds = dispatchMinions(symbol)
        const deskNames = minionIds.slice(0, 3).map(id => MINIONS[id]?.name).filter(Boolean).join(', ')
        const marketOpen = isTradingNow(symbol)
        const ms = !marketOpen ? msUntilOpen(symbol) : 0
        const isActive = latest.consensus_bias !== 'skip' && latest.consensus_bias !== 'neutral'
        const mm = priceCache[symbol] || {}
        const currentPrice = mm.currentPrice ?? mm.price ?? mm.vwap ?? null
        const checks = preFlightChecks(latest, currentPrice, marketOpen)
        const allPass = checks.every(c => c.ok)
        const ttlStyle = latest.time_cap_minutes
          ? latest.time_cap_minutes <= 30 ? 'Scalper' : latest.time_cap_minutes <= 480 ? 'Swing' : 'Short-Term'
          : '—'

        const ageMs = latest.analyzed_at ? Date.now() - new Date(latest.analyzed_at).getTime() : 0
        const ageHours = ageMs / 3_600_000
        const isOld = ageHours > 4

        return (
          <div key={symbol} className="mb-3 last:mb-0 rounded-[5px] bg-[var(--color-bg)] overflow-hidden">
            <div className="px-2 py-1.5 flex items-center gap-2 border-b border-[var(--color-border)]">
              <span className="font-mono font-bold text-[13px] text-[var(--color-text)]">{symbol}</span>
              <Badge tone={isActive ? (latest.consensus_bias === 'long' ? 'up' : 'down') : 'neutral'} className="text-[10px] px-1">
                {String(latest.consensus_bias || '—').toUpperCase()}
              </Badge>
              <span className="font-mono text-[11px] text-[var(--color-text)]">{latest.overall_conviction}/10</span>
              <Badge tone="neutral" className="text-[10px] px-1">{ttlStyle}</Badge>
              {latest.auto_trade ? <Badge tone="up" className="text-[10px] px-1">AUTO-READY</Badge> : null}
              {!marketOpen && ms > 0 && <Badge tone="warning" className="text-[10px] px-1">opens {fmtDuration(ms)}</Badge>}
              {marketOpen && isActive && allPass && <Badge tone="up" className="text-[10px] px-1">READY</Badge>}
              {isOld && <Badge tone="warning" className="text-[10px] px-1">STALE ({ageHours.toFixed(0)}h)</Badge>}
              <span className="ml-auto flex items-center gap-1.5">
                <span className="text-[11px] text-[var(--color-muted)]">{rows.length} rev{rows.length !== 1 ? 's' : ''}</span>
                <button type="button" disabled={actionBusy[latest.id]}
                  onClick={() => dismissAnalysis(latest.id)}
                  className="px-1.5 py-0.5 rounded text-[10px] text-[var(--color-muted)] hover:text-[var(--color-down)] border border-[var(--color-border)] hover:border-[var(--color-down)]"
                  title="Dismiss this analysis"
                >✕</button>
              </span>
            </div>

            {isActive && (
              <div className="px-2 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
                <p className="text-[10px] font-semibold text-[var(--color-muted)] mb-1">Pre-Flight Checklist</p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {checks.map((c, i) => (
                    <span key={i} className={`text-[11px] flex items-center gap-1 ${c.ok ? 'text-[var(--color-text)]' : c.warn ? 'text-[var(--color-warning-text)]' : 'text-[var(--color-down)]'}`}>
                      <span className="text-[10px]">{c.ok ? '✓' : '✗'}</span>
                      <span className={c.ok ? '' : 'font-semibold'}>{c.label}</span>
                      <span className="font-mono opacity-70">{c.detail}</span>
                    </span>
                  ))}
                </div>
                {allPass && <p className="text-[10px] text-[var(--color-up)] mt-1 font-semibold">All checks pass — agent will auto-execute when autotrade is ON</p>}
                {!allPass && <p className="text-[10px] text-[var(--color-muted)] mt-1">Waiting for failing checks to clear before auto-execution</p>}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-[var(--color-muted)] text-left bg-[var(--color-surface)]">
                    <th className="px-2 py-1 font-medium w-6">#</th>
                    <th className="px-2 py-1 font-medium">Time</th>
                    <th className="px-2 py-1 font-medium">Status</th>
                    <th className="px-2 py-1 font-medium">Bias</th>
                    <th className="px-2 py-1 font-medium text-right">Conv</th>
                    <th className="px-2 py-1 font-medium text-right">Entry</th>
                    <th className="px-2 py-1 font-medium text-right">Current</th>
                    <th className="px-2 py-1 font-medium text-right">SL</th>
                    <th className="px-2 py-1 font-medium text-right">TP</th>
                    <th className="px-2 py-1 font-medium">Style</th>
                    <th className="px-2 py-1 font-medium">Strategy</th>
                    <th className="px-2 py-1 font-medium">Desk</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {rows.map((a, i) => {
                    const serial = rows.length - i
                    const prevBias = rows[i + 1]?.consensus_bias
                    const biasChanged = prevBias && prevBias !== a.consensus_bias
                    const status = i === rows.length - 1 ? '1st' : biasChanged ? `Rev #${serial} (was ${prevBias})` : `#${serial}`
                    const priceFmt = (p) => p ? fmtMoney(p, p > 100 ? 2 : 5) : '—'
                    const slPips = pipDist(a.entry_price, a.sl_price, symbol)
                    const tpPips = pipDist(a.entry_price, a.tp1_price, symbol)
                    const rowTtl = a.time_cap_minutes
                      ? a.time_cap_minutes <= 30 ? '⚡ Scalp' : a.time_cap_minutes <= 480 ? '🔄 Swing' : '📅 Short'
                      : '—'

                    return (
                      <tr key={a.id} className={i === 0 ? 'bg-[var(--color-surface)]' : ''}>
                        <td className="px-2 py-1 font-mono text-[var(--color-muted)]">{serial}</td>
                        <td className="px-2 py-1 text-[var(--color-muted)] whitespace-nowrap">{fmtAgo(a.analyzed_at)}</td>
                        <td className="px-2 py-1">
                          {biasChanged ? (
                            <span className="text-[var(--color-warning-text)] font-semibold">{status}</span>
                          ) : (
                            <span className="text-[var(--color-muted)]">{status}</span>
                          )}
                        </td>
                        <td className={`px-2 py-1 font-semibold ${a.consensus_bias === 'long' ? 'text-[var(--color-up)]' : a.consensus_bias === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'}`}>
                          {String(a.consensus_bias || '—').toUpperCase()}
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-[var(--color-text)]">{a.overall_conviction}/10</td>
                        <td className="px-2 py-1 text-right font-mono text-[var(--color-text)]">{priceFmt(a.entry_price)}</td>
                        <td className="px-2 py-1 text-right font-mono text-[var(--color-text)]">{priceFmt(currentPrice)}</td>
                        <td className="px-2 py-1 text-right font-mono text-[var(--color-down)]">
                          {priceFmt(a.sl_price)}
                          {slPips != null && <span className="opacity-60 ml-0.5">({Math.abs(slPips).toFixed(0)}p)</span>}
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-[var(--color-up)]">
                          {priceFmt(a.tp1_price)}
                          {tpPips != null && <span className="opacity-60 ml-0.5">({Math.abs(tpPips).toFixed(0)}p)</span>}
                        </td>
                        <td className="px-2 py-1 text-[var(--color-text)]">{rowTtl}</td>
                        <td className="px-2 py-1 text-[var(--color-text)] truncate max-w-[100px]" title={a.strategy || ''}>{a.strategy || '—'}</td>
                        <td className="px-2 py-1 text-[var(--color-muted)] truncate max-w-[100px]">{deskNames}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </PanelFrame>
  )
}

// ---------------------------------------------------------------------------
// Failed Trades — risk gate vetoes for system improvement
// ---------------------------------------------------------------------------

function FailedTrades({ role }) {
  const [events, setEvents] = useState([])

  useEffect(() => {
    if (!agentConfigured(role)) return
    agentGet('/state/risk-events?limit=20', role)
      .then(r => setEvents((r?.events || []).filter(e => !e.approved)))
      .catch(() => {})
  }, [role])

  if (events.length === 0) return null

  return (
    <PanelFrame id="failed-trades" title="Failed to Trade" defaultSize="M" badge={
      <Badge tone="down" className="text-[10px] px-1">{events.length}</Badge>
    }>
      <p className="text-[10px] text-[var(--color-muted)] mb-2">Risk gate vetoes — review to improve strategy and sizing rules.</p>
      <div className="space-y-1 max-h-[300px] overflow-y-auto">
        {events.map((e, i) => {
          let checks = null
          try { checks = JSON.parse(e.checks_json) } catch {}
          return (
            <div key={i} className="rounded-[4px] bg-[var(--color-bg)] px-2 py-1.5 space-y-0.5">
              <div className="flex items-center gap-2 text-[11px]">
                <Badge tone="down" className="text-[10px] px-1">VETO</Badge>
                <span className="font-mono font-bold text-[var(--color-text)]">{e.symbol}</span>
                <span className="text-[var(--color-muted)]">{e.side}</span>
                <span className="ml-auto text-[10px] text-[var(--color-muted)]">{fmtAgo(e.created_at)}</span>
              </div>
              <p className="text-[10px] text-[var(--color-down)]">{e.veto_reason}</p>
              {checks && (
                <div className="text-[10px] text-[var(--color-muted)] flex flex-wrap gap-2">
                  {checks.daily_pnl != null && <span>Daily P&L: ${fmtMoney(checks.daily_pnl)}</span>}
                  {checks.open_positions != null && <span>Open pos: {checks.open_positions}</span>}
                  {checks.rr != null && <span>R:R: {checks.rr.toFixed(2)}</span>}
                  {checks.sl_pct != null && <span>SL dist: {checks.sl_pct}%</span>}
                  {checks.risk_based_volume != null && <span>Sized vol: {checks.risk_based_volume}</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </PanelFrame>
  )
}

// ---------------------------------------------------------------------------
// Trade Results — wins/losses by source + 30d attribution
// ---------------------------------------------------------------------------

function TradeResults({ role }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!agentConfigured(role)) return
    agentGet('/state/attribution?groupBy=source&days=30', role)
      .then(r => setData(r))
      .catch(() => {})
  }, [role])

  const rows = data?.rows || []
  if (rows.length === 0) return null

  const totalPnl = rows.reduce((s, r) => s + (r.total_pnl || 0), 0)
  const totalTrades = rows.reduce((s, r) => s + (r.trades || 0), 0)
  const totalWins = rows.reduce((s, r) => s + (r.wins || 0), 0)

  return (
    <PanelFrame id="trade-results" title="Trade Results (30d)" defaultSize="M" badge={
      <span className={`text-[10px] font-mono font-bold ${totalPnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
        {totalPnl >= 0 ? '+' : ''}{fmtMoney(totalPnl)}
      </span>
    }>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <p className="t-meta text-[var(--color-muted)]">Total Trades</p>
          <p className="text-[15px] font-bold font-mono text-[var(--color-text)]">{totalTrades}</p>
        </div>
        <div>
          <p className="t-meta text-[var(--color-muted)]">Wins</p>
          <p className="text-[15px] font-bold font-mono text-[var(--color-up)]">{totalWins}</p>
        </div>
        <div>
          <p className="t-meta text-[var(--color-muted)]">Losses</p>
          <p className="text-[15px] font-bold font-mono text-[var(--color-down)]">{totalTrades - totalWins}</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-[var(--color-muted)] text-left">
              <th className="pb-1 font-medium">Source</th>
              <th className="pb-1 font-medium text-right">Trades</th>
              <th className="pb-1 font-medium text-right">Win%</th>
              <th className="pb-1 font-medium text-right">P&L</th>
              <th className="pb-1 font-medium text-right">PF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="py-1 font-medium text-[var(--color-text)] uppercase">{r.group_key || '—'}</td>
                <td className="py-1 text-right font-mono text-[var(--color-text)]">{r.trades}</td>
                <td className="py-1 text-right font-mono text-[var(--color-text)]">{r.win_rate != null ? `${(r.win_rate * 100).toFixed(0)}%` : '—'}</td>
                <td className={`py-1 text-right font-mono font-semibold ${(r.total_pnl || 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                  {r.total_pnl != null ? fmtMoney(r.total_pnl) : '—'}
                </td>
                <td className="py-1 text-right font-mono text-[var(--color-text)]">{r.profit_factor != null ? r.profit_factor.toFixed(2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelFrame>
  )
}

// ---------------------------------------------------------------------------
// Pending Orders at cTrader — dedicated card for limit/stop orders
// ---------------------------------------------------------------------------

function PendingOrders({ ctrader }) {
  const [orders, setOrders] = useState(null)
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)

  const accountId = ctrader.linkedAccountId || ctrader.accounts?.[0]?.accountId || null
  const selected = ctrader.accounts?.find(a => a.accountId === accountId)
  const isLive = selected?.isLive ?? false

  const load = useCallback(async () => {
    if (!accountId || !ctrader.accessToken) return
    setLoading(true)
    try {
      const res = await fetch('/api/ctrader', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'open-positions', accessToken: ctrader.accessToken, accountId, isLive }),
      })
      if (res.ok) {
        const data = await res.json()
        setOrders(data?.orders || [])
      }
    } catch {}
    setLoading(false)
    setFetched(true)
  }, [ctrader.accessToken, accountId, isLive])

  useEffect(() => { if (!fetched) load() }, [fetched, load])

  if (!accountId || !ctrader.accounts?.length) return null
  if (!orders || orders.length === 0) {
    if (fetched) return (
      <PanelFrame id="pending-orders" title="cTrader Pending Orders" defaultSize="M" badge={
        <Badge tone="neutral" className="text-[10px] px-1">0</Badge>
      }>
        <p className="t-sub text-[var(--color-muted)] py-2 text-center">No pending orders at cTrader.</p>
      </PanelFrame>
    )
    return null
  }

  return (
    <PanelFrame id="pending-orders" title="cTrader Pending Orders" defaultSize="L" badge={
      <span className="flex items-center gap-1">
        <Badge tone="accent" className="text-[10px] px-1">{orders.length} order{orders.length !== 1 ? 's' : ''}</Badge>
        <Badge tone={isLive ? 'down' : 'accent'} className="text-[10px] px-1">{isLive ? 'LIVE' : 'DEMO'}</Badge>
        <button type="button" onClick={load} disabled={loading} className="text-[10px] text-[var(--color-accent)] hover:underline ml-1">
          {loading ? '…' : '↻'}
        </button>
      </span>
    }>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[var(--color-muted)] text-left bg-[var(--color-surface)]">
              <th className="px-2 py-1 font-medium">Symbol</th>
              <th className="px-2 py-1 font-medium">Side</th>
              <th className="px-2 py-1 font-medium">Type</th>
              <th className="px-2 py-1 font-medium text-right">Lots</th>
              <th className="px-2 py-1 font-medium text-right">Trigger</th>
              <th className="px-2 py-1 font-medium text-right">SL</th>
              <th className="px-2 py-1 font-medium text-right">TP</th>
              <th className="px-2 py-1 font-medium">Source</th>
              <th className="px-2 py-1 font-medium">Expires</th>
              <th className="px-2 py-1 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {orders.map((o, i) => {
              const sym = o.symbolName || `#${o.symbolId}`
              const volLots = o.volume != null ? o.volume / 10000 : null
              const priceDigits = sym.endsWith('JPY') ? 3 : sym.startsWith('XAU') ? 2 : 5
              const triggerPrice = o.limitPrice ?? o.stopPrice ?? null
              const typeRaw = o.orderType?.replace(/^ORDER_TYPE_/, '') || o.orderType || '—'
              const parsedLabel = o.label ? parseLabel(o.label) : null
              const sourceBadge = parsedLabel?.source ? SOURCE_BADGE[parsedLabel.source] : null
              const slPips = pipDist(triggerPrice, o.stopLoss, sym)
              const tpPips = pipDist(triggerPrice, o.takeProfit, sym)

              return (
                <tr key={o.orderId || i}>
                  <td className="px-2 py-1 font-mono font-bold text-[var(--color-text)]">{sym}</td>
                  <td className={`px-2 py-1 font-semibold ${o.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                    {o.side === 'BUY' ? '▲ BUY' : '▼ SELL'}
                  </td>
                  <td className="px-2 py-1">
                    <Badge tone={typeRaw.includes('STOP') ? 'warning' : 'accent'} className="text-[10px] px-1">{typeRaw}</Badge>
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-[var(--color-text)]">{volLots != null ? volLots.toFixed(2) : '—'}</td>
                  <td className="px-2 py-1 text-right font-mono text-[var(--color-text)]">{triggerPrice != null ? triggerPrice.toFixed(priceDigits) : '—'}</td>
                  <td className="px-2 py-1 text-right font-mono text-[var(--color-down)]">
                    {o.stopLoss != null ? o.stopLoss.toFixed(priceDigits) : '—'}
                    {slPips != null && <span className="opacity-60 ml-0.5">({Math.abs(slPips).toFixed(0)}p)</span>}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-[var(--color-up)]">
                    {o.takeProfit != null ? o.takeProfit.toFixed(priceDigits) : '—'}
                    {tpPips != null && <span className="opacity-60 ml-0.5">({Math.abs(tpPips).toFixed(0)}p)</span>}
                  </td>
                  <td className="px-2 py-1">
                    {sourceBadge ? (
                      <Badge tone={sourceBadge.tone} className="text-[10px] px-1">{sourceBadge.text}</Badge>
                    ) : (
                      <span className="text-[var(--color-muted)]">{parsedLabel?.source || '—'}</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-[var(--color-muted)] whitespace-nowrap">{o.expirationTimestamp ? fmtAgo(o.expirationTimestamp) : '—'}</td>
                  <td className="px-2 py-1 text-[var(--color-muted)] whitespace-nowrap">{o.utcLastUpdateTimestamp ? fmtAgo(o.utcLastUpdateTimestamp) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </PanelFrame>
  )
}

// ---------------------------------------------------------------------------
// API Health — connectivity status for Polygon, Anthropic, cTrader
// ---------------------------------------------------------------------------

function ApiHealth({ health }) {
  if (!health?.apis) return null

  const apis = [
    { key: 'anthropic', label: 'Claude API', icon: '🧠' },
    { key: 'polygon',   label: 'Polygon',    icon: '📊' },
    { key: 'ctrader',   label: 'cTrader WS',  icon: '🔌' },
  ]

  return (
    <PanelFrame id="api-health" title="System Health" defaultSize="M" defaultCollapsed={true} badge={
      <span className="flex items-center gap-1">
        {apis.map(a => {
          const info = health.apis[a.key]
          const ok = info?.lastCall
          return (
            <span key={a.key} className={`inline-block w-1.5 h-1.5 rounded-full ${ok ? 'bg-[var(--color-up)]' : 'bg-[var(--color-muted)]'}`}
              title={`${a.label}: ${ok ? 'OK' : 'unknown'}`} />
          )
        })}
        <span className="text-[10px] text-[var(--color-muted)] ml-0.5">{health.symbols?.enabled || 0} symbols</span>
      </span>
    }>
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          {apis.map(a => {
            const info = health.apis[a.key] || {}
            const ok = !!info.lastCall
            const lastErr = info.lastError
            return (
              <div key={a.key} className="rounded-[5px] bg-[var(--color-bg)] px-2 py-1.5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-[var(--color-up)]' : 'bg-[var(--color-muted)]'}`} />
                  <span className="text-[10px] font-semibold text-[var(--color-text)]">{a.label}</span>
                </div>
                <p className="text-[10px] text-[var(--color-muted)]">
                  {info.lastCall ? `OK · ${fmtAgo(info.lastCall)}` : 'No calls yet'}
                </p>
                {lastErr && (
                  <p className="text-[10px] text-[var(--color-down)] truncate mt-0.5" title={lastErr}>{lastErr}</p>
                )}
              </div>
            )
          })}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <div>
            <p className="text-[var(--color-muted)]">Symbols</p>
            <p className="font-mono text-[var(--color-text)]">{health.symbols?.enabled || 0} / {health.symbols?.total || 0}</p>
          </div>
          <div>
            <p className="text-[var(--color-muted)]">Force-Skipped</p>
            <p className={`font-mono ${(health.symbols?.skipped || 0) > 0 ? 'text-[var(--color-warning-text)]' : 'text-[var(--color-text)]'}`}>{health.symbols?.skipped || 0}</p>
          </div>
          <div>
            <p className="text-[var(--color-muted)]">Memory</p>
            <p className={`font-mono ${(health.memoryMB || 0) > 256 ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>{health.memoryMB ? `${health.memoryMB}MB` : '—'}</p>
          </div>
          <div>
            <p className="text-[var(--color-muted)]">DB Size</p>
            <p className="font-mono text-[var(--color-text)]">{health.dbSizeMB ? `${health.dbSizeMB}MB` : '—'}</p>
          </div>
        </div>
      </div>
    </PanelFrame>
  )
}

// ---------------------------------------------------------------------------
// Symbol Controls — human interference + strategy style toggles per symbol
// ---------------------------------------------------------------------------

const STYLE_META = {
  scalper:    { label: 'Scalper',    desc: '< 30 min trades',    icon: '⚡' },
  swing:     { label: 'Swing',      desc: '1-8 hour trades',    icon: '🔄' },
  short_term:{ label: 'Short-Term', desc: '1-5 day trades',     icon: '📅' },
  mid_term:  { label: 'Mid-Term',   desc: 'Weeks to months',    icon: '📆' },
}

const BIAS_OPTIONS = [
  { value: '', label: 'AI decides' },
  { value: 'long', label: '▲ Force Long' },
  { value: 'short', label: '▼ Force Short' },
  { value: 'neutral', label: '○ Force Neutral' },
  { value: 'skip', label: '✕ Force Skip' },
]

function SymbolControls({ symbols, role, onRefresh }) {
  const [busy, setBusy] = useState({})
  const [expanded, setExpanded] = useState(null)

  const updateSymbol = async (symbol, updates) => {
    setBusy(prev => ({ ...prev, [symbol]: true }))
    try {
      await agentPost('/actions/symbol-config', { symbol, ...updates }, role)
      if (onRefresh) onRefresh()
    } catch (e) {
      console.error('symbol-config error:', e.message)
    }
    setBusy(prev => ({ ...prev, [symbol]: false }))
  }

  if (!symbols || symbols.length === 0) return null

  return (
    <PanelFrame id="symbol-controls" title="Symbol Controls" defaultSize="L" badge={
      <span className="flex items-center gap-1">
        <Badge tone="accent" className="text-[10px] px-1">{symbols.filter(s => s.enabled !== false && !s.force_skip).length} active</Badge>
        {symbols.some(s => s.force_skip) && <Badge tone="warning" className="text-[10px] px-1">{symbols.filter(s => s.force_skip).length} skipped</Badge>}
        {symbols.some(s => s.override_bias) && <Badge tone="special" className="text-[10px] px-1">{symbols.filter(s => s.override_bias).length} overridden</Badge>}
      </span>
    }>
      <p className="text-[10px] text-[var(--color-muted)] mb-2">
        Override agent decisions per symbol. Style toggles control which trade durations are allowed — disabling a style blocks auto-trades of that duration.
      </p>
      <div className="space-y-1">
        {symbols.map(sym => {
          const s = typeof sym === 'string' ? { symbol: sym, enabled: true } : sym
          const isExpanded = expanded === s.symbol
          const isBusy = busy[s.symbol]
          const styles = s.allowed_styles || { scalper: true, swing: true, short_term: true, mid_term: false }

          return (
            <div key={s.symbol} className="rounded-[5px] bg-[var(--color-bg)] overflow-hidden">
              <button type="button" onClick={() => setExpanded(isExpanded ? null : s.symbol)}
                className="w-full px-2 py-1.5 flex items-center gap-2 text-[11px] hover:opacity-80 cursor-pointer"
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${s.force_skip ? 'bg-[var(--color-warning-text)]' : s.enabled !== false ? 'bg-[var(--color-up)]' : 'bg-[var(--color-muted)]'}`} />
                <span className="font-mono font-bold text-[var(--color-text)]">{s.symbol}</span>
                {s.force_skip && <Badge tone="warning" className="text-[10px] px-1">SKIP</Badge>}
                {s.override_bias && <Badge tone="special" className="text-[10px] px-1">BIAS: {s.override_bias.toUpperCase()}</Badge>}
                {s.block_next_trade && <Badge tone="down" className="text-[10px] px-1">BLOCKED</Badge>}
                <span className="flex-1" />
                <span className="flex items-center gap-0.5">
                  {Object.entries(styles).map(([k, v]) => (
                    <span key={k} className={`text-[10px] ${v ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)] opacity-40'}`}
                      title={`${STYLE_META[k]?.label}: ${v ? 'ON' : 'OFF'}`}>
                      {STYLE_META[k]?.icon || k[0]}
                    </span>
                  ))}
                </span>
                <span className="text-[10px] text-[var(--color-muted)]">{isExpanded ? '▾' : '▸'}</span>
              </button>

              {isExpanded && (
                <div className="px-2 pb-2 space-y-2 border-t border-[var(--color-border)]">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                    <div>
                      <p className="text-[10px] text-[var(--color-muted)] mb-1">Force Skip</p>
                      <button type="button" disabled={isBusy}
                        onClick={() => updateSymbol(s.symbol, { force_skip: !s.force_skip })}
                        className={`px-2 py-1 rounded text-[10px] font-bold w-full ${s.force_skip ? 'bg-[var(--color-warning-text)] text-white' : 'bg-[var(--color-bg)] text-[var(--color-muted)] border border-[var(--color-border)]'}`}
                      >{s.force_skip ? 'SKIPPING' : 'Active'}</button>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--color-muted)] mb-1">Block Next Trade</p>
                      <button type="button" disabled={isBusy}
                        onClick={() => updateSymbol(s.symbol, { block_next_trade: !s.block_next_trade })}
                        className={`px-2 py-1 rounded text-[10px] font-bold w-full ${s.block_next_trade ? 'bg-[var(--color-down)] text-white' : 'bg-[var(--color-bg)] text-[var(--color-muted)] border border-[var(--color-border)]'}`}
                      >{s.block_next_trade ? 'BLOCKED' : 'Allow'}</button>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--color-muted)] mb-1">Override Bias</p>
                      <select value={s.override_bias || ''} disabled={isBusy}
                        onChange={e => updateSymbol(s.symbol, { override_bias: e.target.value || null })}
                        className="w-full px-1.5 py-1 rounded text-[10px] bg-[var(--color-bg)] text-[var(--color-text)] border border-[var(--color-border)]"
                      >
                        {BIAS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--color-muted)] mb-1">Auto-Trade Threshold</p>
                      <div className="flex items-center gap-1">
                        <input type="range" min="4" max="10" value={s.autoTradeThreshold || 8} disabled={isBusy}
                          onChange={e => updateSymbol(s.symbol, { autoTradeThreshold: Number(e.target.value) })}
                          className="flex-1 h-1 accent-[var(--color-accent)]"
                        />
                        <span className="font-mono text-[10px] text-[var(--color-text)] w-5 text-right">{s.autoTradeThreshold || 8}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] text-[var(--color-muted)] mb-1">Allowed Trading Styles</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(STYLE_META).map(([key, meta]) => {
                        const on = styles[key] !== false
                        return (
                          <button key={key} type="button" disabled={isBusy}
                            onClick={() => updateSymbol(s.symbol, { allowed_styles: { ...styles, [key]: !on } })}
                            className={`px-2 py-1 rounded text-[10px] flex items-center gap-1 ${on
                              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-bold'
                              : 'bg-[var(--color-bg)] text-[var(--color-muted)] border border-[var(--color-border)] line-through'
                            }`}
                          >
                            <span>{meta.icon}</span>
                            <span>{meta.label}</span>
                            <span className="opacity-60 text-[10px]">{meta.desc}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-[10px] text-[var(--color-muted)] mb-1">Max Volume (lots)</p>
                      <input type="number" step="0.01" min="0.01" max="10" value={s.maxVolume || 0.01} disabled={isBusy}
                        onChange={e => updateSymbol(s.symbol, { maxVolume: Number(e.target.value) || 0.01 })}
                        className="w-full px-1.5 py-1 rounded text-[10px] font-mono bg-[var(--color-bg)] text-[var(--color-text)] border border-[var(--color-border)]"
                      />
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--color-muted)] mb-1">Status</p>
                      <button type="button" disabled={isBusy}
                        onClick={() => updateSymbol(s.symbol, { enabled: s.enabled === false })}
                        className={`px-2 py-1 rounded text-[10px] font-bold w-full ${s.enabled !== false ? 'bg-[var(--color-up)] text-white' : 'bg-[var(--color-muted)] text-white'}`}
                      >{s.enabled !== false ? 'ENABLED' : 'DISABLED'}</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </PanelFrame>
  )
}

// ---------------------------------------------------------------------------
// CSV Download helper
// ---------------------------------------------------------------------------

function downloadCSV(filename, headers, rows) {
  const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function DownloadButtons({ role }) {
  const [busy, setBusy] = useState(false)

  const exportTrades = async () => {
    setBusy(true)
    try {
      const r = await agentGet('/state/trades', role)
      const trades = r?.trades || []
      if (trades.length === 0) return alert('No trades to export')
      downloadCSV('trade-log.csv',
        ['symbol','side','entry_price','exit_price','volume','opened_at','closed_at','gross_pnl','net_pnl','strategy','conviction','source','close_reason'],
        trades.map(t => [t.symbol, t.side, t.entry_price, t.exit_price, t.volume, t.opened_at, t.closed_at, t.gross_pnl, t.net_pnl, t.label_strategy, t.label_conviction, t.source, t.close_reason])
      )
    } catch (e) { alert(e.message) } finally { setBusy(false) }
  }

  const exportRiskEvents = async () => {
    setBusy(true)
    try {
      const r = await agentGet('/state/risk-events?limit=200', role)
      const events = r?.events || []
      if (events.length === 0) return alert('No risk events to export')
      downloadCSV('risk-events.csv',
        ['symbol','side','approved','veto_reason','created_at'],
        events.map(e => [e.symbol, e.side, e.approved, e.veto_reason, e.created_at])
      )
    } catch (e) { alert(e.message) } finally { setBusy(false) }
  }

  return (
    <Card>
      <p className="t-label mb-2">Downloads</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={exportTrades} disabled={busy}>Trade Log CSV</Button>
        <Button size="sm" variant="ghost" onClick={exportRiskEvents} disabled={busy}>Risk Events CSV</Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// History — recent trade lifecycle events (open/close/SL/TP/cancel)
// ---------------------------------------------------------------------------

function TradeHistory({ activity, role }) {
  const [trades, setTrades] = useState([])
  useEffect(() => {
    if (!agentConfigured(role)) return
    agentGet('/state/trades', role).then(r => setTrades(r?.trades || [])).catch(() => {})
  }, [role])

  const tradeEvents = activity.filter(r => r.kind === 'trade' || r.kind === 'monitor')
  const allRows = [
    ...trades.map(t => ({
      time: t.closed_at || t.opened_at,
      action: t.status === 'closed' ? (t.close_reason === 'sl_hit' ? 'SL HIT' : t.close_reason === 'tp_hit' ? 'TP HIT' : 'CLOSE') : 'OPEN',
      sym: t.symbol,
      detail: `${t.side} ${t.volume ? (t.volume / 10000).toFixed(2) : '?'} @ ${t.entry_price || '—'}`,
      pnl: t.realized_pnl,
      desk: dispatchMinions(t.symbol).slice(0, 2).map(id => MINIONS[id]?.name).filter(Boolean).join(' + '),
      strategy: t.strategy || null,
    })),
    ...tradeEvents.map(r => ({
      time: r.at,
      action: r.kind === 'trade' ? (r.v1 === 'BUY' || r.v1 === 'SELL' ? 'OPEN' : String(r.v1).toUpperCase()) : 'MONITOR',
      sym: r.symbol,
      detail: r.note || '',
      pnl: null,
      desk: dispatchMinions(r.symbol).slice(0, 2).map(id => MINIONS[id]?.name).filter(Boolean).join(' + '),
      strategy: r.extra || null,
    })),
  ]
  allRows.sort((a, b) => new Date(b.time) - new Date(a.time))
  const unique = allRows.slice(0, 20)

  if (unique.length === 0) return null

  const actionColor = (a) => {
    if (a === 'OPEN' || a === 'TP HIT') return 'text-[var(--color-up)]'
    if (a === 'SL HIT' || a === 'CLOSE') return 'text-[var(--color-down)]'
    return 'text-[var(--color-muted)]'
  }

  return (
    <Card>
      <p className="t-label mb-2">History</p>
      <div className="space-y-1 max-h-[320px] overflow-y-auto">
        {unique.map((r, i) => (
          <div key={i} className="rounded-[5px] bg-[var(--color-bg)] px-2 py-1.5 space-y-0.5">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-mono text-[10px] text-[var(--color-muted)] w-12 shrink-0">{r.time ? new Date(r.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
              <span className={`font-semibold text-[10px] w-14 ${actionColor(r.action)}`}>{r.action}</span>
              <span className="font-mono font-bold text-[var(--color-text)]">{r.sym}</span>
              <span className="text-[var(--color-muted)] text-[10px] truncate flex-1">{r.detail}</span>
              {r.pnl != null && (
                <span className={`font-mono font-semibold text-[11px] ${r.pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                  {r.pnl >= 0 ? '+' : ''}{fmtMoney(r.pnl)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-[var(--color-muted)]">
              {r.desk && <span>Desk: {r.desk}</span>}
              {r.strategy && <span className="uppercase">{r.strategy}</span>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Activity row styling
// ---------------------------------------------------------------------------

const KIND_TONE = {
  scan: 'neutral', analysis: 'accent', monitor: 'info',
  trade: 'up', regime: 'neutral', flip: 'warning',
}
const KIND_LABEL = {
  scan: 'SCAN', analysis: 'ANALYSIS', monitor: 'MONITOR',
  trade: 'TRADE', regime: 'REGIME', flip: 'FLIP',
}

function ActivityRow({ row }) {
  const biasColor = row.v1 === 'long' || row.v1 === 'BUY'
    ? 'text-[var(--color-up)]'
    : row.v1 === 'short' || row.v1 === 'SELL'
    ? 'text-[var(--color-down)]'
    : 'text-[var(--color-muted)]'
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 rounded-[5px] hover:bg-[var(--color-bg)] text-[11px]">
      <Badge tone={KIND_TONE[row.kind] || 'neutral'} className="text-[10px] px-1 shrink-0">
        {KIND_LABEL[row.kind] || row.kind.toUpperCase()}
      </Badge>
      <span className="font-bold w-[65px] shrink-0 text-[var(--color-text)]">{row.symbol}</span>
      {row.v1 && (
        <span className={`font-bold w-[52px] shrink-0 ${biasColor}`}>{String(row.v1).slice(0, 8)}</span>
      )}
      {row.v2 != null && (
        <span className="font-mono w-[32px] shrink-0 text-[var(--color-text-sub)]">
          {typeof row.v2 === 'number' ? row.v2.toFixed(1) : row.v2}
        </span>
      )}
      <span className="flex-1 min-w-0 text-[var(--color-text-sub)] truncate">
        {row.note || row.extra || ''}
      </span>
      <span className="text-[10px] text-[var(--color-muted)] shrink-0">{fmtAgo(row.at)}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const ROLE_STORAGE_KEY = 'bot-trade:agent-role'

export default function Agent() {
  const { state } = useStrategy()
  // Which Railway backend to talk to. Autopilot = trades autonomously;
  // copilot = monitors user-entered trades only. Persisted so a reload keeps
  // the operator on the same cockpit.
  const [role, setRoleState] = useState(() => {
    try {
      const saved = localStorage.getItem(ROLE_STORAGE_KEY)
      if (ROLES.includes(saved)) return saved
    } catch {}
    return ROLES.find(r => agentConfigured(r)) || 'autopilot'
  })
  const setRole = (r) => {
    setRoleState(r)
    try { localStorage.setItem(ROLE_STORAGE_KEY, r) } catch {}
  }

  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)
  const [activity, setActivity] = useState([])
  const [botPositions, setBotPositions] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    if (!agentConfigured(role)) return
    try {
      const [h, c, a, p] = await Promise.all([
        agentGet('/health', role).catch(() => null),
        agentGet('/state/config', role).catch(() => null),
        agentGet('/state/activity?limit=40', role).catch(() => ({ activity: [] })),
        agentGet('/state/positions', role).catch(() => ({ positions: [] })),
      ])
      setHealth(h); setConfig(c)
      setActivity(a?.activity || [])
      setBotPositions(p?.positions || [])
      setError(null)
    } catch (e) { setError(e.message) }
  }, [role])

  // Reset visible state the moment the operator flips roles so they never
  // see stale autopilot data bleeding into the copilot view.
  useEffect(() => {
    setHealth(null); setConfig(null); setActivity([]); setBotPositions([]); setError(null)
  }, [role])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const iv = setInterval(refresh, 10_000)
    return () => clearInterval(iv)
  }, [refresh])

  const scanOn = config?.scan_enabled !== false
  const analyzeOn = config?.analyze_enabled !== false
  const autotradeOn = config?.autotrade_enabled === true

  const toggle = async (endpoint, on) => {
    setBusy(true)
    try {
      await agentPost(endpoint, { on }, role)
      await refresh()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const killAll = async () => {
    if (!window.confirm(`Kill switch: disarm ${role} + pause every monitored position. Proceed?`)) return
    setBusy(true)
    try { await agentPost('/actions/kill-all', undefined, role); await refresh() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const pausePos = async (id) => { try { await agentPost(`/actions/pause-position/${id}`, undefined, role); refresh() } catch (e) { setError(e.message) } }
  const unpausePos = async (id) => { try { await agentPost(`/actions/unpause-position/${id}`, undefined, role); refresh() } catch (e) { setError(e.message) } }

  // Index bot-monitored positions by their cTrader position id so the
  // AccountPanel can correlate each cTrader row with its bot thesis.
  const botById = {}
  for (const bp of botPositions) {
    if (bp.ctrader_position_id) botById[String(bp.ctrader_position_id)] = bp
  }

  const enabledSymbols = (config?.symbols || config?.watchlist || []).filter(w => w.enabled !== false)

  if (!agentConfigured('autopilot') && !agentConfigured('copilot')) {
    return (
      <Card>
        <p className="t-label mb-1">Trade Window</p>
        <p className="t-sub text-[var(--color-muted)]">
          Agent backend not configured. Set <code>VITE_AGENT_URL_AUTOPILOT</code> + <code>VITE_AGENT_SECRET_AUTOPILOT</code> (and optionally the matching <code>_COPILOT</code> pair) in Vercel, then redeploy.
        </p>
      </Card>
    )
  }

  const circuitBreaker = health?.circuitBreaker
  const resetBreaker = async () => {
    setBusy(true)
    try { await agentPost('/actions/reset-breaker', undefined, role); await refresh() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const statusBadge = role === 'copilot'
    ? { tone: 'special', text: 'COPILOT STANDBY' }
    : circuitBreaker
      ? { tone: 'down', text: 'CIRCUIT BREAKER' }
      : autotradeOn
        ? { tone: 'up', text: 'AUTO-TRADE ON' }
        : analyzeOn
          ? { tone: 'accent', text: 'ANALYZE ONLY' }
          : scanOn
            ? { tone: 'neutral', text: 'SCAN ONLY' }
            : { tone: 'neutral', text: 'ALL OFF' }

  return (
    <section className="space-y-3">
      {/* Role switcher — one cockpit per Railway backend. */}
      {(agentConfigured('autopilot') || agentConfigured('copilot')) && (
        <div className="flex items-center gap-1 text-[10px]">
          {ROLES.map(r => {
            const wired = agentConfigured(r)
            const active = r === role
            return (
              <button
                key={r}
                type="button"
                onClick={() => wired && setRole(r)}
                disabled={!wired}
                className={`px-2.5 py-1 rounded-[5px] uppercase font-bold tracking-wider ${
                  active
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : wired
                    ? 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]'
                    : 'text-[var(--color-muted)] opacity-40 cursor-not-allowed'
                }`}
                title={wired ? '' : `VITE_AGENT_URL_${r.toUpperCase()} not set`}
              >
                {r}
                {!wired && <span className="ml-1 opacity-60">(off)</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* Autopilot header */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className={`text-[18px] ${autotradeOn && role !== 'copilot' ? 'animate-pulse text-[var(--color-accent)]' : (scanOn || analyzeOn) && role !== 'copilot' ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}`}>
              {autotradeOn && role !== 'copilot' ? '●' : (scanOn || analyzeOn) ? '◐' : '○'}
            </span>
            <h1 className="t-label text-lg">Trade Window</h1>
            <Badge tone={statusBadge.tone} pill>{statusBadge.text}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={killAll} disabled={busy} className="text-[var(--color-down)]">
              Kill Switch
            </Button>
            <Link to="/workshop" className="t-meta text-[var(--color-accent)] underline self-center ml-1">
              Workshop →
            </Link>
          </div>
        </div>

        {/* Granular toggles — scan / analyze / auto-trade */}
        {role === 'autopilot' && (
          <div className="flex items-center gap-1.5 mb-3">
            <Button
              size="sm"
              variant={scanOn ? 'primary' : 'ghost'}
              onClick={() => toggle('/actions/scan-toggle', !scanOn)}
              disabled={busy}
              title="24/7 market scanning"
            >
              {scanOn ? '■' : '▶'} Scan
            </Button>
            <Button
              size="sm"
              variant={analyzeOn ? 'primary' : 'ghost'}
              onClick={() => toggle('/actions/analyze-toggle', !analyzeOn)}
              disabled={busy}
              title="Deep analysis on hot symbols + alerts"
            >
              {analyzeOn ? '■' : '▶'} Analyze
            </Button>
            <Button
              size="sm"
              variant={autotradeOn ? 'primary' : 'ghost'}
              onClick={() => toggle('/actions/autotrade-toggle', !autotradeOn)}
              disabled={busy}
              className={autotradeOn ? '!bg-[var(--color-up)] !border-[var(--color-up)] !text-white' : ''}
              title="Auto-place orders when conviction passes threshold"
            >
              {autotradeOn ? '■' : '▶'} Trade
            </Button>
          </div>
        )}

        {error && <p className="text-[10px] text-[var(--color-down)] mb-2">{error}</p>}

        {circuitBreaker && (
          <div className="mb-3 px-3 py-2 rounded-[5px] bg-[color-mix(in_srgb,var(--color-down)_15%,transparent)] border border-[var(--color-down)]">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-[var(--color-down)] font-bold">CIRCUIT BREAKER TRIPPED</span>
              <span className="text-[var(--color-muted)]">·</span>
              <span className="text-[var(--color-text-sub)]">{fmtAgo(circuitBreaker)}</span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={resetBreaker} disabled={busy} className="text-[var(--color-accent)]">
                Reset
              </Button>
            </div>
            {health?.lastError && (
              <p className="text-[11px] text-[var(--color-text-sub)] mt-1 truncate">{health.lastError}</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <p className="t-meta text-[var(--color-muted)]">Loops</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{health?.loopCount ?? '—'}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Last Scan</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{fmtAgo(health?.lastScanAt) || '—'}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Symbols</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{enabledSymbols.length} configured</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Bot Positions</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{botPositions.length} open</p>
          </div>
        </div>
        {health && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mt-2 text-[11px]">
            <div>
              <p className="text-[var(--color-muted)]">Loop Time</p>
              <p className="font-mono text-[var(--color-text)]">{health.lastLoopMs ? `${(health.lastLoopMs / 1000).toFixed(1)}s` : '—'}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Uptime</p>
              <p className="font-mono text-[var(--color-text)]">{health.uptime ? `${(health.uptime / 3600).toFixed(1)}h` : '—'}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Memory</p>
              <p className="font-mono text-[var(--color-text)]">{health.memoryMB ? `${health.memoryMB}MB` : '—'}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">DB Size</p>
              <p className="font-mono text-[var(--color-text)]">{health.dbSizeMB ? `${health.dbSizeMB}MB` : '—'}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Errors Today</p>
              <p className={`font-mono ${health.errorsToday > 0 ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>{health.errorsToday ?? 0}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Open Trades</p>
              <p className="font-mono text-[var(--color-text)]">{health.openTrades ?? 0}</p>
            </div>
          </div>
        )}
      </Card>

      {/* Risk dashboard — Sharpe, drawdown, daily P&L, risk limits */}
      <RiskDashboard role={role} />

      {/* System + API health — connectivity status, symbol counts */}
      <ApiHealth health={health} />

      {/* Market data strip — prices, VWAP, regime, EMA per symbol */}
      <MarketDataStrip symbols={enabledSymbols.map(s => s.symbol || s).filter(Boolean)} role={role} />

      {/* Market status — which watchlist markets are live vs closed */}
      <MarketStatus symbols={enabledSymbols.map(s => s.symbol || s).filter(Boolean)} activity={activity} />

      {/* Two-column grid for mid-section panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <AttributionPanel role={role} />
        <EquityCurve role={role} />
      </div>

      {/* Monitor Agent — what's being watched, last checks, thesis status */}
      <MonitorAgent role={role} />

      {/* Symbol Controls — human interference, style toggles, overrides */}
      <SymbolControls
        symbols={config?.symbols || config?.watchlist || []}
        role={role}
        onRefresh={refresh}
      />

      {/* Planned Orders — analysis revision trail per symbol */}
      <PlannedOrders activity={activity} role="autopilot" />
      {agentConfigured('copilot') && <PlannedOrders activity={activity} role="copilot" />}

      {/* cTrader Pending Orders — limit/stop orders at broker */}
      <PendingOrders ctrader={state.ctrader} />

      {/* Two-column grid: failed trades + trade results */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <FailedTrades role={role} />
        <TradeResults role={role} />
      </div>

      {/* Two-column grid for operational panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <TeamRoster activity={activity} />
        <ScanFeed activity={activity} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* cTrader account — default collapsed, lazy fetch on expand */}
        <PanelFrame id="ctrader-account" title="Trading Account" defaultCollapsed={true}
          onExpand={() => {
            const panel = document.querySelector('[data-panel="ctrader-account"]')
            if (panel) panel.dispatchEvent(new Event('panel-expand'))
          }}
          badge={<Badge tone={state.ctrader?.accounts?.some(a => a.isLive) ? 'down' : 'accent'} className="text-[10px] px-1">
            {state.ctrader?.accounts?.some(a => a.isLive) ? 'LIVE' : 'DEMO'}
          </Badge>}
        >
          <AccountPanel
            ctrader={state.ctrader}
            botPositionsById={botById}
            onPause={pausePos}
            onUnpause={unpausePos}
          />
        </PanelFrame>
        <TradeHistory activity={activity} role={role} />
      </div>

      {/* CSV Downloads */}
      <DownloadButtons role={role} />

      {/* Live activity stream */}
      <PanelFrame id="live-activity" title="Live Activity" defaultCollapsed={true}
        badge={<span className="text-[10px] text-[var(--color-muted)]">{activity.length} events · 10s</span>}
      >
        {activity.length === 0 ? (
          <p className="t-sub text-[var(--color-muted)] py-4 text-center">
            No events yet. The loop scans every 5 min — first activity should appear shortly after autopilot is engaged.
          </p>
        ) : (
          <div className="space-y-0.5 max-h-[520px] overflow-y-auto">
            {activity.map((row, i) => (
              <ActivityRow key={`${row.kind}-${row.id}-${i}`} row={row} />
            ))}
          </div>
        )}
        <div className="mt-2 pt-2 border-t border-[var(--color-border)] flex items-center justify-between">
          <span className="text-[10px] text-[var(--color-muted)]">
            Drill into any analysis, trade, or monitor check in the Workshop.
          </span>
          <Link to="/workshop" className="text-[10px] text-[var(--color-accent)] underline">
            Workshop →
          </Link>
        </div>
      </PanelFrame>
    </section>
  )
}
