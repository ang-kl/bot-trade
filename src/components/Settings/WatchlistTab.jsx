// Watchlist tab — screener-style table with 24h trading hours matrix,
// expandable rows for sub-agent config, Pepperstone symbol search,
// and Finviz-inspired filtering (category, session, asset class).

import { useState, useMemo, useCallback, useEffect } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import Badge from '../common/Badge.jsx'
import TradingHoursBar from './TradingHoursBar.jsx'
import TradingHoursMatrix from './TradingHoursMatrix.jsx'
import { useStrategy, SUB_AGENTS, WATCHLIST_CATEGORIES } from '../../lib/strategy-store.js'
import { isTradingNow, searchCatalog, lookupSymbol } from '../../lib/trading-hours.js'

// ── AI Picks helpers ──

async function callAiPicks(action, body = {}) {
  const res = await fetch('/api/ai-picks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `ai-picks ${action} ${res.status}`)
  return data
}

const BIAS_COLORS = {
  long: 'var(--color-up)',
  short: 'var(--color-down)',
  neutral: 'var(--color-muted)',
}

// ── AI Picks prompt card (top — always visible, no results here) ──

function AiPicksPrompt({ state, dispatch }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const { picks, lastPickedAt } = state.aiPicks

  const onPick = useCallback(async () => {
    const countMatch = prompt.match(/(\d+)/)?.[1]
    const indexMatch = prompt.match(/(?:from|in)\s+(\w+)/i)?.[1]
    const count = countMatch ? Number(countMatch) : 5
    const idx = indexMatch || 'US30'

    setBusy(true)
    setError(null)
    try {
      const data = await callAiPicks('pick', {
        index: idx,
        count,
        prompt: prompt || `Pick ${count} best stock setups from ${idx}`,
        massiveApiKey: state.massive.apiKey,
      })
      dispatch({
        type: 'AI_PICKS_SET',
        picks: data.picks || [],
        rationale: data.rationale || '',
        index: data.index || idx,
        scanned: data.scanned || 0,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [prompt, state.massive.apiKey, dispatch])

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <h2 className="t-label flex-1">AI Picks</h2>
        {lastPickedAt && (
          <span className="t-meta text-[var(--color-muted)]">
            {new Date(lastPickedAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
          </span>
        )}
        {picks.length > 0 && (
          <Badge tone="info" pill>{picks.length} picks</Badge>
        )}
        {picks.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'AI_PICKS_CLEAR' })}>
            Clear
          </Button>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && onPick()}
          placeholder="e.g. 5 stocks from US30"
          className="flex-1"
        />
        <Button size="sm" onClick={onPick} disabled={busy || !state.massive.apiKey}>
          {busy ? 'Scanning...' : 'Scout'}
        </Button>
      </div>

      {!state.massive.apiKey && (
        <p className="t-meta text-[var(--color-down)] mt-2">
          Massive API key required. Set it in Admin.
        </p>
      )}
      {error && <p className="t-meta text-[var(--color-down)] mt-2">{error}</p>}
    </Card>
  )
}

// ── AI Picks results table (rendered inside matrix card) ──

function AiPicksResults({ state, dispatch, existingSymbols }) {
  const { picks, rationale, index, scanned } = state.aiPicks
  if (picks.length === 0) return null

  const addToWatchlist = (pick) => {
    dispatch({
      type: 'WATCHLIST_ADD',
      symbol: pick.ticker,
      label: pick.thesis || '',
      category: pick.category || 'Stocks',
    })
  }

  const removePick = (ticker) => {
    dispatch({ type: 'AI_PICKS_REMOVE', ticker })
  }

  return (
    <div className="mb-3">
      {/* Section header */}
      <div className="flex items-center gap-2 px-1 mb-1.5">
        <span className="t-meta font-bold text-[var(--color-accent)]">AI Picks</span>
        <span className="t-meta text-[var(--color-muted)]">{picks.length} picks</span>
        {scanned > 0 && (
          <span className="t-meta text-[var(--color-muted)]">from {index} ({scanned} scanned)</span>
        )}
      </div>

      {/* Rationale */}
      {rationale && (
        <p className="t-meta text-[var(--color-text-sub)] italic px-1 mb-1.5">{rationale}</p>
      )}

      {/* Picks table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[10px] sm:text-[11px]">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className="px-2 py-1 text-left t-meta font-semibold text-[var(--color-text-sub)] w-[70px]">Ticker</th>
              <th className="px-2 py-1 text-center t-meta font-semibold text-[var(--color-text-sub)] w-[50px]">Bias</th>
              <th className="px-2 py-1 text-center t-meta font-semibold text-[var(--color-text-sub)] w-[35px]">C</th>
              <th className="px-2 py-1 text-right t-meta font-semibold text-[var(--color-text-sub)] w-[70px]">Price</th>
              <th className="px-2 py-1 text-right t-meta font-semibold text-[var(--color-text-sub)] w-[55px]">Chg%</th>
              <th className="px-2 py-1 text-left t-meta font-semibold text-[var(--color-text-sub)]">Thesis</th>
              <th className="px-2 py-1 text-right t-meta font-semibold text-[var(--color-text-sub)] w-[70px]"></th>
            </tr>
          </thead>
          <tbody>
            {picks.map((p) => {
              const alreadyInWatchlist = existingSymbols.has(p.ticker)
              const biasColor = p.bias === 'long' ? 'text-[var(--color-up)]' : p.bias === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'
              const arrow = p.bias === 'long' ? '\u25B2' : p.bias === 'short' ? '\u25BC' : ''
              return (
                <tr key={p.ticker} className="border-b border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]/30">
                  <td className="px-2 py-1.5">
                    <span className={`font-bold ${biasColor}`}>{arrow} {p.ticker}</span>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <span
                      className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-[3px] inline-block"
                      style={{
                        color: BIAS_COLORS[p.bias] || BIAS_COLORS.neutral,
                        backgroundColor: `color-mix(in srgb, ${BIAS_COLORS[p.bias] || BIAS_COLORS.neutral} 15%, transparent)`,
                      }}
                    >
                      {p.bias || 'neutral'}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <span className={`font-bold ${p.confidence >= 7 ? 'text-[var(--color-up)]' : p.confidence >= 4 ? 'text-[var(--color-text)]' : 'text-[var(--color-down)]'}`}>
                      {p.confidence}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-[var(--color-text)]">
                    {p.price != null ? `$${p.price}` : '\u2014'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {p.change != null ? (
                      <span className={`font-bold ${Number(p.change) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                        {Number(p.change) >= 0 ? '+' : ''}{p.change}%
                      </span>
                    ) : '\u2014'}
                  </td>
                  <td className="px-2 py-1.5 text-[var(--color-text-sub)] truncate max-w-[250px]">
                    {p.thesis || '\u2014'}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {alreadyInWatchlist ? (
                        <span className="text-[9px] text-[var(--color-muted)]">Added</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => addToWatchlist(p)}
                          className="text-[9px] font-bold text-[var(--color-accent)] hover:underline cursor-pointer"
                        >
                          +WL
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removePick(p.ticker)}
                        className="text-[var(--color-down)] text-[11px] cursor-pointer hover:opacity-70 ml-1"
                      >
                        {'\u00D7'}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Expandable row ──

function ExpandedRow({ w, dispatch }) {
  return (
    <tr className="bg-[var(--color-bg)]">
      <td colSpan={6} className="px-4 py-3">
        <div className="space-y-3 max-w-2xl">
          {/* Trading hours */}
          <div>
            <p className="t-meta text-[var(--color-muted)] mb-1">Trading Hours (UTC)</p>
            <TradingHoursBar symbol={w.symbol} />
          </div>

          {/* Sub-agents */}
          <div>
            <p className="t-meta text-[var(--color-muted)] mb-1">Sub-Agents</p>
            <div className="flex flex-wrap gap-1.5">
              {SUB_AGENTS.map(a => (
                <button
                  key={a}
                  onClick={() => dispatch({ type: 'WATCHLIST_TOGGLE_AGENT', symbol: w.symbol, agent: a })}
                  className={`px-2 py-1 rounded-[5px] text-[11px] font-bold uppercase tracking-wide border transition-colors ${
                    w.agents[a]
                      ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
                      : 'bg-transparent border-[var(--color-border)] text-[var(--color-muted)]'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          {/* Trading gates */}
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block t-meta text-[var(--color-muted)] mb-1">
                Auto-trade threshold
              </label>
              <select
                value={w.autoTradeThreshold || 8}
                onChange={(e) => dispatch({ type: 'WATCHLIST_SET_THRESHOLD', symbol: w.symbol, threshold: Number(e.target.value) })}
                className="block min-h-[36px] px-2 py-1 rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-[12px]"
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(n => (
                  <option key={n} value={n}>{n === 11 ? 'Manual only' : `${n}/10`}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block t-meta text-[var(--color-muted)] mb-1">
                Max volume (lots)
              </label>
              <input
                type="number"
                value={w.maxVolume || 0.01}
                onChange={(e) => dispatch({ type: 'WATCHLIST_SET_VOLUME', symbol: w.symbol, volume: Number(e.target.value) })}
                step="0.01"
                min="0.01"
                max="100"
                className="block w-20 min-h-[36px] px-2 py-1 rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-[12px]"
              />
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={isTradingNow(w.symbol) ? 'up' : 'neutral'} pill>
                {isTradingNow(w.symbol) ? 'OPEN NOW' : 'CLOSED'}
              </Badge>
            </div>
          </div>
        </div>
      </td>
    </tr>
  )
}

// ── Search dropdown ──

function SearchDropdown({ results, onSelect }) {
  if (results.length === 0) return null
  return (
    <div className="absolute z-20 top-full left-0 right-0 mt-1 max-h-[240px] overflow-y-auto rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
      {results.map(c => (
        <button
          key={c.symbol}
          type="button"
          onClick={() => onSelect(c)}
          className={`w-full text-left px-3 py-2 text-[13px] hover:bg-[var(--color-accent-soft)] flex items-center gap-2 border-b border-[var(--color-border)] last:border-b-0 ${
            c._aliasFrom ? 'bg-[var(--color-accent-soft)]/40' : ''
          }`}
        >
          {c._aliasFrom && (
            <span className="text-[10px] text-[var(--color-accent)] font-bold shrink-0">
              {c._aliasFrom} =
            </span>
          )}
          <span className="font-bold text-[var(--color-accent)] w-20 shrink-0">{c.symbol}</span>
          <span className="text-[var(--color-text-sub)] flex-1 truncate">{c.label}</span>
          <Badge tone="neutral">{c.category}</Badge>
        </button>
      ))}
    </div>
  )
}

// ── Main component ──

export default function WatchlistTab() {
  const { state, dispatch } = useStrategy()
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [sessionFilter, setSessionFilter] = useState('All')
  const [sortField, setSortField] = useState('symbol')
  const [sortAsc, setSortAsc] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [confirmAdd, setConfirmAdd] = useState(null) // { input, resolved, alternatives }
  const [viewMode, setViewMode] = useState('matrix') // 'matrix' | 'list'
  const [matrixGroup, setMatrixGroup] = useState('category') // 'category' | 'ticker' | 'status'
  const [massiveMetrics, setMassiveMetrics] = useState({})
  const [metricsLoading, setMetricsLoading] = useState(false)

  // Fetch Massive metrics for stock symbols
  useEffect(() => {
    if (!state.massive.apiKey) return
    const stockSymbols = state.watchlist
      .filter(w => w.category === 'Stocks')
      .map(w => w.symbol)
    if (stockSymbols.length === 0) return

    let cancelled = false
    setMetricsLoading(true)
    fetch('/api/massive-compute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'batch-compute',
        apiKey: state.massive.apiKey,
        tickers: stockSymbols,
      }),
    })
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.results) setMassiveMetrics(data.results)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setMetricsLoading(false) })
    return () => { cancelled = true }
  }, [state.massive.apiKey, state.watchlist])

  const existingSymbols = useMemo(
    () => new Set(state.watchlist.map(w => w.symbol)),
    [state.watchlist],
  )

  // Search catalog as user types
  const searchResults = useMemo(() => {
    if (!draft || draft.length < 1) return []
    return searchCatalog(draft, 15).filter(c => !existingSymbols.has(c.symbol))
  }, [draft, existingSymbols])

  const add = useCallback((symbolOrCatalog) => {
    if (typeof symbolOrCatalog === 'object') {
      dispatch({
        type: 'WATCHLIST_ADD',
        symbol: symbolOrCatalog.symbol,
        label: symbolOrCatalog.label,
        category: symbolOrCatalog.category,
      })
      setDraft('')
      setShowDropdown(false)
      setConfirmAdd(null)
      return
    }
    const sym = draft.trim()
    if (!sym) return

    // Try exact resolution
    const resolved = lookupSymbol(sym)
    if (resolved) {
      dispatch({
        type: 'WATCHLIST_ADD',
        symbol: resolved.symbol,
        label: resolved.label,
        category: resolved.category,
      })
      setDraft('')
      setShowDropdown(false)
      return
    }

    // No exact match — search for alternatives
    const alternatives = searchCatalog(sym, 5).filter(c => !existingSymbols.has(c.symbol))
    setConfirmAdd({ input: sym, resolved: null, alternatives })
  }, [draft, dispatch, existingSymbols])

  const confirmAddSymbol = useCallback((choice) => {
    if (!choice) {
      setConfirmAdd(null)
      return
    }
    if (typeof choice === 'object') {
      dispatch({
        type: 'WATCHLIST_ADD',
        symbol: choice.symbol,
        label: choice.label,
        category: choice.category,
      })
    } else {
      dispatch({ type: 'WATCHLIST_ADD', symbol: choice })
    }
    setDraft('')
    setShowDropdown(false)
    setConfirmAdd(null)
  }, [dispatch])

  const toggleSort = (field) => {
    if (sortField === field) setSortAsc(prev => !prev)
    else { setSortField(field); setSortAsc(true) }
  }

  const sortIndicator = (field) => {
    if (sortField !== field) return ''
    return sortAsc ? ' \u25B2' : ' \u25BC'
  }

  // Filtered + sorted
  const filtered = useMemo(() => {
    let list = state.watchlist

    if (search) {
      const q = search.toUpperCase()
      list = list.filter(w =>
        w.symbol.includes(q) ||
        (w.label && w.label.toUpperCase().includes(q)) ||
        (w.category && w.category.toUpperCase().includes(q))
      )
    }

    if (categoryFilter !== 'All') list = list.filter(w => w.category === categoryFilter)
    if (statusFilter === 'Enabled') list = list.filter(w => w.enabled)
    else if (statusFilter === 'Disabled') list = list.filter(w => !w.enabled)
    if (sessionFilter === 'Open') list = list.filter(w => isTradingNow(w.symbol))
    else if (sessionFilter === 'Closed') list = list.filter(w => !isTradingNow(w.symbol))

    return [...list].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'symbol': cmp = a.symbol.localeCompare(b.symbol); break
        case 'category': cmp = (a.category || '').localeCompare(b.category || ''); break
        case 'enabled': cmp = (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0); break
        default: cmp = 0
      }
      return sortAsc ? cmp : -cmp
    })
  }, [state.watchlist, search, categoryFilter, statusFilter, sessionFilter, sortField, sortAsc])

  const enabledCount = state.watchlist.filter(w => w.enabled).length
  const openCount = state.watchlist.filter(w => isTradingNow(w.symbol)).length

  const selectCls = 'block w-full min-h-[36px] px-2 py-1 rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]'

  return (
    <div className="space-y-3">
      {/* AI Picks prompt — always visible at top */}
      <AiPicksPrompt state={state} dispatch={dispatch} />

      {/* Filter bar */}
      <Card>
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2 sm:gap-3 mb-3">
          <div className="col-span-2 sm:flex-1 sm:min-w-[180px]">
            <label className="block t-meta text-[var(--color-text-sub)] mb-1">Search</label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by symbol or name..."
            />
          </div>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1">Category</label>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className={selectCls}>
              <option value="All">All</option>
              {WATCHLIST_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1">Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
              <option value="All">All</option>
              <option value="Enabled">Enabled</option>
              <option value="Disabled">Disabled</option>
            </select>
          </div>
          <div>
            <label className="block t-meta text-[var(--color-text-sub)] mb-1">Session</label>
            <select value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)} className={selectCls}>
              <option value="All">All ({openCount} open)</option>
              <option value="Open">Trading Now</option>
              <option value="Closed">Closed</option>
            </select>
          </div>
          {(search || categoryFilter !== 'All' || statusFilter !== 'All' || sessionFilter !== 'All') && (
            <Button size="sm" variant="ghost" onClick={() => {
              setSearch(''); setCategoryFilter('All'); setStatusFilter('All'); setSessionFilter('All')
            }}>
              Clear
            </Button>
          )}
          {/* View toggle */}
          <div className="flex items-center gap-0.5 col-span-2 sm:col-span-1 sm:ml-auto">
            <button
              onClick={() => setViewMode('matrix')}
              className={`px-2 py-1 text-[11px] font-bold rounded-l-[5px] border transition-colors ${
                viewMode === 'matrix'
                  ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'bg-transparent border-[var(--color-border)] text-[var(--color-muted)]'
              }`}
            >
              MATRIX
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-2 py-1 text-[11px] font-bold rounded-r-[5px] border border-l-0 transition-colors ${
                viewMode === 'list'
                  ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'bg-transparent border-[var(--color-border)] text-[var(--color-muted)]'
              }`}
            >
              LIST
            </button>
          </div>
        </div>

        {/* Add symbol with autocomplete */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
          <div className="flex gap-2 flex-1 relative">
            <Input
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setShowDropdown(true) }}
              onKeyDown={(e) => { if (e.key === 'Enter') add() }}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              placeholder="Search instruments (GOLD, NASDAQ...)"
            />
            <Button size="sm" onClick={() => add()} disabled={!draft.trim()}>Add</Button>
            {showDropdown && searchResults.length > 0 && (
              <SearchDropdown results={searchResults} onSelect={add} />
            )}
          </div>
          <span className="t-meta text-[var(--color-text-sub)] whitespace-nowrap text-center sm:text-left">
            {filtered.length}/{state.watchlist.length} shown {'\u00B7'} {enabledCount} enabled
          </span>
        </div>

        {/* Symbol validation confirmation */}
        {confirmAdd && (
          <div className="mt-2 p-3 rounded-[7px] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]">
            <p className="t-sub text-[var(--color-warning-text)] mb-2">
              <span className="font-bold">"{confirmAdd.input}"</span> not found in trading platform catalog.
            </p>
            {confirmAdd.alternatives.length > 0 && (
              <div className="space-y-1 mb-2">
                <p className="t-meta text-[var(--color-text-sub)]">Did you mean:</p>
                {confirmAdd.alternatives.map(alt => (
                  <button
                    key={alt.symbol}
                    type="button"
                    onClick={() => confirmAddSymbol(alt)}
                    className="flex items-center gap-2 w-full text-left px-2 py-1 rounded-[5px] hover:bg-[var(--color-accent-soft)] text-[12px] cursor-pointer"
                  >
                    <span className="font-bold text-[var(--color-accent)] w-20">{alt.symbol}</span>
                    <span className="text-[var(--color-text-sub)] flex-1 truncate">{alt.label}</span>
                    <span className="text-[var(--color-muted)] text-[10px]">{alt.category}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => confirmAddSymbol(confirmAdd.input)}
                className="px-2 py-1 text-[11px] rounded-[5px] bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-accent-soft)] cursor-pointer"
              >
                Add "{confirmAdd.input}" anyway
              </button>
              <button
                type="button"
                onClick={() => setConfirmAdd(null)}
                className="px-2 py-1 text-[11px] rounded-[5px] text-[var(--color-muted)] hover:text-[var(--color-text)] cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* Matrix view */}
      {viewMode === 'matrix' && (
        <Card className="!px-2 !py-2">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="t-meta text-[var(--color-muted)]">Group by:</span>
            {[
              { key: 'category', label: 'Category' },
              { key: 'ticker', label: 'Ticker' },
              { key: 'status', label: 'Market Open' },
            ].map(opt => (
              <button
                key={opt.key}
                onClick={() => setMatrixGroup(opt.key)}
                className={`px-2 py-0.5 text-[10px] font-bold rounded-[4px] border transition-colors ${
                  matrixGroup === opt.key
                    ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'bg-transparent border-[var(--color-border)] text-[var(--color-muted)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
            {metricsLoading && (
              <span className="t-meta text-[var(--color-muted)] animate-pulse">Computing metrics...</span>
            )}
          </div>
          {/* AI Picks results — pinned above category groups */}
          <AiPicksResults state={state} dispatch={dispatch} existingSymbols={existingSymbols} />

          {filtered.length === 0 ? (
            <p className="t-sub text-[var(--color-text-sub)] px-4 py-6 text-center">
              {state.watchlist.length === 0 ? 'Empty watchlist. Search and add instruments above.' : 'No symbols match current filters.'}
            </p>
          ) : (
            <TradingHoursMatrix
              watchlist={filtered}
              groupMode={matrixGroup}
              onToggle={(sym) => dispatch({ type: 'WATCHLIST_TOGGLE_ENABLED', symbol: sym })}
              massiveMetrics={massiveMetrics}
            />
          )}
        </Card>
      )}

      {/* List view */}
      {viewMode === 'list' && (
        <Card className="overflow-x-auto !px-0">
          {state.watchlist.length === 0 ? (
            <p className="t-sub text-[var(--color-text-sub)] px-4 py-6 text-center">
              Empty watchlist. Search and add instruments above.
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
                      checked={filtered.length > 0 && filtered.every(w => w.enabled)}
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
                    Hours
                  </th>
                  <th className="px-4 py-2 t-meta text-[var(--color-text-sub)] font-medium w-20 text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((w, i) => {
                  const isExpanded = expanded === w.symbol
                  const trading = isTradingNow(w.symbol)
                  return [
                    <tr
                      key={w.symbol}
                      className={`border-b border-[var(--color-border)] cursor-pointer transition-colors ${
                        isExpanded ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-bg)]'
                      } ${w.enabled ? '' : 'opacity-50'}`}
                      onClick={() => setExpanded(isExpanded ? null : w.symbol)}
                    >
                      <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={w.enabled}
                          onChange={() => dispatch({ type: 'WATCHLIST_TOGGLE_ENABLED', symbol: w.symbol })}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] ${trading ? 'text-[var(--color-up)]' : 'text-[var(--color-muted)]'}`}>
                            {trading ? '\u25CF' : '\u25CB'}
                          </span>
                          <span className="t-sub font-medium text-[var(--color-accent)]">{w.symbol}</span>
                          <span className="text-[10px] text-[var(--color-muted)]">
                            {isExpanded ? '\u25BC' : '\u25B6'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 hidden sm:table-cell">
                        <span className="t-sub text-[var(--color-text-sub)] truncate max-w-[200px] block">{w.label || '-'}</span>
                      </td>
                      <td className="px-4 py-2.5 hidden sm:table-cell">
                        {w.category ? <Badge tone="neutral">{w.category}</Badge> : <span className="t-meta text-[var(--color-muted)]">-</span>}
                      </td>
                      <td className="px-4 py-2.5 hidden md:table-cell">
                        <TradingHoursBar symbol={w.symbol} compact />
                      </td>
                      <td className="px-4 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'WATCHLIST_MOVE', symbol: w.symbol, delta: -1 })} disabled={i === 0}>
                            {'\u2191'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'WATCHLIST_MOVE', symbol: w.symbol, delta: 1 })} disabled={i === filtered.length - 1}>
                            {'\u2193'}
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => dispatch({ type: 'WATCHLIST_REMOVE', symbol: w.symbol })}>
                            {'\u00D7'}
                          </Button>
                        </div>
                      </td>
                    </tr>,
                    isExpanded && <ExpandedRow key={`${w.symbol}-exp`} w={w} dispatch={dispatch} />,
                  ]
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  )
}
