// Advisory command strip — sticky top bar showing scan status,
// session clocks, risk usage, and arm/disarm control.

import { useEffect, useState } from 'react'
import Card from '../common/Card.jsx'
import Badge from '../common/Badge.jsx'
import Button from '../common/Button.jsx'
import { useStrategy } from '../../lib/strategy-store.js'

function formatCountdown(secs) {
  if (secs <= 0) return '0:00'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatTimeAgo(ts) {
  if (!ts) return null
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function SessionClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(t)
  }, [])

  const fmt = (tz) => {
    try { return now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }) } catch { return '--:--' }
  }

  return (
    <div className="flex gap-2 sm:gap-3 text-[9px] sm:text-[10px] font-mono text-[var(--color-muted)] flex-wrap">
      <span>SGT {fmt('Asia/Singapore')}</span>
      <span>TYO {fmt('Asia/Tokyo')}</span>
      <span>LDN {fmt('Europe/London')}</span>
      <span>NYC {fmt('America/New_York')}</span>
    </div>
  )
}

const AGENT_LABELS = [
  { id: 'scout', name: 'SCOUT' },
  { id: 'analyst', name: 'ANALYST' },
]

export default function TradingFloor({
  agentStates = {},
  countdown = 0,
  lastScanAt = null,
  liveCount = 0,
  pendingCount = 0,
  riskUsed = 0,
  onArm,
  onScan,
  enabledCount = 0,
  scanning = false,
}) {
  const { state } = useStrategy()
  const isArmed = state.risk.armed

  const displayCountdown = countdown

  return (
    <Card className="sticky top-0 z-20 space-y-2">
      {/* Row 1: Scan status + arm */}
      <div className="flex items-center gap-2 flex-wrap">
        {AGENT_LABELS.map(a => {
          const st = agentStates[a.id] || 'idle'
          const pulse = st === 'running' ? 'animate-pulse' : ''
          const color = st === 'running'
            ? 'text-[var(--color-accent)]'
            : st === 'done' ? 'text-[var(--color-up)]' : 'text-[var(--color-muted)]'
          return (
            <span key={a.id} className={`flex items-center gap-1 text-[10px] sm:text-[11px] font-bold ${color} ${pulse}`}>
              <span className="text-[8px]">{st === 'running' ? '●' : st === 'done' ? '●' : '○'}</span>
              <span className="hidden sm:inline">{a.name}</span>
              <span className="sm:hidden">{a.name.slice(0, 3)}</span>
            </span>
          )
        })}

        <div className="flex-1" />

        {isArmed && displayCountdown > 0 && (
          <span className="text-[11px] font-mono text-[var(--color-muted)]">
            Next: {formatCountdown(displayCountdown)}
          </span>
        )}
        {lastScanAt && (
          <span className="text-[10px] text-[var(--color-muted)]">
            Scanned {formatTimeAgo(lastScanAt)}
          </span>
        )}

        <Badge tone={isArmed ? 'up' : 'neutral'} pill>
          {isArmed ? 'ARMED' : 'DISARMED'}
        </Badge>
        <Button
          size="sm"
          variant={isArmed ? 'danger' : 'primary'}
          onClick={onArm}
          disabled={enabledCount === 0}
        >
          {isArmed ? '■ Disarm' : '▶ Arm'}
        </Button>
        {!scanning && (
          <Button size="sm" variant="ghost" onClick={onScan} disabled={enabledCount === 0 || scanning}>
            {'↻'} Scan
          </Button>
        )}
      </div>

      {/* Row 2: Session clocks + risk */}
      <div className="flex items-center gap-3 flex-wrap">
        <SessionClock />
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--color-muted)]">
          {pendingCount > 0 && <>{pendingCount} analysed {'·'} </>}
          {enabledCount} symbols
        </span>
      </div>

      {/* Guide — shown when not armed */}
      {!isArmed && enabledCount > 0 && (
        <div className="border-t border-[var(--color-border)] pt-2 mt-1">
          <p className="t-meta text-[var(--color-text-sub)] leading-relaxed">
            <span className="font-bold text-[var(--color-accent)]">How it works:</span>{' '}
            <span className="font-bold">1.</span> Enable symbols in <span className="font-semibold">Watchlist</span>.{' '}
            <span className="font-bold">2.</span> Click <span className="font-semibold">Arm</span> to start scanning.{' '}
            <span className="font-bold">3.</span> Review the fundamental + technical analysis.{' '}
            <span className="font-bold">4.</span> Click <span className="font-semibold">Analyse</span> on promising setups for deep-dive reports.{' '}
            <span className="font-bold">5.</span> Place orders manually when you're convinced.
          </p>
        </div>
      )}
    </Card>
  )
}
