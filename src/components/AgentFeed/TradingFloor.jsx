// Trading Floor command strip — sticky top bar showing agent status,
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
  { id: 'trader', name: 'TRADER' },
  { id: 'monitor', name: 'MONITOR' },
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
  autoTradeCount = 0,
  onAutoTrade,
  autoTradeCountdown = 0,
}) {
  const { state } = useStrategy()
  const isArmed = state.risk.armed

  // Tick the countdown display — use the prop directly as the starting
  // point but track independently so the interval can decrement locally.
  const displayCountdown = countdown

  return (
    <Card className="sticky top-0 z-20 space-y-2">
      {/* Row 1: Agent status + arm */}
      <div className="flex items-center gap-2 flex-wrap">
        {AGENT_LABELS.map(a => {
          const st = agentStates[a.id] || 'idle'
          const pulse = st === 'running' ? 'animate-pulse' : ''
          const color = st === 'running'
            ? 'text-[var(--color-accent)]'
            : st === 'done' ? 'text-[var(--color-up)]' : 'text-[var(--color-muted)]'
          return (
            <span key={a.id} className={`flex items-center gap-1 text-[10px] sm:text-[11px] font-bold ${color} ${pulse}`}>
              <span className="text-[8px]">{st === 'running' ? '\u25CF' : st === 'done' ? '\u25CF' : '\u25CB'}</span>
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
          {isArmed ? '\u25A0 Disarm' : '\u25B6 Arm'}
        </Button>
        {!scanning && (
          <Button size="sm" variant="ghost" onClick={onScan} disabled={enabledCount === 0 || scanning}>
            {'\u21BB'} Scan
          </Button>
        )}
        {onAutoTrade && (
          <Button
            size="sm"
            variant={autoTradeCountdown > 0 ? 'danger' : 'primary'}
            onClick={onAutoTrade}
            disabled={enabledCount === 0 || !isArmed}
          >
            {autoTradeCountdown > 0
              ? `\u25A0 Auto ${formatCountdown(autoTradeCountdown)}`
              : '\u26A1 Auto-Trade'}
            {autoTradeCount > 0 && (
              <span className="ml-1 px-1 py-0 text-[9px] bg-white/20 rounded-[4px]">{autoTradeCount}</span>
            )}
          </Button>
        )}
      </div>

      {/* Row 2: Session clocks + risk */}
      <div className="flex items-center gap-3 flex-wrap">
        <SessionClock />
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--color-muted)]">
          {liveCount > 0 && <>{liveCount} live \u00B7 </>}
          {pendingCount > 0 && <>{pendingCount} pending \u00B7 </>}
          Risk: ${riskUsed.toFixed(0)} / {state.risk.dailyMaxLossPct}% daily
        </span>
      </div>
    </Card>
  )
}
