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

function SymbolCard({ symbol, scan, analysis, onOrder }) {
  const hasAnalysis = !!analysis
  const synthesis = analysis?.synthesis
  const reports = analysis?.reports || []

  const bias = synthesis?.consensus_bias || scan?.bias || 'neutral'
  const conviction = synthesis?.overall_conviction || scan?.confidence || 0
  const isSkip = bias === 'skip' || bias === 'neutral'
  const arrow = bias === 'long' ? '\u25B2' : bias === 'short' ? '\u25BC' : '\u25CF'
  const sideColor = bias === 'long' ? 'text-[var(--color-up)]' : bias === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'

  const [expanded, setExpanded] = useState(false)

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-1 flex-wrap">
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
            <div className="space-y-1 mb-2 pl-2 border-l-2 border-[var(--color-border)]">
              {reports.map((r, i) => (
                <div key={i} className="text-[12px]">
                  <span className="font-bold text-[var(--color-accent)]">
                    {r.icon || '\u25CF'} {r.name}
                  </span>
                  <span className="text-[var(--color-muted)] ml-1">({r.role})</span>
                  <Badge
                    tone={r.bias === 'long' ? 'up' : r.bias === 'short' ? 'down' : 'neutral'}
                    className="ml-1"
                  >
                    {r.bias?.toUpperCase()}
                  </Badge>
                  <span className="text-[var(--color-muted)] ml-1">{r.conviction}/10</span>
                  <p className="text-[var(--color-text-sub)] ml-4">{r.report}</p>
                </div>
              ))}
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

  const scanTimerRef = useRef(null)

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
  }, [state.watchlist, state.ctrader.linkedAccountId, isArmed, addLog, sendTelegramAlert, trackTokens, addMonitoredTrade])

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
  }, [enabledSymbols, addLog, showToast, state.telegram, sendTelegramAlert, trackTokens])

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
    await apiPost('/api/ctrader', body)
    addLog('trader', `Order placed!`, { symbol: order.symbol })
    sendTelegramAlert({
      action: 'send-alert', alertType: 'trade',
      trade: { symbol: order.symbol, side: order.side, entry: order.limitPrice || 'market', stopLoss: order.stopLoss, takeProfit: order.takeProfit, action: order.orderType.toUpperCase() },
    })
    addLog('telegram', `Trade alert sent`, { symbol: order.symbol })
    // Add to monitor
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
      />

      {/* Desk note */}
      {deskNote && (
        <Card>
          <p className="t-label mb-1">Desk Notes</p>
          <p className="t-sub text-[var(--color-text-sub)]">{deskNote}</p>
        </Card>
      )}

      {/* Activity log */}
      <ActivityLog entries={log} />

      {/* Symbol cards */}
      {displaySymbols.length > 0 && (
        <div className="space-y-2">
          <p className="t-label">{displaySymbols.length} symbols active</p>
          {displaySymbols.map(d => (
            <SymbolCard
              key={d.symbol}
              symbol={d.symbol}
              scan={d.scan}
              analysis={d.analysis}
              onOrder={handleOpenOrder}
            />
          ))}
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
    </section>
  )
}
