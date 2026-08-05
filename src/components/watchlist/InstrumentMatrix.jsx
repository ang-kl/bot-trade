// ---------------------------------------------------------------------------
// InstrumentMatrix — the whole broker catalogue as a 4 × 7 grid.
//
// Owner, 04-08-2026: a CSS Grid sized for a half-screen iPad Pro split
// (~500–600px wide, about a third of screen height) with NO page overflow;
// fixed-height cells showing only a title and a count; tapping a cell expands
// its symbols in place, hyperlinked to TradingView; a sticky filter bar whose
// search highlights matches whether or not their cell is open; All / Active
// Now / Closed session toggles; 44pt tap targets; open state cached.
//
// WHY THE CELLS DO NOT GROW THE GRID. Every cell is a fixed 44px with its
// overflow hidden, and an expansion renders BELOW the grid rather than inside
// the cell's own box. Letting a cell grow would reflow the other 27 around
// your tap — the exact complaint the watchlist table's internal scroll was
// added to fix ("shifting the screen up and down whenever I tap the group").
// The grid is a map you point at; the panel underneath is what you read.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import {
  MATRIX_COLUMNS, MATRIX_ROWS, buildMatrix, cellKey, tradingViewUrl,
  rowMatchesSessionFilter, rowOpenNow,
} from '../../lib/instrument-matrix.js'

const OPEN_KEY = 'watchlist_matrix_open'
const SESSION_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Active Now' },
  { key: 'closed', label: 'Closed' },
]

function loadOpen() {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')) } catch { return new Set() }
}

export default function InstrumentMatrix({ symbols = [], descriptions = null, inList = null, onAdd, onRemove }) {
  const [open, setOpen] = useState(loadOpen)
  const [q, setQ] = useState('')
  const [session, setSession] = useState('all')

  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open])) } catch { /* private mode */ }
  }, [open])

  const { cells, unplaced, total, placed } = useMemo(
    () => buildMatrix(symbols, descriptions), [symbols, descriptions])

  const query = q.trim().toUpperCase()
  // Matches are computed over the WHOLE grid, not over what happens to be
  // expanded — the ask was that search highlight matches "regardless of
  // collapse state", so a closed cell has to be able to say it holds three.
  const matchCount = useMemo(() => {
    if (!query) return null
    const by = new Map()
    for (const [key, list] of cells) by.set(key, list.filter(s => s.includes(query)).length)
    return by
  }, [cells, query])

  const toggle = (key) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const visibleRows = MATRIX_ROWS.filter(r => rowMatchesSessionFilter(r.key, session, rowOpenNow))
  const openCells = [...open].filter(k => (cells.get(k)?.length ?? 0) > 0)

  return (
    <div className="text-[9px]">
      {/* Sticky filter bar — it stays put while the grid scrolls, which is the
          only way search stays reachable on a half-width iPad split. */}
      <div className="sticky top-0 z-20 bg-[var(--color-bg)] pb-1.5 flex flex-wrap items-center gap-1.5">
        <input
          type="search" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search all instruments…" aria-label="Search all instruments"
          className="glass-inset rounded-[7px] px-2 py-1.5 text-[9px] min-h-[44px] flex-1 min-w-[140px]"
        />
        <div className="flex gap-1" role="group" aria-label="Session filter">
          {SESSION_FILTERS.map(f => (
            <button
              key={f.key} type="button" role="switch" aria-checked={session === f.key}
              onClick={() => setSession(f.key)}
              className={`min-h-[44px] min-w-[44px] px-2 rounded-[2px] border cursor-pointer capitalize ${
                session === f.key
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-[var(--glass-edge)] text-[var(--color-text-sub)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-[var(--color-text-sub)] w-full">
          {total.toLocaleString()} instruments · {placed.toLocaleString()} placed
          {unplaced.length > 0 && (
            // NAMED, not swallowed. A US listing whose sector we cannot
            // establish is not dropped into the biggest cell to make the
            // counts look complete — see instrument-matrix.js's header.
            <>
              {' · '}
              <button type="button" onClick={() => toggle('__unplaced__')}
                className="text-[var(--color-warning-text)] cursor-pointer hover:underline"
                title="US listings with no sector we could establish from the curated table or the broker's own description. Placing them would be a guess; they are listed here instead.">
                {unplaced.length} unclassified
              </button>
            </>
          )}
          {query && matchCount && <> · {[...matchCount.values()].reduce((a, b) => a + b, 0)} match “{query}”</>}
        </span>
      </div>

      {/* THE GRID. Four fixed columns × the visible rows, cells 44px tall with
          overflow hidden, so it never grows past its third of the screen. */}
      <div className="overflow-x-auto">
        <div
          className="grid gap-[2px] min-w-[480px]"
          style={{ gridTemplateColumns: `72px repeat(${MATRIX_COLUMNS.length}, minmax(0, 1fr))` }}
        >
          <div aria-hidden="true" />
          {MATRIX_COLUMNS.map(c => (
            <div key={c.key} className="px-1 pb-0.5 font-semibold leading-tight truncate" title={c.label}>
              {c.short}
            </div>
          ))}

          {visibleRows.map(r => {
            const live = rowOpenNow(r.key)
            return [
              <div key={`h:${r.key}`} className="px-1 py-1 font-semibold leading-tight break-words" title={`${r.label} — ${live ? 'open now' : 'closed now'}`}>
                {r.short}
                <span className={`block text-[9px] font-normal ${live ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-sub)]'}`}>
                  {live ? 'OPEN' : 'CLOSED'}
                </span>
              </div>,
              ...MATRIX_COLUMNS.map(c => {
                const key = cellKey(c.key, r.key)
                const list = cells.get(key) || []
                const hits = matchCount?.get(key) ?? 0
                const isOpen = open.has(key)
                const empty = list.length === 0
                return (
                  <button
                    key={key} type="button" disabled={empty}
                    onClick={() => toggle(key)} aria-expanded={isOpen}
                    title={`${c.label} × ${r.label} — ${list.length} instrument(s)`}
                    className={`h-[44px] overflow-hidden px-1 text-left rounded-[2px] border leading-tight cursor-pointer disabled:cursor-default disabled:opacity-30 ${
                      isOpen
                        ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                        : hits > 0
                          ? 'border-[var(--color-warning-text)] text-[var(--color-warning-text)]'
                          : 'border-[var(--glass-edge)] text-[var(--color-text-sub)]'
                    }`}
                  >
                    <span className="block truncate text-[9px]">{c.short}</span>
                    <span className="block font-semibold tabular-nums">
                      [{list.length}]
                      {/* The highlight the ask names: a COLLAPSED cell still
                          reports how many of its members match. */}
                      {hits > 0 && <span className="ml-1 font-normal">{hits}✓</span>}
                    </span>
                  </button>
                )
              }),
            ]
          })}
        </div>
      </div>

      {/* Expansions, BELOW the grid — see the header for why not inside the
          cell. Symbols in 2/3/4 columns depending on the width available. */}
      {open.has('__unplaced__') && unplaced.length > 0 && (
        <SymbolPanel
          title={`Unclassified (${unplaced.length})`}
          note="A US listing with no sector in the curated table and none readable from the broker's description. Listed rather than placed — a wrong cell here would be a claim we cannot support."
          symbols={unplaced} query={query} inList={inList} onAdd={onAdd} onRemove={onRemove}
          onClose={() => toggle('__unplaced__')}
        />
      )}
      {openCells.map(key => {
        const [col, row] = key.split('|')
        const c = MATRIX_COLUMNS.find(x => x.key === col)
        const r = MATRIX_ROWS.find(x => x.key === row)
        if (!c || !r) return null
        return (
          <SymbolPanel
            key={key}
            title={`${c.short} · ${r.short}`}
            note={`${c.label} × ${r.label}`}
            symbols={cells.get(key) || []} query={query}
            inList={inList} onAdd={onAdd} onRemove={onRemove}
            onClose={() => toggle(key)}
          />
        )
      })}
    </div>
  )
}

/** One expanded cell: its symbols, TradingView-linked, add/remove in place. */
function SymbolPanel({ title, note, symbols, query, inList, onAdd, onRemove, onClose }) {
  const shown = query ? symbols.filter(s => s.includes(query)) : symbols
  return (
    <div className="glass-inset rounded-[8px] border border-[var(--color-border)] p-2 mt-1.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-semibold">{title}</span>
        <span className="text-[var(--color-text-sub)] truncate" title={note}>{note}</span>
        <button type="button" onClick={onClose} aria-label={`Collapse ${title}`}
          className="ml-auto min-h-[44px] min-w-[44px] cursor-pointer text-[var(--color-accent)]">close</button>
      </div>
      {shown.length === 0
        ? <p className="text-[var(--color-text-sub)]">Nothing here matches “{query}”.</p>
        : (
          <div className="max-h-[40vh] overflow-y-auto grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-2">
            {shown.map(s => {
              const on = inList?.has(s)
              return (
                <div key={s} className="flex items-center gap-1 min-h-[44px]">
                  <a href={tradingViewUrl(s)} target="_blank" rel="noreferrer"
                    className="truncate hover:underline text-[var(--color-accent)]" title={`Open ${s} on TradingView`}>
                    {s}
                  </a>
                  {(onAdd || onRemove) && (
                    <button type="button"
                      onClick={() => (on ? onRemove?.(s) : onAdd?.([s]))}
                      aria-label={`${on ? 'Remove' : 'Add'} ${s}`}
                      className="ml-auto min-h-[44px] min-w-[44px] cursor-pointer text-[var(--color-text-sub)]">
                      {on ? '−' : '+'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
