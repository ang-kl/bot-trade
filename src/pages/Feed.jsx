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

const SCAN_INTERVAL = 30 * 60 // 30 minutes in seconds
const SCAN_CACHE_KEY = 'bot-trade:scan-cache'
const MONITOR_KEY = 'bot-trade:agent-monitor'

const TRADES_KEY = 'bot-trade:monitored-trades'

function readScanCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function readMonitoredTrades() {
  try { return JSON.parse(localStorage.getItem(TRADES_KEY) || '[]') } catch { return [] }
}

function writeScanCache(data) {
  try { localStorage.setItem(SCAN_CACHE_KEY, JSON.stringify(data)) } catch {}
}

function writeMonitorState(data) {
  try { localStorage.setItem(MONITOR_KEY, JSON.stringify(data)) } catch {}
}

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

// ── Currency helpers ──

const SYMBOL_CCY = {
  EURUSD: 'USD', GBPUSD: 'USD', AUDUSD: 'USD', NZDUSD: 'USD',
  USDJPY: 'JPY', AUDJPY: 'JPY', GBPJPY: 'JPY', EURJPY: 'JPY', CADJPY: 'JPY',
  USDCAD: 'CAD', USDCHF: 'CHF', EURGBP: 'GBP', EURCHF: 'CHF',
  XAUUSD: 'USD', XAGUSD: 'USD',
  BTCUSD: 'USD', ETHUSD: 'USD', SOLUSD: 'USD',
  NAS100: 'USD', USTEC: 'USD', US30: 'USD', US500: 'USD',
  GER40: 'EUR', JPN225: 'JPY', CN50: 'CNY', ASX200: 'AUD',
  COPPER: 'USD', NATGAS: 'USD', SPOTCRUDE: 'USD', COCOA: 'USD',
}

const CCY_SIGN = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', AUD: 'A$', CAD: 'C$', CHF: 'Fr', NZD: 'NZ$', CNY: '¥',
}

function getCcy(symbol) {
  if (SYMBOL_CCY[symbol]) return SYMBOL_CCY[symbol]
  if (/USD$/.test(symbol)) return 'USD'
  if (/JPY$/.test(symbol)) return 'JPY'
  return 'USD'
}

function fmtP(v) {
  if (v == null || v === '' || v === 0) return '\u2014'
  const n = Number(v)
  if (!Number.isFinite(n)) return '\u2014'
  return n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
}

// ── Symbol result card ──

function SymbolCard({ symbol, scan, analysis, onOrder, onAnalyse, eventLine, defaultCollapsed = false }) {
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
          <span className="text-[8px] text-[var(--color-muted)]">{CCY_SIGN[getCcy(symbol)] || '$'}</span>
          <span>Entry: <span className="font-mono font-semibold">{fmtP(synthesis.entry)}</span></span>
          {synthesis.sl != null && <span className="text-[var(--color-down)]">SL: {fmtP(synthesis.sl)}</span>}
          {synthesis.tp1 != null && <span className="text-[var(--color-up)]">TP1: {fmtP(synthesis.tp1)}</span>}
          {synthesis.tp2 != null && <span className="text-[var(--color-up)]">TP2: {fmtP(synthesis.tp2)}</span>}
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
        {!hasAnalysis && scan && !isSkip && conviction >= 4 && (
          <Button size="sm" variant="ghost" onClick={() => onAnalyse?.(symbol)} className="!py-0.5 !px-2 text-[10px]">
            Analyse ↗
          </Button>
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

function SummaryMatrix({ symbols, scanning, collapsed, onToggle, massiveMetrics = {}, onRefreshMetrics }) {
  const [vwapPeriod, setVwapPeriod] = useState('today')

  const hasAnyScan = symbols.some(d => d.scan)
  const hasAnyMetrics = symbols.some(d => massiveMetrics[d.symbol])

  // Sort: scanned symbols first (by grade/confidence), then unscanned (alphabetical)
  const sorted = useMemo(() => {
    return [...symbols].sort((a, b) => {
      const ga = GRADE_ORDER[getTradeGrade(a)] ?? 2
      const gb = GRADE_ORDER[getTradeGrade(b)] ?? 2
      if (ga !== gb) return ga - gb
      if (a.confidence !== b.confidence) return b.confidence - a.confidence
      return a.symbol.localeCompare(b.symbol)
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
          {scanning && <span className="animate-pulse text-[var(--color-accent)] text-[10px]">scanning...</span>}
        </div>
        {!collapsed && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="t-meta text-[var(--color-muted)] mr-1">VWAP:</span>
            {VWAP_PERIODS.map(p => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  setVwapPeriod(p.key)
                  if (onRefreshMetrics) onRefreshMetrics()
                }}
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
          {/* Show table immediately — technical data first, scan data fills in later */}
          {!hasAnyScan && !hasAnyMetrics && (
            <div className="flex items-center gap-2 py-4 justify-center">
              {scanning ? (
                <>
                  <span className="animate-pulse text-[var(--color-accent)] text-[14px]">{'\u25CF'}</span>
                  <span className="t-sub text-[var(--color-muted)]">Loading technical data and scanning symbols...</span>
                </>
              ) : (
                <span className="t-sub text-[var(--color-muted)]">Arm the system and run a scan to populate the matrix</span>
              )}
            </div>
          )}

          {(hasAnyScan || hasAnyMetrics) && (
            <div className="overflow-x-auto -mx-2 px-0">
              <table className="border-collapse w-full text-[10px] sm:text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="sticky left-0 z-10 bg-[var(--color-surface)] px-2 py-1.5 text-left t-meta font-semibold text-[var(--color-text-sub)] min-w-[70px]">Symbol</th>
                    <th className="px-2 py-1.5 text-center t-meta font-semibold text-[var(--color-text-sub)] min-w-[55px]">Grade</th>
                    <th className="px-1 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[22px]">Ccy</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[70px]">Price</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[60px]">POC</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[60px]">HVN</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[60px]">LVN</th>
                    <th className="px-2 py-1.5 text-right t-meta font-semibold text-[var(--color-text-sub)] min-w-[70px]">VWAP</th>
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
                    const emaStack = mm.ema_stack?.stack || syn?.ema_stack || d.scan?.ema_stack || null
                    const ccy = getCcy(d.symbol)
                    const ccySign = CCY_SIGN[ccy] || ccy

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
                        <td className="px-1 py-1.5 text-right text-[8px] text-[var(--color-muted)]">
                          {ccySign}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text)]">
                          {fmtP(syn?.entry || d.scan?.price || mm.price)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                          {fmtP(vp.poc)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                          {fmtP(vp.hvn)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                          {fmtP(vp.lvn)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                          {fmtP(vp[`vwap_${vwapPeriod}`] || vp.vwap)}
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

// ── Main page ──

export default function Feed() {
  const { state, dispatch } = useStrategy()
  const [log, setLog] = useState([])
  const [scanResults, setScanResults] = useState(() => readScanCache()?.scanResults || {})
  const [analyses, setAnalyses] = useState({})
  const [deskNote, setDeskNote] = useState(null)
  const [agentStates, setAgentStates] = useState({})
  const [lastScanAt, setLastScanAt] = useState(() => readScanCache()?.lastScanAt || null)
  const [countdown, setCountdown] = useState(0)
  const [tokenCount, setTokenCount] = useState(0)
  const [agentTokens, setAgentTokens] = useState({})
  const [agentCalls, setAgentCalls] = useState({})
  const [orderFor, setOrderFor] = useState(null)
  const [toast, setToast] = useState(null)
  const [monitoredTrades, setMonitoredTrades] = useState(() => readMonitoredTrades())
  const [sessionStart] = useState(() => Date.now())
  const [symbolsCollapsed, setSymbolsCollapsed] = useState(false)
  const [activityCollapsed, setActivityCollapsed] = useState(false)
  const [matrixCollapsed, setMatrixCollapsed] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [autoTradeActive, setAutoTradeActive] = useState(false)
  const [autoTradeCountdown, setAutoTradeCountdown] = useState(0)
  const [autoTradeCount, setAutoTradeCount] = useState(0)
  const [massiveMetrics, setMassiveMetrics] = useState(() => readScanCache()?.massiveMetrics || {})

  const scanTimerRef = useRef(null)
  // Locks the card order after a scan — prevents re-sort when analyses trickle in
  const scanOrderRef = useRef([])
  const analysisQueueRef = useRef([]) // symbols queued for analysis
  const [analysing, setAnalysing] = useState(false)

  // Show scroll-to-top when scrolled past 400px
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Persist monitored trades across page navigations
  useEffect(() => {
    try { localStorage.setItem(TRADES_KEY, JSON.stringify(monitoredTrades)) } catch {}
  }, [monitoredTrades])

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

  // Sync monitoring state to localStorage for the Agent page
  useEffect(() => {
    writeMonitorState({
      sessionStart,
      agentStates,
      lastScanAt,
      tokenCount,
      agentTokens,
      agentCalls,
      enabledSymbols: enabledSymbols.map(w => w.symbol),
      monitoredTrades,
      armed: state.risk.armed,
      updatedAt: Date.now(),
    })
  }, [sessionStart, agentStates, lastScanAt, tokenCount, agentTokens, agentCalls, enabledSymbols, monitoredTrades, state.risk.armed])

  // ── Telegram helper ──
  const sendTelegramAlert = useCallback((body) => {
    const tg = state.telegram
    if (!tg.enabled || !tg.botToken || !tg.chatId) return
    apiPost('/api/telegram', { ...body, botToken: tg.botToken, chatId: tg.chatId }).catch(() => {})
  }, [state.telegram])

  // ── Refs for cache writes from inside callbacks ──
  const massiveMetricsRef = useRef(massiveMetrics)
  massiveMetricsRef.current = massiveMetrics
  const scanResultsRef = useRef(scanResults)
  scanResultsRef.current = scanResults
  const lastScanAtRef = useRef(lastScanAt)
  lastScanAtRef.current = lastScanAt

  const fetchMassiveMetrics = useCallback(async (symbols, force = false) => {
    if (!state.massive.apiKey) return
    const toFetch = symbols.filter(s => force || !massiveMetricsRef.current[s])
    if (toFetch.length === 0) return

    const mapTicker = (sym) => {
      const s = sym.toUpperCase()
      if (/^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|XAU|XAG)/.test(s) && s.length === 6) return `C:${s}`
      if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|DOT|LINK|AVAX|MATIC)/.test(s) && s.endsWith('USD')) return `X:${s}`
      return s
    }

    addLog('massive', `Computing metrics for ${toFetch.length} symbols...`)
    try {
      const data = await apiPost('/api/massive-compute', {
        action: 'batch-compute',
        apiKey: state.massive.apiKey,
        tickers: toFetch.map(mapTicker),
      })
      if (data.results) {
        const remapped = {}
        for (let i = 0; i < toFetch.length; i++) {
          const mappedKey = mapTicker(toFetch[i]).toUpperCase()
          if (data.results[mappedKey]) remapped[toFetch[i]] = data.results[mappedKey]
        }
        setMassiveMetrics(prev => {
          const merged = { ...prev, ...remapped }
          writeScanCache({ scanResults: scanResultsRef.current, massiveMetrics: merged, massiveCachedAt: Date.now(), lastScanAt: lastScanAtRef.current })
          return merged
        })
        const ok = Object.values(remapped).filter(r => !r.error).length
        addLog('massive', `Computed: ${ok}/${toFetch.length} symbols`)
      }
    } catch (e) {
      addLog('massive', `Compute failed: ${e.message}`)
    }
  }, [state.massive.apiKey, addLog])

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
        dispatch({
          type: 'ALERT_LOG_ADD',
          symbol,
          message: `Analysis: ${syn.consensus_bias?.toUpperCase()} ${syn.overall_conviction}/10 — ${syn.synthesis || syn.consensus_summary || ''}`,
          agent: 'analyst',
          status: syn.auto_trade ? 'alive' : 'done',
          tokens: data.usage?.output_tokens || 0,
        })

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
      const scanTime = Date.now()
      setLastScanAt(scanTime)
      writeScanCache({ scanResults: map, massiveMetrics: massiveMetricsRef.current, lastScanAt: scanTime })
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

      // Lock the card order to the scan order — prevents jerk when analyses trickle in
      scanOrderRef.current = (data.scans || []).map(s => s.symbol).filter(Boolean)

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

      // Fetch Massive computed metrics (non-blocking)
      const scannedSymbols = (data.scans || []).map(s => s.symbol).filter(Boolean)
      fetchMassiveMetrics(scannedSymbols)

      // Log hot symbols to alert log
      for (const sym of hotSymbols) {
        const s = (data.scans || []).find(x => x.symbol === sym)
        if (s) {
          dispatch({
            type: 'ALERT_LOG_ADD',
            symbol: sym,
            message: `Scout: ${s.bias?.toUpperCase()} ${s.confidence}/10 — ${s.thesis || ''}`,
            agent: 'scout',
            status: 'alive',
          })
        }
      }

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

      // ── NO auto-analysis — user clicks "Analyse" per symbol or "Analyse All"
      return { hot: hotSymbols, warm: warmSymbols }
    } catch (e) {
      addLog('scout', `FAILED: ${e.message}`)
      setAgentStates(prev => ({ ...prev, scout: 'idle' }))
      showToast(`Scout failed: ${e.message}`)
      return null
    }
  }, [enabledSymbols, isArmed, addLog, showToast, state.telegram, sendTelegramAlert, trackTokens, dispatch, fetchMassiveMetrics])

  // ── Manual analysis triggers ──
  const handleAnalyseSymbol = useCallback((symbol) => {
    setAnalysing(true)
    runAnalyst(symbol).finally(() => setAnalysing(false))
  }, [runAnalyst])

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

  // ── Fetch MASSIVE metrics — runs on mount and when page becomes visible again ──
  const MASSIVE_TTL = 30 * 60 * 1000 // 30 min cache
  useEffect(() => {
    if (enabledCount === 0 || !state.massive.apiKey) return
    const cache = readScanCache()
    const age = Date.now() - (cache?.massiveCachedAt || 0)
    if (age > MASSIVE_TTL) {
      fetchMassiveMetrics(enabledSymbols.map(w => w.symbol))
    }
  }, [enabledCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch MASSIVE when user returns to this page after 30+ min away
  useEffect(() => {
    if (!state.massive.apiKey) return
    const onVisible = () => {
      if (document.hidden || enabledCount === 0) return
      const cache = readScanCache()
      const age = Date.now() - (cache?.massiveCachedAt || 0)
      if (age > MASSIVE_TTL) {
        fetchMassiveMetrics(enabledSymbols.map(w => w.symbol), true)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabledCount, state.massive.apiKey, fetchMassiveMetrics, enabledSymbols]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Stable symbol list — sort locked to scan order, analyses don't reshuffle cards ──
  const displaySymbols = useMemo(() => {
    const order = scanOrderRef.current // only changes when a new scan completes
    return enabledSymbols
      .map(w => ({
        symbol: w.symbol,
        scan: scanResults[w.symbol] || null,
        analysis: analyses[w.symbol] || null,
        confidence: analyses[w.symbol]?.synthesis?.overall_conviction || scanResults[w.symbol]?.confidence || 0,
      }))
      .sort((a, b) => {
        const ia = order.indexOf(a.symbol)
        const ib = order.indexOf(b.symbol)
        if (ia !== -1 && ib !== -1) return ia - ib // respect scan order
        if (ia !== -1) return -1
        if (ib !== -1) return 1
        return a.symbol.localeCompare(b.symbol)
      })
  // scanResults change locks new order; analyses updates re-render without resorting
  }, [enabledSymbols, scanResults, analyses])

  const handleAnalyseAll = useCallback(() => {
    const hot = displaySymbols.filter(d =>
      d.scan && !d.analysis && (d.scan.confidence || 0) >= 5 && d.scan.bias !== 'skip'
    ).map(d => d.symbol).slice(0, 5)
    if (hot.length === 0) return
    setAnalysing(true)
    Promise.all(hot.map(sym => runAnalyst(sym))).finally(() => setAnalysing(false))
  }, [displaySymbols, runAnalyst])

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

      {/* Summary matrix */}
      {displaySymbols.length > 0 && (
        <SummaryMatrix
          symbols={displaySymbols}
          scanning={scanning}
          collapsed={matrixCollapsed}
          onToggle={() => setMatrixCollapsed(prev => !prev)}
          massiveMetrics={massiveMetrics}
          onRefreshMetrics={() => {
            const syms = enabledSymbols.map(w => w.symbol)
            fetchMassiveMetrics(syms, true)
          }}
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
            {/* Manual analyse controls */}
            {displaySymbols.some(d => d.scan && !d.analysis) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleAnalyseAll}
                disabled={analysing}
                className="!py-0.5 !px-2 text-[10px]"
              >
                {analysing ? 'Analysing…' : `Analyse All ↗`}
              </Button>
            )}
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
                onAnalyse={handleAnalyseSymbol}
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
