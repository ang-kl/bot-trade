// Trading Floor — mission control for the minion swarm.
// Scout → Analyst (parallel minions) → Synthesis → Trade → Monitor.
// Activity log shows every agent action in real time.

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import TradingFloor from '../components/AgentFeed/TradingFloor.jsx'
import ActivityLog from '../components/AgentFeed/ActivityLog.jsx'
import OrderDialog from '../components/AgentFeed/OrderDialog.jsx'
import TradeMonitor from '../components/AgentFeed/TradeMonitor.jsx'
import AskDock from '../components/AgentFeed/AskDock.jsx'
import BottomBar from '../components/AgentFeed/BottomBar.jsx'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import { useStrategy } from '../lib/strategy-store.js'
import { isTradingNow, getHoursForSymbol } from '../lib/trading-hours.js'

const SCAN_INTERVAL = 5 * 60 // 5 minutes in seconds

// ── API helpers ──

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${url} ${res.status}`)
  return data
}

// ── Activity log helpers ──

let logId = 0
function logEntry(agent, message, extra = {}) {
  return { id: ++logId, ts: Date.now(), agent, message, ...extra }
}

// ── Symbol result card ──

function SymbolCard({ symbol, scan, analysis, onOrder, eventLine, defaultCollapsed = false }) {
  const hasAnalysis = !!analysis
  const synthesis = analysis?.synthesis
  const reports = analysis?.reports || []

  const bias = synthesis?.consensus_bias || scan?.bias || 'neutral'
  const conviction = synthesis?.overall_conviction || scan?.confidence || 0
  const isSkip = bias === 'skip' || bias === 'neutral'
  const arrow = bias === 'long' ? '\u25B2' : bias === 'short' ? '\u25BC' : '\u25CF'
  const sideColor = bias === 'long' ? 'text-[var(--color-up)]' : bias === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'

  const [cardOpen, setCardOpen] = useState(!defaultCollapsed)
  const [expanded, setExpanded] = useState(false)
  const [showOriginal, setShowOriginal] = useState({}) // false = English, true = original language

  return (
    <Card id={`symbol-${symbol}`}>
      {/* Header — always visible, click to toggle */}
      <div
        className="flex items-center gap-2 cursor-pointer flex-wrap"
        onClick={() => setCardOpen(prev => !prev)}
      >
        <span className="text-[10px] text-[var(--color-muted)]">{cardOpen ? '\u25BC' : '\u25B6'}</span>
        <span className={`t-body font-bold ${sideColor}`}>{arrow} {symbol}</span>
        <Badge tone={isSkip ? 'neutral' : bias === 'long' ? 'up' : 'down'} pill>
          {bias.toUpperCase()}
        </Badge>
        <Badge tone="info" pill>{conviction}/10</Badge>
        {synthesis?.consensus_summary && (
          <span className="t-meta text-[var(--color-muted)]">{synthesis.consensus_summary}</span>
        )}
        {scan?.session_fit && (
          <span className="t-meta text-[var(--color-muted)]">Session: {scan.session_fit}</span>
        )}
        {scan?.trade_at && scan.trade_at !== 'now' && (
          <Badge tone="warning" pill>Trade at: {scan.trade_at}</Badge>
        )}
      </div>

      {cardOpen && <>
      {/* Calendar event one-liner */}
      {eventLine && (
        <p className="t-meta text-[var(--color-special-text)] bg-[var(--color-special-bg)] px-2 py-1 rounded-[4px] mb-1.5">
          {'\u{1F4C5}'} {eventLine}
        </p>
      )}

      {/* Scout thesis */}
      {scan?.thesis && !hasAnalysis && (
        <p className="t-sub text-[var(--color-text-sub)] mb-2">{scan.thesis}</p>
      )}

      {/* Synthesis summary */}
      {synthesis?.synthesis && (
        <p className="t-sub text-[var(--color-text-sub)] mb-2">{synthesis.synthesis}</p>
      )}

      {/* Minion reports (expandable) */}
      {reports.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="t-meta text-[var(--color-accent)] cursor-pointer mb-2 hover:underline"
          >
            {expanded ? '\u25BC' : '\u25B6'} {reports.length} minion reports
          </button>
          {expanded && (
            <div className="space-y-2 mb-2 pl-2 border-l-2 border-[var(--color-border)]">
              {reports.map((r, i) => {
                const hasTranslation = r.translated_report && r.original_language
                const useOriginal = showOriginal[i]
                const displayText = hasTranslation && useOriginal ? r.original_report || r.report : (hasTranslation ? r.translated_report : r.report)

                return (
                  <div key={i} className="text-[12px]">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="font-bold text-[var(--color-accent)]">
                        {r.icon || '\u25CF'} {r.name}
                      </span>
                      {r.organisation && (
                        <span className="text-[var(--color-muted-light)] text-[10px]">{r.organisation}</span>
                      )}
                      <span className="text-[var(--color-muted)] text-[10px]">({r.role})</span>
                      <Badge
                        tone={r.bias === 'long' ? 'up' : r.bias === 'short' ? 'down' : 'neutral'}
                        className="ml-0.5"
                      >
                        {r.bias?.toUpperCase()}
                      </Badge>
                      <span className="text-[var(--color-muted)] text-[10px]">{r.conviction}/10</span>
                      {r.url && (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--color-accent)] text-[9px] hover:underline"
                        >
                          source
                        </a>
                      )}
                    </div>
                    {/* Date/time */}
                    {r.timestamp && (
                      <span className="text-[9px] text-[var(--color-muted-light)] ml-4">
                        {new Date(r.timestamp).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                      </span>
                    )}
                    {/* Report text with translation toggle */}
                    <p className="text-[var(--color-text-sub)] ml-4">{displayText}</p>
                    {hasTranslation && (
                      <button
                        type="button"
                        onClick={() => setShowOriginal(prev => ({ ...prev, [i]: !prev[i] }))}
                        className="ml-4 text-[9px] text-[var(--color-accent)] cursor-pointer hover:underline"
                      >
                        {useOriginal ? `Show English` : `Show original (${r.original_language})`}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Levels */}
      {synthesis?.entry != null && (
        <div className="flex gap-4 t-meta mb-2 flex-wrap">
          <span>Entry: <span className="font-mono font-semibold">{synthesis.entry}</span></span>
          {synthesis.sl != null && <span className="text-[var(--color-down)]">SL: {synthesis.sl}</span>}
          {synthesis.tp1 != null && <span className="text-[var(--color-up)]">TP1: {synthesis.tp1}</span>}
          {synthesis.tp2 != null && <span className="text-[var(--color-up)]">TP2: {synthesis.tp2}</span>}
        </div>
      )}

      {/* Dissent */}
      {synthesis?.dissent && (
        <p className="t-meta text-[var(--color-warning-text)] mb-2">
          Dissent: {synthesis.dissent}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        {!isSkip && synthesis?.entry != null && (
          <Button size="sm" variant="primary" onClick={() => onOrder(symbol, synthesis)}>
            {arrow} Place Order
          </Button>
        )}
        {hasAnalysis && synthesis?.auto_trade && (
          <Badge tone="up" pill>AUTO-TRADE ELIGIBLE</Badge>
        )}
        {!hasAnalysis && !isSkip && conviction >= 5 && (
          <Badge tone="info" pill>ANALYZING...</Badge>
        )}
      </div>
      </>}
    </Card>
  )
}

// ── VWAP period options ──

const VWAP_PERIODS = [
  { key: 'today', label: 'Today' },
  { key: '3d', label: '3D' },
  { key: '5d', label: '5D' },
  { key: '1w', label: '1W' },
  { key: '14d', label: '14D' },
  { key: '21d', label: '21D' },
  { key: '1m', label: '1M' },
  { key: '3m', label: '3M' },
  { key: '6m', label: '6M' },
  { key: '1y', label: '1Y' },
  { key: '2jan', label: '2 Jan' },
  { key: 'qtr', label: 'Qtr' },
]

// ── Trade grade helpers ──

function getTradeGrade(d) {
  const scan = d.scan
  const syn = d.analysis?.synthesis
  const bias = syn?.consensus_bias || scan?.bias || 'neutral'
  const confidence = syn?.overall_conviction || scan?.confidence || 0
  const grade = scan?.trade_grade
  if (grade) return grade
  if (bias === 'skip' || bias === 'neutral' || confidence < 4) return 'none'
  if (confidence >= 6) return 'potential'
  return 'weak'
}

const GRADE_ORDER = { potential: 0, weak: 1, none: 2 }
const GRADE_LABEL = { potential: 'Potential Trade', weak: 'Weak Trade', none: 'No Trade' }
const GRADE_TONE = { potential: 'up', weak: 'warning', none: 'neutral' }

// ── Summary matrix card ──

function SummaryMatrix({ symbols, scanning, collapsed, onToggle, massiveMetrics = {} }) {
  const [vwapPeriod, setVwapPeriod] = useState('today')

  const hasAnyScan = symbols.some(d => d.scan)

  // Sort by trade grade then confidence
  const sorted = useMemo(() => {
    return [...symbols].sort((a, b) => {
      const ga = GRADE_ORDER[getTradeGrade(a)] ?? 2
      const gb = GRADE_ORDER[getTradeGrade(b)] ?? 2
      if (ga !== gb) return ga - gb
      return b.confidence - a.confidence
    })
  }, [symbols])

  if (symbols.length === 0) return null

  const scrollToSymbol = (sym) => {
    const el = document.getElementById(`symbol-${sym}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2 cursor-pointer" onClick={onToggle}>
          <span className="text-[10px] text-[var(--color-muted)]">{collapsed ? '\u25B6' : '\u25BC'}</span>
          <p className="t-label">Summary Matrix</p>
          <span className="t-meta text-[var(--color-muted)]">{symbols.length} symbols</span>
        </div>
        {!collapsed && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="t-meta text-[var(--color-muted)] mr-1">VWAP:</span>
            {VWAP_PERIODS.map(p => (
              <button
                key={p.key}
                type="button"
                onClick={() => setVwapPeriod(p.key)}
                className={`px-1.5 py-0.5 text-[9px] sm:text-[10px] rounded-[4px] font-bold cursor-pointer transition-colors ${
                  vwapPeriod === p.key
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'bg-[var(--color-bg)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          {/* Loading / awaiting state */}
          {!hasAnyScan && (
            <div className="flex items-center gap-2 py-4 justify-center">
              {scanning ? (
                <>
                  <span className="animate-pulse text-[var(--color-accent)] text-[14px]">{'\u25CF'}</span>
                  <span className="t-sub text-[var(--color-muted)]">Scanning symbols... data will populate shortly</span>
                </>
              ) : (
                <span className="t-sub text-[var(--color-muted)]">Arm the system and run a scan to populate the matrix</span>
              )}
            </div>
          )}

          {hasAnyScan && (
            <div className="overflow-x-auto -mx-2 px-0">
              <table className="border-collapse w-full text-[10px] sm:text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="sticky left-0 z-10 bg-[var(--color-surface)] px-2 py-1.5 text-left t-meta font-semibold text-[var(--color-text-sub)] min-w-[70px]">Symbol</th>
                    <th className="px-2 py-1.5 text-center t-meta font-semibold text-[var(--color-text-sub)] min-w-[55px]">Grade</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[60px]">Price</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[50px]">POC</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[50px]">HVN</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[50px]">LVN</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[60px]">VWAP</th>
                    <th className="px-2 py-1.5 text-left t-meta font-semibold text-[var(--color-text-sub)] min-w-[70px]">Trend</th>
                    <th className="px-2 py-1.5 text-left t-meta font-semibold text-[var(--color-text-sub)] min-w-[110px]">EMA Stack</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(d => {
                    const syn = d.analysis?.synthesis
                    const bias = syn?.consensus_bias || d.scan?.bias || 'neutral'
                    const sideColor = bias === 'long' ? 'text-[var(--color-up)]' : bias === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'
                    const arrow = bias === 'long' ? '\u25B2' : bias === 'short' ? '\u25BC' : ''
                    const grade = getTradeGrade(d)
                    const mm = massiveMetrics[d.symbol] || {}
                    const mmVp = mm.volume_profile || {}
                    const mmVwap = mm.vwap || {}
                    const vp = { ...mmVp, ...mmVwap, ...(syn?.volume_profile || d.scan?.volume_profile || {}) }
                    const trendBias = syn?.consensus_bias || d.scan?.bias || 'neutral'
                    const trendLabel = trendBias === 'long' ? 'Bullish' : trendBias === 'short' ? 'Bearish' : 'Sideways'
                    const trendColor = trendBias === 'long' ? 'text-[var(--color-up)]' : trendBias === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'
                    const emaStack = syn?.ema_stack || d.scan?.ema_stack || null

                    return (
                      <tr
                        key={d.symbol}
                        className="border-b border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]/30 cursor-pointer"
                        onClick={() => scrollToSymbol(d.symbol)}
                      >
                        <td className="sticky left-0 z-10 bg-[var(--color-surface)] px-2 py-1.5">
                          <span className={`font-bold ${sideColor} hover:underline`}>{arrow} {d.symbol}</span>
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <Badge tone={GRADE_TONE[grade]} className="text-[8px] px-1">{GRADE_LABEL[grade]}</Badge>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text)]">
                          {syn?.entry || d.scan?.price || mm.price || '\u2014'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                          {vp.poc || '\u2014'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                          {vp.hvn || '\u2014'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                          {vp.lvn || '\u2014'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                          {vp[`vwap_${vwapPeriod}`] || vp.vwap || '\u2014'}
                        </td>
                        <td className={`px-2 py-1.5 text-left font-semibold ${trendColor}`}>
                          {trendLabel}
                        </td>
                        <td className="px-2 py-1.5 text-left text-[var(--color-text-sub)] truncate max-w-[140px]">
                          {emaStack || '\u2014'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ── Impact colour helpers ──

const IMPACT_TONE = { high: 'down', medium: 'warning', low: 'neutral' }
const CATEGORY_ICON = {
  economic: '\u{1F4CA}',
  holiday: '\u{1F3D6}',
  earnings: '\u{1F4B0}',
  political: '\u{1F3DB}',
  'central-bank': '\u{1F3E6}',
  sector: '\u{1F3ED}',
}

// ── Calendar card ──

function CalendarCard({ events, loading, onRefresh }) {
  const [range, setRange] = useState('week') // today | week | month

  const filtered = useMemo(() => {
    if (!events || events.length === 0) return []
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
    const weekEnd = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10)
    const monthEnd = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10)

    let cutoff = monthEnd
    if (range === 'today') cutoff = tomorrow
    else if (range === 'week') cutoff = weekEnd

    return events.filter(e => e.date >= today && e.date < cutoff)
  }, [events, range])

  // Group by date
  const grouped = useMemo(() => {
    const groups = {}
    for (const e of filtered) {
      if (!groups[e.date]) groups[e.date] = []
      groups[e.date].push(e)
    }
    return groups
  }, [filtered])

  const dateKeys = Object.keys(grouped).sort()

  const fmtDate = (d) => {
    const dt = new Date(d + 'T00:00:00')
    const today = new Date().toISOString().slice(0, 10)
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    if (d === today) return 'Today'
    if (d === tomorrow) return 'Tomorrow'
    return dt.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="t-label">Market Calendar</h2>
        <div className="flex items-center gap-1">
          {['today', 'week', 'month'].map(r => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-[10px] rounded-[4px] font-bold cursor-pointer ${
                range === r
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-bg)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]'
              }`}
            >
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading} className="ml-1">
            {loading ? 'Loading...' : '\u21BB'}
          </Button>
        </div>
      </div>

      {filtered.length === 0 && !loading && (
        <p className="t-sub text-[var(--color-muted)] py-3 text-center">
          No events loaded. Click refresh to generate the calendar.
        </p>
      )}

      {dateKeys.length > 0 && (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {dateKeys.map(date => (
            <div key={date}>
              <p className="t-meta font-bold text-[var(--color-text)] sticky top-0 bg-[var(--color-surface)] py-0.5">
                {fmtDate(date)}
              </p>
              <div className="space-y-0.5 pl-2 border-l-2 border-[var(--color-border)]">
                {grouped[date].map((e, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px]">
                    <span className="shrink-0 w-[38px] font-mono text-[var(--color-muted)]">
                      {e.time === 'all-day' ? 'all' : e.time || '--:--'}
                    </span>
                    <span className="shrink-0">{CATEGORY_ICON[e.category] || '\u25CF'}</span>
                    <Badge
                      tone={IMPACT_TONE[e.impact] || 'neutral'}
                      className="shrink-0 text-[8px] px-1"
                    >
                      {e.impact?.toUpperCase()}
                    </Badge>
                    <span className="text-[var(--color-text)]">
                      <span className="font-semibold">{e.event}</span>
                      {e.currency && (
                        <span className="text-[var(--color-accent)] ml-1">{e.currency}</span>
                      )}
                    </span>
                    {e.details && (
                      <span className="text-[var(--color-muted)] truncate hidden sm:inline">
                        {e.details}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ── Main page ──

export default function Feed() {
  const { state, dispatch } = useStrategy()
  const [log, setLog] = useState([])
  const [scanResults, setScanResults] = useState({})
  const [analyses, setAnalyses] = useState({})
  const [deskNote, setDeskNote] = useState(null)
  const [agentStates, setAgentStates] = useState({})
  const [lastScanAt, setLastScanAt] = useState(null)
  const [countdown, setCountdown] = useState(0)
  const [tokenCount, setTokenCount] = useState(0)
  const [agentTokens, setAgentTokens] = useState({})
  const [agentCalls, setAgentCalls] = useState({})
  const [orderFor, setOrderFor] = useState(null)
  const [toast, setToast] = useState(null)
  const [monitoredTrades, setMonitoredTrades] = useState([])
  const [sessionStart] = useState(() => Date.now())
  const [symbolsCollapsed, setSymbolsCollapsed] = useState(false)
  const [activityCollapsed, setActivityCollapsed] = useState(false)
  const [matrixCollapsed, setMatrixCollapsed] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [autoTradeActive, setAutoTradeActive] = useState(false)
  const [autoTradeCountdown, setAutoTradeCountdown] = useState(0)
  const [autoTradeCount, setAutoTradeCount] = useState(0)
  const [calendarEvents, setCalendarEvents] = useState([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [symbolEventLines, setSymbolEventLines] = useState({})
  const [massiveMetrics, setMassiveMetrics] = useState({}) // { AAPL: { volume_profile, vwap, risk_metrics, ... } }

  const scanTimerRef = useRef(null)

  // Show scroll-to-top when scrolled past 400px
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Track per-agent token usage
  const trackTokens = useCallback((agent, tokens) => {
    if (!tokens || tokens <= 0) return
    setTokenCount(prev => prev + tokens)
    setAgentTokens(prev => ({ ...prev, [agent]: (prev[agent] || 0) + tokens }))
    setAgentCalls(prev => ({ ...prev, [agent]: (prev[agent] || 0) + 1 }))
  }, [])

  const addLog = useCallback((agent, message, extra = {}) => {
    setLog(prev => [...prev, logEntry(agent, message, extra)])
  }, [])

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  const enabledSymbols = useMemo(
    () => state.watchlist.filter(w => w.enabled),
    [state.watchlist],
  )
  const enabledCount = enabledSymbols.length
  const isArmed = state.risk.armed

  // ── Telegram helper ──
  const sendTelegramAlert = useCallback((body) => {
    const tg = state.telegram
    if (!tg.enabled || !tg.botToken || !tg.chatId) return
    apiPost('/api/telegram', { ...body, botToken: tg.botToken, chatId: tg.chatId }).catch(() => {})
  }, [state.telegram])

  // ── Massive compute — fetch real metrics for stock symbols ──
  const fetchMassiveMetrics = useCallback(async (symbols) => {
    if (!state.massive.apiKey) return
    // Only compute for stock symbols that Massive supports (US stocks)
    const stockSymbols = symbols
      .filter(s => {
        const w = state.watchlist.find(w => w.symbol === s)
        return w?.category === 'Stocks'
      })
      .filter(s => !massiveMetrics[s]) // skip already computed
    if (stockSymbols.length === 0) return

    addLog('massive', `Computing metrics for ${stockSymbols.length} stocks...`)
    try {
      const data = await apiPost('/api/massive-compute', {
        action: 'batch-compute',
        apiKey: state.massive.apiKey,
        tickers: stockSymbols,
      })
      if (data.results) {
        setMassiveMetrics(prev => ({ ...prev, ...data.results }))
        const ok = Object.values(data.results).filter(r => !r.error).length
        addLog('massive', `Computed: ${ok}/${stockSymbols.length} stocks`)
      }
    } catch (e) {
      addLog('massive', `Compute failed: ${e.message}`)
    }
  }, [state.massive.apiKey, state.watchlist, massiveMetrics, addLog])

  // ── Trade monitor helpers (must be defined before runAnalyst) ──
  const addMonitoredTrade = useCallback((trade) => {
    setMonitoredTrades(prev => {
      if (prev.some(t => t.symbol === trade.symbol)) return prev
      return [...prev, trade]
    })
    setAgentStates(prev => ({ ...prev, monitor: 'running' }))
    // Register server-side so it survives browser close
    const tg = state.telegram
    apiPost('/api/monitor-manage', {
      action: 'register',
      symbol: trade.symbol,
      side: trade.side,
      entry: trade.entry,
      sl: trade.sl,
      tp: trade.tp,
      volume: trade.volume,
      thesis: trade.thesis,
      placedAt: trade.placedAt,
      telegramBotToken: tg.enabled ? tg.botToken : null,
      telegramChatId: tg.enabled ? tg.chatId : null,
    }).then(res => {
      if (res.id) addLog('monitor', `Registered server-side: ${trade.symbol} (${res.id})`, { symbol: trade.symbol })
    }).catch(() => {
      addLog('monitor', `Server registration failed for ${trade.symbol} — client-only monitoring`, { symbol: trade.symbol })
    })
  }, [state.telegram, addLog])

  const stopTrade = useCallback(async (trade) => {
    addLog('monitor', `Stopping ${trade.symbol} position...`, { symbol: trade.symbol })
    try {
      if (state.ctrader.linkedAccountId) {
        await apiPost('/api/ctrader', {
          action: 'close-position',
          accountId: state.ctrader.linkedAccountId,
          symbolName: trade.symbol,
        })
      }
      setMonitoredTrades(prev => prev.filter(t => t.symbol !== trade.symbol))
      addLog('monitor', `${trade.symbol} position STOPPED`, { symbol: trade.symbol })
      sendTelegramAlert({
        action: 'send-alert', alertType: 'trade',
        trade: { symbol: trade.symbol, side: trade.side, action: 'CLOSED/STOPPED' },
      })
      showToast(`${trade.symbol} position stopped`)
    } catch (e) {
      addLog('monitor', `Failed to stop ${trade.symbol}: ${e.message}`, { symbol: trade.symbol })
      showToast(`Failed to stop: ${e.message}`)
    }
  }, [state.ctrader.linkedAccountId, addLog, sendTelegramAlert, showToast])

  const updateMonitoredTrade = useCallback((symbol, updates) => {
    setMonitoredTrades(prev =>
      prev.map(t => t.symbol === symbol ? { ...t, ...updates } : t),
    )
  }, [])

  // ── Analyst deep dive (defined before runScout so it can be referenced) ──
  const analystRef = useRef(null)

  const runAnalyst = useCallback(async (symbol) => {
    setAgentStates(prev => ({ ...prev, analyst: 'running' }))
    const wItem = state.watchlist.find(w => w.symbol === symbol)
    const threshold = wItem?.autoTradeThreshold || 8

    addLog('analyst', `Dispatching minions...`, { symbol })

    try {
      const data = await apiPost('/api/analyze', { symbol, autoTradeThreshold: threshold })

      setAnalyses(prev => ({ ...prev, [symbol]: data }))
      if (data.usage?.output_tokens) trackTokens('analyst', data.usage.output_tokens)

      for (const r of (data.reports || [])) {
        addLog('analyst', `${r.bias?.toUpperCase()} ${r.conviction}/10 \u2014 ${r.report}`, {
          symbol, minionName: r.name, icon: r.icon,
        })
      }

      const syn = data.synthesis
      if (syn) {
        // Enrich symbolStats with analysis-level data
        const synBias = (syn.consensus_bias || '').toLowerCase()
        const conv = syn.overall_conviction || 0
        const synText = (syn.synthesis || '').toLowerCase()
        const prevStats = state.symbolStats?.[symbol] || {}
        dispatch({
          type: 'SYMBOL_STATS_UPDATE',
          statsMap: {
            [symbol]: {
              ...prevStats,
              trend: (synBias === 'long' || synBias === 'short') && conv >= 5,
              high: conv >= 7,
              dip: synBias === 'long' && (synText.includes('dip') || synText.includes('pullback') || synText.includes('bounce') || synText.includes('revert')),
              aboveHvn: synText.includes('above hvn') || synText.includes('> hvn'),
              belowHvn: synText.includes('below hvn') || synText.includes('< hvn'),
              insidePoc: synText.includes('inside poc') || synText.includes('near poc') || synText.includes('at poc'),
            },
          },
        })

        addLog('synthesis', `${syn.consensus_summary || ''} \u2014 Conviction ${syn.overall_conviction}/10. ${syn.auto_trade ? 'AUTO-TRADE ELIGIBLE.' : 'Manual approval needed.'}`, { symbol })

        if (syn.dissent) {
          addLog('synthesis', `Dissent: ${syn.dissent}`, { symbol })
        }

        if (syn.auto_trade && isArmed && syn.entry != null) {
          addLog('trader', `Auto-trade triggered. Placing ${syn.consensus_bias?.toUpperCase()} order...`, { symbol })
          try {
            const orderBody = {
              action: 'new-market-order',
              accountId: state.ctrader.linkedAccountId,
              symbolName: symbol,
              orderType: 'MARKET',
              tradeSide: syn.consensus_bias === 'short' ? 'SELL' : 'BUY',
              volume: (wItem?.maxVolume || 0.01) * 100,
              stopLoss: syn.sl || undefined,
              takeProfit: syn.tp1 || undefined,
            }
            await apiPost('/api/ctrader', orderBody)
            addLog('trader', `Order placed! ${syn.consensus_bias?.toUpperCase()} @ market`, { symbol })
            setAgentCalls(prev => ({ ...prev, trader: (prev.trader || 0) + 1 })) // ctrader doesn't return tokens
            // Monitor the auto-trade
            addMonitoredTrade({
              symbol,
              side: syn.consensus_bias === 'short' ? 'SELL' : 'BUY',
              entry: syn.entry,
              sl: syn.sl,
              tp: syn.tp1,
              volume: wItem?.maxVolume || 0.01,
              thesis: syn.synthesis || '',
              placedAt: Date.now(),
            })
            sendTelegramAlert({
              action: 'send-alert', alertType: 'trade',
              trade: { symbol, side: syn.consensus_bias, entry: syn.entry, stopLoss: syn.sl, takeProfit: syn.tp1, action: 'AUTO-TRADE', message: syn.synthesis },
            })
            addLog('telegram', `Trade alert sent`, { symbol })
          } catch (e) {
            addLog('trader', `Order FAILED: ${e.message}`, { symbol })
          }
        }
      }

      setAgentStates(prev => ({ ...prev, analyst: 'done' }))
    } catch (e) {
      addLog('analyst', `FAILED: ${e.message}`, { symbol })
      setAgentStates(prev => ({ ...prev, analyst: 'idle' }))
    }
  }, [state.watchlist, state.symbolStats, state.ctrader.linkedAccountId, isArmed, addLog, sendTelegramAlert, trackTokens, addMonitoredTrade, dispatch])

  // Keep ref in sync so runScout can call it without circular deps
  useEffect(() => { analystRef.current = runAnalyst }, [runAnalyst])

  // ── Scout scan ──
  const runScout = useCallback(async () => {
    if (enabledSymbols.length === 0) return
    setAgentStates(prev => ({ ...prev, scout: 'running' }))
    addLog('scout', `Scanning ${enabledSymbols.length} symbols...`)

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore'

    // Enrich symbols with trading status for the scanner
    const enriched = enabledSymbols.map(w => {
      const trading = isTradingNow(w.symbol)
      const hours = getHoursForSymbol(w.symbol)
      let nextOpen = ''
      if (!trading && hours.length > 0) {
        const utcNow = new Date().getUTCHours()
        // Find next open hour
        const opens = hours.map(h => h.open).sort((a, b) => a - b)
        const next = opens.find(h => h > utcNow) || opens[0]
        nextOpen = `${String(next).padStart(2, '0')}:00 UTC`
      }
      return { ...w, tradingNow: trading, nextOpen }
    })

    try {
      const data = await apiPost('/api/scan', { symbols: enriched, timezone: tz })

      const map = {}
      for (const s of (data.scans || [])) {
        if (s.symbol) map[s.symbol.toUpperCase()] = s
      }
      setScanResults(map)
      setLastScanAt(Date.now())
      if (data.desk_note) setDeskNote(data.desk_note)
      if (data.usage?.output_tokens) trackTokens('scout', data.usage.output_tokens)

      const hotSymbols = data.hot || []
      const warmSymbols = data.warm || []
      addLog('scout', `Done. ${hotSymbols.length} hot, ${warmSymbols.length} warm.`)

      for (const s of (data.scans || [])) {
        addLog('scout', `${s.bias?.toUpperCase()} ${s.confidence}/10 \u2014 ${s.thesis || 'no thesis'}`, {
          symbol: s.symbol,
        })
        if (hotSymbols.includes(s.symbol)) {
          addLog('scout', `HOT \u2014 kicking to ANALYST`, { symbol: s.symbol })
        }
      }

      setAgentStates(prev => ({ ...prev, scout: 'done' }))

      // Derive per-symbol stats from scan results for the category headers
      const statsMap = {}
      for (const s of (data.scans || [])) {
        if (!s.symbol) continue
        const sym = s.symbol.toUpperCase()
        const c = s.confidence || 0
        const bias = (s.bias || '').toLowerCase()
        const thesis = (s.thesis || '').toLowerCase()
        statsMap[sym] = {
          trend: (bias === 'long' || bias === 'short') && c >= 5,
          high: c >= 7,
          dip: bias === 'long' && (thesis.includes('dip') || thesis.includes('pullback') || thesis.includes('revert') || thesis.includes('bounce')),
          aboveHvn: false,
          belowHvn: false,
          insidePoc: false,
        }
      }
      dispatch({ type: 'SYMBOL_STATS_UPDATE', statsMap })

      // Fetch Massive computed metrics for stock symbols (non-blocking)
      const scannedSymbols = (data.scans || []).map(s => s.symbol).filter(Boolean)
      fetchMassiveMetrics(scannedSymbols)

      // Fire Telegram scan alert
      if (data.scans?.length) {
        const tg = state.telegram
        if (tg.enabled && tg.alertOnScan) {
          const filtered = data.scans.filter(s => s.confidence == null || s.confidence >= tg.minConfidence)
          if (filtered.length > 0) {
            sendTelegramAlert({
              action: 'send-alert', alertType: 'scan',
              scans: filtered, deskNote: data.desk_note, session: data.session,
            })
            addLog('telegram', `Scan alert sent (${filtered.length} setups)`)
          }
        }
      }

      // Auto-dispatch analyst for hot symbols via ref
      for (const sym of hotSymbols) {
        analystRef.current?.(sym)
      }

      return { hot: hotSymbols, warm: warmSymbols }
    } catch (e) {
      addLog('scout', `FAILED: ${e.message}`)
      setAgentStates(prev => ({ ...prev, scout: 'idle' }))
      showToast(`Scout failed: ${e.message}`)
      return null
    }
  }, [enabledSymbols, addLog, showToast, state.telegram, sendTelegramAlert, trackTokens, dispatch, fetchMassiveMetrics])

  // ── Arm / Disarm ──
  const handleArm = useCallback(() => {
    dispatch({ type: 'RISK_TOGGLE_ARMED' })
    if (!isArmed) {
      addLog('system', 'System ARMED. Scout starting...')
      setCountdown(0)
      // Immediate scan on arm
      setTimeout(() => runScout().then(() => setCountdown(SCAN_INTERVAL)), 100)
    } else {
      addLog('system', 'System DISARMED. All agents idle.')
      setAgentStates({ scout: 'idle', analyst: 'idle', trader: 'idle', monitor: 'idle' })
      setCountdown(0)
    }
  }, [isArmed, dispatch, addLog, runScout])

  // ── Manual scan ──
  const handleManualScan = useCallback(() => {
    setCountdown(0)
    runScout().then(() => setCountdown(SCAN_INTERVAL))
  }, [runScout])

  // ── Auto-scan loop when armed ──
  useEffect(() => {
    if (!isArmed || enabledCount === 0) {
      if (scanTimerRef.current) clearInterval(scanTimerRef.current)
      return
    }
    scanTimerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          runScout().then(() => setCountdown(SCAN_INTERVAL))
          return SCAN_INTERVAL
        }
        return prev - 1
      })
    }, 1000)
    return () => { if (scanTimerRef.current) clearInterval(scanTimerRef.current) }
  }, [isArmed, enabledCount, runScout])

  // ── Auto-trade toggle ──
  const handleAutoTrade = useCallback(() => {
    if (autoTradeActive) {
      setAutoTradeActive(false)
      setAutoTradeCountdown(0)
      addLog('trader', 'Auto-trade STOPPED.')
    } else {
      setAutoTradeActive(true)
      setAutoTradeCountdown(300) // 5 min countdown per cycle
      addLog('trader', 'Auto-trade STARTED. Will execute eligible setups.')
    }
  }, [autoTradeActive, addLog])

  // Auto-trade countdown tick
  useEffect(() => {
    if (!autoTradeActive) return
    const id = setInterval(() => {
      setAutoTradeCountdown(prev => {
        if (prev <= 1) {
          // Trigger scan + auto-trade cycle
          runScout()
          return 300
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [autoTradeActive, runScout])

  // Track auto-trades (count placements from auto-trade)
  useEffect(() => {
    const count = monitoredTrades.filter(t => t.placedAt > sessionStart).length
    setAutoTradeCount(count)
  }, [monitoredTrades, sessionStart])

  // ── Calendar ──
  const fetchCalendar = useCallback(async () => {
    setCalendarLoading(true)
    try {
      const syms = enabledSymbols.map(w => w.symbol)
      const data = await apiPost('/api/calendar', { action: 'generate', symbols: syms })
      const events = data.events || []
      setCalendarEvents(events)
      if (data.usage?.output_tokens) trackTokens('calendar', data.usage.output_tokens)

      // Generate per-symbol event lines
      const lines = {}
      for (const sym of syms.slice(0, 20)) {
        const relevant = events.filter(e =>
          (e.symbols || []).some(s => s.toUpperCase() === sym.toUpperCase()) ||
          (e.currency && sym.toUpperCase().includes(e.currency)),
        )
        if (relevant.length > 0) {
          const ev = relevant[0]
          const d = new Date(ev.date + 'T00:00:00')
          const dd = String(d.getDate()).padStart(2, '0')
          const mm = String(d.getMonth() + 1).padStart(2, '0')
          lines[sym] = `${dd}/${mm} ${ev.event}${ev.details ? ' - ' + ev.details : ''}`
        }
      }
      setSymbolEventLines(lines)
    } catch (e) {
      addLog('calendar', `Failed: ${e.message}`)
    } finally {
      setCalendarLoading(false)
    }
  }, [enabledSymbols, addLog, trackTokens])

  // ── Order dialog ──
  const handleOpenOrder = useCallback((symbol, synthesis) => {
    setOrderFor({ symbol, synthesis })
  }, [])

  const handleConfirmOrder = useCallback(async (order) => {
    addLog('trader', `Placing ${order.orderType} ${order.side} order...`, { symbol: order.symbol })
    const body = {
      action: order.orderType === 'market' ? 'new-market-order' : 'new-limit-order',
      accountId: state.ctrader.linkedAccountId,
      symbolName: order.symbol,
      orderType: order.orderType === 'market' ? 'MARKET' : order.orderType === 'limit' ? 'LIMIT' : 'STOP',
      tradeSide: order.side,
      volume: (order.volume || 0.01) * 100,
      stopLoss: order.stopLoss || undefined,
      takeProfit: order.takeProfit || undefined,
      limitPrice: order.limitPrice || undefined,
    }
    try {
      await apiPost('/api/ctrader', body)
      addLog('trader', `Order placed!`, { symbol: order.symbol })
    } catch (e) {
      addLog('trader', `Order failed: ${e.message}`, { symbol: order.symbol })
      showToast(`Order failed: ${e.message}`)
    }
    // Always add to monitor and send alerts (even if ctrader API fails,
    // we want to track the intent)
    sendTelegramAlert({
      action: 'send-alert', alertType: 'trade',
      trade: { symbol: order.symbol, side: order.side, entry: order.limitPrice || 'market', stopLoss: order.stopLoss, takeProfit: order.takeProfit, action: order.orderType.toUpperCase() },
    })
    addMonitoredTrade({
      symbol: order.symbol,
      side: order.side,
      entry: order.limitPrice || 'market',
      sl: order.stopLoss,
      tp: order.takeProfit,
      volume: order.volume,
      thesis: orderFor?.synthesis?.synthesis || '',
      placedAt: Date.now(),
    })
    showToast(`Order placed for ${order.symbol}`)
    setOrderFor(null)
  }, [state.ctrader.linkedAccountId, addLog, sendTelegramAlert, showToast, addMonitoredTrade, orderFor])

  // ── Ask dock context ──
  const askContext = useMemo(() => ({
    watchlist: state.watchlist,
    rundown: state.news.latestRundown,
    scanResults,
    analyses,
  }), [state.watchlist, state.news.latestRundown, scanResults, analyses])

  const handleAskReply = useCallback((_q, data) => {
    if (data?.usage?.output_tokens) trackTokens('analyst', data.usage.output_tokens)
  }, [trackTokens])

  // ── Sorted symbols for display ──
  const displaySymbols = useMemo(() => {
    return enabledSymbols
      .map(w => ({
        symbol: w.symbol,
        scan: scanResults[w.symbol] || null,
        analysis: analyses[w.symbol] || null,
        confidence: analyses[w.symbol]?.synthesis?.overall_conviction || scanResults[w.symbol]?.confidence || 0,
      }))
      .sort((a, b) => b.confidence - a.confidence)
  }, [enabledSymbols, scanResults, analyses])

  const scanning = agentStates.scout === 'running'

  return (
    <section className="space-y-3">
      {/* Command strip */}
      <TradingFloor
        agentStates={agentStates}
        countdown={countdown}
        lastScanAt={lastScanAt}
        liveCount={0}
        pendingCount={Object.keys(analyses).length}
        riskUsed={0}
        onArm={handleArm}
        onScan={handleManualScan}
        enabledCount={enabledCount}
        scanning={scanning}
        autoTradeCount={autoTradeCount}
        onAutoTrade={handleAutoTrade}
        autoTradeCountdown={autoTradeActive ? autoTradeCountdown : 0}
      />

      {/* Desk note */}
      {deskNote && (
        <Card>
          <p className="t-label mb-1">Desk Notes</p>
          <p className="t-sub text-[var(--color-text-sub)] whitespace-pre-line">{deskNote}</p>
        </Card>
      )}

      {/* Activity log */}
      <ActivityLog
        entries={log}
        collapsed={activityCollapsed}
        onToggle={() => setActivityCollapsed(prev => !prev)}
      />

      {/* Market calendar */}
      <CalendarCard
        events={calendarEvents}
        loading={calendarLoading}
        onRefresh={fetchCalendar}
      />

      {/* Summary matrix */}
      {displaySymbols.length > 0 && (
        <SummaryMatrix
          symbols={displaySymbols}
          scanning={scanning}
          collapsed={matrixCollapsed}
          onToggle={() => setMatrixCollapsed(prev => !prev)}
          massiveMetrics={massiveMetrics}
        />
      )}

      {/* Symbol cards */}
      {displaySymbols.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div
              className="flex items-center gap-2 cursor-pointer"
              onClick={() => setSymbolsCollapsed(prev => !prev)}
            >
              <span className="text-[10px] text-[var(--color-muted)]">{symbolsCollapsed ? '\u25B6' : '\u25BC'}</span>
              <p className="t-label">{displaySymbols.length} Symbols Active</p>
            </div>
            {displaySymbols.some(d => d.scan) && (
              <div className="flex gap-2 t-meta text-[var(--color-muted)]">
                {(() => {
                  const counts = { potential: 0, weak: 0, none: 0 }
                  displaySymbols.forEach(d => { counts[getTradeGrade(d)]++ })
                  return (
                    <>
                      {counts.potential > 0 && <Badge tone="up" pill>{counts.potential} potential</Badge>}
                      {counts.weak > 0 && <Badge tone="warning" pill>{counts.weak} weak</Badge>}
                      {counts.none > 0 && <Badge tone="neutral" pill>{counts.none} no trade</Badge>}
                    </>
                  )
                })()}
              </div>
            )}
          </div>
          {!symbolsCollapsed && (() => {
            // Sort by trade grade: potential first, then weak, then none
            const sorted = [...displaySymbols].sort((a, b) => {
              const ga = GRADE_ORDER[getTradeGrade(a)] ?? 2
              const gb = GRADE_ORDER[getTradeGrade(b)] ?? 2
              if (ga !== gb) return ga - gb
              return b.confidence - a.confidence
            })
            return sorted.map(d => (
              <SymbolCard
                key={d.symbol}
                symbol={d.symbol}
                scan={d.scan}
                analysis={d.analysis}
                onOrder={handleOpenOrder}
                eventLine={symbolEventLines[d.symbol] || null}
              />
            ))
          })()}
        </div>
      )}

      {/* Empty state */}
      {enabledCount === 0 && (
        <Card className="text-center py-8">
          <p className="t-body text-[var(--color-text-sub)] mb-2">No symbols enabled.</p>
          <p className="t-meta text-[var(--color-muted)]">Enable symbols in Settings, then Arm the system.</p>
        </Card>
      )}

      {/* Ask dock */}
      <AskDock context={askContext} onAsk={handleAskReply} />

      {/* Trade monitor */}
      <TradeMonitor
        trades={monitoredTrades}
        onStop={stopTrade}
        onUpdate={updateMonitoredTrade}
        onLog={addLog}
      />

      <BottomBar
        tokenCount={tokenCount}
        agentStates={agentStates}
        agentTokens={agentTokens}
        agentCalls={agentCalls}
        monitoredCount={monitoredTrades.length}
        sessionStart={sessionStart}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-[8px] bg-[var(--color-text)] text-[var(--color-surface)] t-sub max-w-sm text-center">
          {toast}
        </div>
      )}

      {/* Order dialog */}
      {orderFor && (
        <OrderDialog
          symbol={orderFor.symbol}
          synthesis={orderFor.synthesis}
          maxVolume={state.watchlist.find(w => w.symbol === orderFor.symbol)?.maxVolume || 0.01}
          onConfirm={handleConfirmOrder}
          onCancel={() => setOrderFor(null)}
        />
      )}

      {/* Scroll to top */}
      {showScrollTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed right-4 bottom-14 z-40 w-10 h-10 rounded-full bg-[var(--color-accent)] text-white flex items-center justify-center shadow-lg hover:opacity-90 transition-opacity"
          aria-label="Scroll to top"
        >
          {'\u2191'}
        </button>
      )}
    </section>
  )
}
