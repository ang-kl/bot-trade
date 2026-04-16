// Watchlist tab - screener-style table with search/filter bar.
// Inspired by Stock Market Guides table layout and Finviz-style filtering.

import { useState, useMemo } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import Badge from '../common/Badge.jsx'
import { useStrategy, SUB_AGENTS, WATCHLIST_CATEGORIES } from '../../lib/strategy-store.js'

export default function WatchlistTab() {
  const { state, dispatch } = useStrategy()
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [sortField, setSortField] = useState('symbol')
  const [sortAsc, setSortAsc] = useState(true)

  const add = () => {
    const sym = draft.trim()
    if (!sym) return
    dispatch({ type: 'WATCHLIST_ADD', symbol: sym })
    setDraft('')
  }

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortAsc(prev => !prev)
    } else {
      setSortField(field)
      setSortAsc(true)
    }
  }

  const sortIndicator = (field) => {
    if (sortField !== field) return ''
    return sortAsc ? ' \u25B2' : ' \u25BC'
  }

  // Filtered and sorted watchlist
  const filtered = useMemo(() => {
    let list = state.watchlist

    // Text search
    if (search) {
      const q = search.toUpperCase()
      list = list.filter(w =>
        w.symbol.includes(q) ||
        (w.label && w.label.toUpperCase().includes(q)) ||
        (w.category && w.category.toUpperCase().includes(q))
      )
    }

    // Category filter
    if (categoryFilter !== 'All') {
      list = list.filter(w => w.category === categoryFilter)
    }

    // Status filter
    if (statusFilter === 'Enabled') {
      list = list.filter(w => w.enabled)
    } else if (statusFilter === 'Disabled') {
      list = list.filter(w => !w.enabled)
    }

    // Sort
    const sorted = [...list].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'symbol':
          cmp = a.symbol.localeCompare(b.symbol)
          break
        case 'category':
          cmp = (a.category || '').localeCompare(b.category || '')
          break
        case 'enabled':
          cmp = (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0)
          break
        default:
          cmp = 0
      }
      return sortAsc ? cmp : -cmp
    })

    return sorted
  }, [state.watchlist, search, categoryFilter, statusFilter, sortField, sortAsc])

  const enabledCount = state.watchlist.filter(w => w.enabled).length
  const categories = ['All', ...WATCHLIST_CATEGORIES]

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <Card>
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <div className="flex-1 min-w-[180px]">
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="wl-search">Search</label>
            <Input
              id="wl-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by symbol or name..."
              aria-label="Search watchlist"
            />
          </div>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="wl-category">Category</label>
            <select
              id="wl-category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="block w-full min-h-[36px] px-3 py-1.5 rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] t-sub focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            >
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1" htmlFor="wl-status">Status</label>
            <select
              id="wl-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="block w-full min-h-[36px] px-3 py-1.5 rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] t-sub focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            >
              <option value="All">All</option>
              <option value="Enabled">Enabled</option>
              <option value="Disabled">Disabled</option>
            </select>
          </div>
          {(search || categoryFilter !== 'All' || statusFilter !== 'All') && (
            <Button size="sm" variant="ghost" onClick={() => {
              setSearch('')
              setCategoryFilter('All')
              setStatusFilter('All')
            }}>
              Clear
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-2 flex-1">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="Add symbol (e.g. EURUSD)"
              aria-label="New symbol"
            />
            <Button size="sm" onClick={add} disabled={!draft.trim()}>Add</Button>
          </div>
          <span className="t-meta text-[var(--color-text-sub)] whitespace-nowrap">
            {filtered.length} / {state.watchlist.length} shown - {enabledCount} enabled
          </span>
        </div>
      </Card>

      {/* Watchlist table */}
      <Card className="overflow-x-auto !px-0">
        {state.watchlist.length === 0 ? (
          <p className="t-sub text-[var(--color-text-sub)] px-4 py-6 text-center">
            Empty watchlist. Add a symbol above to get started.
          </p>
        ) : filtered.length === 0 ? (
          <p className="t-sub text-[var(--color-text-sub)] px-4 py-6 text-center">
            No symbols match current filters.
          </p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-4 py-2 t-meta text-[var(--color-text-sub)] font-medium w-8">
                  <input
                    type="checkbox"
                    checked={filtered.every(w => w.enabled)}
                    onChange={() => {
                      const allEnabled = filtered.every(w => w.enabled)
                      for (const w of filtered) {
                        if (allEnabled ? w.enabled : !w.enabled) {
                          dispatch({ type: 'WATCHLIST_TOGGLE_ENABLED', symbol: w.symbol })
                        }
                      }
                    }}
                    aria-label="Toggle all visible"
                  />
                </th>
                <th
                  className="px-4 py-2 t-meta text-[var(--color-text-sub)] font-medium cursor-pointer select-none"
                  onClick={() => toggleSort('symbol')}
                >
                  Ticker{sortIndicator('symbol')}
                </th>
                <th className="px-4 py-2 t-meta text-[var(--color-text-sub)] font-medium hidden sm:table-cell">
                  Name
                </th>
                <th
                  className="px-4 py-2 t-meta text-[var(--color-text-sub)] font-medium cursor-pointer select-none hidden sm:table-cell"
                  onClick={() => toggleSort('category')}
                >
                  Category{sortIndicator('category')}
                </th>
                <th className="px-4 py-2 t-meta text-[var(--color-text-sub)] font-medium hidden md:table-cell">
                  Sub-agents
                </th>
                <th className="px-4 py-2 t-meta text-[var(--color-text-sub)] font-medium w-24 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((w, i) => {
                return (
                  <tr
                    key={w.symbol}
                    className={`border-b border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors ${
                      w.enabled ? '' : 'opacity-50'
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={w.enabled}
                        onChange={() => dispatch({ type: 'WATCHLIST_TOGGLE_ENABLED', symbol: w.symbol })}
                        aria-label={`${w.symbol} enabled`}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="t-sub font-medium text-[var(--color-accent)]">{w.symbol}</span>
                    </td>
                    <td className="px-4 py-2.5 hidden sm:table-cell">
                      <span className="t-sub text-[var(--color-text-sub)] truncate max-w-[200px] block">{w.label || '-'}</span>
                    </td>
                    <td className="px-4 py-2.5 hidden sm:table-cell">
                      {w.category ? (
                        <Badge tone="neutral">{w.category}</Badge>
                      ) : (
                        <span className="t-meta text-[var(--color-muted)]">-</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {SUB_AGENTS.map(a => (
                          <button
                            key={a}
                            onClick={() => dispatch({ type: 'WATCHLIST_TOGGLE_AGENT', symbol: w.symbol, agent: a })}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide border transition-colors ${
                              w.agents[a]
                                ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
                                : 'bg-transparent border-[var(--color-border)] text-[var(--color-muted)]'
                            }`}
                            aria-label={`${a} agent for ${w.symbol}`}
                          >
                            {a}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => dispatch({ type: 'WATCHLIST_MOVE', symbol: w.symbol, delta: -1 })}
                          disabled={i === 0}
                          aria-label={`Move ${w.symbol} up`}
                        >
                          {'\u2191'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => dispatch({ type: 'WATCHLIST_MOVE', symbol: w.symbol, delta: 1 })}
                          disabled={i === filtered.length - 1}
                          aria-label={`Move ${w.symbol} down`}
                        >
                          {'\u2193'}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => dispatch({ type: 'WATCHLIST_REMOVE', symbol: w.symbol })}
                          aria-label={`Remove ${w.symbol}`}
                        >
                          {'\u00D7'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
