// Watchlist tab — add / remove / reorder symbols, per-row sub-agent toggles.
// Reorder uses up/down buttons (YAGNI: drag-drop lives behind a v2 upgrade).

import { useState } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import { useStrategy, SUB_AGENTS } from '../../lib/strategy-store.js'

export default function WatchlistTab() {
  const { state, dispatch } = useStrategy()
  const [draft, setDraft] = useState('')

  const add = () => {
    const sym = draft.trim()
    if (!sym) return
    dispatch({ type: 'WATCHLIST_ADD', symbol: sym })
    setDraft('')
  }

  return (
    <Card>
      <h2 className="font-semibold mb-2">Watchlist</h2>
      <p className="text-sm text-[var(--color-fg-subtle)] mb-3">
        Ported from v1 as a default pool — every row starts disabled so you (or the agent) pick the handful
        worth trading today. Use arrows to reorder, and toggle which sub-agents run for each row.
      </p>
      <div className="flex gap-2 mb-4">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="EURUSD"
          aria-label="New symbol"
        />
        <Button size="sm" onClick={add} disabled={!draft.trim()}>Add</Button>
      </div>
      {state.watchlist.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-subtle)]">Empty — add a symbol above.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {state.watchlist.map((w, i) => (
            <li key={w.symbol} className="py-3">
              <div className="flex items-center gap-2 mb-1">
                <input
                  type="checkbox"
                  checked={w.enabled}
                  onChange={() => dispatch({ type: 'WATCHLIST_TOGGLE_ENABLED', symbol: w.symbol })}
                  aria-label={`${w.symbol} enabled`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{w.symbol}</span>
                    {w.label && (
                      <span className="text-xs text-[var(--color-fg-subtle)] truncate">
                        {w.label}
                      </span>
                    )}
                  </div>
                  {w.category && (
                    <span className="inline-block mt-0.5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded border border-[var(--color-border)] text-[var(--color-fg-subtle)]">
                      {w.category}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dispatch({ type: 'WATCHLIST_MOVE', symbol: w.symbol, delta: -1 })}
                  disabled={i === 0}
                  aria-label={`Move ${w.symbol} up`}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dispatch({ type: 'WATCHLIST_MOVE', symbol: w.symbol, delta: 1 })}
                  disabled={i === state.watchlist.length - 1}
                  aria-label={`Move ${w.symbol} down`}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => dispatch({ type: 'WATCHLIST_REMOVE', symbol: w.symbol })}
                  aria-label={`Remove ${w.symbol}`}
                >
                  ×
                </Button>
              </div>
              <div className="flex flex-wrap gap-3 pl-6 text-xs text-[var(--color-fg-subtle)]">
                {SUB_AGENTS.map((a) => (
                  <label key={a} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={!!w.agents[a]}
                      onChange={() => dispatch({ type: 'WATCHLIST_TOGGLE_AGENT', symbol: w.symbol, agent: a })}
                    />
                    {a}
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
