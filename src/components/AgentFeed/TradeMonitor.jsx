// Trade Monitor — shows active monitored trades with real-time status.
// Periodically calls /api/monitor for health checks.
// Allows stopping (closing) positions via /api/ctrader.

import { useState, useEffect, useRef, useCallback } from 'react'
import Card from '../common/Card.jsx'
import Badge from '../common/Badge.jsx'
import Button from '../common/Button.jsx'

const MONITOR_INTERVAL = 60_000 // check every 60s

const THESIS_TONE = {
  intact: 'up',
  weakening: 'warning',
  broken: 'down',
}

const URGENCY_TONE = {
  low: 'neutral',
  medium: 'warning',
  high: 'down',
}

const ACTION_LABELS = {
  HOLD: 'HOLD',
  TIGHTEN_SL: 'TIGHTEN SL',
  SCALE_OUT: 'SCALE OUT',
  EXIT: 'EXIT NOW',
  ADD: 'ADD',
}

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

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function TradeRow({ trade, onStop, onCheck, checking }) {
  const now = useNow()
  const elapsed = trade.placedAt
    ? Math.round((now - trade.placedAt) / 60_000)
    : 0
  const elapsedLabel = elapsed < 60
    ? `${elapsed}m`
    : `${Math.floor(elapsed / 60)}h ${elapsed % 60}m`

  const lastCheck = trade.lastMonitor
  const thesisTone = lastCheck ? THESIS_TONE[lastCheck.thesis_status] || 'neutral' : 'neutral'
  const urgencyTone = lastCheck ? URGENCY_TONE[lastCheck.urgency] || 'neutral' : 'neutral'
  const actionLabel = lastCheck ? ACTION_LABELS[lastCheck.action] || lastCheck.action : null

  return (
    <div className="py-2.5 border-b border-[var(--color-border)] last:border-b-0">
      {/* Top: Symbol + side + actions */}
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[10px] ${trade.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
          {trade.side === 'BUY' ? '\u25B2' : '\u25BC'}
        </span>
        <span className="t-sub font-bold text-[var(--color-accent)]">{trade.symbol}</span>
        <Badge tone={trade.side === 'BUY' ? 'up' : 'down'} pill>
          {trade.side}
        </Badge>
        <span className="text-[9px] text-[var(--color-muted)]">{elapsedLabel}</span>
        <div className="flex-1" />
        <div className="flex gap-1 shrink-0">
          <Button size="sm" variant="danger" onClick={() => onStop(trade)}>STOP</Button>
          <Button size="sm" variant="ghost" onClick={() => onCheck(trade)} disabled={checking}>
            {checking ? '...' : 'Check'}
          </Button>
        </div>
      </div>

      {/* Levels */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 t-meta text-[var(--color-text-sub)]">
        {trade.entry != null && <span>Entry: <span className="font-mono">{trade.entry}</span></span>}
        {trade.sl != null && <span className="text-[var(--color-down)]">SL: {trade.sl}</span>}
        {trade.tp != null && <span className="text-[var(--color-up)]">TP: {trade.tp}</span>}
        {trade.volume != null && <span>Vol: {trade.volume}</span>}
      </div>

      {/* Monitor result */}
      {lastCheck && (
        <div className="mt-1 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={thesisTone}>
              Thesis: {lastCheck.thesis_status?.toUpperCase()}
            </Badge>
            <Badge tone={urgencyTone}>
              {lastCheck.urgency?.toUpperCase()}
            </Badge>
            {actionLabel && (
              <Badge tone={lastCheck.action === 'EXIT' ? 'down' : lastCheck.action === 'HOLD' ? 'up' : 'warning'}>
                {actionLabel}
              </Badge>
            )}
          </div>
          {lastCheck.reasoning && (
            <p className="text-[11px] text-[var(--color-text-sub)]">{lastCheck.reasoning}</p>
          )}
          {lastCheck.new_sl != null && (
            <span className="text-[10px] text-[var(--color-warning-text)]">New SL: {lastCheck.new_sl}</span>
          )}
        </div>
      )}

      {!lastCheck && (
        <p className="text-[10px] text-[var(--color-muted)] mt-1">Monitoring... waiting for first check</p>
      )}
    </div>
  )
}

export default function TradeMonitor({ trades, onStop, onUpdate, onLog }) {
  const [checking, setChecking] = useState({})
  const intervalRef = useRef(null)

  const checkTrade = useCallback(async (trade) => {
    setChecking(prev => ({ ...prev, [trade.symbol]: true }))
    try {
      const result = await apiPost('/api/monitor', {
        symbol: trade.symbol,
        side: trade.side,
        entry: trade.entry,
        sl: trade.sl,
        tp1: trade.tp,
        thesis: trade.thesis || '',
        holdTime: trade.placedAt
          ? `${Math.round((Date.now() - trade.placedAt) / 60_000)}m`
          : 'unknown',
      })
      onUpdate?.(trade.symbol, { lastMonitor: result, lastCheckAt: Date.now() })
      onLog?.('monitor', `${trade.symbol}: ${result.action} \u2014 ${result.reasoning}`, { symbol: trade.symbol })

      // Auto-act on EXIT recommendation
      if (result.action === 'EXIT' && result.urgency === 'high') {
        onLog?.('monitor', `${trade.symbol}: HIGH URGENCY EXIT recommended`, { symbol: trade.symbol })
      }
    } catch (e) {
      onLog?.('monitor', `${trade.symbol}: check failed \u2014 ${e.message}`, { symbol: trade.symbol })
    } finally {
      setChecking(prev => ({ ...prev, [trade.symbol]: false }))
    }
  }, [onUpdate, onLog])

  // Periodic monitoring
  useEffect(() => {
    if (trades.length === 0) return
    intervalRef.current = setInterval(() => {
      for (const trade of trades) {
        checkTrade(trade)
      }
    }, MONITOR_INTERVAL)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [trades, checkTrade])

  // Initial check on mount for new trades
  useEffect(() => {
    for (const trade of trades) {
      if (!trade.lastMonitor && !checking[trade.symbol]) {
        checkTrade(trade)
      }
    }
    // Only run on trades change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades.length])

  if (trades.length === 0) return null

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="t-label">Trade Monitor</span>
          <Badge tone="info" pill>{trades.length} active</Badge>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-up)] opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-up)]" />
          </span>
        </div>
        <span className="text-[9px] text-[var(--color-muted)]">Auto-checks every 60s</span>
      </div>

      <div className="divide-y divide-[var(--color-border)]">
        {trades.map(trade => (
          <TradeRow
            key={`${trade.symbol}-${trade.placedAt}`}
            trade={trade}
            onStop={onStop}
            onCheck={checkTrade}
            checking={!!checking[trade.symbol]}
          />
        ))}
      </div>
    </Card>
  )
}
