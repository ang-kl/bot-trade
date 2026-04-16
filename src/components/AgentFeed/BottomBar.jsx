// Bottom bar — agent status dashboard + token accounting.
// Shows per-agent token usage, run status, and session cost estimate.

import { useState, useEffect } from 'react'
import Badge from '../common/Badge.jsx'

// Approximate cost per 1K output tokens (Claude Sonnet 4.5)
const COST_PER_1K = 0.015

const STATUS_ICON = {
  running: '\u25CF',
  done: '\u25CF',
  idle: '\u25CB',
  sleeping: '\u25CB',
  error: '\u25CF',
}

const STATUS_COLOR = {
  running: 'text-[var(--color-accent)]',
  done: 'text-[var(--color-up)]',
  idle: 'text-[var(--color-muted)]',
  sleeping: 'text-[var(--color-muted)]',
  error: 'text-[var(--color-down)]',
}

const STATUS_LABEL = {
  running: 'WORKING',
  done: 'DONE',
  idle: 'IDLE',
  sleeping: 'SLEEP',
  error: 'ERROR',
}

const AGENT_META = {
  scout: { label: 'Scout', role: 'Scans all symbols, flags hot candidates' },
  analyst: { label: 'Analyst', role: 'Dispatches minions for deep analysis' },
  synthesis: { label: 'Synthesis', role: 'Consensus from minion reports' },
  trader: { label: 'Trader', role: 'Places and manages orders' },
  monitor: { label: 'Monitor', role: 'Checks thesis on open positions' },
  telegram: { label: 'Telegram', role: 'Sends alerts and updates' },
}

const AGENT_ORDER = ['scout', 'analyst', 'synthesis', 'trader', 'monitor', 'telegram']

export default function BottomBar({
  tokenCount = 0,
  agentStates = {},
  agentTokens = {},
  agentCalls = {},
  monitoredCount = 0,
  sessionStart,
}) {
  const [expanded, setExpanded] = useState(false)

  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const cost = (tokenCount / 1000) * COST_PER_1K
  const activeCount = Object.values(agentStates).filter(s => s === 'running').length
  const totalCalls = Object.values(agentCalls).reduce((s, n) => s + n, 0)

  const elapsed = sessionStart
    ? Math.round((now - sessionStart) / 60_000)
    : 0
  const elapsedLabel = elapsed < 60
    ? `${elapsed}m`
    : `${Math.floor(elapsed / 60)}h ${elapsed % 60}m`

  const handleLogout = () => {
    if (window.confirm('Clear all local data and reload?')) {
      localStorage.clear()
      window.location.reload()
    }
  }

  return (
    <footer className="border-t border-[var(--color-border)] pt-2 mt-4 space-y-1">
      {/* Summary row — always visible */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Agent dots */}
        <div className="flex items-center gap-1.5">
          {AGENT_ORDER.map(id => {
            const st = agentStates[id] || 'idle'
            const pulse = st === 'running' ? 'animate-pulse' : ''
            return (
              <span
                key={id}
                className={`text-[8px] ${STATUS_COLOR[st]} ${pulse}`}
                title={`${AGENT_META[id]?.label}: ${STATUS_LABEL[st] || st}`}
              >
                {STATUS_ICON[st]}
              </span>
            )
          })}
          {activeCount > 0 && (
            <Badge tone="info" pill>{activeCount} working</Badge>
          )}
        </div>

        {/* Tokens + cost */}
        <span className="t-meta text-[var(--color-muted)]">
          {tokenCount.toLocaleString()} tokens
        </span>
        <span className="t-meta text-[var(--color-muted)]">
          ~${cost.toFixed(3)}
        </span>
        {totalCalls > 0 && (
          <span className="t-meta text-[var(--color-muted)]">
            {totalCalls} API calls
          </span>
        )}
        {monitoredCount > 0 && (
          <Badge tone="up" pill>{monitoredCount} monitored</Badge>
        )}

        <div className="flex-1" />

        {sessionStart && (
          <span className="t-meta text-[var(--color-muted)]">{elapsedLabel}</span>
        )}

        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="t-meta text-[var(--color-accent)] hover:underline underline-offset-2 cursor-pointer"
        >
          {expanded ? '\u25BC Agents' : '\u25B6 Agents'}
        </button>

        <button
          type="button"
          onClick={handleLogout}
          className="t-meta text-[var(--color-muted-light)] hover:text-[var(--color-muted)] cursor-pointer underline-offset-2 hover:underline"
        >
          Logout
        </button>
      </div>

      {/* Expanded agent table */}
      {expanded && (
        <div className="overflow-x-auto rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[var(--color-muted)]">
                <th className="px-3 py-1.5 text-left font-medium">Agent</th>
                <th className="px-3 py-1.5 text-left font-medium">Status</th>
                <th className="px-3 py-1.5 text-right font-medium">Tokens</th>
                <th className="px-3 py-1.5 text-right font-medium">Calls</th>
                <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                <th className="px-3 py-1.5 text-left font-medium hidden sm:table-cell">Role</th>
              </tr>
            </thead>
            <tbody>
              {AGENT_ORDER.map(id => {
                const meta = AGENT_META[id] || { label: id, role: '' }
                const st = agentStates[id] || 'idle'
                const tokens = agentTokens[id] || 0
                const calls = agentCalls[id] || 0
                const agentCost = (tokens / 1000) * COST_PER_1K

                return (
                  <tr key={id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-3 py-1.5">
                      <span className={`font-bold ${STATUS_COLOR[st]}`}>
                        {STATUS_ICON[st]} {meta.label}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge
                        tone={st === 'running' ? 'info' : st === 'done' ? 'up' : st === 'error' ? 'down' : 'neutral'}
                      >
                        {STATUS_LABEL[st] || st.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                      {tokens > 0 ? tokens.toLocaleString() : '-'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                      {calls > 0 ? calls : '-'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--color-text-sub)]">
                      {tokens > 0 ? `$${agentCost.toFixed(3)}` : '-'}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--color-muted)] hidden sm:table-cell">
                      {meta.role}
                    </td>
                  </tr>
                )
              })}
              {/* Totals row */}
              <tr className="bg-[var(--color-bg)] font-bold">
                <td className="px-3 py-1.5 text-[var(--color-text)]">Total</td>
                <td className="px-3 py-1.5" />
                <td className="px-3 py-1.5 text-right font-mono text-[var(--color-text)]">
                  {tokenCount.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[var(--color-text)]">
                  {totalCalls}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[var(--color-text)]">
                  ${cost.toFixed(3)}
                </td>
                <td className="px-3 py-1.5 hidden sm:table-cell" />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </footer>
  )
}
