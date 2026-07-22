// WatchlistScreener — a sortable, selectable table over a curated symbol
// list (owner: "curate down all the defence stocks... table with five
// columns... select/unselect, sort, clickable for more details, and advice
// whether aggressive buying or buying or volatility"). Works for BOTH
// jobs the owner named: finding new symbols to add, and checking which
// already-watchlisted symbols belong to this set — it lists every symbol
// in `curated` this broker account actually offers, whether or not it's
// in the watchlist yet.
//
// "Advice" is a real technical read (see src/lib/screener-advice.js) —
// bias + confidence from the last scan, ATR% from the regime detector —
// not a fundamentals/analyst call. It stays blank until a symbol has
// actually been scanned (only true for watchlisted, enabled symbols).
//
// Five columns on a notebook/tablet; narrower viewports drop to three
// (Symbol / Advice / select) and the rest lives in the click-to-expand
// detail row — Tailwind responsive classes, no JS breakpoint logic needed.
import { Fragment, useState } from 'react'
import Badge from './common/Badge.jsx'
import Button from './common/Button.jsx'
import { screenerAdvice } from '../lib/screener-advice.js'

function SortHeader({ label, col, sort, onSort, className = '' }) {
  const active = sort.col === col
  return (
    <th className={`py-1.5 pr-2 font-semibold text-left ${className}`}>
      <button type="button" className="cursor-pointer hover:underline whitespace-nowrap" onClick={() => onSort(col)}>
        {label}{active ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  )
}

export default function WatchlistScreener({ title = 'Defense stocks', curated, allSymbols, symbols, scanInfo, regimeBy, onAdd, onRemove }) {
  const [sort, setSort] = useState({ col: 'symbol', dir: 'asc' })
  const [selected, setSelected] = useState(() => new Set())
  const [expanded, setExpanded] = useState(null)

  const have = new Set((allSymbols || []).map(s => s.toUpperCase()))
  const inWatchlist = new Set((symbols || []).map(s => s.symbol.toUpperCase()))

  const rows = (curated || [])
    .filter(sym => have.has(sym.toUpperCase()))
    .map(sym => {
      const scan = scanInfo?.by?.[sym]
      const regime = regimeBy?.[sym]
      const advice = screenerAdvice({
        bias: scan?.bias ?? null,
        confidence: scan?.confidence ?? null,
        atrPct: regime?.atr_pct ?? null,
      })
      return {
        symbol: sym,
        onList: inWatchlist.has(sym.toUpperCase()),
        price: scan?.price ?? null,
        bias: scan?.bias && scan.bias !== 'skip' ? scan.bias : null,
        confidence: scan?.confidence ?? null,
        atrPct: regime?.atr_pct ?? null,
        regimeType: regime?.regime ?? null,
        thesis: scan?.thesis ?? null,
        advice,
      }
    })

  const sortVal = (r) => {
    switch (sort.col) {
      case 'onList': return r.onList ? 1 : 0
      case 'atrPct': return r.atrPct ?? -Infinity
      case 'advice': return r.advice?.label ?? ''
      default: return r.symbol
    }
  }
  const sorted = [...rows].sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b)
    const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb
    return sort.dir === 'desc' ? -c : c
  })
  const onSort = (col) => setSort(s => ({ col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' }))

  const toggle = (sym) => setSelected(s => {
    const n = new Set(s)
    n.has(sym) ? n.delete(sym) : n.add(sym)
    return n
  })
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.symbol))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.symbol)))

  if (rows.length === 0) {
    return <p className="text-[12px] text-[var(--color-text-sub)]">None of the {title.toLowerCase()} list is offered by this broker account.</p>
  }

  const selSymbols = [...selected]
  const selToAdd = selSymbols.filter(s => !inWatchlist.has(s.toUpperCase()))
  const selToRemove = selSymbols.filter(s => inWatchlist.has(s.toUpperCase()))

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-1.5 text-[12px]">
        <span className="text-[var(--color-text-sub)]">{rows.length} available · {selected.size} selected</span>
        {selToAdd.length > 0 && (
          <Button size="sm" variant="subtle" onClick={() => { onAdd?.(selToAdd); setSelected(new Set()) }}>
            Add {selToAdd.length} to watchlist
          </Button>
        )}
        {selToRemove.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => { selToRemove.forEach(s => onRemove?.(s)); setSelected(new Set()) }}>
            Remove {selToRemove.length} from watchlist
          </Button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] tabular-nums">
          <thead className="text-[var(--color-text-sub)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-1.5 pr-2 w-6">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              <SortHeader label="Symbol" col="symbol" sort={sort} onSort={onSort} />
              <SortHeader label="Advice" col="advice" sort={sort} onSort={onSort} />
              <SortHeader label="Volatility" col="atrPct" sort={sort} onSort={onSort} className="hidden sm:table-cell" />
              <SortHeader label="Watchlist" col="onList" sort={sort} onSort={onSort} className="hidden md:table-cell" />
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <Fragment key={r.symbol}>
                <tr className="border-b border-[var(--color-border)] cursor-pointer" onClick={() => setExpanded(e => e === r.symbol ? null : r.symbol)}>
                  <td className="py-1.5 pr-2" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(r.symbol)} onChange={() => toggle(r.symbol)} aria-label={`Select ${r.symbol}`} />
                  </td>
                  <td className="py-1.5 pr-2 font-semibold whitespace-nowrap">{r.symbol}</td>
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    {r.advice ? <Badge tone={r.advice.tone}>{r.advice.label}</Badge> : <span className="text-[var(--color-text-sub)]">not scanned yet</span>}
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap hidden sm:table-cell">
                    {r.atrPct != null ? `${r.atrPct.toFixed(2)}%${r.regimeType ? ` · ${r.regimeType}` : ''}` : '—'}
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap hidden md:table-cell">
                    <Badge tone={r.onList ? 'up' : 'neutral'}>{r.onList ? 'on list' : 'not added'}</Badge>
                  </td>
                </tr>
                {expanded === r.symbol && (
                  <tr className="border-b border-[var(--color-border)]">
                    <td colSpan={5} className="py-2 px-2 text-[11px] text-[var(--color-text-sub)] bg-[var(--color-surface-2,rgba(127,127,127,0.06))]">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:hidden mb-1">
                        <span>Volatility</span><span>{r.atrPct != null ? `${r.atrPct.toFixed(2)}% · ${r.regimeType ?? '—'}` : '—'}</span>
                        <span>Watchlist</span><span>{r.onList ? 'on list' : 'not added'}</span>
                      </div>
                      <div>Price: {r.price != null ? r.price : '—'} · Bias: {r.bias ? `${r.bias.toUpperCase()}${r.confidence != null ? ` (${r.confidence}/10)` : ''}` : 'not scanned yet'}</div>
                      {r.thesis && <div className="mt-0.5">{r.thesis}</div>}
                      {!r.onList && <div className="mt-1"><Button size="sm" variant="subtle" onClick={() => onAdd?.([r.symbol])}>Add to watchlist</Button></div>}
                      {r.onList && <div className="mt-1"><Button size="sm" variant="ghost" onClick={() => onRemove?.(r.symbol)}>Remove from watchlist</Button></div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
