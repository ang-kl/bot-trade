// Bottom status ribbon — Word-style persistent bar. Polls the Railway agent
// every 30s for armed-state + health. Stays visible on every route so the
// operator always knows whether autopilot is on, how many positions are live,
// and whether the backend is reachable.

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
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] text-[var(--color-muted)] px-3 py-1 flex items-center gap-3">
        <span>Agent backend not configured</span>
      </div>
    )
  }

  const armed = config?.armed === true
  const openCount = positions.length
  const dotClass = !reachable
    ? 'bg-[var(--color-down)]'
    : armed
      ? 'bg-[var(--color-up)] animate-pulse'
      : 'bg-[var(--color-muted)]'

  return (
    <div
      className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] text-[var(--color-text-sub)] px-3 py-1 flex items-center gap-3 whitespace-nowrap overflow-x-auto"
      role="status"
      aria-live="polite"
    >
      <span className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
        <Link to="/agent" className="font-bold hover:underline">
          {!reachable ? 'OFFLINE' : armed ? 'AUTOPILOT ON' : 'AUTOPILOT OFF'}
        </Link>
      </span>
      <span className="text-[var(--color-muted)]">·</span>
      <span>
        <span className="text-[var(--color-muted)]">Positions</span>{' '}
        <b>{openCount}</b>
      </span>
      <span className="text-[var(--color-muted)]">·</span>
      <span>
        <span className="text-[var(--color-muted)]">Loop</span>{' '}
        <b>{health?.loopCount ?? '—'}</b>
      </span>
      <span className="text-[var(--color-muted)]">·</span>
      <span>
        <span className="text-[var(--color-muted)]">Last scan</span>{' '}
        <b>{health?.lastScanAt ? fmtAgo(health.lastScanAt) : '—'}</b>
      </span>
      <span className="flex-1" />
      <Link to="/workshop" className="text-[var(--color-accent)] hover:underline">
        Workshop →
      </Link>
    </div>
  )
}
