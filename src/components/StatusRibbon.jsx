import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { agentGet, agentConfigured } from '../lib/agent-api.js'
import { fmtAgo } from '../lib/time.js'

const POLL_MS = 30_000

export default function StatusRibbon() {
  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)
  const [positions, setPositions] = useState([])
  const [reachable, setReachable] = useState(true)

  useEffect(() => {
    if (!agentConfigured) return
    let live = true
    async function poll() {
      try {
        const [h, c, p] = await Promise.all([
          agentGet('/health').catch(() => null),
          agentGet('/state/config').catch(() => null),
          agentGet('/state/positions').catch(() => ({ positions: [] })),
        ])
        if (!live) return
        setHealth(h)
        setConfig(c)
        setPositions(p?.positions || [])
        setReachable(Boolean(h))
      } catch {
        if (live) setReachable(false)
      }
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { live = false; clearInterval(id) }
  }, [])

  if (!agentConfigured) {
    return (
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] text-[var(--color-muted)] px-3 py-1 flex items-center gap-3 font-mono">
        <span>agent offline</span>
      </div>
    )
  }

  const autotradeOn = config?.autotrade_enabled === true
  const scanOn = config?.scan_enabled !== false
  const analyzeOn = config?.analyze_enabled !== false
  const openCount = positions.length
  const circuitBreaker = health?.circuitBreaker
  const dotClass = !reachable
    ? 'bg-[var(--color-down)]'
    : circuitBreaker
      ? 'bg-[var(--color-down)] animate-pulse'
      : autotradeOn
        ? 'bg-[var(--color-up)] animate-pulse'
        : (scanOn || analyzeOn)
          ? 'bg-[var(--color-accent)]'
          : 'bg-[var(--color-muted)]'

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div
        className="text-[10px] text-[var(--color-text-sub)] px-3 py-1 flex items-center gap-3 whitespace-nowrap overflow-x-auto font-mono"
        role="status"
        aria-live="polite"
      >
        <span className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
          <Link to="/agent" className="font-bold hover:underline">
            {!reachable ? 'OFFLINE' : circuitBreaker ? 'CIRCUIT BREAKER' : autotradeOn ? 'AUTO-TRADE ON' : analyzeOn ? 'ANALYZING' : scanOn ? 'SCANNING' : 'ALL OFF'}
          </Link>
        </span>
        <span className="text-[var(--color-muted)]">|</span>
        <span>Pos <b>{openCount}</b></span>
        <span className="text-[var(--color-muted)]">|</span>
        <span>Loop <b>{health?.loopCount ?? '—'}</b></span>
        <span className="text-[var(--color-muted)]">|</span>
        <span>Scan <b>{health?.lastScanAt ? fmtAgo(health.lastScanAt) : '—'}</b></span>
        {health?.errorsToday > 0 && (
          <>
            <span className="text-[var(--color-muted)]">|</span>
            <span className="text-[var(--color-down)]">Err <b>{health.errorsToday}</b></span>
          </>
        )}
      </div>
    </div>
  )
}
