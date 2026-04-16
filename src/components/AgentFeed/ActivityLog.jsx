// Activity Log — real-time scrolling feed of agent actions.
// This is the main UI element: you watch agents think and act.

import { useRef, useEffect } from 'react'
import Card from '../common/Card.jsx'

const AGENT_COLORS = {
  scout: 'text-[var(--color-accent)]',
  analyst: 'text-[var(--color-info-text)]',
  trader: 'text-[var(--color-up)]',
  monitor: 'text-[var(--color-warning-text)]',
  telegram: 'text-[var(--color-special-text)]',
  risk: 'text-[var(--color-down)]',
  synthesis: 'text-[var(--color-accent)]',
  system: 'text-[var(--color-muted)]',
}

const AGENT_ICONS = {
  scout: '\u{1F50D}',
  analyst: '\u{1F9E0}',
  trader: '\u{1F4B0}',
  monitor: '\u{1F4CA}',
  telegram: '\u{1F4F1}',
  risk: '\u{1F6A8}',
  synthesis: '\u{1F9E0}',
  system: '\u2699\uFE0F',
}

function formatTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

function LogEntry({ entry }) {
  const agentColor = AGENT_COLORS[entry.agent] || AGENT_COLORS.system
  const icon = entry.icon || AGENT_ICONS[entry.agent] || '\u25CF'
  const nameLabel = entry.minionName || entry.agent?.toUpperCase() || 'SYSTEM'

  return (
    <div className="flex gap-1.5 sm:gap-2 items-start py-0.5 text-[11px] sm:text-[12px] leading-relaxed">
      <span className="text-[var(--color-muted)] font-mono shrink-0 w-[48px] sm:w-[60px]">
        {formatTime(entry.ts)}
      </span>
      <span className="shrink-0">{icon}</span>
      <span className={`font-bold shrink-0 ${agentColor}`}>
        {nameLabel}
      </span>
      {entry.symbol && (
        <span className="font-semibold text-[var(--color-text)]">{entry.symbol}</span>
      )}
      <span className="text-[var(--color-text-sub)] break-words min-w-0">
        {entry.message}
      </span>
    </div>
  )
}

export default function ActivityLog({ entries = [], maxVisible = 50 }) {
  const bottomRef = useRef(null)
  const containerRef = useRef(null)

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [entries.length])

  const visible = entries.slice(-maxVisible)

  if (visible.length === 0) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <span className="t-section-label">{'\u25CF'} ACTIVITY LOG</span>
        </div>
        <p className="t-meta text-[var(--color-muted)] text-center py-4">
          Arm the system to start the agents. Activity will appear here.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <span className="t-section-label">{'\u25CF'} ACTIVITY LOG</span>
        <span className="t-meta text-[var(--color-muted)]">{entries.length} events</span>
      </div>
      <div
        ref={containerRef}
        className="max-h-[400px] overflow-y-auto font-mono space-y-0"
        style={{ scrollbarWidth: 'thin' }}
      >
        {visible.map((entry, i) => (
          <LogEntry key={entry.id || i} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>
    </Card>
  )
}
