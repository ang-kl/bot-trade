// ---------------------------------------------------------------------------
// LossReview — post-loss playback (owner: "playback after each loss to
// understand what the market is happening").
//
// Each losing trade gets a verdict of what the market DID next, computed by
// the agent's postmortem sweep:
//   stop_hunt    — right idea, stop too tight (price came back to entry)
//   thesis_wrong — wrong idea, stop saved money (price kept going)
//   chop         — noise; the entry filter let it through
//   time_cap     — the clock closed it, not the market
// plus a bar-replay sparkline (entry → stop → aftermath).
//
// Accessibility (owner has red-green colour vision): verdicts are NEVER
// colour-only — each carries its text label; the sparkline uses the accent
// colour for price and TEXT markers (E / SL / X), not red/green coding.
// ---------------------------------------------------------------------------

import { Fragment, useEffect, useState } from 'react'

// Verdict → label + tone. Tones map to the app's blue/neutral palette (no
// red-vs-green distinction is required to read them; text always present).
const VERDICTS = {
  stop_hunt: { label: 'STOP HUNT', hint: 'right idea, stop too tight' },
  thesis_wrong: { label: 'THESIS WRONG', hint: 'stop saved money' },
  chop: { label: 'CHOP', hint: 'noise entry' },
  time_cap: { label: 'TIME CAP', hint: 'clock, not market' },
  inconclusive: { label: 'INCONCLUSIVE', hint: 'not enough data' },
  // Wins carry lessons too (owner: "lesson learnt for both lost and wins")
  clean_win: { label: 'CLEAN WIN', hint: 'exit captured the move' },
  gave_back: { label: 'GAVE BACK', hint: 'left ≥1R on the table' },
  escaped: { label: 'ESCAPED', hint: 'won after near-stop — luck, not edge' },
}
const WIN_CLASSES = new Set(['clean_win', 'gave_back', 'escaped'])

// Owner: "so many the same, where is the date, time" — the collapsed row
// carried no timestamp at all, so a genuinely repeated setup (same symbol,
// same stop distance, same $ loss, on different days) was indistinguishable
// from one entry rendered 30 times. day+time, device-local.
function dateTime(iso) {
  if (!iso) return null
  const t = Date.parse(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z')
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

// Owner: "collapse and expand the groups (losses, wins)" — same triangle
// pattern as every other section/row in the app, not just the individual
// trade rows underneath.
function Group({ title, rows }) {
  const [open, setOpen] = useState(true)
  if (rows.length === 0) return null
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center gap-1.5 text-left cursor-pointer text-[9px] font-semibold text-[var(--color-text-sub)] mb-1">
        <span aria-hidden="true" className="w-2.5 text-[9px] shrink-0">{open ? '▾' : '▸'}</span>
        {title} ({rows.length})
      </button>
      {/* Owner: 3 columns desktop, 2 columns iPad-mini-landscape and iPhone. */}
      {open && (
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-2 items-start">
          {rows.map((r) => <Verdict key={r.id} r={r} />)}
        </div>
      )}
    </div>
  )
}

// Sort accessors — null/undefined always sorts last, matching StdTradeTable's
// convention so every table in the app behaves the same way.
function sortVal(r, key) {
  switch (key) {
    case 'date': {
      // Same normalization as dateTime() above — an ISO string already has a
      // 'T' and its own zone; only the sqlite " " form needs 'Z' appended.
      // Codex review: unconditionally appending 'Z' turned ISO rows into
      // "...ZZ", which Date.parse reads as NaN and leaves them unsorted.
      const s = String(r.trade_closed_at || r.trade_opened_at || r.created_at || '')
      const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
      return Number.isFinite(t) ? t : null
    }
    case 'symbol': return r.symbol || null
    case 'classification': return VERDICTS[r.classification]?.label || r.classification || null
    case 'r_multiple': return r.r_multiple
    case 'net_pnl': return r.net_pnl
    default: return null
  }
}

// Owner: "the Trade lesson learnt must be capable of sort and filter in
// different ways" + "create a mini table within each symbol, and also a
// group table for losses and wins" — filters/sort apply to BOTH views; the
// view toggle switches how the (already filtered) rows are laid out.
export default function LossReview({ postmortems }) {
  const allRows = postmortems?.rows || []
  const stats = postmortems?.stats || []
  const [view, setView] = useState('groups') // 'groups' | 'symbol'
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' })
  const [filter, setFilter] = useState({ symbol: '', strategy: '', classification: '', side: '' })
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(0)

  // A narrower filter/sort/page-size must not leave the view stranded on a
  // page that no longer exists.
  useEffect(() => { setPage(0) }, [filter, sort, view, pageSize])

  if (allRows.length === 0) {
    return (
      <p className="text-[9px] text-[var(--color-text-sub)]">
        No classified trades yet — the sweep reviews every closed trade (wins AND losses) a few bars after it closes, working back through 90 days of history.
      </p>
    )
  }
  // Per-strategy learning line: "FIB: 5 stop_hunt · 2 thesis_wrong …"
  const byStrat = {}
  for (const s of stats) {
    (byStrat[s.strategy] ||= []).push(`${s.n} ${VERDICTS[s.classification]?.label?.toLowerCase() || s.classification}`)
  }

  const symbols = [...new Set(allRows.map(r => r.symbol).filter(Boolean))].sort()
  const strategies = [...new Set(allRows.map(r => r.strategy).filter(Boolean))].sort()
  const classifications = [...new Set(allRows.map(r => r.classification).filter(Boolean))].sort()

  const filteredRows = allRows
    .filter(r => !filter.symbol || r.symbol === filter.symbol)
    .filter(r => !filter.strategy || r.strategy === filter.strategy)
    .filter(r => !filter.classification || r.classification === filter.classification)
    .filter(r => !filter.side || String(r.side).toUpperCase() === filter.side)
    .sort((a, b) => {
      const va = sortVal(a, sort.key), vb = sortVal(b, sort.key)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb
      return sort.dir === 'desc' ? -c : c
    })

  // Multi-page pagination (owner: 25/50/100/200 per page) — clamp instead of
  // trusting `page` blindly, since the useEffect above resets it async.
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const rows = filteredRows.slice(safePage * pageSize, (safePage + 1) * pageSize)

  const losses = rows.filter(r => !WIN_CLASSES.has(r.classification))
  const wins = rows.filter(r => WIN_CLASSES.has(r.classification))
  const bySymbol = {}
  for (const r of rows) (bySymbol[r.symbol] ||= []).push(r)

  const selectCls = 'glass-inset rounded-[var(--radius-control)] px-1.5 py-1 text-[9px]'
  return (
    <div className="space-y-3">
      {Object.keys(byStrat).length > 0 && (
        <div className="text-[9px] text-[var(--color-text-sub)]">
          <span className="font-semibold text-[var(--color-text)]">Pattern (30d): </span>
          {Object.entries(byStrat).map(([k, v]) => `${k}: ${v.join(' · ')}`).join('  |  ')}
        </div>
      )}

      {/* Sort/filter bar — applies to whichever view is selected below. */}
      <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
        <div role="radiogroup" aria-label="View" className="flex rounded-[var(--radius-control)] overflow-hidden border border-[var(--color-border)]">
          {[['groups', 'Losses / Wins'], ['symbol', 'By symbol']].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={view === k} onClick={() => setView(k)}
              className={`px-2 py-1 cursor-pointer ${view === k ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]' : 'text-[var(--color-text-sub)]'}`}>
              {label}
            </button>
          ))}
        </div>
        <select className={selectCls} aria-label="Filter by symbol" value={filter.symbol} onChange={e => setFilter(f => ({ ...f, symbol: e.target.value }))}>
          <option value="">All symbols</option>
          {symbols.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className={selectCls} aria-label="Filter by strategy" value={filter.strategy} onChange={e => setFilter(f => ({ ...f, strategy: e.target.value }))}>
          <option value="">All strategies</option>
          {strategies.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className={selectCls} aria-label="Filter by verdict" value={filter.classification} onChange={e => setFilter(f => ({ ...f, classification: e.target.value }))}>
          <option value="">All verdicts</option>
          {classifications.map(c => <option key={c} value={c}>{VERDICTS[c]?.label || c}</option>)}
        </select>
        <select className={selectCls} aria-label="Filter by side" value={filter.side} onChange={e => setFilter(f => ({ ...f, side: e.target.value }))}>
          <option value="">Long &amp; Short</option>
          <option value="BUY">Long</option>
          <option value="SELL">Short</option>
        </select>
        <select className={selectCls} aria-label="Sort by" value={sort.key} onChange={e => setSort(s => ({ ...s, key: e.target.value }))}>
          <option value="date">Sort: Date</option>
          <option value="symbol">Sort: Symbol</option>
          <option value="classification">Sort: Verdict</option>
          <option value="r_multiple">Sort: R-multiple</option>
          <option value="net_pnl">Sort: P&amp;L</option>
        </select>
        <button type="button" aria-label={`Sort direction: ${sort.dir === 'desc' ? 'descending' : 'ascending'}`}
          onClick={() => setSort(s => ({ ...s, dir: s.dir === 'desc' ? 'asc' : 'desc' }))}
          className="glass-inset rounded-[var(--radius-control)] px-1.5 py-1 cursor-pointer">
          {sort.dir === 'desc' ? '↓ desc' : '↑ asc'}
        </button>
        {(filter.symbol || filter.strategy || filter.classification || filter.side) && (
          <button type="button" onClick={() => setFilter({ symbol: '', strategy: '', classification: '', side: '' })}
            className="glass-inset rounded-[var(--radius-control)] px-1.5 py-1 cursor-pointer text-[var(--color-text-sub)]">clear filters</button>
        )}
      </div>

      {/* Pagination — owner: dropdown for 25/50/100/200 per page. */}
      <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
        <select className={selectCls} value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
          {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
        <button type="button" disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
          className="glass-inset rounded-[var(--radius-control)] px-1.5 py-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">‹ prev</button>
        <span className="text-[var(--color-text-sub)]">Page {safePage + 1} of {pageCount}</span>
        <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
          className="glass-inset rounded-[var(--radius-control)] px-1.5 py-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">next ›</button>
        <span className="text-[var(--color-text-sub)]">
          {filteredRows.length === 0 ? 0 : safePage * pageSize + 1}–{Math.min(filteredRows.length, (safePage + 1) * pageSize)} of {filteredRows.length} (of {allRows.length} total)
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-[9px] text-[var(--color-text-sub)]">No trades match this filter.</p>
      ) : view === 'groups' ? (
        <>
          <Group title="Losses — what the market did" rows={losses} />
          <Group title="Wins — what the exit engine did" rows={wins} />
        </>
      ) : (
        <div className="space-y-2">
          {Object.entries(bySymbol).map(([symbol, symRows]) => (
            <SymbolTable key={symbol} symbol={symbol} rows={symRows} />
          ))}
        </div>
      )}
    </div>
  )
}

// Compact per-symbol mini table (owner spec) — one row per trade, dense
// columns instead of the accordion cards the Losses/Wins groups use; still
// expandable per-row for the full FieldGrid + sparkline.
function SymbolTable({ symbol, rows }) {
  const [open, setOpen] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const wins = rows.filter(r => WIN_CLASSES.has(r.classification)).length
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center gap-1.5 text-left cursor-pointer text-[9px] font-semibold mb-1">
        <span aria-hidden="true" className="w-2.5 text-[9px] shrink-0 text-[var(--color-text-sub)]">{open ? '▾' : '▸'}</span>
        {symbol} <span className="text-[var(--color-text-sub)] font-normal">({rows.length} · {wins}W/{rows.length - wins}L)</span>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-[9px] tabular-nums">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                {['Date', 'Side', 'TF', 'Strategy', 'Verdict', 'Lesson', 'P&L', 'R'].map(h => (
                  <th key={h} className="py-1 pr-2 text-left whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const v = VERDICTS[r.classification] || { label: r.classification, hint: '' }
                const pnlText = r.net_pnl != null ? `${r.net_pnl < 0 ? '−' : ''}$${Math.abs(r.net_pnl).toFixed(2)}` : '—'
                const isOpen = expandedId === r.id
                return (
                  <Fragment key={r.id}>
                    {/* Row-click stays for pointer users; the caret button is
                        the keyboard-operable disclosure (inventory D41 — a
                        bare tr onClick is keyboard-dead). */}
                    <tr className="border-b border-[var(--color-border)] cursor-pointer" onClick={() => setExpandedId(isOpen ? null : r.id)}>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <button type="button" aria-expanded={isOpen} aria-label="Trade details"
                          onClick={e => { e.stopPropagation(); setExpandedId(isOpen ? null : r.id) }}
                          className="cursor-pointer text-[var(--color-text-sub)] pr-1">
                          <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                        </button>
                        {dateTime(r.trade_closed_at || r.trade_opened_at || r.created_at) || '—'}
                      </td>
                      <td className="py-1 pr-2">{r.side}</td>
                      <td className="py-1 pr-2">{r.timeframe || '—'}</td>
                      <td className="py-1 pr-2 whitespace-nowrap">{r.strategy || 'unlabelled'}</td>
                      <td className="py-1 pr-2 whitespace-nowrap">{v.label}</td>
                      <td className="py-1 pr-2 max-w-[260px] truncate text-[var(--color-text-sub)]" title={r.lesson || v.hint}>{r.lesson || v.hint}</td>
                      <td className={`py-1 pr-2 text-right whitespace-nowrap ${r.net_pnl != null && r.net_pnl < 0 ? 'text-[var(--color-down)]' : r.net_pnl != null ? 'text-[var(--color-up)]' : ''}`}>{pnlText}</td>
                      <td className="py-1 pr-2 text-right whitespace-nowrap">{r.r_multiple != null ? `${r.r_multiple.toFixed(2)}R` : '—'}</td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-[var(--color-border)]">
                        <td colSpan={8} className="py-2">
                          {r.lesson && <p className="text-[9px] font-semibold leading-snug">Lesson: {r.lesson}</p>}
                          <p className="text-[9px] leading-snug text-[var(--color-text)]">{r.detail}</p>
                          <FieldGrid r={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Collapsed by default, same accordion pattern as the Risk-Decision veto
// rows (owner: "create collapse/expand like veto triangle") — with 30
// postmortems on one symbol/timeframe the old always-expanded cards made
// the panel unreadably tall; a one-line summary row now expands on demand.
function Verdict({ r }) {
  const [open, setOpen] = useState(false)
  const v = VERDICTS[r.classification] || { label: r.classification, hint: '' }
  const pnlText = r.net_pnl != null ? `${r.net_pnl < 0 ? '−' : ''}$${Math.abs(r.net_pnl).toFixed(2)}` : '—'
  return (
    <div className="glass-inset rounded-lg p-2">
      {/* overflow-x-auto: a row whose fixed-width (shrink-0) spans exceed a
          phone viewport scrolls sideways instead of bleeding off the card
          (owner iPhone screenshots, 2026-07-24: P&L amounts clipped). */}
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center gap-1.5 min-w-0 text-left cursor-pointer overflow-x-auto whitespace-nowrap">
        <span aria-hidden="true" className="w-2.5 text-[9px] shrink-0 text-[var(--color-text-sub)]">{open ? '▾' : '▸'}</span>
        {/* The TRADE's own timestamp, not the sweep's row-insertion time —
            Codex review caught pm.created_at reading as "when classified",
            which can be identical across many rows from one backfill/sweep
            pass and defeats the point of showing a date at all. */}
        <span className="text-[9px] text-[var(--color-text-sub)] shrink-0 tabular-nums" title={r.trade_closed_at || r.trade_opened_at || r.created_at || ''}>
          {dateTime(r.trade_closed_at || r.trade_opened_at || r.created_at) || '—'}
        </span>
        <span className="font-semibold shrink-0">{r.symbol}</span>
        {/* Strategy is ALWAYS stated, never silently dropped (owner: "if you
            are using different strategy state it") — 'unlabelled' is an
            honest bucket (see the Pattern line above), not a blank. */}
        <span className="text-[9px] text-[var(--color-text-sub)] shrink-0">{r.side} · {r.timeframe || '—'} · {r.strategy || 'unlabelled'}</span>
        <span className="text-[9px] font-bold tracking-wide shrink-0">{v.label}</span>
        <span className="text-[9px] text-[var(--color-text-sub)] truncate">{r.lesson || v.hint}</span>
        <span className={`ml-auto text-[9px] shrink-0 ${r.net_pnl != null && r.net_pnl < 0 ? 'text-[var(--color-down)]' : r.net_pnl != null ? 'text-[var(--color-up)]' : ''}`}>
          {pnlText}{r.r_multiple != null ? ` · ${r.r_multiple.toFixed(2)}R` : ''}
        </span>
      </button>
      {open && (
        <div className="mt-1.5">
          {r.lesson && <p className="text-[9px] font-semibold leading-snug">Lesson: {r.lesson}</p>}
          <p className="text-[9px] leading-snug text-[var(--color-text)]">{r.detail}</p>
          <FieldGrid r={r} />
        </div>
      )}
    </div>
  )
}

const dash = (v) => (v == null || v === '' ? '—' : v)
const px2 = (v) =>(v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 100 ? 2 : 5 }))

// Full Trade-Lesson Extraction field breakdown (owner spec) — every field
// the spec names, laid out explicitly. Fields this codebase doesn't capture
// yet (Fundamental tag, structured Confluence indicators/Fib/VWAP, TP3, a
// SMART-goal text) are labelled "not tracked yet" rather than omitted or
// invented — the spec's shape is honoured, the data gap is honest.
function FieldGrid({ r }) {
  const goal = r.tp1_price != null
    ? `reach TP1 (${px2(r.tp1_price)})`
    : 'no TP1 on record'
  // Owner: don't show fields the codebase doesn't actually track — a row
  // reading "not tracked yet" told the reader nothing they could act on.
  // Only fields with real data now render at all.
  const allRows = [
    ['Symbol', r.symbol],
    ['Strategy', dash(r.strategy)],
    ['Timeframe', dash(r.timeframe)],
    ['Direction', r.side === 'BUY' || r.side === 'long' ? 'Long' : r.side === 'SELL' || r.side === 'short' ? 'Short' : null],
    ['Confluence-count', r.confluence_count != null ? String(r.confluence_count) : null],
    ['Entry', r.entry_price != null ? px2(r.entry_price) : null],
    ['Lot', r.lot != null ? Number(r.lot).toFixed(2) : null],
    ['SL', r.sl_price != null ? px2(r.sl_price) : null],
    ['TP1', r.tp1_price != null ? px2(r.tp1_price) : null],
    ['TP2', r.tp2_price != null ? px2(r.tp2_price) : null],
    ['Exit', r.exit_price != null ? px2(r.exit_price) : null],
    ['Goal (SMART)', goal],
    ['Result', r.result ? r.result : null],
    ['R-multiple', r.r_multiple != null ? `${r.r_multiple.toFixed(2)}R` : null],
    ['Alpha-decay', r.alpha_decay ? `${r.alpha_decay === 'decay' ? 'DECAY' : r.alpha_decay} (keyed Symbol+Strategy+Timeframe)` : null],
    ['Entry-quality', r.entry_quality ? r.entry_quality : null],
  ]
  const rows = allRows.filter(([, value]) => value != null && value !== '')
  return (
    <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[9px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <span className="text-[var(--color-text-sub)]">{label}</span>
          <span>{value}</span>
        </div>
      ))}
      {r.setup_thesis && (
        <span className="col-span-2 mt-0.5 text-[9px] text-[var(--color-text-sub)] opacity-80">
          Setup thesis (free text, not the structured Confluence breakdown above): {r.setup_thesis}
        </span>
      )}
    </div>
  )
}
