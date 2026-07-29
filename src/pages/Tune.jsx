// Tune — every knob a trader can turn, in one place:
// pipeline toggles, autotrade timeframes, risk limits + account, watchlist,
// backtest, presets. Folio tabs (one panel at a time) — no long scroll.
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import { Fragment, useEffect, useState, useCallback, useRef } from 'react'
import Card from '../components/common/Card.jsx'
import Skeleton from '../components/common/Skeleton.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import Field from '../components/common/Field.jsx'
import FolioTabs from '../components/common/FolioTabs.jsx'
import { agentGet, agentPost, agentConfigured, pageAsleep } from '../lib/agent-api.js'
import { stratShort } from '../lib/strategy-labels.js'
import { NATIVE_TF_MS, parseTimeframe, tfMs } from '../lib/timeframes.js'
import { priceDp } from '../lib/std-trade-rows.js'
import WorkedExample from '../components/common/WorkedExample.jsx'
import { keeperExample, guardianExample, closedMarketExample } from '../lib/worked-examples.js'
import StrategyPicker from '../components/watchlist/StrategyPicker.jsx'
import WatchlistScreener from '../components/WatchlistScreener.jsx'
import ScreenerChat from '../components/ScreenerChat.jsx'

// Native broker timeframes power the quick-pick menu; free-text (90m, 1.5h,
// 2d, 1M) is parsed by src/lib/timeframes.js and synthesised agent-side.
const TF_MS = NATIVE_TF_MS
const ALL_TIMEFRAMES = [...Object.keys(TF_MS)].sort((a, b) => tfMs(b) - tfMs(a))
const byTfDesc = (a, b) => tfMs(b) - tfMs(a)

// Shared row-pager for the two pipeline tables below (owner: match the
// Trade-lessons card's 25/50/100/200 dropdown pattern — LossReview.jsx).
// Reset-page-on-change is the caller's job (a plain useEffect at the call
// site, same as LossReview) — this hook only slices.
function usePager(rows, pageSize, page, setPage) {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = rows.slice(safePage * pageSize, (safePage + 1) * pageSize)
  return { pageRows, page: safePage, setPage, pageCount, total: rows.length }
}

function Pager({ pageSize, setPageSize, page, setPage, pageCount, total }) {
  const selectCls = 'glass-inset rounded-[6px] px-1.5 py-1 text-[9px]'
  return (
    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[9px] text-[var(--color-text-sub)]">
      <span>Show</span>
      <select className={selectCls} value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(0) }}>
        {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
      <button type="button" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
        className="glass-inset rounded-[6px] px-1.5 py-1 disabled:opacity-40">‹ prev</button>
      <span>Page {page + 1} of {pageCount}</span>
      <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
        className="glass-inset rounded-[6px] px-1.5 py-1 disabled:opacity-40">next ›</button>
      <span>{total === 0 ? 0 : page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total}</span>
    </div>
  )
}

// UI-6: the 'risk' tab was removed 2026-07-29 (owner). Every field it carried
// now lives on the Risk page, which is the single home for risk settings —
// two editors for one config is how two editors disagree.
const TABS = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'watchlist', label: 'Watchlist' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'presets', label: 'Presets' },
]

// ---------------------------------------------------------------------------
// Timeframe performance — under the Pipeline timeframe chips: one row per
// timeframe, one column per rolling window (2h/4h/1d/5d/1w), each cell the
// net outcome of trades CLOSED in that window: WIN (blue) / LOSS (red) /
// flat / — (no trade). Collapsed/expanded state persists in localStorage so
// the page reopens the way it was left; data refetches on every visit.
// ---------------------------------------------------------------------------
const TF_PERF_OPEN_KEY = 'tune_tf_perf_open'

function TfPerfCell({ cell }) {
  if (!cell || cell.outcome === 'no_trade') {
    return <span className="text-[var(--color-text-sub)]">—</span>
  }
  const money = (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}`
  if (cell.outcome === 'flat') {
    return <Badge tone="neutral">FLAT 0.00 · {cell.trades}</Badge>
  }
  return (
    <Badge tone={cell.outcome === 'win' ? 'up' : 'down'}>
      {cell.outcome === 'win' ? 'WIN' : 'LOSS'} {money(cell.pnl)} · {cell.trades}
    </Badge>
  )
}

function TimeframePerformance({ timeframes }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(TF_PERF_OPEN_KEY) !== '0' } catch { return true }
  })
  const [perf, setPerf] = useState(null)
  const [perfError, setPerfError] = useState(null)
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(0)

  useEffect(() => {
    if (!open) return
    let alive = true
    agentGet('/state/timeframe-performance')
      .then(d => { if (alive) { setPerf(d); setPerfError(d?.error || null) } })
      .catch(e => { if (alive) setPerfError(e.message) })
    return () => { alive = false }
    // Refetch whenever the page is (re)visited, the section is opened, or
    // the armed timeframe list changes — always the latest picture.
  }, [open, timeframes.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOpen = () => setOpen(o => {
    const next = !o
    try { localStorage.setItem(TF_PERF_OPEN_KEY, next ? '1' : '0') } catch { /* private mode */ }
    return next
  })

  const armedRows = (perf?.rows || []).filter(r => r.armed).sort((a, b) => byTfDesc(a.timeframe, b.timeframe))
  const removedRows = (perf?.rows || []).filter(r => !r.armed).sort((a, b) => byTfDesc(a.timeframe, b.timeframe))
  const allRows = [...armedRows, ...removedRows]
  const windows = perf?.windows || ['2h', '4h', '1d', '5d', '1w']
  const pager = usePager(allRows, pageSize, page, setPage)
  const rows = pager.pageRows

  return (
    <div className="mt-3">
      <button
        type="button" onClick={toggleOpen} aria-expanded={open}
        className="flex items-center gap-1.5 text-[9px] font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-text)]"
      >
        <span aria-hidden="true" className="inline-block w-3 text-[9px]">{open ? '▾' : '▸'}</span>
        Timeframe performance
        <span className="font-normal">— trades CLOSED in the last 2h/4h/1d/5d/1w, grouped by TIMEFRAME. The stage-matrix counts are a different cut (per STRATEGY, 30-day usage incl. open trades) — the totals are not meant to match.</span>
      </button>
      {open && (
        <div className="mt-1.5 overflow-x-auto">
          {perfError && <div className="text-[9px] text-[var(--color-down)]">Could not load: {perfError}</div>}
          {!perfError && !perf && <Skeleton lines={3} />}
          {!perfError && perf && (
            <table className="std-cols min-w-full text-[9px]">
              <thead>
                <tr>
                  <th className="py-1 pr-3">Timeframe</th>
                  {windows.map(w => <th key={w} className="py-1 pr-3">{w}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.timeframe} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {r.timeframe}
                      {!r.armed && <span className="ml-1.5 font-normal text-[9px] text-[var(--color-text-sub)]">(removed)</span>}
                    </td>
                    {windows.map(w => (
                      <td key={w} className="py-1.5 pr-3 whitespace-nowrap"><TfPerfCell cell={r.cells?.[w]} /></td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td className="py-1.5 text-[var(--color-text-sub)]" colSpan={windows.length + 1}>No timeframes configured.</td></tr>
                )}
              </tbody>
            </table>
          )}
          {!perfError && perf && allRows.length > 0 && <Pager {...pager} pageSize={pageSize} setPageSize={setPageSize} />}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Strategy × timeframe performance — the RECONCILED grid (owner: "timeframe
// performance doesn't tally with the stage matrix"): ONE shared window,
// closed trades only, strategy rows × timeframe columns, so every number in
// the grid sums to the same total. Unlabelled/unknown get their own bucket.
// ---------------------------------------------------------------------------
function StrategyTfPerformance() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('tune_stf_open') === '1' } catch { return false }
  })
  const [grid, setGrid] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    agentGet('/state/strategy-tf-performance?days=30')
      .then(d => { if (alive) { setGrid(d); setErr(d?.error || null) } })
      .catch(e => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [open])

  const toggle = () => setOpen(o => {
    const next = !o
    try { localStorage.setItem('tune_stf_open', next ? '1' : '0') } catch { /* private mode */ }
    return next
  })
  const money = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(0)
  const pager = usePager(grid?.strategies || [], pageSize, page, setPage)

  return (
    <div className="mt-3">
      <button
        type="button" onClick={toggle} aria-expanded={open}
        className="flex items-center gap-1.5 text-[9px] font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-text)]"
      >
        <span aria-hidden="true" className="inline-block w-3 text-[9px]">{open ? '▾' : '▸'}</span>
        Strategy × timeframe performance
        <span className="font-normal">— closed trades, ONE 30-day window on both axes: the reconciled view</span>
      </button>
      {open && (
        <div className="mt-1.5 overflow-x-auto">
          {err && <div className="text-[9px] text-[var(--color-down)]">Could not load: {err}</div>}
          {!err && !grid && <Skeleton lines={3} />}
          {!err && grid && (
            <>
              <table className="std-cols w-auto text-[9px] tabular-nums">
                <thead>
                  <tr>
                    <th className="py-0.5 pr-3">Strategy</th>
                    {grid.timeframes.map(tf => <th key={tf} className="py-0.5 px-2 text-right whitespace-nowrap">{tf}</th>)}
                    <th className="py-0.5 pl-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {pager.pageRows.map(s => (
                    <tr key={s.strategy} className="border-t border-[var(--color-border)]">
                      {/* Short code, not the raw registry key: every other
                          table in the app renders `FIB`, this one alone
                          rendered `fib_618_fade`, which is both inconsistent
                          and the widest column in a dense grid. */}
                      <td className="py-1 pr-3 whitespace-nowrap" title={s.strategy}>{stratShort(s.strategy)}</td>
                      {grid.timeframes.map(tf => {
                        const c = s.cells[tf]
                        return (
                          <td key={tf} className="py-1 px-2 text-right whitespace-nowrap" title={c ? `${c.n} trades · ${c.winRate}% wins` : ''}>
                            {c
                              ? <><span className="text-[var(--color-text-sub)]">{c.n}·</span><span className={`font-semibold ${c.net >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{money(c.net)}</span></>
                              : <span className="text-[var(--color-text-sub)]">—</span>}
                          </td>
                        )
                      })}
                      <td className="py-1 pl-3 text-right whitespace-nowrap">
                        <span className="text-[var(--color-text-sub)]">{s.total.n}·</span>
                        <span className={`font-semibold ${s.total.net >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{money(s.total.net)}</span>
                      </td>
                    </tr>
                  ))}
                  {grid.strategies.length === 0 && (
                    <tr><td className="py-1.5 text-[var(--color-text-sub)]" colSpan={grid.timeframes.length + 2}>No closed trades in the last {grid.days} days.</td></tr>
                  )}
                </tbody>
              </table>
              <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">
                Cell = trades · net P&L, {grid.days}d window, hover for win rate. Grid total {grid.total_closed} = every closed trade once — nothing double-counted or dropped.
              </p>
              {grid.strategies.length > 0 && <Pager {...pager} pageSize={pageSize} setPageSize={setPageSize} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Strategy × stage matrix — the Pipeline control table. Columns are the four
// pipeline stages (Scan / Backtest / Auto Trade & Open / Live Tweak & Close);
// rows are the registry strategies with the fib confluence filters beneath.
// Each cell shows ✓/✗ plus its last-30-day usage counts. Changing a cell:
// click it, then use the editor that opens BELOW the table, separated by a
// hollow line — the tick itself never flips on the first tap (owner spec).
// Trade-column edits write through the legacy keys on the agent, so Telegram
// /pause, autopilot and the old toggles all stay in agreement.
// ---------------------------------------------------------------------------
const STAGE_MX_OPEN_KEY = 'tune_stage_mx_open'

function MxCell({ on, counts, selected, na, onClick }) {
  if (na) {
    return <td className="py-0.5 px-1 text-center text-[var(--color-text-sub)]">—</td>
  }
  // Tick and counts on ONE line, full-strength text — the stacked pale
  // sublines were unreadable and doubled the row height (owner report).
  return (
    <td className="py-0.5 px-1 text-center">
      <button
        type="button" aria-pressed={!!on} onClick={onClick}
        className={`w-full rounded-md px-1.5 py-0.5 cursor-pointer border whitespace-nowrap ${
          selected
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft,rgba(37,99,235,0.12))]'
            : 'border-transparent hover:border-[var(--color-border)]'
        }`}
      >
        <span className={`text-[9px] font-bold ${on ? 'text-[var(--color-accent)]' : 'text-[var(--color-down)]'}`}>
          {on ? '✓' : '✗'}
        </span>
        {counts && (
          <span className="ml-1 text-[9px] font-semibold text-[var(--color-text)] tabular-nums">
            {counts.ok}<span className="text-[var(--color-accent)]">✓</span>/{counts.fail}<span className="text-[var(--color-down)]">✗</span>
          </span>
        )}
      </button>
    </td>
  )
}

function StageMatrix({ mx, onUpdated, onError, armTarget }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(STAGE_MX_OPEN_KEY) !== '0' } catch { return true }
  })
  const [sel, setSel] = useState(null)   // { kind, key, name, stage }
  const [busy, setBusy] = useState(false)
  const editorRef = useRef(null)
  const armedOnce = useRef(false)

  // Deep-link from Desk's Edge-health ("tap rsi2_reversion → arm it"): open the
  // matrix, preselect that strategy's Auto Trade cell so the Turn ON control is
  // right there, and scroll it into view. Crucial on iPhone, where the wide
  // matrix otherwise buries the cell the owner came to flip. Runs once.
  useEffect(() => {
    if (armedOnce.current || !armTarget || !mx) return
    const row = (mx.strategies || []).find(r => r.key === armTarget)
    if (!row) return
    armedOnce.current = true
    setOpen(true)
    setSel({ kind: 'strategy', key: row.key, name: row.name, stage: 'trade' })
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }, [armTarget, mx])

  const toggleOpen = () => setOpen(o => {
    const next = !o
    try { localStorage.setItem(STAGE_MX_OPEN_KEY, next ? '1' : '0') } catch { /* private mode */ }
    return next
  })

  if (!mx) {
    return <Skeleton lines={4} className="mt-3" />
  }

  const columns = mx.columns || []
  const counts = (kind, key, stage) => mx.stats?.[`${kind}|${key}|${stage}`] || null
  const selRow = sel
    ? (sel.kind === 'strategy' ? mx.strategies : mx.filters)?.find(r => r.key === sel.key)
    : null
  const selOn = selRow ? selRow.stages[sel.stage] : null
  const selCol = sel ? columns.find(c => c.key === sel.stage) : null

  const pick = (kind, row, stage) => {
    if (kind === 'filter' && stage === 'manage') return // no such cell
    setSel({ kind, key: row.key, name: row.name, stage })
  }

  const apply = async (on) => {
    if (!sel) return
    if (sel.stage === 'trade' && on && sel.kind === 'strategy' &&
        !window.confirm(`Arm ${sel.name} for Auto Trade & Open? The agent will place REAL orders on its signals — same risk gate.`)) return
    if (sel.stage === 'trade' && !on && sel.key === 'fib_618_fade' && sel.kind === 'strategy' &&
        !window.confirm('Turn the Fib 61.8% fade OFF for Auto Trade & Open? It is the strategy behind your armed pending orders — no new fib orders will open (scanning continues; existing pending orders are not cancelled).')) return
    setBusy(true)
    try {
      const r = await agentPost('/actions/stage-matrix', { kind: sel.kind, key: sel.key, stage: sel.stage, on })
      onUpdated?.(r)
    } catch (e) { onError?.(e.message) } finally { setBusy(false) }
  }

  const renderRow = (kind, row) => (
    <tr key={`${kind}|${row.key}`} className="border-t border-[var(--color-border)]">
      <td className={`py-0.5 pr-3 whitespace-nowrap ${kind === 'strategy' ? '' : 'pl-4 text-[var(--color-text-sub)]'}`}>
        {row.name}
      </td>
      {columns.map(c => (
        <MxCell
          key={c.key}
          na={row.stages[c.key] === null}
          on={row.stages[c.key]}
          counts={counts(kind, row.key, c.key)}
          selected={sel?.kind === kind && sel?.key === row.key && sel?.stage === c.key}
          onClick={() => pick(kind, row, c.key)}
        />
      ))}
    </tr>
  )

  return (
    <div className="mt-3">
      <button
        type="button" onClick={toggleOpen} aria-expanded={open}
        className="flex items-center gap-1.5 text-[9px] font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-text)]"
      >
        <span aria-hidden="true" className="inline-block w-3 text-[9px]">{open ? '▾' : '▸'}</span>
        Strategy × stage matrix
        <span className="font-normal">— what runs at each pipeline stage; counts are the last {mx.windowDays || 30} days</span>
      </button>
      {open && (
        <>
          <div className="mt-1.5 overflow-x-auto">
            {/* w-auto: columns hug their content instead of spreading across
                the page (owner: "too much white space, squeeze rows/columns"). */}
            <table className="std-cols w-auto text-[9px]">
              <thead>
                <tr>
                  <th className="py-0.5 pr-3">Strategy</th>
                  {columns.map(c => (
                    <th key={c.key} className="py-0.5 px-2 text-center whitespace-nowrap">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(mx.strategies || []).map(row => renderRow('strategy', row))}
                <tr className="border-t border-[var(--color-border)]">
                  <td colSpan={columns.length + 1} className="py-0.5 text-[9px] text-[var(--color-text-sub)]">
                    Filters (fib confluence — annotate the scan, gate the trade)
                  </td>
                </tr>
                {(mx.filters || []).map(row => renderRow('filter', row))}
              </tbody>
            </table>
          </div>
          {/* Hollow separator line + the editor for the selected cell — the
              ONLY place a cell's value changes (owner spec: click the cell,
              then edit below the line). */}
          <hr ref={editorRef} className="my-3 border-0 border-t border-[var(--color-border)] scroll-mt-24" />
          {!sel && (
            <p className="text-[9px] text-[var(--color-text-sub)]">
              Tap any ✓/✗ cell above to change it here. Scan is wide by default — every strategy is analysed and filters only annotate (a failed filter no longer hides a conviction; it blocks the order at Auto Trade &amp; Open instead).
            </p>
          )}
          {sel && (
            <div className="flex flex-wrap items-center gap-2 text-[9px]">
              <span className="font-semibold">{sel.name}</span>
              <span className="text-[var(--color-text-sub)]">× {selCol?.label || sel.stage} — currently</span>
              <Badge tone={selOn ? 'on' : 'off'}>{selOn ? 'ON ✓' : 'OFF ✗'}</Badge>
              <Button size="sm" disabled={busy || selOn === true} onClick={() => apply(true)}>Turn ON</Button>
              <Button size="sm" variant="subtle" disabled={busy || selOn === false} onClick={() => apply(false)}>Turn OFF</Button>
              <Button size="sm" variant="subtle" onClick={() => setSel(null)}>Close</Button>
              <span className="w-full text-[9px] text-[var(--color-text-sub)]">
                {sel.stage === 'scan' && 'Scan: whether the 5-minute scan computes this at all. Filters ON here gate the scan the old strict way; OFF means analyse everything and let Auto Trade & Open decide.'}
                {sel.stage === 'backtest' && 'Backtest: whether the nightly autopilot sweep tests this strategy / the manual Backtest tab applies this filter.'}
                {sel.stage === 'trade' && 'Auto Trade & Open: the live gate. Writes the same agent key the old toggles used — Telegram and autopilot stay in sync.'}
                {sel.stage === 'manage' && 'Live Tweak & Close: whether the monitor may move stops / close positions opened by this strategy. Broker-side SL/TP and your per-position guards always stay active.'}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// UI-6 (2026-07-29): the typed-field draft persistence that lived here
// existed only for the Risk tab's money-critical inputs. The tab is gone and
// the Risk page is now the single editor for those fields, so the machinery
// went with it rather than lingering with no consumer.


// ---------------------------------------------------------------------------
// Backtest verdict — evidence-based, three states:
//   go        every criterion passed
//   thin      the EDGE criteria pass but there aren't enough trades to trust
//             them (1,000 bars is ~5.5 months of 4h but only ~10 days of 15m
//             — high TFs can't physically reach 10 trades in the window, so
//             "not enough evidence" must not read as "proven bad")
//   no-go     an edge criterion actually failed
// Profit factor is null when there are zero losing trades — that's an
// INFINITE profit factor and must pass, not fail, the PF bar.
// ---------------------------------------------------------------------------
const GO_MIN_TRADES = 10
function verdictFor(r) {
  if (!r || r.error) return null
  if (!r.trades) return { state: 'no-go', label: 'NO-GO', checks: [{ ok: false, text: 'no trades taken in this window' }] }
  const pfVal = r.profitFactor ?? (r.losses === 0 ? Infinity : 0)
  const checks = [
    {
      ok: r.trades >= GO_MIN_TRADES, gate: 'evidence',
      text: `${r.trades} trade${r.trades === 1 ? '' : 's'} — need ≥${GO_MIN_TRADES} to trust the numbers`,
    },
    {
      ok: pfVal >= 1.1, gate: 'edge',
      text: `profit factor ${pfVal === Infinity ? '∞ (no losing trades)' : pfVal} — need ≥1.1`,
    },
    {
      ok: r.totalProfitPct > 0, gate: 'edge',
      text: `total ${r.totalProfitPct}% after costs — need >0`,
    },
  ]
  // Walk-forward gates (when the agent returned segment data): the edge must
  // repeat across sequential segments, and no segment may be catastrophic.
  if (r.wfActive != null && r.wfActive >= 2) {
    checks.push({
      ok: r.wfPositive * 2 > r.wfActive, gate: 'edge',
      text: `walk-forward: ${r.wfPositive} of ${r.wfActive} active segments positive — need a majority`,
    })
  }
  if (r.wfWorstMddPct != null && r.wfWorstMddPct > 10) {
    checks.push({
      ok: false, gate: 'edge',
      text: `a walk-forward segment drew down ${r.wfWorstMddPct}% — catastrophic (cap 10%)`,
    })
  }
  const edgeOk = checks.filter(c => c.gate === 'edge').every(c => c.ok)
  const evidenceOk = checks.filter(c => c.gate === 'evidence').every(c => c.ok)
  if (edgeOk && evidenceOk) return { state: 'go', label: 'GO', checks }
  // Conservative go: the edge criteria pass, only the sample size is short.
  if (edgeOk) return { state: 'thin', label: 'GO (thin)', checks }
  return { state: 'no-go', label: 'NO-GO', checks }
}

// Tap (or hover) the verdict to see exactly which criteria passed/failed.
function VerdictBadge({ r }) {
  const [open, setOpen] = useState(false)
  const v = verdictFor(r)
  if (!v) return null
  const tone = v.state === 'go' ? 'up' : v.state === 'thin' ? 'info' : 'down'
  return (
    <span className="relative inline-block">
      <button
        type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        title={v.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.text}`).join('\n')}
        className="cursor-pointer"
      >
        <Badge tone={tone}>{v.label}</Badge>
      </button>
      {open && (
        <span className="glass-panel absolute right-0 top-full z-30 mt-1 w-72 rounded-[12px] p-3 shadow-xl block text-left">
          <span className="block text-[9px] font-semibold mb-1">Why {v.label}?</span>
          {v.checks.map((c, i) => (
            <span key={i} className={`block text-[9px] py-0.5 ${c.ok ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
              {c.ok ? '✓' : '✗'} {c.text}
            </span>
          ))}
          {v.state === 'thin' && (
            <span className="block text-[9px] text-[var(--color-text-sub)] mt-1">
              The edge looks positive but the sample is too small to prove it. Not armed by Activate unless you tick "arm anyway" on the row.
            </span>
          )}
        </span>
      )}
    </span>
  )
}

// Colour clearly-good cells blue and clearly-bad cells red; leave the
// ambiguous middle neutral. lowerBetter flips the sense for drawdown columns.
function metricClass(v, { good, bad, lowerBetter = false } = {}) {
  const n = Number(v)
  if (v == null || Number.isNaN(n)) return ''
  const isGood = lowerBetter ? n <= good : n >= good
  const isBad = lowerBetter ? n >= bad : n <= bad
  if (isGood) return 'text-[var(--color-up)] font-semibold'
  if (isBad) return 'text-[var(--color-down)]'
  return ''
}

// Backtest table columns — key is the result field ('tf' sorts by duration).
const BT_COLS = [
  { key: 'tf', label: 'TF' },
  { key: 'trades', label: 'Trades' },
  { key: 'winRatePct', label: 'Win rate' },
  { key: 'arrPct', label: 'ARR' },
  { key: 'totalProfitPct', label: 'Total' },
  { key: 'profitFactor', label: 'Profit factor' },
  { key: 'sharpeAnnualized', label: 'Sharpe' },
  { key: 'sortinoAnnualized', label: 'Sortino' },
  { key: 'calmarRatio', label: 'Calmar' },
  { key: 'maxDrawdownPct', label: 'Max DD' },
  { key: 'mddP95Pct', label: 'DD p95', title: '95th-percentile max drawdown across 1,000 reshuffles of the same trades — the single backtest path may be a lucky ordering' },
  { key: 'cvar95Pct', label: 'CVaR', title: 'Average of the worst 5% of trades (tail-loss expectancy)' },
  { key: 'wfPositive', label: 'WF', title: 'Walk-forward: the same rule over 4 sequential quarters of the data — filled blue = profitable segment, filled red = losing, hollow = no trades. The edge should repeat, not appear once.' },
]

function sortBtRows(entries, { col, dir }) {
  const sign = dir === 'desc' ? -1 : 1
  const val = ([tf, r]) => {
    if (col === 'tf') return tfMs(tf)
    if (col === 'profitFactor') return r.profitFactor ?? (r.trades > 0 && r.losses === 0 ? Infinity : null)
    const v = Number(r[col])
    return Number.isFinite(v) ? v : null
  }
  return [...entries].sort((a, b) => {
    const va = val(a)
    const vb = val(b)
    if (va == null && vb == null) return byTfDesc(a[0], b[0])
    if (va == null) return 1   // rows without the metric sink to the bottom
    if (vb == null) return -1
    return sign * (va - vb) || byTfDesc(a[0], b[0])
  })
}

// (The old regex-based instrumentCategory browser was replaced by the
// broker-truth classification tree from GET /actions/instrument-tree.)

// Quick-group presets — market-standard buckets. Every list is intersected
// with the broker's actual instrument names before adding, so unavailable
// tickers are silently dropped and the chip shows the true count. Broker
// naming varies for single equities (suffix conventions) — the counts make
// gaps visible instead of failing silently.
// `market` buckets the screener's group picker into sub-sections (owner
// 2026-07-28: "stocks sub-tab by market") — one <optgroup> per market, so
// the stock lists sit under their market instead of one flat list.
const PRESET_GROUPS = [
  { key: 'FX majors', market: 'Forex', names: ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'] },
  { key: 'FX minors (crosses)', market: 'Forex', names: ['EURGBP', 'EURJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'EURNZD', 'GBPJPY', 'GBPCHF', 'GBPAUD', 'GBPCAD', 'GBPNZD', 'AUDJPY', 'AUDCAD', 'AUDCHF', 'AUDNZD', 'CADJPY', 'CADCHF', 'CHFJPY', 'NZDJPY', 'NZDCAD', 'NZDCHF'] },
  { key: 'Asian indices', market: 'Indices', names: ['JPN225', 'HK50', 'CN50', 'AUS200', 'SGP30', 'INDIA50', 'CHINAH', 'TWIX'] },
  { key: 'European indices', market: 'Indices', names: ['GER40', 'UK100', 'FRA40', 'SPA35', 'EU50', 'EUSTX50', 'SWI20', 'NETH25', 'IT40'] },
  { key: 'US indices', market: 'Indices', names: ['US30', 'US500', 'NAS100', 'US2000', 'VIX'] },
  { key: 'Metals', market: 'Commodities', names: ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD', 'COPPER'] },
  { key: 'Energies', market: 'Commodities', names: ['SPOTCRUDE', 'WTI', 'BRENT', 'NATGAS'] },
  { key: 'Softs & agri', market: 'Commodities', names: ['COCOA', 'COFFEE', 'SUGAR', 'COTTON', 'WHEAT', 'CORN', 'SOYBEAN'] },
  { key: 'Crypto majors', market: 'Crypto', names: ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD', 'ADAUSD', 'LTCUSD', 'DOGEUSD'] },
  { key: 'US mega-cap 10', market: 'Stocks — US', names: ['AAPL.US', 'MSFT.US', 'NVDA.US', 'GOOGL.US', 'AMZN.US', 'META.US', 'TSLA.US', 'AVGO.US', 'LLY.US', 'JPM.US'] },
  { key: 'FTSE 100 top 20', market: 'Stocks — UK', names: ['AZN.UK', 'SHEL.UK', 'HSBA.UK', 'ULVR.UK', 'BP.UK', 'GSK.UK', 'RIO.UK', 'DGE.UK', 'REL.UK', 'BATS.UK', 'AAL.UK', 'LSEG.UK', 'BARC.UK', 'NG.UK', 'VOD.UK', 'PRU.UK', 'LLOY.UK', 'TSCO.UK', 'CPG.UK', 'RR.UK'] },
  // Owner-curated (no sector data exists anywhere in this app — see the
  // Defense screener note below): well-known, liquid US aerospace/defense
  // contractors. Same "intersect with what the broker actually offers"
  // handling as every other preset group.
  { key: 'Defense stocks', market: 'Stocks — US', names: ['LMT.US', 'RTX.US', 'NOC.US', 'GD.US', 'BA.US', 'LHX.US', 'HII.US', 'TXT.US', 'KTOS.US', 'LDOS.US', 'AVAV.US', 'BWXT.US', 'CW.US', 'HEI.US', 'TDY.US'] },
]
const PRESET_MARKETS = [...new Set(PRESET_GROUPS.map(g => g.market))]

// Owner spec (2026-07-22): shrink every genuine on/off control app-wide —
// tiny bordered curved-square, background matched to the page (not a fixed
// color, so it reads correctly in both themes), minimal text-to-border
// padding, and the ON/OFF word itself dropped — state is carried by color +
// weight + case alone (bold uppercase = off, normal titlecase = on) instead
// of spelling it out, since that's the actual "estate" being reclaimed.
// UI-6: the Risk page's section heading, so the Pipeline tab's cards read
// the same way. Deliberately the same markup rather than a shared import —
// the two pages have diverged before, and a copied six-line heading is a
// cheaper mistake than a shared component that grows props for both.
function SectionTitle({ children }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      <h3 className="t-h3">{children}</h3>
    </div>
  )
}

// Owner (2026-07-29): "The positive / or ON button or state should be blue
// with the blueish-tint background while the negative or OFF button or state
// is red with redish-tint background."
//
// Two things were wrong here before. ON was the clay ACCENT, which is the
// navigation colour — so an armed strategy looked like a selected tab. And
// NEITHER state had a tinted background: both sat on --color-bg, so the only
// signal was a 1px border and the text colour, which is the weakest possible
// cue on a page carrying dozens of these.
//
// Case is no longer doing semantic work either. It used to shout an OFF
// toggle in bold uppercase and whisper an ON one in normal capitalize, which
// inverted the emphasis — the state you want to notice is whichever one is
// unexpected, and case cannot know that. Colour carries it now; the label
// reads the same either way.
function Toggle({ on, onClick, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={on}
      onClick={onClick}
      title={`${label}: ${on ? 'ON' : 'OFF'} — tap to turn ${on ? 'off' : 'on'}`}
      className={`inline-flex items-center rounded-[2px] border leading-none cursor-pointer transition-colors px-[3px] py-[1px] text-[9px] font-semibold capitalize ${
        on
          ? 'border-[var(--color-state-on-border)] text-[var(--color-state-on-text)] bg-[var(--color-state-on-bg)]'
          : 'border-[var(--color-state-off-border)] text-[var(--color-state-off-text)] bg-[var(--color-state-off-bg)]'
      }`}
    >
      {label}
    </button>
  )
}

function SavedReports() {
  const [names, setNames] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    agentGet('/state/backtest-reports').then(r => setNames(r.reports || [])).catch(e => setErr(e.message))
  }, [])
  const grab = async (name) => {
    try {
      const r = await agentGet(`/state/backtest-reports/${name}`)
      const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html' }))
      const a = document.createElement('a'); a.href = url; a.download = name; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { setErr(e.message) }
  }
  if (err) return <p className="text-[var(--color-warning-text)] mt-1">{err}</p>
  if (!names) return <Skeleton lines={2} className="mt-1" />
  if (names.length === 0) return <p className="text-[var(--color-text-sub)] mt-1">None on the agent right now — reports live on temporary disk and are wiped by each redeploy. The Download button after a run is the durable copy.</p>
  return (
    <ul className="mt-1 space-y-0.5">
      {names.map(n => (
        <li key={n}>
          <button type="button" className="text-[var(--color-accent)] cursor-pointer hover:underline" onClick={() => grab(n)}>{n}</button>
        </li>
      ))}
    </ul>
  )
}

export default function Tune() {
  const [tab, setTab] = useState(() => {
    try {
      // A ?tab= link (e.g. from Edge Health's strategy names) wins over the
      // remembered tab — otherwise the link dumped you on whatever tab you
      // last used (owner: "hyperlink to Risk... i cannot arm them, why?").
      const urlTab = new URLSearchParams(window.location.search).get('tab')
      if (urlTab && TABS.some(t => t.id === urlTab)) return urlTab
      // Validate the REMEMBERED tab too: anyone whose session last sat on the
      // now-deleted 'risk' tab would otherwise land on a blank page.
      const saved = sessionStorage.getItem('tune_tab')
      return saved && TABS.some(t => t.id === saved) ? saved : 'pipeline'
    } catch { return 'pipeline' }
  })
  const pickTab = (id) => { setTab(id); try { sessionStorage.setItem('tune_tab', id) } catch { /* quota — skip */ } }
  // ?arm=<strategyKey> deep-link (Desk Edge-health → arm a strategy). Read once.
  const [armTarget] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('arm') } catch { return null }
  })

  const [config, setConfig] = useState(null)          // toggles + symbols
  const [risk, setRisk] = useState(null)              // { effective, derived }
  const [timeframes, setTimeframes] = useState(['4h', '1d'])
  const [armedMatrix, setArmedMatrix] = useState(null)   // {SYM:[tfs]} currently armed on the agent
  const [tfMenu, setTfMenu] = useState(false)
  const [tfDraft, setTfDraft] = useState('')   // free-text timeframe, e.g. "1.5h"
  // Backtest table sorting — TF slow→fast by default; click a header to re-sort.
  const [btSort, setBtSort] = useState({ col: 'tf', dir: 'desc' })
  const [rsiFilter, setRsiFilter] = useState(false)
  const [vwapFilter, setVwapFilter] = useState(false)
  // Backtest-only session filter — proves whether the edge depends on the
  // instrument's prime-liquidity hours before any live gate exists.
  const [btSessionFilter, setBtSessionFilter] = useState(false)
  const [btTouchFill, setBtTouchFill] = useState(false)
  const [btStrategy, setBtStrategy] = useState('fib_618_fade')
  const [screener, setScreener] = useState(null)     // cup-screener results
  const [screenerBusy, setScreenerBusy] = useState(false)
  const [fvgFilter, setFvgFilter] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [allSymbols, setAllSymbols] = useState([])   // broker's full instrument list for autocomplete
  const [browse, setBrowse] = useState(false)        // full-catalogue browser open?
  const [browseQ, setBrowseQ] = useState('')
  // Broker-truth classification tree (asset class → category → symbols) for
  // the tree browser; loaded once when the browser is first opened.
  const [tree, setTree] = useState(null)
  const [treeErr, setTreeErr] = useState('')
  const [openNodes, setOpenNodes] = useState(() => new Set())
  const toggleNode = (key) => setOpenNodes(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const [scanInfo, setScanInfo] = useState(null)     // latest scan per symbol — price + signal for the watchlist
  const [regimeBy, setRegimeBy] = useState(null)     // latest regime (atr_pct, regime type) per symbol — real volatility read for the screener
  // Screener works over ANY preset group (owner: "Defense stocks screener is
  // an example, you should be able to let me select any stocks or stock
  // group or FOREX") — group picker + an optional custom ad-hoc symbol list
  // for one-off searches that don't belong to a named preset.
  const [screenerGroupKey, setScreenerGroupKey] = useState('Defense stocks')
  const [screenerCustom, setScreenerCustom] = useState('')
  // LLM free-text search (owner: "AI stock", "network layer stocks", "P.E.
  // >3") — a result here wins over both the preset group and the typed
  // custom list until cleared, since it's the most specific choice made.
  const [screenerChatOpen, setScreenerChatOpen] = useState(false)
  const [screenerAiSymbols, setScreenerAiSymbols] = useState(null)
  const [wlStats, setWlStats] = useState(null)       // live per-symbol closed-trade results
  const [wlRemoved, setWlRemoved] = useState(null)   // previously-watched symbols (server record)
  const [wlSelected, setWlSelected] = useState(() => new Set()) // checkbox bulk-select in the watchlist table
  // Symbol whose strategy picker is open, or '__bulk__' for the selected rows.
  const [stratEditor, setStratEditor] = useState(null)
  // Screener sections collapse (owner 2026-07-28: triangle collapse — the
  // two screeners took the whole first screen). Default CLOSED, per device.
  const [screenerOpen, setScreenerOpen] = useState(() => { try { return localStorage.getItem('tune_screener_open') === 'true' } catch { return false } })
  const [chScreenerOpen, setChScreenerOpen] = useState(() => { try { return localStorage.getItem('tune_ch_open') === 'true' } catch { return false } })
  const flip = (setter, storageKey) => setter(v => { try { localStorage.setItem(storageKey, String(!v)) } catch { /* private mode */ } return !v })
  // Durable backtest history (backtest_runs table) — loaded when opened.
  const [btHistOpen, setBtHistOpen] = useState(false)
  const [btHist, setBtHist] = useState(null)
  const [btHistSym, setBtHistSym] = useState('')
  const [stageMx, setStageMx] = useState(null)       // strategy × stage matrix (Pipeline table)
  const [vetoMix, setVetoMix] = useState(null)       // veto reasons breakdown (30d)
  const [monOvDraft, setMonOvDraft] = useState({ symbol: '', minutes: '' }) // per-symbol monitor override editor
  // Excel-style bands in the active watchlist: which group bands are OPEN.
  // Groups default COLLAPSED (100s of instruments must not overwhelm the
  // page); the Singles band starts open. Persisted per device.
  const [openBands, setOpenBands] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('tune_wl_bands_v1'))
      return new Set(Array.isArray(stored) ? stored : ['__singles__'])
    } catch { return new Set(['__singles__']) }
  })
  const toggleBand = (k) => setOpenBands(prev => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k); else next.add(k)
    try { localStorage.setItem('tune_wl_bands_v1', JSON.stringify([...next])) } catch { /* private mode */ }
    return next
  })
  const [sizingPrev, setSizingPrev] = useState(null) // dynamic lot preview per symbol — same math as the risk gate
  const [keeper, setKeeper] = useState(null)         // Profit Keeper policy (manual/external position protection)
  const [lossGuard, setLossGuard] = useState(null)   // Loss Guardian policy (naked-position safety net)
  const [closedLimits, setClosedLimits] = useState(null) // resting limit orders for closed markets
  // Backtest covers the ENABLED watchlist symbols — the instruments set on
  // this page — never a typed-in default. Tap a chip to skip one this run.
  const [btSkip, setBtSkip] = useState(() => new Set())
  // Backtest results survive tab switches (sessionStorage) — losing them on
  // navigation hid the Activate button and read as "nothing happened".
  const [bt, setBt] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('backtest_cache_v2')) || null } catch { return null }
  })
  const [btError, setBtError] = useState('')
  const [btRunning, setBtRunning] = useState(false)
  // Per-row "arm anyway" overrides (sym|tf) — the trader may knowingly arm a
  // NO-GO / GO (thin) timeframe; the verdict stays honest, the choice is theirs.
  const [btForce, setBtForce] = useState(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('bt_force_v1')) || []) } catch { return new Set() }
  })
  // Which verdict CLASSES go into Activate (owner spec): Go only (default),
  // Go + Go (thin), Go (thin) only, or everything incl. No-Go (<½ blue).
  const [btArmClass, setBtArmClass] = useState(() => {
    try { return sessionStorage.getItem('bt_arm_class') || 'go' } catch { return 'go' }
  })
  const pickArmClass = (v) => {
    setBtArmClass(v)
    try { sessionStorage.setItem('bt_arm_class', v) } catch { /* quota — skip */ }
  }
  const toggleForce = (sym, tf) => setBtForce(prev => {
    const k = `${sym}|${tf}`
    const next = new Set(prev)
    if (next.has(k)) next.delete(k); else next.add(k)
    try { sessionStorage.setItem('bt_force_v1', JSON.stringify([...next])) } catch { /* quota — skip */ }
    return next
  })
  const [status, setStatus] = useState('')
  const [lastSaved, setLastSaved] = useState(null) // persistent save proof { msg, at }
  const [error, setError] = useState('')

  // Stamped every time this page WRITES. A /state/config fetch issued before
  // a save resolves after it and carries the pre-save answer — applying that
  // silently reverts what you just changed on screen while the server holds
  // the new value (seen at 390px, where the page has more in flight: a symbol
  // reverted to its old strategy pick 2.5s after a save the agent had
  // accepted). Any load() whose fetches began before the newest write is
  // therefore discarded; the write's own load() is the one that lands.
  const writeSeq = useRef(0)

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    const seenSeq = writeSeq.current
    console.log('[dbg] load start seq=', seenSeq)
    try {
      const [c, r, tf, rf, vf, ff, sm, vm] = await Promise.all([
        agentGet('/state/config'),
        agentGet('/state/risk-config'),
        agentGet('/state/autotrade-timeframes').catch(() => null),
        agentGet('/state/fib-rsi-filter').catch(() => null),
        agentGet('/state/fib-vwap-filter').catch(() => null),
        agentGet('/state/fib-fvg-filter').catch(() => null),
        agentGet('/state/stage-matrix').catch(() => null),
        agentGet('/state/veto-breakdown?days=30').catch(() => null),
      ])
      console.log('[dbg] load done seen=', seenSeq, 'now=', writeSeq.current, 'EURUSD=', JSON.stringify(c.symbols?.find(x=>x.symbol==='EURUSD')?.strategies))
      if (writeSeq.current !== seenSeq) { console.log('[dbg] DISCARDED'); return }
      setConfig(c)
      setRisk(r)
      if (tf?.timeframes) setTimeframes(tf.timeframes)
      setArmedMatrix(tf?.matrix && typeof tf.matrix === 'object' ? tf.matrix : null)
      if (rf) setRsiFilter(!!rf.on)
      if (vf) setVwapFilter(!!vf.on)
      if (ff) setFvgFilter(!!ff.on)
      if (sm) setStageMx(sm)
      if (vm) setVetoMix(vm)
      setError('')
    } catch (e) { setError(e.message) }
  }, [])

  // Deferred a tick: react-hooks/set-state-in-effect forbids state writes
  // synchronously inside an effect body.
  useEffect(() => {
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [load])

  // Live-refresh the PIPELINE FLAGS only — autotrade can be flipped in the
  // background (equity stop, /killall, Telegram /pause, autopilot auto mode)
  // and a once-on-mount snapshot left this page contradicting Desk/Trade.
  // Only toggle-ish keys are merged so in-progress form edits are never
  // clobbered.
  useEffect(() => {
    if (!agentConfigured()) return undefined
    const t = setInterval(async () => {
      if (pageAsleep()) return // background/idle tab — skip the sync poll
      try {
        const c = await agentGet('/state/config')
        setConfig(prev => prev ? {
          ...prev,
          scan_enabled: c.scan_enabled,
          analyze_enabled: c.analyze_enabled,
          autotrade_enabled: c.autotrade_enabled,
          autopilot_mode: c.autopilot_mode,
          strategies: c.strategies,
          pending_mode_enabled: c.pending_mode_enabled,
          pending_matrix: c.pending_matrix,
        } : c)
        // Trade column of the stage matrix can flip in the background too
        // (autopilot arm/disarm, Telegram) — refresh the whole table.
        const sm = await agentGet('/state/stage-matrix')
        if (sm?.strategies) setStageMx(sm)
      } catch { /* transient — next tick retries */ }
    }, 20_000)
    return () => clearInterval(t)
  }, [])

  // Latest scan snapshot — live price + signal per watchlist symbol.
  useEffect(() => {
    if (tab !== 'watchlist' || !agentConfigured()) return
    agentGet('/state/scans').then(r => {
      const by = {}
      for (const s of r?.lastResults?.scans || []) by[s.symbol] = s
      setScanInfo({ at: r?.lastScanAt || null, by })
    }).catch(() => {})
    agentGet('/state/regime').then(r => {
      const by = {}
      for (const row of r?.regimes || []) by[row.symbol] = row
      setRegimeBy(by)
    }).catch(() => {})
    // Dynamic per-symbol lot sizing — same math as the live risk gate.
    agentGet('/state/sizing-preview').then(r => setSizingPrev(r || null)).catch(() => {})
    // Live per-symbol results — evidence beside the config (owner order).
    agentGet('/state/watchlist-stats').then(r => setWlStats(r || null)).catch(() => {})
    // Previously-watched record — powers the re-add card.
    agentGet('/state/watchlist-removed').then(r => setWlRemoved(r?.removed || [])).catch(() => {})
  }, [tab])

  // Durable backtest history — (re)loaded when the section opens, the symbol
  // filter changes, OR a run finishes while the section is open (bt?.ranAt
  // changes when the job poll applies a completed run — Codex review).
  useEffect(() => {
    if (!btHistOpen || !agentConfigured()) return
    const q = btHistSym.trim() ? `?symbol=${encodeURIComponent(btHistSym.trim().toUpperCase())}` : ''
    agentGet(`/state/backtest-history${q}`).then(r => setBtHist(r || null)).catch(() => {})
  }, [btHistOpen, btHistSym, bt?.ranAt])

  // Profit Keeper policy — loaded once; updates flow through the POST replies.
  useEffect(() => {
    if (!agentConfigured()) return
    agentGet('/state/profit-keeper').then(r => setKeeper(r?.config || null)).catch(() => {})
    agentGet('/state/loss-guardian').then(r => setLossGuard(r?.config || null)).catch(() => {})
    agentGet('/state/closed-market-limits').then(r => setClosedLimits(r?.config || null)).catch(() => {})
  }, [])

  // Broker instrument list (once) — powers the add-symbol autocomplete.
  useEffect(() => {
    if (!agentConfigured()) return
    agentGet('/state/symbol-map')
      .then(r => setAllSymbols(Object.keys(r?.map || {}).sort()))
      .catch(() => {})
  }, [])

  // Top matches for the typed prefix (name contains, prefix first)
  const q = newSymbol.trim().toUpperCase()
  const suggestions = q.length >= 1
    ? allSymbols.filter(s => s.includes(q)).sort((a, b) => (a.startsWith(q) === b.startsWith(q) ? a.localeCompare(b) : a.startsWith(q) ? -1 : 1)).slice(0, 25)
    : []

  const flash = (msg) => { setStatus(msg); setTimeout(() => setStatus(''), 2500) }
  const run = async (fn, okMsg) => {
    try {
      await fn()
      writeSeq.current += 1; console.log('[dbg] write done seq=', writeSeq.current)
      await load(); flash(okMsg)
      // Persistent "it saved" proof (owner: "i feel not saved but actually is").
      // The flash vanishes in 2.5s; this line stays with a clock time so you
      // can always confirm the last change stuck.
      if (okMsg) setLastSaved({ msg: okMsg, at: new Date() })
    } catch (e) { setError(e.message) }
  }

  const toggle = (path, key, current) =>
    run(() => agentPost(path, { on: !current }), `${key} ${!current ? 'enabled' : 'disabled'}`)

  const toggleTimeframe = (tf) => {
    const next = timeframes.includes(tf) ? timeframes.filter(t => t !== tf) : [...timeframes, tf]
    if (next.length === 0) { setError('At least one timeframe must stay enabled'); return }
    setTimeframes(next)
    run(() => agentPost('/actions/autotrade-timeframes', { timeframes: next }), 'Autotrade timeframes saved')
  }

  // Free-text timeframe: "90m", "1.5h", "0.25d", "2d", "1w", "1M" — parsed
  // locally, synthesised agent-side by aggregating the closest native bars.
  const addCustomTimeframe = () => {
    const parsed = parseTimeframe(tfDraft)
    if (!parsed) {
      setError(`Cannot read "${tfDraft}" — try forms like 90m, 1.5h, 2d, 1w, 1M (decimals from hours up)`)
      return
    }
    const clash = timeframes.find(t => tfMs(t) === parsed.ms)
    if (clash) { setError(`${parsed.label} is the same timeframe as ${clash} — already on the list`); return }
    setTfDraft('')
    setTfMenu(false)
    toggleTimeframe(parsed.label)
  }

  // UI-6: saveRisk / saveBalance and their draft-persistence effects were
  // removed with the Risk tab. Both configs are edited on the Risk page now,
  // which owns /actions/risk-config and /actions/balance.

  const symbols = config?.symbols || []
  const enabledSymbols = symbols.filter(s => s.enabled !== false).map(s => s.symbol)
  const btSymbols = enabledSymbols.filter(s => !btSkip.has(s))

  const pushSymbols = (next) =>
    run(async () => {
      await agentPost('/actions/symbols', { symbols: next })
      // The save may have RECORDED removals — refresh the Previously-watched
      // card in place, or it stays stale until a tab switch (Codex review).
      agentGet('/state/watchlist-removed').then(r => setWlRemoved(r?.removed || [])).catch(() => {})
    }, 'Watchlist saved')

  const addSymbol = () => {
    const sym = newSymbol.toUpperCase().trim()
    if (!sym) return
    if (symbols.some(s => s.symbol === sym)) { setError(`${sym} already in watchlist`); return }
    setNewSymbol('')
    pushSymbols([...symbols, { symbol: sym, enabled: true }])
  }

  // --- Classification groups -----------------------------------------------
  // Ticking a category adds its symbols tagged { group } — the agent loop
  // keeps seeing plain per-symbol rows (nothing to change server-side), but
  // the watchlist UI folds every group into ONE row: "Forex / Majors (42)".
  const groupOf = new Map()
  for (const s of symbols) {
    if (!s.group) continue
    if (!groupOf.has(s.group)) groupOf.set(s.group, [])
    groupOf.get(s.group).push(s)
  }
  const singles = symbols.filter(s => !s.group)
  const groupSelected = (key) => groupOf.has(key)

  const addGroup = (key, memberNames) => {
    const have = new Set(symbols.map(s => s.symbol))
    const fresh = memberNames.filter(n => !have.has(n)).map(n => ({ symbol: n, enabled: true, group: key }))
    if (fresh.length === 0) { setError('All symbols in this classification are already in the watchlist'); return }
    pushSymbols([...symbols, ...fresh])
  }
  const removeGroup = (key) => pushSymbols(symbols.filter(s => s.group !== key))
  // Individual add/remove for the screener (owner: select a handful out of
  // a curated list, not necessarily the whole preset group at once).
  const addSymbolsPlain = (names) => {
    const have = new Set(symbols.map(s => s.symbol))
    const fresh = names.filter(n => !have.has(n)).map(n => ({ symbol: n, enabled: true }))
    if (fresh.length) pushSymbols([...symbols, ...fresh])
  }
  const removeSymbolPlain = (name) => pushSymbols(symbols.filter(s => s.symbol !== name))
  // Batched remove for the screener's bulk action (Codex review, PR #267):
  // firing removeSymbolPlain once per selected symbol in a loop had every
  // call close over the SAME render-time `symbols` array, so each saved a
  // list with only ITS OWN symbol removed — whichever POST resolved last
  // won and silently restored the rest. One list, one save.
  const removeSymbolsPlain = (names) => {
    const drop = new Set(names)
    pushSymbols(symbols.filter(s => !drop.has(s.symbol)))
  }
  const toggleGroupEnabled = (key, on) =>
    pushSymbols(symbols.map(s => (s.group === key ? { ...s, enabled: on } : s)))

  // Backtest filters come from the stage matrix's "Backtest" column — the
  // owner's point: backtest setups are tuned separately from live trading.
  const mxBtFilter = (k) => !!stageMx?.filters?.find(f => f.key === k)?.stages?.backtest
  const mxBtFilterNames = ['rsi', 'vwap', 'fvg'].filter(mxBtFilter).map(k => k.toUpperCase())

  // The backtest runs as a BACKGROUND JOB on the agent: POST starts it and
  // returns a ticket; results wait server-side in /state/backtest-job.
  // Leaving this page mid-run no longer loses them — come back any time.
  const runBacktest = async () => {
    if (btSymbols.length === 0) { setBtError('No symbols selected — enable some on the Watchlist tab.'); return }
    setBtRunning(true)
    setBtError('')
    setBt(null)
    try {
      await agentPost('/actions/backtest', {
        symbols: btSymbols,
        // Test exactly what Pipeline arms — one source of truth for timeframes.
        timeframes,
        bars: 1000,
        rsiFilter: mxBtFilter('rsi'),
        vwapFilter: mxBtFilter('vwap'),
        sessionFilter: btSessionFilter,
        strategy: btStrategy,
        entryMode: btTouchFill ? 'touch' : 'close',
        fvgFilter: mxBtFilter('fvg'),
      })
      // btRunning stays true — the poll effect below collects the results.
    } catch (e) {
      // 409 = a run is already in flight; keep polling instead of erroring.
      if (!/already running/i.test(e.message)) { setBtError(e.message); setBtRunning(false) }
    }
  }

  // Poll the job while the Backtest tab is open. Applies a finished job's
  // results exactly once (keyed by job id) so revisits pick up runs that
  // completed while the page was elsewhere.
  const btAppliedJobRef = useRef(null)
  useEffect(() => {
    if (tab !== 'backtest' || !agentConfigured()) return undefined
    let alive = true
    const tick = async () => {
      try {
        const j = await agentGet('/state/backtest-job')
        if (!alive || !j?.job) return
        if (j.job.status === 'running') { setBtRunning(true); return }
        setBtRunning(false)
        if (btAppliedJobRef.current === j.job.id) return
        btAppliedJobRef.current = j.job.id
        if (j.job.status === 'error') { setBtError(j.job.error || 'backtest failed'); return }
        if (j.result) {
          setBt(j.result)
          setBtError('')
          try { sessionStorage.setItem('backtest_cache_v2', JSON.stringify(j.result)) } catch { /* quota — skip */ }
        }
      } catch { /* transient — next tick retries */ }
    }
    tick()
    const iv = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(iv) }
  }, [tab])

  // Same collection loop for the C&H screener job (Watchlist tab).
  const screenerAppliedJobRef = useRef(null)
  useEffect(() => {
    if (tab !== 'watchlist' || !agentConfigured()) return undefined
    let alive = true
    const tick = async () => {
      try {
        const j = await agentGet('/state/job/cup-screener')
        if (!alive || !j?.job) return
        if (j.job.status === 'running') { setScreenerBusy(true); return }
        setScreenerBusy(false)
        if (screenerAppliedJobRef.current === j.job.id) return
        screenerAppliedJobRef.current = j.job.id
        if (j.job.status === 'error') { setError(j.job.error || 'screener failed'); return }
        if (j.result) setScreener(j.result)
      } catch { /* transient — next tick retries */ }
    }
    tick()
    const iv = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(iv) }
  }, [tab])

  // Trades per symbol in the last backtest (all timeframes summed) — surfaced
  // on the Watchlist so each instrument shows how much it actually traded.
  const btTradeCount = (sym) => {
    const results = bt?.symbols?.[sym]?.results
    if (!results) return null
    return Object.values(results).reduce((n, r) => n + (r.trades || 0), 0)
  }

  // Verdict-class selection (owner spec) — which classes flow into Activate.
  // 'nogo' = less than half the checks pass ("less than ½ blue").
  const ARM_CLASS_SETS = { go: ['go'], 'go+thin': ['go', 'thin'], thin: ['thin'], all: ['go', 'thin', 'nogo'] }
  const stateOf = (r) => { const s2 = verdictFor(r)?.state; return s2 === 'go' ? 'go' : s2 === 'thin' ? 'thin' : 'nogo' }
  const inClass = (r) => !r.error && (ARM_CLASS_SETS[btArmClass] || ['go']).includes(stateOf(r))
  // Selected timeframes across every tested symbol (union) — the Activate
  // flow arms timeframes, not symbols, so any included row lights its tf up.
  const goTfs = bt?.symbols
    ? [...new Set(
        Object.values(bt.symbols).flatMap(s => s.results
          ? Object.entries(s.results).filter(([, r]) => inClass(r)).map(([tf]) => tf)
          : []),
      )]
    : []
  // Timeframes armed only because the trader ticked "arm anyway" on a row
  // OUTSIDE the selected class (stale overrides of old result sets ignored).
  const forcedTfs = bt?.symbols
    ? [...new Set(
        Object.entries(bt.symbols).flatMap(([sym, s]) => s.results
          ? Object.entries(s.results)
              .filter(([tf, r]) => !r.error && btForce.has(`${sym}|${tf}`) && !inClass(r))
              .map(([tf]) => tf)
          : []),
      )].filter(tf => !goTfs.includes(tf))
    : []
  const armTfs = [...goTfs, ...forcedTfs]
  // Per-instrument arm matrix: {SYMBOL: [tfs]} — an included row arms that
  // symbol×timeframe pair; "arm anyway" arms exactly its own pair, never the
  // whole watchlist. This is what the agent's matrix gate enforces.
  const armMatrix = bt?.symbols
    ? Object.fromEntries(
        Object.entries(bt.symbols)
          .map(([sym, s]) => [sym, s.results
            ? Object.entries(s.results)
                .filter(([tf, r]) => !r.error && (inClass(r) || btForce.has(`${sym}|${tf}`)))
                .map(([tf]) => tf)
            : []])
          .filter(([, tfs]) => tfs.length > 0),
      )
    : {}
  const matrixSummary = Object.entries(armMatrix).map(([s, tfs]) => `${s} (${tfs.join(', ')})`).join(' · ')
  // Pending-order arming is stricter than Activate: full-GO rows only, never
  // "arm anyway" overrides — a resting order at the broker is a live commitment.
  const pendingGoMatrix = bt?.symbols
    ? Object.fromEntries(
        Object.entries(bt.symbols)
          .map(([sym, s]) => [sym, s.results
            ? Object.entries(s.results).filter(([, r]) => verdictFor(r)?.state === 'go').map(([tf]) => tf)
            : []])
          .filter(([, tfs]) => tfs.length > 0),
      )
    : {}
  const pendingGoCount = Object.values(pendingGoMatrix).reduce((n, tfs) => n + tfs.length, 0)
  const pendingGoSummary = Object.entries(pendingGoMatrix).map(([s, tfs]) => `${s} (${tfs.join(', ')})`).join(' · ')
  const pendingArmed = config?.pending_mode_enabled === true || config?.pending_mode_enabled === 'true'
  const pendingMatrixSummary = config?.pending_matrix && typeof config.pending_matrix === 'object'
    ? Object.entries(config.pending_matrix).map(([s, tfs]) => `${s} (${(tfs || []).join(', ')})`).join(' · ')
    : ''
  const matrixEq = (a, b) => {
    const norm = (m) => JSON.stringify(Object.fromEntries(Object.entries(m || {}).filter(([, v]) => v?.length).map(([k, v]) => [k, [...v].sort()]).sort()))
    return norm(a) === norm(b)
  }

  return (
    <div className="space-y-3">
      {/* FAB delegates to pickTab — Tune navigates by tab state, not scroll. */}
      <SectionNavFab sections={TABS} onSelect={pickTab} />
      {error && <Card className="border-[var(--color-down)] text-[9px]">{error}</Card>}
      {status && <div className="text-[9px] text-[var(--color-info-text)]" role="status">{status}</div>}
      {/* Persistent save proof — most controls here auto-save the instant you
          change them (no Save button needed); this line stays visible with the
          time of the last saved change so you never have to wonder. */}
      {lastSaved && (
        <div className="text-[9px] text-[var(--color-text-sub)]" aria-live="polite">
          ✓ Saved at {lastSaved.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} — {lastSaved.msg}. Changes auto-save on the agent as you make them.
        </div>
      )}

      <FolioTabs tabs={TABS} active={tab} onChange={pickTab}>
        {tab === 'pipeline' && (
          <div className="space-y-2">
            <Card id="sec-pipe-master" className="w3-hover-shadow">
              <SectionTitle>Master switches</SectionTitle>
              <p className="text-[9px] text-[var(--color-text-sub)] mb-1.5">The three phases, and how wide autotrade casts. Everything below only matters while these are on.</p>
            <div className="flex flex-wrap gap-2">
              <Toggle on={config?.scan_enabled} label="Scan" onClick={() => toggle('/actions/scan-toggle', 'Scan', config?.scan_enabled)} />
              <Toggle on={config?.analyze_enabled} label="Analyze" onClick={() => toggle('/actions/analyze-toggle', 'Analyze', config?.analyze_enabled)} />
              <Toggle on={config?.autotrade_enabled} label="Autotrade" onClick={() => {
                if (!config?.autotrade_enabled && !window.confirm('Arm autotrade? The agent will place REAL orders when a signal passes the risk gate.')) return
                toggle('/actions/autotrade-toggle', 'Autotrade', config?.autotrade_enabled)
              }} />
            </div>
            {/* Autotrade scope (owner): the backtest arms combos, but the
                DEFAULT trader covers the whole watchlist — every enabled
                symbol × armed strategies × any scanned timeframe. 'Armed
                combos only' restores the narrow gate. */}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[9px]">
              <span className="text-[9px] text-[var(--color-text-sub)]">Autotrade scope:</span>
              <div className="flex rounded-[7px] overflow-hidden border border-[var(--color-border)]" role="radiogroup" aria-label="Autotrade scope">
                {[['all', 'Full watchlist (default)'], ['armed', 'Armed combos only']].map(([sc, lbl]) => (
                  <button key={sc} type="button" role="radio" aria-checked={(config?.autotrade_scope ?? 'all') === sc}
                    onClick={() => run(async () => {
                      await agentPost('/actions/autotrade-scope', { scope: sc })
                      setConfig(c => ({ ...c, autotrade_scope: sc }))
                    }, `Autotrade scope → ${lbl}`)}
                    className={`px-2 py-1 text-[9px] font-semibold cursor-pointer ${(config?.autotrade_scope ?? 'all') === sc ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg)] text-[var(--color-text-sub)]'}`}>
                    {lbl}
                  </button>
                ))}
              </div>
              <span className="text-[9px] text-[var(--color-text-sub)]">
                Full watchlist = every enabled symbol may trade on any scanned timeframe with every armed strategy; backtest-armed combos stay as micro-tuning. The risk gate, stage matrix, market hours and equity stop still veto every order.
              </span>
            </div>
            </Card>
            <Card id="sec-pipe-strategy" className="w3-hover-shadow">
              <SectionTitle>What may trade</SectionTitle>
              <p className="text-[9px] text-[var(--color-text-sub)] mb-1.5">Which strategies and filters act at each pipeline stage, why the trade column vetoed, and whether the nightly evidence loop may change the arming for you.</p>
            {/* Strategy × stage matrix replaces the old strategy/filter chips:
                every strategy and filter is set PER PIPELINE STAGE. Trade
                edits write the same legacy keys the chips used. */}
            <StageMatrix
              mx={stageMx}
              armTarget={armTarget}
              onError={setError}
              onUpdated={(r) => {
                setStageMx(prev => (prev ? { ...prev, strategies: r.strategies, filters: r.filters } : prev))
                // Keep the config/strategy + filter mirrors in step so the
                // Backtest tab pills and Presets export stay truthful.
                if (r.strategies) {
                  setConfig(c => c ? {
                    ...c,
                    strategies: (c.strategies || []).map(x => {
                      const row = r.strategies.find(s => s.key === x.key)
                      return row ? { ...x, on: row.stages.trade } : x
                    }),
                    cup_handle_enabled: !!r.strategies.find(s => s.key === 'cup_handle')?.stages.trade,
                  } : c)
                }
                if (r.filters) {
                  setRsiFilter(!!r.filters.find(f => f.key === 'rsi')?.stages.trade)
                  setVwapFilter(!!r.filters.find(f => f.key === 'vwap')?.stages.trade)
                  setFvgFilter(!!r.filters.find(f => f.key === 'fvg')?.stages.trade)
                }
              }}
            />
            <p className="mt-1.5 text-[9px] text-[var(--color-text-sub)]">
              Scan analyses EVERY conviction — strategies scan wide and filters only annotate what failed; the Auto Trade &amp; Open column is where anything is actually blocked. RSI = long fades only when RSI(14) ≤ 45, shorts ≥ 55. VWAP = longs only below the leg-anchored volume-weighted average price, shorts only above. FVG = the 61.8% zone must overlap an unfilled 3-bar fair value gap in the trade's direction.
            </p>
            {/* WHY the trade-column vetoes happened — reason families, 30d.
                A persisting signal retries every 5-min cycle, so one blocked
                setup can log hundreds of repeat vetoes; this shows the mix. */}
            {vetoMix && (vetoMix.vetoes?.length || 0) > 0 && (
              <p className="mt-1 text-[9px]">
                <span className="font-semibold">Why vetoed (last {vetoMix.days}d):</span>{' '}
                {vetoMix.vetoes.slice(0, 8).map((v, i) => (
                  <span key={v.reason}>{i > 0 && ' · '}{v.reason} <span className="font-semibold tabular-nums">{v.count.toLocaleString()}</span></span>
                ))}
                <span className="text-[var(--color-text-sub)]"> — repeats included: a waiting setup re-tries every 5-minute cycle.</span>
              </p>
            )}
            {/* Pending mode is armed from the Backtest tab (evidence-gated), so
                Pipeline only reports the state and offers the way out. */}
            {pendingArmed && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
                <Badge tone="warning">⏳ PENDING ORDERS ARMED</Badge>
                <span className="font-semibold">{pendingMatrixSummary || 'no instruments in the matrix'}</span>
                <Button
                  size="sm" variant="subtle"
                  onClick={() => run(() => agentPost('/actions/pending-mode', { on: false }), 'Pending orders disarmed')}
                >Disarm</Button>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
              <span className="font-semibold">Strategy Autopilot:</span>
              {['off', 'suggest', 'auto'].map(m => (
                <button
                  key={m} type="button" role="radio" aria-checked={(config?.autopilot_mode || 'off') === m}
                  onClick={() => {
                    if (m === 'auto' && !window.confirm('AUTO mode: every ~24h the bot backtests all strategies and arms GO combos / disarms decayed ones by itself (max 4 changes per run, announced on Telegram, never on LIVE accounts). You stay in charge via /pause, Disarm and these buttons. Enable?')) return
                    run(async () => {
                      await agentPost('/actions/autopilot', { mode: m })
                      setConfig(c => ({ ...c, autopilot_mode: m }))
                    }, `Autopilot: ${m}`)
                  }}
                  className={`rounded-[1px] px-2.5 py-0.5 min-h-[28px] text-[9px] font-semibold cursor-pointer ${(config?.autopilot_mode || 'off') === m ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
                >{m}</button>
              ))}
              <span className="text-[9px] text-[var(--color-text-sub)]">
                nightly evidence loop — every run saves a charted GO/NO-GO report under Past reports; suggest = Telegram proposals only, auto = applies within a 4-change cap
              </span>
            </div>
            </Card>
            <Card id="sec-pipe-breakers" className="w3-hover-shadow">
              <SectionTitle>Breakers and gates</SectionTitle>
              <p className="text-[9px] text-[var(--color-text-sub)] mb-1.5">When the bot must adapt or stand down on its own — a loss streak, a decayed edge, the wrong regime, or the minutes right after a session opens.</p>
            {/* Adaptive breaker + fast monitor cadence — the owner's "no
                human pauses" doctrine: a loss streak CHANGES strategy/
                filters; open positions are watched every ~minute, scaled
                by live market volume. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={config?.adaptive_breaker?.on !== false} label="Adaptive breaker" onClick={() => {
                const next = !(config?.adaptive_breaker?.on !== false)
                run(async () => {
                  await agentPost('/actions/adaptive-breaker', { on: next })
                  setConfig(c => ({ ...c, adaptive_breaker: { ...(c?.adaptive_breaker || {}), on: next } }))
                }, `Adaptive breaker ${next ? 'ON' : 'off'}`)
              }} />
              <span className="text-[9px] text-[var(--color-text-sub)]">
                {config?.adaptive_breaker?.streak ?? 3} losses in a row on a strategy → it is disarmed (or, if it's the last one, the next filter is armed) — the bot adapts instead of pausing
              </span>
            </div>
            {/* Performance breaker — the "all hands on deck" checkpoint: a
                bad rolling profit factor that never strings 3 losses in a
                row still bleeds, so this watches the AGGREGATE edge
                (owner: "what checkpoints would trigger all hands on deck to
                turn the tide"). Alert-first — auto-disarm is opt-in. */}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={config?.performance_breaker?.on !== false} label="Performance breaker (all hands on deck)" onClick={() => {
                const next = !(config?.performance_breaker?.on !== false)
                run(async () => {
                  const r = await agentPost('/actions/performance-breaker', { on: next })
                  setConfig(c => ({ ...c, performance_breaker: r }))
                }, `Performance breaker ${next ? 'ON' : 'off'}`)
              }} />
              <span className="text-[9px] text-[var(--color-text-sub)]">
                profit factor below {config?.performance_breaker?.pfThreshold ?? 0.8} over the last {config?.performance_breaker?.window ?? 20} closed trades (min {config?.performance_breaker?.minTrades ?? 15} to judge an edge) → urgent Telegram alert
              </span>
              <Toggle on={config?.performance_breaker?.autoDisarm === true} label="also auto-disarm autotrade" onClick={() => {
                const next = !(config?.performance_breaker?.autoDisarm === true)
                if (next && !window.confirm('Auto-disarm autotrade when the performance breaker fires? New entries stop until you re-arm from Tune — open positions keep being managed normally.')) return
                run(async () => {
                  const r = await agentPost('/actions/performance-breaker', { autoDisarm: next })
                  setConfig(c => ({ ...c, performance_breaker: r }))
                }, `Performance breaker auto-disarm ${next ? 'ON' : 'off'}`)
              }} />
            </div>
            {/* Regime gate — owner: "trading like a beginner" (PF 0.15). The
                fade strategy was firing into trends where its levels get
                blown through; this blocks strategy/regime mismatches. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={config?.regime_gate?.on !== false} label="Regime gate" onClick={() => {
                const next = !(config?.regime_gate?.on !== false)
                run(async () => {
                  const r = await agentPost('/actions/regime-gate', { on: next })
                  setConfig(c => ({ ...c, regime_gate: r }))
                }, `Regime gate ${next ? 'ON' : 'off'}`)
              }} />
              <span className="text-[9px] text-[var(--color-text-sub)]">
                don't fade a trend, don't chase a range — blocks mean-reversion entries (Fib fade, RSI) in trending/volatile markets and trend entries (EMA, breakout) in quiet ones, using the per-symbol regime the quant phase computes
              </span>
            </div>
            {/* Session-open guard — owner: "when markets open, XAUUSD went
                from profit to loss $333" → lock breakeven on open-window
                profit the normal +0.7R ladder hasn't reached yet. */}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={config?.session_open_guard?.on !== false} label="Session-open guard" onClick={() => {
                const next = !(config?.session_open_guard?.on !== false)
                run(async () => {
                  const r = await agentPost('/actions/session-open-guard', { on: next })
                  setConfig(c => ({ ...c, session_open_guard: r }))
                }, `Session-open guard ${next ? 'ON' : 'off'}`)
              }} />
              <span className="text-[9px] text-[var(--color-text-sub)]">
                first {config?.session_open_guard?.windowMin ?? 30}m after a major session opens (Tokyo/London/NY…), any bot position already up ≥ {config?.session_open_guard?.minR ?? 0.3}R gets its SL locked to breakeven — opens are where reversals hit hardest
              </span>
            </div>
            </Card>
            <Card id="sec-pipe-cadence" className="w3-hover-shadow">
              <SectionTitle>Cadence and coverage</SectionTitle>
              <p className="text-[9px] text-[var(--color-text-sub)] mb-1.5">How often the loop runs, how often open positions are checked, and which timeframes are scanned at all.</p>
            {/* UI-6: the shared Field row. onChange tracks the draft, onCommit
                fires on blur — the same commit point as before, so typing "1"
                on the way to "15" still cannot post a 1-minute loop. */}
            <div className="mt-3">
              <Field label="Scan every" unit="min" min="1" max="60" placeholder="5"
                value={config?.loop_interval_min ?? 5}
                onChange={v => setConfig(c => ({ ...c, loop_interval_min: v ?? '' }))}
                onCommit={() => {
                  const n = Number(config?.loop_interval_min)
                  if (Number.isFinite(n) && n >= 1 && n <= 60) run(() => agentPost('/actions/loop-interval', { minutes: n }), `Scan cadence: every ${n} min`)
                }}
                hint="How often the whole loop runs — scan, analyze, dispatch, monitor. Applies from the next cycle, no restart."
                recommend="5 minutes. Faster = more broker calls (still free); slower = later entries." />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[9px]">
              <span className="font-semibold">Position monitor:</span>
              {[1, 2, 3, 5].map(m => (
                <button
                  key={m} type="button" role="radio" aria-checked={(config?.monitor_interval_min ?? 1) === m}
                  onClick={() => run(async () => {
                    await agentPost('/actions/monitor-interval', { minutes: m })
                    setConfig(c => ({ ...c, monitor_interval_min: m }))
                  }, `Position monitor every ${m}m (volume-scaled)`)}
                  className={`inline-flex items-center rounded-[2px] border leading-none cursor-pointer bg-[var(--color-bg)] px-[4px] py-[3px] ${
                    (config?.monitor_interval_min ?? 1) === m
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)] text-[9px] font-normal capitalize'
                      : 'border-[var(--color-down)] text-[var(--color-down)] text-[9px] font-bold uppercase'
                  }`}
                >{m}m</button>
              ))}
              <span className="text-[9px] text-[var(--color-text-sub)]">
                base cadence per OPEN position (scan stays 5m) — busy market checks at base speed, average 2×, quiet 3×; broker-side SL/TP covers every tick in between
              </span>
            </div>
            {/* Per-symbol cadence overrides — owner's word beats the volume
                logic: pin one symbol faster (0.25m) or throttle it (30m). */}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px]">
              <span className="text-[var(--color-text-sub)]">Per-symbol override:</span>
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  const sym = monOvDraft.symbol.toUpperCase().trim()
                  const mins = monOvDraft.minutes === '' ? null : Number(monOvDraft.minutes)
                  if (!sym) { setError('Override needs a symbol'); return }
                  run(async () => {
                    const r = await agentPost('/actions/monitor-override', { symbol: sym, minutes: mins })
                    setConfig(c => ({ ...c, monitor_overrides: r.overrides }))
                    setMonOvDraft({ symbol: '', minutes: '' })
                  }, mins == null ? `${sym} monitor cadence → auto` : `${sym} monitor cadence pinned to ${mins}m`)
                }}
              >
                {/* UI-6 part 4: styling unified with every other input on the
                    page, but the SUBMIT IS DELIBERATELY KEPT. This is not a
                    setting — it is a two-field ADD, and the two fields are
                    only meaningful together. On blur-to-commit, tabbing out
                    of the symbol box would POST an override with no cadence,
                    and leaving the row half-filled would create a bogus
                    entry. A commit that needs two values needs a commit
                    button; converting it for consistency's sake would be
                    consistency bought with a real bug. */}
                <Input value={monOvDraft.symbol} onChange={e => setMonOvDraft(d => ({ ...d, symbol: e.target.value }))} placeholder="SYMBOL" className="!w-24 !min-h-[26px] max-[430px]:!min-h-[44px] !py-0.5 !px-2 !text-[9px]" aria-label="Override symbol" />
                <Input type="number" step="0.25" min="0.25" max="30" value={monOvDraft.minutes} onChange={e => setMonOvDraft(d => ({ ...d, minutes: e.target.value }))} placeholder="min (empty=auto)" className="!w-32 !min-h-[26px] max-[430px]:!min-h-[44px] !py-0.5 !px-2 !text-[9px] text-right" aria-label="Override minutes" />
                <Button size="sm" variant="subtle" type="submit" className="!px-2 !py-0.5 !min-h-0 text-[9px]">Set</Button>
              </form>
              {Object.entries(config?.monitor_overrides || {}).map(([sym, m]) => (
                <span key={sym} className="glass-inset rounded-[1px] px-2 py-0.5 inline-flex items-center gap-1.5 font-semibold">
                  {sym} {m}m
                  <button
                    type="button" aria-label={`Clear ${sym} override`}
                    className="cursor-pointer text-[var(--color-text-sub)] hover:text-[var(--color-down)]"
                    onClick={() => run(async () => {
                      const r = await agentPost('/actions/monitor-override', { symbol: sym, minutes: null })
                      setConfig(c => ({ ...c, monitor_overrides: r.overrides }))
                    }, `${sym} monitor cadence → auto`)}
                  >✕</button>
                </span>
              ))}
              {Object.keys(config?.monitor_overrides || {}).length === 0 && (
                <span className="text-[var(--color-text-sub)]">none — all symbols on auto (volume-adaptive)</span>
              )}
            </div>
            <div className="mt-3">
              <div className="text-[9px] text-[var(--color-text-sub)] mb-1.5">
                Autotrade timeframes — add or remove any the broker supports (1m → 1 month). Scans and backtests follow this list:
              </div>
              <div className="flex flex-wrap gap-1.5 items-center">
                {[...timeframes].sort(byTfDesc).map(tf => (
                  <span
                    key={tf}
                    className="inline-flex items-center gap-1.5 rounded-[20px] bg-[var(--color-accent)] text-white px-3 py-1 text-[9px] font-semibold min-h-[36px]"
                  >
                    {tf}
                    <button
                      type="button" aria-label={`Remove ${tf}`}
                      onClick={() => toggleTimeframe(tf)}
                      className="cursor-pointer rounded-full hover:bg-white/25 w-5 h-5 leading-none"
                    >×</button>
                  </span>
                ))}
                <span className="relative">
                  <button
                    type="button" onClick={() => setTfMenu(o => !o)} aria-expanded={tfMenu}
                    className="rounded-[20px] border border-dashed border-[var(--color-border)] px-3 py-1 text-[9px] font-semibold min-h-[36px] cursor-pointer text-[var(--color-text-sub)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  >+ Add timeframe</button>
                  {tfMenu && (
                    <span className="glass-panel absolute left-0 top-full z-30 mt-1 w-56 rounded-[12px] p-1.5 shadow-xl block max-h-80 overflow-y-auto">
                      <span className="flex gap-1 p-1">
                        <Input
                          value={tfDraft} onChange={e => setTfDraft(e.target.value)}
                          placeholder="e.g. 90m · 1.5h · 2d · 1M"
                          className="!py-1 text-[9px]"
                          onKeyDown={e => e.key === 'Enter' && addCustomTimeframe()}
                        />
                        <Button size="sm" onClick={addCustomTimeframe}>Add</Button>
                      </span>
                      <span className="block px-2 pb-1 text-[9px] text-[var(--color-text-sub)]">
                        min/h/d/w · M = month · decimals from hours up
                      </span>
                      {ALL_TIMEFRAMES.filter(tf => !timeframes.includes(tf)).map(tf => (
                        <button
                          key={tf} type="button"
                          onClick={() => { setTfMenu(false); toggleTimeframe(tf) }}
                          className="w-full text-left rounded-[8px] px-3 py-1.5 text-[9px] cursor-pointer hover:bg-[var(--color-accent-soft)] block"
                        >{tf}</button>
                      ))}
                    </span>
                  )}
                </span>
              </div>
              <TimeframePerformance timeframes={timeframes} />
              <StrategyTfPerformance />
            </div>
            </Card>
            <Card id="sec-pipe-protection" className="w3-hover-shadow">
              <SectionTitle>Position management</SectionTitle>
              <p className="text-[9px] text-[var(--color-text-sub)] mb-1.5">What happens to a position once it is open: per-class exit ladders, the weekend and tick sweeps, and the three guardians.</p>
            {/* Per-asset-class controllers — owner: "separate controllers for
                forex/indices/commodities... trading like a beginner." A
                EURUSD and a NatGas trade shouldn't be managed identically. */}
            <div className="mt-3">
              <div className="text-[9px] font-semibold mb-1">Asset-class controllers</div>
              <span className="text-[9px] text-[var(--color-text-sub)]">
                per-class breakeven / partial / runner triggers (in R). Whippy classes (energy, crypto) lock in sooner; clean trenders (indices, gold) give runners more room. Blank = class default.
              </span>
              <div className="overflow-x-auto mt-1">
                <table className="std-cols text-[9px] tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <th className="py-1 pr-3">Class</th>
                      <th className="py-1 pr-3" title="Move stop to breakeven at this R">BE @R</th>
                      <th className="py-1 pr-3" title="Take half off at this R">Partial @R</th>
                      <th className="py-1 pr-3" title="Start trailing the runner at this R">Runner @R</th>
                      <th className="py-1 pr-3" title="Trail this many R behind price">Trail R</th>
                      <th className="py-1" title="Close the WHOLE position at this R — recycles margin out of big winners into new setups">Bank @R</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(config?.asset_controllers || []).map(row => (
                      <tr key={row.class} className="border-b border-[var(--color-border)]/40">
                        <td className="py-1 pr-3">{row.class}{row.overridden ? ' *' : ''}</td>
                        {['beTriggerR', 'partialTriggerR', 'runnerTriggerR', 'runnerTrailR', 'bankTriggerR'].map(k => (
                          <td key={k} className="py-1 pr-3">
                            {/* UI-6 part 4: was a bare <input> with its own
                                hand-rolled border/padding — the last control
                                on this page not using the shared Input. Its
                                COMMIT POINT is unchanged (it already fired on
                                blur, and still skips the POST when the value
                                did not actually move). It stays a bare cell
                                rather than a Field row because the table
                                header already labels the column; a Field row
                                here would put a second label in every cell. */}
                            <Input
                              type="number" step="0.1" min="0.1" max="20"
                              defaultValue={row[k]}
                              aria-label={`${row.class} ${k}`}
                              className="!w-16 !min-h-[26px] !py-0.5 !px-2 !text-[9px] text-right"
                              onBlur={(e) => {
                                const v = e.target.value === '' ? null : Number(e.target.value)
                                if (e.target.value !== '' && Number(v) === row[k]) return
                                run(async () => {
                                  const r = await agentPost('/actions/asset-controller', { class: row.class, [k]: v })
                                  setConfig(c => ({ ...c, asset_controllers: r.asset_controllers }))
                                }, `${row.class} ${k} → ${v ?? 'default'}`)
                              }}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {/* Weekend bank + tick guardian — both existed backend-only with
                no control here (audit finding, owner: "audit the last 20
                PRs, did you do what I want"). */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={config?.weekend_bank !== false} label="Weekend profit bank" onClick={() => {
                const next = !(config?.weekend_bank !== false)
                run(async () => {
                  await agentPost('/actions/weekend-bank', { on: next })
                  setConfig(c => ({ ...c, weekend_bank: next }))
                }, `Weekend bank ${next ? 'ON' : 'off'}`)
              }} />
              <span className="text-[9px] text-[var(--color-text-sub)]">
                inside the final window before a weekend/holiday closure, closes any position (bot or manual) that's in profit — skips losers, avoids holding gap risk through the close
              </span>
            </div>
            {/* UI-6 part 4: was a write-only box + Set button that started
                EMPTY and printed "current: 0.05%" in prose beside it — so the
                field never showed you the setting, only accepted a new one.
                As a Field row the current value IS the field, which is how
                every other setting on this page and the Risk page behaves. */}
            <div className="mt-2 max-w-[320px]">
              <Field label="Tick guardian threshold" unit="%" min="0.01" max="5" step="0.01"
                value={config?.guardian_move_pct ?? 0.05}
                onChange={v => setConfig(c => ({ ...c, guardian_move_pct: v }))}
                onCommit={() => {
                  const pct = Number(config?.guardian_move_pct)
                  if (!Number.isFinite(pct) || pct <= 0) { setError('Guardian threshold must be a positive percent'); return }
                  run(() => agentPost('/actions/guardian-move-pct', { pct }), `Tick guardian threshold → ${pct}%`)
                }}
                hint="A live price tick moving this much between the 30-second checks triggers an immediate sweep of open positions instead of waiting for the next one."
                recommend="0.05% — small enough to catch a spike, large enough not to sweep on noise." />
            </div>
            {/* Burn-in — the track-record builder: min-size trades with
                tight time caps across the enabled watchlist, mass-producing
                completed round-trips so sizing decisions get a sample. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={config?.burn_in?.on} label="Burn-in (track record)" onClick={() => {
                const next = !config?.burn_in?.on
                const sizeWord = (config?.burn_in?.sizeMode ?? 'auto') === 'fixed' ? `fixed ${config?.burn_in?.lots ?? 0.01}-lot` : 'risk-sized (auto)'
                if (next && !window.confirm(`Arm BURN-IN (micro-quant)? Every 5 minutes the bot opens REAL ${sizeWord} positions across the enabled watchlist. The operating timeframe is chosen PER SYMBOL from live volume & condition — hot tape → 5m scalps (~12m cap), active → 15m (~30m), trending-quiet → 1h (~2h) — and the pace steers itself toward ${config?.burn_in?.targetTrades ?? 200} completed trades in ${config?.burn_in?.windowDays ?? 2} days. Runs only while Autotrade is armed; /pause, Kill all and the equity stop all stop it.`)) return
                run(async () => {
                  await agentPost('/actions/burn-in', { on: next })
                  setConfig(c => ({ ...c, burn_in: { ...(c?.burn_in || {}), on: next } }))
                }, `Burn-in ${next ? 'ARMED' : 'disarmed'}`)
              }} />
              <span className="text-[9px] text-[var(--color-text-sub)]">Sizing:</span>
              <div className="flex rounded-[7px] overflow-hidden border border-[var(--color-border)]" role="radiogroup" aria-label="Burn-in sizing">
                {[['auto', 'Auto (risk-based)'], ['fixed', 'Fixed 0.01–0.05']].map(([mode, lbl]) => (
                  <button key={mode} type="button" role="radio" aria-checked={(config?.burn_in?.sizeMode ?? 'auto') === mode}
                    onClick={() => run(async () => {
                      await agentPost('/actions/burn-in', { sizeMode: mode })
                      setConfig(c => ({ ...c, burn_in: { ...(c?.burn_in || {}), sizeMode: mode } }))
                    }, `Burn-in sizing → ${lbl}`)}
                    className={`px-2 py-1 text-[9px] font-semibold cursor-pointer ${(config?.burn_in?.sizeMode ?? 'auto') === mode ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg)] text-[var(--color-text-sub)]'}`}>
                    {lbl}
                  </button>
                ))}
              </div>
              <span className="text-[9px] text-[var(--color-text-sub)]">
                micro-quant: timeframe adapts per symbol to live volume &amp; condition (5m scalps ↔ 1h swings), self-pacing toward {config?.burn_in?.targetTrades ?? 200} completed trades in {config?.burn_in?.windowDays ?? 2} days — behind pace → more symbols per cycle &amp; shorter cooldowns. Auto sizing uses the SAME uncapped risk-based lot as auto signals; Fixed pins a cheap 0.01–0.05 sample. Every attempt lands in the Order log (BURN-IN badge).
              </span>
            </div>
            {/* Loss Guardian — safety net the Profit Keeper's opposite number:
                protects a NAKED position (no stop) and enforces an optional
                time cap. Never tightens a valid mean-reversion stop. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={lossGuard?.on} label="Loss Guardian" onClick={() => {
                const next = !lossGuard?.on
                run(async () => {
                  const r = await agentPost('/actions/loss-guardian', { on: next })
                  setLossGuard(r.config)
                }, `Loss Guardian ${next ? 'armed' : 'off'}`)
              }} />
              {lossGuard?.on && (
                <span className="min-w-[190px]">
                  <Field label="Time cap" unit="h" min="0" step="1" placeholder="off"
                    value={lossGuard.maxHoldHours ?? null}
                    onChange={v => setLossGuard(g => ({ ...g, maxHoldHours: v }))}
                    onCommit={() => run(async () => {
                      const r = await agentPost('/actions/loss-guardian', { maxHoldHours: lossGuard.maxHoldHours === '' || lossGuard.maxHoldHours == null ? null : Number(lossGuard.maxHoldHours) })
                      setLossGuard(r.config)
                    }, 'Loss Guardian updated')}
                    hint="A naked position still open after this many hours is closed regardless of P&L. Empty = off."
                    recommend="unset — let price levels decide, unless positions keep rotting for days." />
                </span>
              )}
              <span className="w-full text-[9px] text-[var(--color-text-sub)]">
                Safety net for LOSING positions the Profit Keeper won't touch. A position with NO stop gets a protective SL {lossGuard?.maxAtrMult ?? 3}×ATR from entry (or is closed if already past that); an optional time cap closes anything held too long. It never tightens a stop you already set — your mean-reversion trades keep their room to breathe.
              </span>
              <WorkedExample lines={guardianExample(lossGuard || {})} label="Worked example" />
            </div>
            {/* Closed-market resting limits — when a signal fires while its
                market is closed, place a broker LIMIT at the entry so it fills
                at open, instead of the invisible internal re-fire queue. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={closedLimits?.on} label="Closed-market limit orders" onClick={() => {
                const next = !closedLimits?.on
                run(async () => {
                  const r = await agentPost('/actions/closed-market-limits', { on: next })
                  setClosedLimits(r.config)
                }, `Closed-market limit orders ${next ? 'on' : 'off'}`)
              }} />
              <span className="w-full text-[9px] text-[var(--color-text-sub)]">
                When a setup fires while its market is CLOSED (weekend FX/metals, off-hours stocks/indices), rest a real broker LIMIT order at the entry — visible on the desk, filling automatically at open with the setup's SL/TP — instead of the hidden re-fire queue. One order per symbol, clears the SAME risk gate, expires with the timeframe. Off → falls back to the internal queue (re-scan &amp; market order at open).
              </span>
              <WorkedExample lines={closedMarketExample(closedLimits || {})} label="Worked example" />
            </div>
            {/* Profit Keeper — automatic protection for MANUAL/external
                positions: ratchets a broker-side SL once peak profit arms,
                closes on giveback. Stops only ever tighten. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]">
              <Toggle on={keeper?.on} label="Profit Keeper" onClick={() => {
                const next = !keeper?.on
                if (next && !window.confirm('Arm the Profit Keeper? It will place REAL stop-loss amendments and market closes on your MANUAL/external positions once they reach the arm threshold. Stops only ever tighten; it never adds risk.')) return
                run(async () => {
                  const r = await agentPost('/actions/profit-keeper', { on: next })
                  setKeeper(r.config)
                }, `Profit Keeper ${next ? 'armed' : 'off'}`)
              }} />
              {keeper?.on && (() => {
                const post = (patch, msg = 'Profit Keeper updated') => run(async () => {
                  const r = await agentPost('/actions/profit-keeper', patch)
                  setKeeper(r.config)
                }, msg)
                // UI-6: same shared Field row as the Risk page. The commit
                // point is unchanged (blur → POST); `opts.wide` is gone
                // because every field is now the same width, which was the
                // point of the uniform row.
                const numField = (label, key, opts = {}) => (
                  <span key={key} className="min-w-[170px]">
                    <Field label={label} unit={opts.suffix ? opts.suffix.trim() : undefined}
                      min={opts.min} max={opts.max} step={opts.step || 'any'}
                      value={keeper[key] ?? null} hint={opts.hint}
                      onChange={v => setKeeper(k => ({ ...k, [key]: v }))}
                      onCommit={() => post({ [key]: Number(keeper[key]) })} />
                  </span>
                )
                return (
                  <>
                    <span role="radiogroup" aria-label="Profit Keeper mode" className="flex items-center gap-1">
                      {['adaptive', 'fixed'].map(m => (
                        <button key={m} type="button" role="radio" aria-checked={keeper.mode === m}
                          onClick={() => post({ mode: m }, `Profit Keeper mode: ${m}`)}
                          className={`rounded-[1px] px-2 py-0.5 min-h-[28px] text-[9px] font-semibold cursor-pointer ${keeper.mode === m ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
                        >{m}</button>
                      ))}
                    </span>
                    {keeper.mode === 'adaptive' ? (
                      <>
                        {numField('Arm', 'armAtrMult', { min: 0.1, max: 10, step: 0.1, suffix: '×ATR', hint: "Arms once peak profit passes this many ATRs of the position's own value." })}
                        {numField('Noise floor', 'armBalancePct', { min: 0.01, max: 5, step: 0.05, suffix: '% bal', hint: 'Minimum arm threshold as a % of balance — stops tiny instruments arming on noise.' })}
                        {numField('Trail', 'trailAtrMult', { min: 0.5, max: 10, step: 0.5, suffix: '×ATR', hint: 'Chandelier distance: the broker stop sits this many ATRs behind the peak price. Only ever rises.' })}
                        {numField('Bank at arm', 'scaleOutFrac', { min: 0, max: 0.9, step: 0.1, suffix: 'frac', hint: 'Fraction closed the moment it arms; the rest runs on the trail. 0 = off.' })}
                      </>
                    ) : (
                      <>
                        {numField('Arm at', 'armProfitUsd', { min: 1, suffix: '$', hint: 'Fixed mode: nothing happens until peak floating profit reaches this.' })}
                        {numField('Giveback', 'givebackPct', { min: 5, max: 95, suffix: '%', hint: 'Fixed mode: the lock sits at (100 − this)% of the peak. Clamped 0–95 by the engine.' })}
                      </>
                    )}
                    <span role="radiogroup" aria-label="Profit Keeper scope" className="flex items-center gap-1">
                      {['external', 'all'].map(sc => (
                        <button key={sc} type="button" role="radio" aria-checked={keeper.scope === sc}
                          onClick={() => post({ scope: sc }, `Profit Keeper scope: ${sc}`)}
                          className={`rounded-[1px] px-2 py-0.5 min-h-[28px] text-[9px] font-semibold cursor-pointer ${keeper.scope === sc ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
                        >{sc === 'external' ? 'manual only' : 'all positions'}</button>
                      ))}
                    </span>
                  </>
                )
              })()}
              <span className="text-[9px] text-[var(--color-text-sub)]">
                {keeper?.mode === 'fixed'
                  ? <>fixed mode: once floating profit peaks past the arm level, a broker-side SL locks {100 - (Number(keeper?.givebackPct) || 40)}% of the peak; a retrace past the lock closes at market.</>
                  : <>adaptive mode (recommended): arms once profit exceeds {keeper?.armAtrMult ?? 1}× the instrument's ATR (min {keeper?.armBalancePct ?? 0.1}% of balance), then a broker-side SL trails {keeper?.trailAtrMult ?? 2.5}×ATR behind the peak — volatility-scaled per instrument, so winners get room to run and noise never arms it.{Number(keeper?.scaleOutFrac) > 0 ? ` Banks ${Math.round(keeper.scaleOutFrac * 100)}% when it arms; the rest runs.` : ''}</>}
                {' '}The SL sits at the broker (tick-level between scan cycles). Losing positions are untouched; positions with their own Manage-sheet rules are left alone.
              </span>
              {/* The example follows the MODE — adaptive and fixed have entirely
                  different arithmetic, and adaptive is the default. Balance is
                  passed when known so the noise floor is a real figure; when it
                  is not, the example says so rather than assuming one. */}
              <WorkedExample label="Worked example"
                lines={keeperExample(keeper || {}, { balance: Number(risk?.derived?.balance) || null })} />
            </div>
            </Card>
          </div>
        )}


        {tab === 'watchlist' && (
          <div>
            <h2 className="t-h3 mb-2">Watchlist ({symbols.length})</h2>
            <div className="flex gap-2 mb-3">
              <Input
                value={newSymbol} onChange={e => setNewSymbol(e.target.value)}
                placeholder={allSymbols.length ? `Search ${allSymbols.length.toLocaleString()} instruments…` : 'Add symbol, e.g. EURUSD'}
                className="max-w-[260px]" list="broker-symbols"
                onKeyDown={e => e.key === 'Enter' && addSymbol()}
              />
              <datalist id="broker-symbols">
                {suggestions.map(s => <option key={s} value={s} />)}
              </datalist>
              <Button size="sm" onClick={addSymbol}>Add</Button>
            </div>
            {q.length >= 2 && allSymbols.length > 0 && !allSymbols.includes(q) && suggestions.length === 0 && (
              <p className="text-[9px] text-[var(--color-warning-text)] mb-2">No instrument matching “{q}” on this broker account.</p>
            )}

            {/* Watchlist insight — one honest glance: composition, live
                results, and the volatility outliers (owner: "insight card").
                Every number comes from data already on this page; nothing
                is fetched twice. */}
            {symbols.length > 0 && (() => {
              const enabled = symbols.filter(s => s.enabled !== false)
              // Both stats endpoints keep HISTORY for symbols no longer on the
              // list — filter to the CURRENT watchlist or removed instruments
              // leak into the totals and movers (Codex review).
              const onList = new Set(symbols.map(s => String(s.symbol).toUpperCase()))
              const stats = Object.entries(wlStats?.by || {}).filter(([sym]) => onList.has(sym.toUpperCase()))
              const withNet = stats.map(([sym, st]) => ({ sym, ...st }))
              const totalNet = withNet.reduce((n, s) => n + (Number(s.net) || 0), 0)
              const losers = withNet.filter(s => s.loser)
              const best = withNet.filter(s => s.n > 0).sort((a, b) => b.net - a.net)[0]
              const worst = withNet.filter(s => s.n > 0).sort((a, b) => a.net - b.net)[0]
              const hotMovers = Object.entries(regimeBy || {})
                .filter(([sym]) => onList.has(sym.toUpperCase()))
                .map(([sym, r]) => ({ sym, atr: Number(r?.atr_pct) }))
                .filter(m => Number.isFinite(m.atr))
                .sort((a, b) => b.atr - a.atr).slice(0, 3)
              const scannedCount = Object.keys(scanInfo?.by || {}).length
              return (
                <div className="glass-inset rounded-[1px] p-2 mb-3 text-[9px]">
                  <div className="font-semibold mb-1">Watchlist insight</div>
                  <div className="flex flex-wrap gap-x-6 gap-y-1">
                    <span><span className="text-[var(--color-text-sub)]">Coverage: </span>{symbols.length} symbols · {enabled.length} enabled · {groupOf.size} group{groupOf.size === 1 ? '' : 's'} · {scannedCount} scanned last cycle</span>
                    <span><span className="text-[var(--color-text-sub)]">Live results: </span>
                      <span className={`font-semibold ${totalNet >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{totalNet >= 0 ? '+' : ''}{totalNet.toFixed(2)}</span> net
                      {best && <> · best {best.sym} {best.net >= 0 ? '+' : ''}{best.net}</>}
                      {worst && worst.sym !== best?.sym && <> · worst {worst.sym} {worst.net}</>}
                    </span>
                    {losers.length > 0 && (
                      <span className="text-[var(--color-down)] font-semibold" title={losers.map(l => `${l.sym} ${l.net}`).join(' · ')}>
                        {losers.length} LOSER{losers.length === 1 ? '' : 'S'} (net negative with enough sample): {losers.map(l => l.sym).join(', ')} — consider disabling
                      </span>
                    )}
                    {hotMovers.length > 0 && (
                      <span><span className="text-[var(--color-text-sub)]">Most volatile now: </span>{hotMovers.map(m => `${m.sym} ${m.atr.toFixed(2)}%`).join(' · ')}</span>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Previously watched — removed symbols with one-tap re-add
                (owner: "free-text re-add + previously-watched card"). The
                record is server-side (survives devices); re-adding or
                manually re-typing a symbol clears it from the card. */}
            {(wlRemoved?.length ?? 0) > 0 && (() => {
              const onList = new Set(symbols.map(s => s.symbol))
              const gone = wlRemoved.filter(r => !onList.has(r.symbol))
              if (gone.length === 0) return null
              return (
                <div className="glass-inset rounded-[1px] p-2 mb-3 text-[9px]">
                  <div className="font-semibold mb-1">Previously watched <span className="font-normal text-[var(--color-text-sub)]">— tap to re-add (or type any symbol above)</span></div>
                  <div className="flex flex-wrap gap-1.5">
                    {gone.slice(0, 30).map(r => (
                      <button key={r.symbol} type="button"
                        onClick={() => addSymbolsPlain([r.symbol])}
                        title={`Removed ${r.removedAt ? new Date(r.removedAt).toLocaleString() : ''}${r.group ? ` (was in ${r.group})` : ''} — tap to re-add`}
                        className="rounded-[1px] border border-[var(--glass-edge)] px-1.5 py-0.5 cursor-pointer hover:border-[var(--color-accent)]">
                        + {r.symbol}
                      </button>
                    ))}
                    {gone.length > 30 && <span className="text-[var(--color-text-sub)]">+{gone.length - 30} more</span>}
                  </div>
                </div>
              )
            })()}

            {/* Quick groups — market-standard buckets, one tap to add the
                whole set as ONE watchlist row. Each preset is intersected
                with the instruments THIS broker account actually offers, so
                a chip never adds a symbol that cannot trade. */}
            {allSymbols.length > 0 && (() => {
              const have = new Set(allSymbols.map(s => s.toUpperCase()))
              const presets = PRESET_GROUPS.map(g => ({
                ...g,
                avail: g.names.filter(n => have.has(n.toUpperCase())),
              }))
              return (
                <div className="mb-3">
                  <div className="text-[9px] text-[var(--color-text-sub)] mb-1.5">
                    Quick groups — tap to add every available instrument of a type as one row (Max lots still sizes per instrument):
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {presets.map(g => {
                      const selected = groupSelected(g.key)
                      const empty = g.avail.length === 0
                      return (
                        <button
                          key={g.key} type="button" role="switch" aria-checked={selected} disabled={empty && !selected}
                          title={empty
                            ? 'None of these tickers exist on this broker account — use Browse below for broker-truth categories'
                            : selected ? 'In the watchlist — tap to remove the group' : g.avail.join(' · ')}
                          onClick={() => selected ? removeGroup(g.key) : addGroup(g.key, g.avail)}
                          className={`inline-flex items-center rounded-[2px] border leading-none cursor-pointer bg-[var(--color-bg)] px-[3px] py-[1px] disabled:opacity-40 disabled:cursor-default ${
                            selected
                              ? 'border-[var(--color-accent)] text-[var(--color-accent)] text-[9px] font-normal capitalize'
                              : 'border-[var(--color-down)] text-[var(--color-down)] text-[9px] font-bold uppercase'
                          }`}
                        >
                          {g.key} ({g.avail.length})
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">
                    Per-country equity lists (top 10 per country, full FTSE/DAX membership) live under Browse below — that tree is the broker's own classification, always complete.
                  </p>
                </div>
              )
            })()}

            {/* Screener — owner: "Defense stocks screener is an example, you
                should be able to let me select any stocks or stock group or
                FOREX." Works over any PRESET_GROUPS entry (every group above,
                FX/indices/metals/crypto/equities all included) OR a one-off
                custom symbol list, typed for an ad-hoc search that doesn't
                belong to a named preset. Doubles as "find new ones to add"
                and "check which watchlisted symbols are in this set" — it
                lists every symbol this broker offers from the chosen set,
                whether or not it's already on the watchlist. */}
            <div className="mb-3">
              <button type="button" aria-expanded={screenerOpen} onClick={() => flip(setScreenerOpen, 'tune_screener_open')}
                className="text-[9px] font-semibold cursor-pointer flex items-center gap-1.5">
                <span aria-hidden="true">{screenerOpen ? '▾' : '▸'}</span> Screener
                <span className="font-normal text-[var(--color-text-sub)]">— preset groups by market, custom lists, AI search</span>
              </button>
              {screenerOpen && <>
              <p className="text-[9px] text-[var(--color-text-sub)] mb-1.5 mt-1">
                Advice is a technical read only (bias + confidence from the last scan, ATR% from the regime detector) — not a fundamentals or sector call; it stays blank until a symbol has actually been scanned.
              </p>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <select
                  value={screenerGroupKey}
                  onChange={e => { setScreenerGroupKey(e.target.value); setScreenerCustom(''); setScreenerAiSymbols(null) }}
                  className="glass-inset rounded-[7px] px-2 py-1.5 text-[9px] min-h-[32px]"
                >
                  {PRESET_MARKETS.map(m => (
                    <optgroup key={m} label={m}>
                      {PRESET_GROUPS.filter(g => g.market === m).map(g => <option key={g.key} value={g.key}>{g.key}</option>)}
                    </optgroup>
                  ))}
                </select>
                <span className="text-[9px] text-[var(--color-text-sub)]">or a custom list:</span>
                <input
                  type="text"
                  value={screenerCustom}
                  onChange={e => { setScreenerCustom(e.target.value); setScreenerAiSymbols(null) }}
                  placeholder="e.g. EURUSD, XAUUSD, NVDA.US"
                  className="glass-inset rounded-[7px] px-2 py-1.5 text-[9px] min-h-[32px] flex-1 min-w-[180px]"
                />
                <Button size="sm" variant="subtle" onClick={() => setScreenerChatOpen(true)}>
                  Search by description…
                </Button>
              </div>
              {screenerAiSymbols && (
                <div className="mb-2 text-[9px] text-[var(--color-text-sub)] flex items-center gap-2">
                  <span>Showing {screenerAiSymbols.length} AI-matched symbol(s).</span>
                  <button type="button" className="text-[var(--color-accent)] cursor-pointer hover:underline" onClick={() => setScreenerAiSymbols(null)}>clear</button>
                </div>
              )}
              {(() => {
                const custom = screenerCustom.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
                const curated = screenerAiSymbols || (custom.length > 0 ? custom : (PRESET_GROUPS.find(g => g.key === screenerGroupKey)?.names || []))
                const title = screenerAiSymbols ? 'AI search' : (custom.length > 0 ? 'Custom search' : screenerGroupKey)
                return (
                  // Key on the curated set's identity (not just title) — a
                  // fresh mount per group/custom-list change resets the
                  // internal `selected` Set, so a bulk Add/Remove can never
                  // act on rows hidden by an earlier switch (Codex review).
                  <WatchlistScreener
                    key={title === 'Custom search' || title === 'AI search' ? `${title}:${curated.join(',')}` : title}
                    title={title}
                    curated={curated}
                    allSymbols={allSymbols}
                    symbols={symbols}
                    scanInfo={scanInfo}
                    regimeBy={regimeBy}
                    onAdd={addSymbolsPlain}
                    onRemove={removeSymbolPlain}
                    onRemoveMany={removeSymbolsPlain}
                  />
                )
              })()}
              <ScreenerChat
                open={screenerChatOpen}
                onClose={() => setScreenerChatOpen(false)}
                onApply={(syms) => { setScreenerAiSymbols(syms); setScreenerChatOpen(false) }}
              />
              </>}
            </div>

            {/* Cup & Handle screener — the video's funnel, broker-honest:
                price / avg volume / RelVol>1 / SMA stack. P/E + sector are
                manual (not in cTrader data) and the panel says so. */}
            <div className="mb-3">
              <button type="button" aria-expanded={chScreenerOpen} onClick={() => flip(setChScreenerOpen, 'tune_ch_open')}
                className="text-[9px] font-semibold cursor-pointer flex items-center gap-1.5 mb-1">
                <span aria-hidden="true">{chScreenerOpen ? '▾' : '▸'}</span> Cup &amp; Handle screener
                {screenerBusy && <span className="font-normal text-[var(--color-text-sub)]">running…</span>}
              </button>
              {chScreenerOpen && <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm" variant="subtle" disabled={screenerBusy}
                  onClick={() => {
                    // Background job on the agent — switching pages mid-run
                    // no longer loses the results (poll effect collects them).
                    setScreenerBusy(true)
                    agentPost('/actions/cup-screener', {})
                      .catch(e => { if (!/already/i.test(e.message)) { setError(e.message); setScreenerBusy(false) } })
                  }}
                >
                  {screenerBusy ? `Screening ${enabledSymbols.length}…` : 'Run C&H screener'}
                </Button>
                <span className="text-[9px] text-[var(--color-text-sub)]">
                  daily bars · price &gt; 20 · RelVol &gt; 1 · above SMA 20/50/200 — on the enabled watchlist
                </span>
              </div>
              {screener && (
                <div className="glass-inset rounded-[12px] p-3 mt-2 text-[9px]">
                  <p className="font-semibold mb-1">
                    {screener.passed.length} of {screener.rows.length} passed{screener.passed.length > 0 ? `: ${screener.passed.join(', ')}` : ''}
                    {screener.rows.some(r => r.error) && ` · ${screener.rows.filter(r => r.error).length} could not be fetched (shown below)`}
                  </p>
                  <ul className="space-y-0.5">
                    {screener.rows.filter(r => !r.pass).map(r => (
                      <li key={r.symbol} className="text-[var(--color-text-sub)]">
                        <span className="font-semibold">{r.symbol}</span>{' — '}
                        {r.error || r.checks.filter(c => !c.ok).map(c => c.text).join(' · ')}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[var(--color-text-sub)]">{screener.manualChecks} Then eyeball the survivors for the actual cup &amp; handle shape.</p>
                </div>
              )}
              </>}
            </div>
            {symbols.length === 0 && <div className="text-[9px] text-[var(--color-text-sub)]">No symbols yet — add one above.</div>}
            {/* ONE table, ONE header — the old side-by-side half-tables
                stacked on narrow screens and repeated the header mid-page.
                Wide content scrolls inside the card instead. */}
            {(() => {
              const prevBy = {}
              for (const r of (sizingPrev?.rows || [])) prevBy[r.symbol] = r
              // The globally-armed keys. A per-symbol pick intersects with
              // this, so it is what "n of m" counts against.
              const armedKeys = (config?.strategies || []).filter(x => x.on).map(x => x.key)
              const toggleWlSel = (sym) => setWlSelected(prev2 => {
                const next = new Set(prev2)
                if (next.has(sym)) next.delete(sym); else next.add(sym)
                return next
              })
              const renderRow = (s) => {
                const i = symbols.indexOf(s)
                const tested = btTradeCount(s.symbol)
                const scan = scanInfo?.by?.[s.symbol]
                const prev = prevBy[String(s.symbol).toUpperCase()]
                const on = s.enabled !== false
                const picked = Array.isArray(s.strategies) && s.strategies.length ? s.strategies : null
                return (
                  <Fragment key={s.symbol}>
                  <tr className="border-t border-[var(--color-border)]">
                    <td className="pr-1 py-1">
                      <input type="checkbox" checked={wlSelected.has(s.symbol)} onChange={() => toggleWlSel(s.symbol)} aria-label={`Select ${s.symbol}`} />
                    </td>
                    <td className="pr-2 py-1 whitespace-nowrap">{s.symbol}</td>
                    <td className="pr-2 text-[9px] text-[var(--color-text-sub)] whitespace-nowrap">{prev?.type || ''}</td>
                    <td className="pr-2"><Badge tone={on ? 'on' : 'off'}>{on ? 'ON' : 'OFF'}</Badge></td>
                    <td className="pr-2 text-[9px] tabular-nums whitespace-nowrap">
                      {scan
                        ? <>
                            {scan.price != null && <span className="font-semibold">{Number(scan.price).toLocaleString(undefined, { maximumFractionDigits: priceDp(scan.price) })}</span>}
                            {' '}
                            {scan.bias && scan.bias !== 'skip'
                              ? <span className={scan.bias === 'long' ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>
                                  {scan.bias.toUpperCase()} {scan.timeframe || ''}{scan.confidence != null ? ` ${scan.confidence}/10` : ''}
                                </span>
                              : <span className="text-[var(--color-text-sub)]">no setup</span>}
                          </>
                        : <span className="text-[var(--color-text-sub)]">—</span>}
                    </td>
                    <td className="pr-2 text-[9px] tabular-nums text-center">{tested != null ? tested : '—'}</td>
                    {/* Live results — closed trades · net · win rate; LOSER
                        flag once the sample is big enough and net < 0. */}
                    <td className="pr-2 text-[9px] tabular-nums whitespace-nowrap">
                      {(() => {
                        const st = wlStats?.by?.[String(s.symbol).toUpperCase()]
                        if (!st) return <span className="text-[var(--color-text-sub)]">—</span>
                        return (
                          <span title={`${st.n} closed trades · net ${st.net >= 0 ? '+' : ''}${st.net} · ${st.winRate}% wins${st.loser ? ` — net negative after ${wlStats.min_n}+ trades` : ''}`}>
                            {st.n} · <span className={`font-semibold ${st.net >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{st.net >= 0 ? '+' : ''}{st.net}</span> · {st.winRate}%
                            {st.loser && <span className="ml-1 text-[9px] font-bold text-[var(--color-down)]">LOSER</span>}
                          </span>
                        )
                      })()}
                    </td>
                    <td
                      className="pr-2 text-[9px] tabular-nums whitespace-nowrap"
                      title={prev?.usdPerLot != null
                        ? `risk budget $${sizingPrev?.budget ?? '?'} ÷ $${prev.usdPerLot}/lot at the tightest allowed stop (${sizingPrev?.minSLDistancePct}% of price) — wider stops size smaller automatically`
                        : prev?.note || ''}
                    >
                      {prev?.autoLots != null
                        ? <span className="font-semibold">{prev.autoLots.toFixed(2)}</span>
                        : <span className="text-[var(--color-text-sub)]">{prev?.note ? '—' : '…'}</span>}
                      {prev?.maxCap != null && prev?.autoLots != null && prev.maxCap < prev.autoLots && (
                        <span className="text-[var(--color-text-sub)]"> → {prev.maxCap.toFixed(2)} (capped)</span>
                      )}
                    </td>
                    <td className="pr-2">
                      <Input
                        type="number" step="0.01" min="0.01" className="w-16 !py-0.5 !min-h-0 text-[9px]" value={s.maxVolume ?? ''}
                        placeholder="auto" aria-label={`Max lots cap for ${s.symbol}`}
                        onChange={e => {
                          const next = [...symbols]
                          next[i] = { ...s, maxVolume: e.target.value === '' ? undefined : Number(e.target.value) }
                          setConfig(c => ({ ...c, symbols: next }))
                        }}
                        onBlur={() => {
                          // Cap must be a positive number ≥ broker minimum —
                          // a negative/zero cap silently broke sizing before.
                          const n = Number(s.maxVolume)
                          const clean = Number.isFinite(n) && n > 0 ? Math.max(0.01, Math.round(n * 100) / 100) : undefined
                          if (clean !== s.maxVolume && !(clean === undefined && (s.maxVolume === undefined || s.maxVolume === ''))) {
                            setError(clean === undefined ? `Max lots for ${s.symbol} must be a positive number — cleared (auto sizing applies)` : '')
                          }
                          const next = symbols.map((x, j) => j === i ? { ...x, maxVolume: clean } : x)
                          setConfig(c => ({ ...c, symbols: next }))
                          pushSymbols(next)
                        }}
                      />
                    </td>
                    {/* Which of the ARMED strategies may trade this symbol.
                        "all" is the default and means "follow Tune >
                        Strategies" — the same thing every row means today. */}
                    <td className="pr-2 whitespace-nowrap">
                      <button
                        type="button"
                        className="cursor-pointer hover:underline text-[9px]"
                        aria-label={`Choose strategies for ${s.symbol}`}
                        onClick={() => setStratEditor(stratEditor === s.symbol ? null : s.symbol)}
                      >
                        {picked
                          ? <span className="text-[var(--color-accent)] font-semibold">{picked.length} of {armedKeys.length}</span>
                          : <span className="text-[var(--color-text-sub)]">all</span>}
                        <span aria-hidden="true"> {stratEditor === s.symbol ? '▾' : '▸'}</span>
                      </button>
                      {/* A pick that intersects the armed set to NOTHING stops
                          the symbol trading entirely. That is a legal thing to
                          configure and a terrible thing to configure by
                          accident, so it is named on the row. */}
                      {picked && picked.every(k => !armedKeys.includes(k)) && (
                        <span className="ml-1 font-bold text-[var(--color-down)]" title="None of this symbol's chosen strategies is armed in Tune > Strategies — nothing can trade it">NONE ARMED</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <Button size="sm" variant="subtle" className="!px-2 !py-0.5 !min-h-0 text-[9px]" onClick={() => pushSymbols(symbols.map((x, j) => j === i ? { ...x, enabled: x.enabled === false } : x))}>
                        {on ? 'Disable' : 'Enable'}
                      </Button>
                      {' '}
                      <Button size="sm" variant="danger" className="!px-2 !py-0.5 !min-h-0 text-[9px]" aria-label={`Remove ${s.symbol}`} onClick={() => pushSymbols(symbols.filter((_, j) => j !== i))}>Remove</Button>
                    </td>
                  </tr>
                  {stratEditor === s.symbol && (
                    <tr className="border-t border-[var(--color-border)] bg-[var(--glass-bg)]">
                      <td colSpan={11} className="py-2 px-2">
                        <StrategyPicker
                          all={config?.strategies || []}
                          value={s.strategies || null}
                          onChange={(next) => {
                            const list = symbols.map((x, j) => j === i ? (next ? { ...x, strategies: next } : (() => { const c = { ...x }; delete c.strategies; return c })()) : x)
                            // Apply locally as well as posting — load() re-reads
                            // eight endpoints, so the cell would otherwise sit on
                            // its old value for a beat after a save that worked
                            // (same reason the Max lots editor does this).
                            setConfig(c => ({ ...c, symbols: list }))
                            pushSymbols(list)
                            setStratEditor(null)
                          }}
                          onCancel={() => setStratEditor(null)}
                          label={s.symbol}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              }
              const selInList = [...wlSelected].filter(sym => symbols.some(s => s.symbol === sym))
              return (
                // Bounded + internally scrollable (owner: "shifting the screen up
                // and down whenever I tap the group") — expanding a band with 100s
                // of members used to reflow the whole page around your tap; now the
                // scroll stays INSIDE this box and everything below the card is
                // rock-still. Sticky header keeps column names visible mid-scroll.
                <>
                {selInList.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 mb-1.5 text-[9px]">
                    <span className="text-[var(--color-text-sub)]">{selInList.length} selected</span>
                    <Button size="sm" variant="danger" className="!px-2 !py-0.5 !min-h-0 text-[9px]" onClick={() => {
                      // One list, one save (same lesson as the screener bulk
                      // remove) — the removals also land in Previously watched.
                      const drop = new Set(selInList)
                      pushSymbols(symbols.filter(s => !drop.has(s.symbol)))
                      setWlSelected(new Set())
                    }}>Remove {selInList.length} selected</Button>
                    <Button size="sm" variant="subtle" className="!px-2 !py-0.5 !min-h-0 text-[9px]" onClick={() => {
                      const pick = new Set(selInList)
                      pushSymbols(symbols.map(s => pick.has(s.symbol) ? { ...s, enabled: false } : s))
                      setWlSelected(new Set())
                    }}>Disable selected</Button>
                    <Button size="sm" variant="subtle" className="!px-2 !py-0.5 !min-h-0 text-[9px]" onClick={() => {
                      const pick = new Set(selInList)
                      pushSymbols(symbols.map(s => pick.has(s.symbol) ? { ...s, enabled: true } : s))
                      setWlSelected(new Set())
                    }}>Enable selected</Button>
                    <Button size="sm" variant="subtle" className="!px-2 !py-0.5 !min-h-0 text-[9px]" onClick={() => setStratEditor(stratEditor === '__bulk__' ? null : '__bulk__')}>
                      Set strategies for {selInList.length}…
                    </Button>
                    <button type="button" className="text-[var(--color-accent)] cursor-pointer hover:underline" onClick={() => setWlSelected(new Set())}>clear</button>
                  </div>
                )}
                {/* Bulk pick — the only practical route when the watchlist runs
                    to hundreds of instruments. One list, one save, same as the
                    other bulk gestures above it. */}
                {stratEditor === '__bulk__' && selInList.length > 0 && (
                  <div className="mb-1.5 p-2 rounded-[8px] border border-[var(--color-border)]">
                    <StrategyPicker
                      all={config?.strategies || []}
                      value={null}
                      label={`${selInList.length} selected symbols`}
                      onCancel={() => setStratEditor(null)}
                      onChange={(next) => {
                        const pick = new Set(selInList)
                        const list = symbols.map(s => {
                          if (!pick.has(s.symbol)) return s
                          if (next) return { ...s, strategies: next }
                          const c = { ...s }; delete c.strategies; return c
                        })
                        setConfig(c => ({ ...c, symbols: list }))
                        pushSymbols(list)
                        setStratEditor(null)
                      }}
                    />
                  </div>
                )}
                <div className="overflow-auto max-h-[65vh] border border-[var(--color-border)] rounded-[8px]">
                  <table className="std-cols min-w-full text-[9px]">
                    <thead className="sticky top-0 z-10 bg-[var(--color-bg)]">
                      <tr>
                        <th className="pr-1 pb-1" title="Tick rows, then Remove/Disable selected above">✓</th>
                        <th className="pr-2 pb-1">Symbol</th>
                        <th className="pr-2 pb-1">Type</th>
                        <th className="pr-2 pb-1">Scanned</th>
                        <th className="pr-2 pb-1">Live signal</th>
                        <th className="pr-2 pb-1 text-center" title="Trades this symbol produced in the last backtest, all timeframes">Backtest trades</th>
                        <th className="pr-2 pb-1" title="LIVE closed trades on this account: count · net P&L · win rate. LOSER = net negative after enough sample — consider disabling">Live results</th>
                        <th className="pr-2 pb-1" title="Computed per instrument from your balance and risk % — the size the risk gate would approve at the tightest allowed stop">Auto lots</th>
                        <th className="pr-2 pb-1" title="Optional manual CAP on the auto size — leave empty for pure risk-based sizing">Max lots (cap)</th>
                        <th className="pr-2 pb-1" title="Which of the ARMED strategies may trade this symbol. 'all' follows Tune &gt; Strategies. A pick can only NARROW that set — a symbol cannot arm a strategy you have disarmed globally.">Strategies</th>
                        <th className="pb-1">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Excel-style bands: one collapsible band per group,
                          plus Singles. Band row = triangle + name + count +
                          state + group actions; expanding reveals the full
                          per-symbol rows. 100s of instruments stay one line
                          each until asked for. */}
                      {[...groupOf.entries()].map(([key, members]) => {
                        const bandOpen = openBands.has(key)
                        const onCount = members.filter(m => m.enabled !== false).length
                        return (
                          <Fragment key={`band:${key}`}>
                            <tr className="border-t border-[var(--color-border)] bg-[var(--glass-bg)]">
                              <td colSpan={11} className="py-1.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <button
                                    type="button" onClick={() => toggleBand(key)} aria-expanded={bandOpen}
                                    className="flex items-center gap-1.5 font-bold cursor-pointer"
                                  >
                                    <span aria-hidden="true" className="inline-block w-3 text-[9px]">{bandOpen ? '▾' : '▸'}</span>
                                    {key}
                                    <span className="font-normal text-[var(--color-text-sub)]">({members.length} symbols · {onCount} on)</span>
                                  </button>
                                  <Badge tone={onCount > 0 ? 'on' : 'off'}>{onCount > 0 ? 'ON' : 'OFF'}</Badge>
                                  <span className="ml-auto flex items-center gap-2">
                                    <Button size="sm" variant="subtle" className="!px-2 !py-0.5 !min-h-0 text-[9px]" onClick={() => toggleGroupEnabled(key, onCount === 0)}>
                                      {onCount > 0 ? 'Disable group' : 'Enable group'}
                                    </Button>
                                    <Button size="sm" variant="subtle" className="!px-2 !py-0.5 !min-h-0 text-[9px]" onClick={() => removeGroup(key)} aria-label={`Remove ${key} group from watchlist`}>
                                      ✕ Remove
                                    </Button>
                                  </span>
                                </div>
                              </td>
                            </tr>
                            {bandOpen && members.map(renderRow)}
                          </Fragment>
                        )
                      })}
                      {singles.length > 0 && (
                        <Fragment key="band:__singles__">
                          {groupOf.size > 0 && (
                            <tr className="border-t border-[var(--color-border)] bg-[var(--glass-bg)]">
                              <td colSpan={11} className="py-1.5">
                                <button
                                  type="button" onClick={() => toggleBand('__singles__')} aria-expanded={openBands.has('__singles__')}
                                  className="flex items-center gap-1.5 font-bold cursor-pointer"
                                >
                                  <span aria-hidden="true" className="inline-block w-3 text-[9px]">{openBands.has('__singles__') ? '▾' : '▸'}</span>
                                  Singles
                                  <span className="font-normal text-[var(--color-text-sub)]">({singles.length})</span>
                                </button>
                              </td>
                            </tr>
                          )}
                          {(groupOf.size === 0 || openBands.has('__singles__')) && singles.map(renderRow)}
                        </Fragment>
                      )}
                    </tbody>
                  </table>
                </div>
                </>
              )
            })()}
            <p className="mt-2 text-[9px] text-[var(--color-text-sub)]">
              {sizingPrev?.balance != null && (
                <>Sizing: each trade risks {Math.round((sizingPrev.riskPct || 0) * 10000) / 100}% of ${Number(sizingPrev.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} = ${sizingPrev.budget} — lots = budget ÷ $-per-lot, computed per instrument (contract size × stop distance). Max lots is only a cap; leave it empty for pure risk-based sizing. </>
              )}
              Symbol names must match your broker's cTrader names (e.g. EURUSD, XAUUSD) — IDs are mapped automatically when you link the account on the Connect tab.
            </p>

            {/* Full catalogue browser — every instrument the broker offers,
                searchable + category-filtered, one tap to add. */}
            {allSymbols.length > 0 && (
              <div className="mb-3">
                <button
                  type="button" aria-expanded={browse}
                  onClick={() => {
                    setBrowse(b => !b)
                    if (!tree) {
                      agentGet('/actions/instrument-tree')
                        .then(t => { setTree(t); setTreeErr('') })
                        .catch(e => setTreeErr(e.message))
                    }
                  }}
                  className="text-[9px] font-semibold text-[var(--color-accent)] cursor-pointer hover:underline"
                >
                  {browse ? '▾' : '▸'} All {allSymbols.length.toLocaleString()} instruments on this account — tick to add, whole groups or one by one
                </button>
                {browse && (() => {
                  if (treeErr) return <p className="text-[9px] text-[var(--color-warning-text)] mt-2">Could not load the classification tree: {treeErr}</p>
                  if (!tree) return <Skeleton lines={4} className="mt-2" />
                  const bq = browseQ.trim().toUpperCase()
                  const inList = new Set(symbols.map(s => s.symbol))
                  return (
                    <div className="glass-inset rounded-[12px] p-3 mt-2">
                      <div className="flex flex-wrap items-center gap-1.5 mb-2">
                        <Input value={browseQ} onChange={e => setBrowseQ(e.target.value)} placeholder="Filter symbols…" className="max-w-[180px] !py-1 !min-h-0" />
                        <span className="ml-auto text-[9px] text-[var(--color-text-sub)]">
                          {tree.total.toLocaleString()} instruments · tick "whole class"/"whole group" to add hundreds at once as ONE watchlist band
                        </span>
                      </div>
                      {/* One card per asset class in a responsive grid — 1900+
                          instruments used to be ONE long vertical accordion (owner:
                          "segment them and use up one screen, not scroll to multiple
                          paging"). Desktop now shows several classes side by side;
                          each card scrolls its OWN categories, so opening one never
                          reflows its neighbours or the page below. A class-level
                          "whole class" tick covers everything in it (e.g. all of
                          Forex, hundreds of pairs) in one action — the fastest way
                          to get from 0 to all 1900+. */}
                      <div className="max-h-[70vh] overflow-y-auto grid gap-2 sm:grid-cols-2 xl:grid-cols-3 items-start text-[9px]">
                        {tree.classes.map(cls => {
                          const clsKey = `c:${cls.name}`
                          const clsOpen = openNodes.has(clsKey) || !!bq
                          const cats = bq
                            ? cls.categories
                                .map(c => ({ ...c, symbols: c.symbols.filter(s => s.toUpperCase().includes(bq)) }))
                                .filter(c => c.symbols.length > 0)
                            : cls.categories
                          if (bq && cats.length === 0) return null
                          const classSelected = groupSelected(cls.name)
                          const classSymbols = cls.categories.flatMap(c => c.symbols)
                          return (
                            <div key={cls.name} className="glass-inset rounded-[8px] border border-[var(--color-border)] p-1.5 min-w-0">
                              <div className="flex items-center gap-2 min-h-[32px]">
                                <button
                                  type="button" onClick={() => toggleNode(clsKey)} aria-expanded={clsOpen}
                                  className="flex items-center gap-1.5 cursor-pointer font-bold min-w-0 truncate"
                                >
                                  <span aria-hidden="true">{clsOpen ? '▾' : '▸'}</span>
                                  {cls.name}
                                  <span className="text-[var(--color-text-sub)] font-normal shrink-0">({cls.count})</span>
                                </button>
                                <label className="ml-auto flex items-center gap-1 text-[9px] text-[var(--color-text-sub)] cursor-pointer shrink-0" title={`Add every instrument in ${cls.name} (${cls.count}) as one watchlist band`}>
                                  <input
                                    type="checkbox" checked={classSelected}
                                    onChange={e => (e.target.checked ? addGroup(cls.name, classSymbols) : removeGroup(cls.name))}
                                    aria-label={`Add whole ${cls.name} class (${cls.count} symbols) to watchlist as one group row`}
                                  />
                                  whole class
                                </label>
                              </div>
                              {clsOpen && (
                                <div className="max-h-56 overflow-y-auto mt-1 pl-1">
                                  {cats.map(cat => {
                                    const key = `${cls.name} / ${cat.name}`
                                    const catKey = `g:${key}`
                                    const catOpen = openNodes.has(catKey) || !!bq
                                    const selected = groupSelected(key)
                                    return (
                                      <div key={cat.name} className="border-t border-[var(--color-border)] first:border-t-0">
                                        <div className="flex items-center gap-2 py-1 min-h-[32px]">
                                          <button
                                            type="button" onClick={() => toggleNode(catKey)} aria-expanded={catOpen}
                                            className="flex items-center gap-1.5 cursor-pointer font-semibold min-w-0 truncate"
                                          >
                                            <span aria-hidden="true">{catOpen ? '▾' : '▸'}</span>
                                            {cat.name}
                                            <span className="text-[var(--color-text-sub)] font-normal shrink-0">({cat.count})</span>
                                          </button>
                                          <label className="ml-auto flex items-center gap-1 text-[9px] text-[var(--color-text-sub)] cursor-pointer shrink-0 pr-1">
                                            <input
                                              type="checkbox" checked={selected}
                                              onChange={e => (e.target.checked ? addGroup(key, cat.symbols) : removeGroup(key))}
                                              aria-label={`Add ${key} (${cat.count} symbols) to watchlist as one group row`}
                                            />
                                            group
                                          </label>
                                        </div>
                                        {catOpen && (
                                          <div className="max-h-40 overflow-y-auto pb-1">
                                            {cat.symbols.map(s => (
                                              <label key={s} className="flex items-center gap-2 border-t border-[var(--color-border)] first:border-t-0 py-0.5 cursor-pointer">
                                                <input
                                                  type="checkbox" checked={inList.has(s)}
                                                  aria-label={`${inList.has(s) ? 'Remove' : 'Add'} ${s}`}
                                                  onChange={e => e.target.checked
                                                    ? pushSymbols([...symbols, { symbol: s, enabled: true }])
                                                    : pushSymbols(symbols.filter(x => x.symbol !== s))}
                                                />
                                                <span className="font-semibold">{s}</span>
                                              </label>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
        )}

        {tab === 'backtest' && (
          <div>
            <h2 className="t-h3 mb-2">Backtest (go/no-go before autotrade)</h2>
            {enabledSymbols.length === 0 ? (
              <p className="text-[9px] text-[var(--color-text-sub)]">No enabled symbols — add instruments on the Watchlist tab first.</p>
            ) : (
              <>
                <div className="text-[9px] text-[var(--color-text-sub)] mb-1.5">Tests your enabled watchlist — groups first: include/skip whole groups, expand only to fine-tune symbols:</div>
                {/* One-tap ALL / NONE across every group (owner spec). */}
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[9px]">
                  <Button size="sm" variant="subtle" onClick={() => setBtSkip(new Set())}>Select all ({enabledSymbols.length})</Button>
                  <Button size="sm" variant="subtle" onClick={() => setBtSkip(new Set(enabledSymbols))}>Select none</Button>
                  <span className="text-[var(--color-text-sub)]">testing {btSymbols.length} of {enabledSymbols.length}</span>
                </div>
                {/* Banded like the watchlist (owner spec): one collapsed row
                    per group with skip/include-all; expand for symbol chips. */}
                {(() => {
                  const groups = new Map()
                  const singleNames = []
                  for (const s of symbols) {
                    if (s.enabled === false) continue
                    if (s.group) {
                      if (!groups.has(s.group)) groups.set(s.group, [])
                      groups.get(s.group).push(s.symbol)
                    } else singleNames.push(s.symbol)
                  }
                  const setGroupSkip = (names, skip) => setBtSkip(prev => {
                    const next = new Set(prev)
                    for (const n of names) { if (skip) next.add(n); else next.delete(n) }
                    return next
                  })
                  const chip = (sym) => {
                    const on = !btSkip.has(sym)
                    return (
                      <button
                        key={sym} type="button" aria-pressed={on}
                        onClick={() => setBtSkip(prev => {
                          const next = new Set(prev)
                          if (next.has(sym)) next.delete(sym); else next.add(sym)
                          return next
                        })}
                        className={`rounded-[20px] border px-2 py-0.5 text-[9px] font-semibold cursor-pointer min-h-[28px] ${
                          on
                            ? 'bg-[var(--color-accent)] text-white border-transparent'
                            : 'bg-[var(--color-bg)] text-[var(--color-text-sub)] border-[var(--color-border)] line-through'
                        }`}
                      >{sym}</button>
                    )
                  }
                  // One card per group in a 5-column grid (owner spec): a
                  // toggle SWITCH includes/skips the whole group; the name
                  // expands the symbol chips. An open card breaks out to the
                  // full row width so its chips have room.
                  const band = (key, names) => {
                    const open = openBands.has(`bt:${key}`)
                    const testing = names.filter(n => !btSkip.has(n)).length
                    const on = testing > 0
                    const partial = on && testing < names.length
                    return (
                      <div
                        key={key}
                        className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 flex flex-col gap-1 ${open ? 'col-span-2 sm:col-span-3 lg:col-span-5' : ''}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button" onClick={() => toggleBand(`bt:${key}`)} aria-expanded={open}
                            className="flex items-center gap-1 font-semibold text-[9px] cursor-pointer min-w-0 min-h-[28px] text-left"
                            title="Expand to pick individual symbols"
                          >
                            <span aria-hidden="true" className="inline-block w-2.5 shrink-0 text-[9px]">{open ? '▾' : '▸'}</span>
                            <span className="truncate">{key}</span>
                          </button>
                          <button
                            type="button" role="switch" aria-checked={on}
                            aria-label={`${on ? 'Skip' : 'Include'} ${key}`}
                            onClick={() => setGroupSkip(names, on)}
                            className={`relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full transition-colors cursor-pointer ${on ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}`}
                          >
                            <span className={`inline-block h-[16px] w-[16px] rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
                          </button>
                        </div>
                        <span className="text-[9px] text-[var(--color-text-sub)]">
                          testing {testing} of {names.length}{partial ? ' (some skipped)' : ''}
                        </span>
                        {open && <div className="mt-1 flex flex-wrap gap-1">{names.map(chip)}</div>}
                      </div>
                    )
                  }
                  return (
                    <div className="mb-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                      {[...groups.entries()].map(([key, names]) => band(key, names))}
                      {singleNames.length > 0 && band('Singles', singleNames)}
                    </div>
                  )
                })()}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={runBacktest} disabled={btRunning}>
                    {btRunning ? `Testing ${btSymbols.length} symbol${btSymbols.length > 1 ? 's' : ''}…` : `Run backtest (${btSymbols.length})`}
                  </Button>
                  <span className="flex items-center gap-1 text-[9px]" role="radiogroup" aria-label="Backtest strategy">
                    {/* Pills come from the registry (config.strategies); the
                        fib fallback keeps the tab usable before config loads. */}
                    {(config?.strategies?.length ? config.strategies : [{ key: 'fib_618_fade', name: 'Fib fade' }]).map(({ key: val, name: lbl }) => (
                      <button
                        key={val} type="button" role="radio" aria-checked={btStrategy === val}
                        onClick={() => {
                          setBtStrategy(val)
                          // touch-fill is a fib-only simulation — clear it so a
                          // stale tick can't ride along with another strategy
                          if (val !== 'fib_618_fade') setBtTouchFill(false)
                        }}
                        className={`rounded-[1px] px-2.5 py-0.5 min-h-[28px] text-[9px] font-semibold cursor-pointer ${btStrategy === val ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-sub)]'}`}
                      >{lbl}</button>
                    ))}
                  </span>
                  <label className="flex items-center gap-1.5 text-[9px] cursor-pointer min-h-[36px]" title="Fib fade only: simulate a resting LIMIT order at the 61.8% level instead of a market order after a close in the zone. Fills on any touch of the level; cancelled when price closes beyond the stop first or the zone expires. A/B this against the default before asking for live pending orders.">
                    <input type="checkbox" checked={btTouchFill} onChange={e => setBtTouchFill(e.target.checked)} disabled={btStrategy !== 'fib_618_fade'} />
                    Touch-fill (pending order)
                  </label>
                  <label className="flex items-center gap-1.5 text-[9px] cursor-pointer min-h-[36px]" title="Only take entries during the instrument's prime-liquidity hours: exchange session for stocks/indices, London+New York (Mon–Fri 08:00–21:00 UTC) for FX/metals/commodities. Proves whether the edge is session-dependent.">
                    <input type="checkbox" checked={btSessionFilter} onChange={e => setBtSessionFilter(e.target.checked)} />
                    Session filter
                  </label>
                  <span className="text-[9px] text-[var(--color-text-sub)]">on {[...timeframes].sort((a, b) => tfMs(a) - tfMs(b)).join(' + ')} (set on Pipeline) · filters: {mxBtFilterNames.length ? mxBtFilterNames.join(' + ') : 'none'} (Backtest column of the Pipeline matrix) · 1,000 real broker bars per timeframe · walk-forward · next-open fills · gap-honest SL · 0.02% cost · SL-before-TP</span>
                </div>
              </>
            )}

            {/* Post-backtest watchdog verdict (owner 2026-07-28): the edge
                watchdog runs immediately after every backtest, so fresh
                backtest optimism never leaves a live-losing strategy armed. */}
            {bt?.watchdog && !bt.watchdog.error && (
              bt.watchdog.actions?.length > 0 ? (
                <div className="mt-2 glass-inset rounded-[1px] border border-[var(--color-down)] p-2 text-[9px]">
                  <span className="font-bold text-[var(--color-down)]">Watchdog acted after this run: </span>
                  {bt.watchdog.actions.map(a => `${a.strategy} disarmed (live: ${a.trades} trades, PF ${a.profitFactor ?? '—'}, net $${a.net})`).join(' · ')}
                </div>
              ) : (
                <p className="mt-2 text-[9px] text-[var(--color-text-sub)]">
                  Post-backtest watchdog: {bt.watchdog.skipped ? `skipped (${bt.watchdog.skipped})` : `${bt.watchdog.evaluated?.length || 0} armed strateg${(bt.watchdog.evaluated?.length || 0) === 1 ? 'y' : 'ies'} checked against LIVE results — none disarmed`}.
                </p>
              )
            )}

            {/* Saved runs on the agent (ephemeral — wiped on redeploy) */}
            <details className="mt-2 text-[9px]">
              <summary className="cursor-pointer font-semibold text-[var(--color-accent)]">Past reports saved on the agent</summary>
              <SavedReports />
            </details>

            {/* Durable per-symbol backtest history (backtest_runs table —
                survives redeploys, unlike the HTML reports above). */}
            <div className="mt-2 text-[9px]">
              <button type="button" aria-expanded={btHistOpen} onClick={() => setBtHistOpen(o => !o)}
                className="cursor-pointer font-semibold text-[var(--color-accent)] flex items-center gap-1.5">
                <span aria-hidden="true">{btHistOpen ? '▾' : '▸'}</span> Backtest history per symbol (durable)
              </button>
              {btHistOpen && (
                <div className="mt-1.5">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <Input value={btHistSym} onChange={e => setBtHistSym(e.target.value)} placeholder="Filter by symbol…" className="max-w-[160px] !py-1 !min-h-0" />
                    {btHist?.bySymbol?.length > 0 && (
                      <span className="text-[var(--color-text-sub)]">{btHist.bySymbol.length} symbols ever tested · newest first · last 2,000 rows kept</span>
                    )}
                  </div>
                  {!btHist && <Skeleton lines={3} />}
                  {btHist && btHist.rows.length === 0 && (
                    <p className="text-[var(--color-text-sub)]">No recorded runs{btHistSym ? ` for ${btHistSym.toUpperCase()}` : ''} yet — history starts recording from the next backtest.</p>
                  )}
                  {btHist && btHist.rows.length > 0 && (
                    <div className="overflow-auto max-h-[45vh] border border-[var(--color-border)] rounded-[8px]">
                      <table className="std-cols min-w-full text-[9px]">
                        <thead className="sticky top-0 z-10 bg-[var(--color-bg)]">
                          <tr>
                            <th className="pr-3 pb-1">Ran</th>
                            <th className="pr-3 pb-1">Symbol</th>
                            <th className="pr-3 pb-1">TF</th>
                            <th className="pr-3 pb-1">Strategy</th>
                            <th className="pr-3 pb-1 text-right">Trades</th>
                            <th className="pr-3 pb-1 text-right">Win %</th>
                            <th className="pr-3 pb-1 text-right">PF</th>
                            <th className="pr-3 pb-1 text-right">Net %</th>
                            <th className="pr-3 pb-1 text-right" title="Walk-forward: positive segments / active segments">WF</th>
                          </tr>
                        </thead>
                        <tbody>
                          {btHist.rows.map(r => (
                            <tr key={r.id} className="border-t border-[var(--color-border)] tabular-nums">
                              <td className="pr-3 py-0.5 whitespace-nowrap text-[var(--color-text-sub)]">{new Date(r.ran_at).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                              <td className="pr-3 font-semibold whitespace-nowrap">{r.symbol}</td>
                              <td className="pr-3">{r.timeframe}</td>
                              <td className="pr-3 whitespace-nowrap text-[var(--color-text-sub)]">{r.strategy}{r.entry_mode === 'touch' ? ' · touch' : ''}</td>
                              {r.error
                                ? <td colSpan={5} className="pr-3 text-[var(--color-warning-text)]">{r.error}</td>
                                : <>
                                    <td className="pr-3 text-right">{r.trades ?? '—'}</td>
                                    <td className="pr-3 text-right">{r.win_rate_pct != null ? `${r.win_rate_pct}%` : '—'}</td>
                                    <td className="pr-3 text-right">{r.profit_factor != null ? r.profit_factor : (r.trades > 0 && r.losses === 0 ? '∞' : '—')}</td>
                                    <td className={`pr-3 text-right font-semibold ${Number(r.total_profit_pct) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{r.total_profit_pct != null ? `${r.total_profit_pct}%` : '—'}</td>
                                    <td className="pr-3 text-right">{r.wf_positive != null ? `${r.wf_positive}/${r.wf_active ?? '?'}` : '—'}</td>
                                  </>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
            {bt?.report?.html && (
              <div className="mt-3">
                <Button
                  size="sm" variant="secondary"
                  onClick={() => {
                    const url = URL.createObjectURL(new Blob([bt.report.html], { type: 'text/html' }))
                    const a = document.createElement('a')
                    a.href = url
                    a.download = bt.report.filename
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                >
                  Download report ({bt.report.filename})
                </Button>
              </div>
            )}

            {bt?.symbols && (
              <div className="mt-3 space-y-4">
                {Object.entries(bt.symbols).map(([sym, sr]) => (
                  <div key={sym}>
                    <h3 className="text-[11px] font-bold mb-1">{sym}</h3>
                    {sr.error
                      ? <p className="text-[9px] text-[var(--color-warning-text)]">{sr.error}</p>
                      : (
                        <div className="overflow-x-auto">
                          <table className="std-cols w-full text-[9px]">
                            <thead>
                              <tr>
                                {BT_COLS.map(c => (
                                  <th
                                    key={c.key} className="pr-3 py-1 cursor-pointer select-none whitespace-nowrap"
                                    title={c.title || `Sort by ${c.label}`}
                                    onClick={() => setBtSort(s => ({ col: c.key, dir: s.col === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}
                                  >
                                    {c.label}{btSort.col === c.key ? (btSort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
                                  </th>
                                ))}
                                <th>Verdict</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sortBtRows(Object.entries(sr.results), btSort).map(([tf, r]) => {
                                // PF is null when no trade lost — display ∞, and let
                                // the highlight treat it as excellent, not missing.
                                const pfShown = r.profitFactor ?? (r.trades > 0 && r.losses === 0 ? '∞' : '—')
                                const pfNum = r.profitFactor ?? (r.trades > 0 && r.losses === 0 ? 999 : null)
                                return (
                                  <tr key={tf} className="border-t border-[var(--color-border)]">
                                    <td className="pr-3 py-1.5">{tf}</td>
                                    {r.error
                                      ? <td colSpan={12} className="text-[var(--color-warning-text)]">{r.error}</td>
                                      : <>
                                          <td className={`pr-3 ${metricClass(r.trades, { good: GO_MIN_TRADES, bad: -1 })}`}>{r.trades}</td>
                                          <td className={`pr-3 ${metricClass(r.winRatePct, { good: 50, bad: 30 })}`}>{r.winRatePct != null ? `${r.winRatePct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.arrPct, { good: 0.0001, bad: -0.0001 })}`}>{r.arrPct != null ? `${r.arrPct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.totalProfitPct, { good: 0.0001, bad: -0.0001 })}`}>{r.totalProfitPct != null ? `${r.totalProfitPct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(pfNum, { good: 1.1, bad: 1 })}`}>{pfShown}</td>
                                          <td className={`pr-3 ${metricClass(r.sharpeAnnualized, { good: 1, bad: 0 })}`}>{r.sharpeAnnualized ?? '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.sortinoAnnualized, { good: 1.5, bad: 0 })}`}>{r.sortinoAnnualized ?? '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.calmarRatio, { good: 1, bad: 0 })}`}>{r.calmarRatio ?? '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.maxDrawdownPct, { good: 1, bad: 3, lowerBetter: true })}`}>{r.maxDrawdownPct != null ? `${r.maxDrawdownPct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.mddP95Pct, { good: 2, bad: 5, lowerBetter: true })}`}>{r.mddP95Pct != null ? `${r.mddP95Pct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.cvar95Pct, { good: -0.25, bad: -1 })}`}>{r.cvar95Pct != null ? `${r.cvar95Pct}%` : '—'}</td>
                                          <td className="pr-3 whitespace-nowrap">
                                            {r.wfSegments
                                              ? r.wfSegments.map((seg, si) => (
                                                  <span
                                                    key={si}
                                                    title={`Segment ${si + 1}: ${seg.trades} trade${seg.trades === 1 ? '' : 's'}, ${seg.totalProfitPct}% total, ${seg.maxDrawdownPct}% max DD`}
                                                    className={`inline-block w-2.5 h-3.5 mr-0.5 rounded-[2px] align-middle ${
                                                      seg.trades === 0
                                                        ? 'border border-[var(--color-border)]'
                                                        : seg.totalProfitPct > 0 ? 'bg-[var(--color-up)]' : 'bg-[var(--color-down)]'
                                                    }`}
                                                  />
                                                ))
                                              : '—'}
                                          </td>
                                        </>}
                                    <td>
                                      {!r.error && (
                                        <span className="flex items-center gap-2 whitespace-nowrap">
                                          <VerdictBadge r={r} />
                                          {verdictFor(r)?.state !== 'go' && (
                                            <label
                                              className="flex items-center gap-1 text-[9px] text-[var(--color-text-sub)] cursor-pointer"
                                              title="Include this timeframe in Activate even though it did not fully pass — you accept the unproven risk"
                                            >
                                              <input
                                                type="checkbox"
                                                checked={btForce.has(`${sym}|${tf}`)}
                                                onChange={() => toggleForce(sym, tf)}
                                              />
                                              arm anyway
                                            </label>
                                          )}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                  </div>
                ))}
                <p className="text-[9px] text-[var(--color-text-sub)]">
                  {(() => {
                    const cells = Object.values(bt.symbols).reduce((n, s2) => n + (s2.results ? Object.keys(s2.results).length : 0), 0)
                    return `Selection-bias note: this run evaluated ${cells} symbol×timeframe cells — the single best-looking cell is partly luck (the more cells you look at, the prettier the best one gets). Trust rows whose walk-forward strip repeats, not one pretty row. `
                  })()}
                  Tap any verdict for the evidence behind it. GO = ≥10 trades, profit factor ≥1.1, positive total. GO (thin) = the edge is positive but there aren't enough trades to trust it — 1,000 bars is ~5.5 months of 4h but only ~10 days of 15m, so slow timeframes often can't reach 10 trades in the window; that's "unproven", not "bad". Tick "arm anyway" on any row to include it in Activate at your own risk. DD p95 = worst-case drawdown across 1,000 reshuffles of the same trades; CVaR = average of the worst 5% of trades. RSI filter setting (Pipeline tab) is applied.
                </p>
                {/* Verdict-class picker (owner spec): choose WHICH classes
                    flow into Activate — one tap instead of per-row ticks. */}
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[9px]" role="radiogroup" aria-label="Which verdicts to arm">
                  <span className="text-[var(--color-text-sub)] font-semibold">Add to Activate:</span>
                  {[
                    ['go', 'Go only'],
                    ['go+thin', 'Go + Go (thin)'],
                    ['thin', 'Go (thin) only'],
                    ['all', 'All incl. No-Go (<½ blue)'],
                  ].map(([v, lbl]) => (
                    <button
                      key={v} type="button" role="radio" aria-checked={btArmClass === v}
                      onClick={() => pickArmClass(v)}
                      className={`rounded-[8px] px-2 py-1 min-h-[28px] font-semibold cursor-pointer ${btArmClass === v ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
                    >{lbl}</button>
                  ))}
                  {btArmClass === 'all' && (
                    <span className="text-[var(--color-warning-text)] font-semibold">No-Go rows failed the evidence bar — arming them trades against your own backtest.</span>
                  )}
                  {btArmClass === 'thin' && (
                    <span className="text-[var(--color-text-sub)]">thin = positive edge, unproven sample.</span>
                  )}
                </div>
                {armTfs.length === 0 && (() => {
                  const anyThin = Object.values(bt.symbols).some(s => s.results && Object.values(s.results).some(r => verdictFor(r)?.state === 'thin'))
                  return (
                    <p className="text-[9px] font-semibold text-[var(--color-warning-text)]">
                      {anyThin
                        ? 'No timeframe fully passed — but some show a positive edge on too few trades (GO thin). Keep the bot in demo to accumulate evidence, re-run later as more bars build up — or tick "arm anyway" on a row to proceed at your own risk.'
                        : 'No timeframe passed on any symbol — do NOT arm autotrade. Adjust the watchlist, wait for more data, or tick "arm anyway" on a row to proceed at your own risk.'}
                    </p>
                  )
                })()}
                {armTfs.length > 0 && config?.autotrade_enabled && (() => {
                  // Already armed — but if the checked selection differs from
                  // what's currently armed, offer to push the new set. The old
                  // static "already ACTIVE" text left ticked checkboxes with
                  // no button to act on them.
                  const same = matrixEq(armMatrix, armedMatrix)
                  if (same) {
                    return <p className="text-[9px] font-semibold">Quant trading is ACTIVE, armed per instrument: {matrixSummary}. Your current selection matches — nothing to apply.</p>
                  }
                  return (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button onClick={async () => {
                        const forcedNote = forcedTfs.length
                          ? ` NOTE: some rows did NOT fully pass — you are overriding those verdicts.`
                          : ''
                        if (!window.confirm(`Apply per-instrument arming: ${matrixSummary}?${forcedNote} Autotrade stays ON — each symbol will only trade its own armed timeframes.`)) return
                        try {
                          await agentPost('/actions/autotrade-timeframes', { timeframes: armTfs, matrix: armMatrix })
                          const benchmarks = {}
                          for (const [sym2, tfs2] of Object.entries(armMatrix)) {
                            for (const tf2 of tfs2) {
                              const r2 = bt?.symbols?.[sym2]?.results?.[tf2]
                              if (r2 && !r2.error) benchmarks[`${sym2}|${tf2}`] = { profitFactor: r2.profitFactor ?? null, expectancyPct: r2.expectancyPct ?? null, trades: r2.trades ?? 0 }
                            }
                          }
                          agentPost('/actions/arm-benchmarks', { benchmarks }).catch(() => {})
                          setTimeframes(armTfs)
                          await load()
                          flash(`Armed per instrument: ${matrixSummary} — autotrade stays ON.`)
                        } catch (err) { setError(err.message) }
                      }}>Apply selection: {Object.keys(armMatrix).length} instrument{Object.keys(armMatrix).length === 1 ? '' : 's'}</Button>
                      <span className="text-[9px] text-[var(--color-text-sub)]">
                        will arm {matrixSummary || 'nothing'} — currently armed: {armedMatrix ? Object.entries(armedMatrix).map(([s2, t2]) => `${s2} (${t2.join(', ')})`).join(' · ') : `${[...timeframes].sort(byTfDesc).join(' + ')} (all watchlist symbols)`}
                      </span>
                    </div>
                  )
                })()}
                {armTfs.length > 0 && !config?.autotrade_enabled && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={async () => {
                      const forcedNote = forcedTfs.length
                        ? ` NOTE: ${forcedTfs.join(' + ')} did NOT fully pass — you are overriding the verdict.`
                        : ''
                      if (!window.confirm(`Arm the bot on ${armTfs.join(' + ')}?${forcedNote} This turns ON Scan, Analyze and Autotrade in one go — the bot will place REAL orders on the linked account whenever a fib signal on these timeframes passes the risk gate. Turn it off any time with the Autotrade toggle on Pipeline or Kill-all on Trade.`)) return
                      try {
                        // One tap arms the WHOLE pipeline — an armed-but-blind
                        // bot (autotrade on, scan off) was a real support case.
                        await agentPost('/actions/autotrade-timeframes', { timeframes: armTfs, matrix: armMatrix })
                        const benchmarks = {}
                        for (const [sym2, tfs2] of Object.entries(armMatrix)) {
                          for (const tf2 of tfs2) {
                            const r2 = bt?.symbols?.[sym2]?.results?.[tf2]
                            if (r2 && !r2.error) benchmarks[`${sym2}|${tf2}`] = { profitFactor: r2.profitFactor ?? null, expectancyPct: r2.expectancyPct ?? null, trades: r2.trades ?? 0 }
                          }
                        }
                        agentPost('/actions/arm-benchmarks', { benchmarks }).catch(() => {})
                        if (!config?.scan_enabled) await agentPost('/actions/scan-toggle', { on: true })
                        if (!config?.analyze_enabled) await agentPost('/actions/analyze-toggle', { on: true })
                        await agentPost('/actions/autotrade-toggle', { on: true })
                        setTimeframes(armTfs)
                        await load()
                        flash(`Bot fully ARMED on ${armTfs.join(' + ')} — Scan + Analyze + Autotrade all ON. Telegram will ping on every trade.`)
                      } catch (err) { setError(err.message) }
                    }}>Arm the bot: {matrixSummary || armTfs.join(' + ')} (everything in one tap)</Button>
                    <span className="text-[9px] text-[var(--color-text-sub)]">
                      {forcedTfs.length
                        ? `turns on Scan + Analyze + Autotrade — GO timeframes + your overrides (${forcedTfs.join(', ')})`
                        : 'turns on Scan + Analyze + Autotrade and arms the GO timeframes'}
                    </span>
                  </div>
                )}
                {/* Touch-fill runs proved the resting-limit entry — offer to arm
                    LIVE pending orders for the fully-GO combos only. */}
                {bt?.entryMode === 'touch' && pendingGoCount > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        if (!window.confirm(`Arm PENDING orders (resting limit orders at the fib 61.8% level) for: ${pendingGoSummary}? The bot will park REAL limit orders at the broker for these combos only.`)) return
                        try {
                          await agentPost('/actions/pending-mode', { on: true, matrix: pendingGoMatrix })
                          await load()
                          flash(`Pending orders ARMED: ${pendingGoSummary}`)
                        } catch (err) { setError(err.message) }
                      }}
                    >Arm pending orders ({pendingGoCount} GO combo{pendingGoCount === 1 ? '' : 's'})</Button>
                    <span className="text-[9px] text-[var(--color-text-sub)]">
                      full-GO rows only — resting limits will appear as Pending orders in cTrader
                    </span>
                  </div>
                )}
              </div>
            )}
            {btError && <div className="mt-2 text-[9px] text-[var(--color-warning-text)]">{btError}</div>}
          </div>
        )}

        {tab === 'presets' && (
          <div>
            <h2 className="t-h3 mb-2">Presets</h2>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="subtle" onClick={() => {
                const preset = {
                  version: 1,
                  riskConfig: risk?.effective || {},
                  autotradeTimeframes: timeframes,
                  rsiFilter,
                  vwapFilter,
                  fvgFilter,
                  symbols,
                }
                const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = 'bot-trade-preset.json'
                a.click()
                URL.revokeObjectURL(a.href)
              }}>Export settings</Button>
              <label className="inline-flex">
                <span className="sr-only">Import settings</span>
                <input type="file" accept="application/json" className="hidden" id="preset-import" onChange={async (e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  try {
                    const preset = JSON.parse(await file.text())
                    if (preset.riskConfig) await agentPost('/actions/risk-config', preset.riskConfig)
                    if (Array.isArray(preset.autotradeTimeframes) && preset.autotradeTimeframes.length > 0) await agentPost('/actions/autotrade-timeframes', { timeframes: preset.autotradeTimeframes })
                    if (typeof preset.rsiFilter === 'boolean') await agentPost('/actions/fib-rsi-filter', { on: preset.rsiFilter })
                    if (typeof preset.vwapFilter === 'boolean') await agentPost('/actions/fib-vwap-filter', { on: preset.vwapFilter })
                    if (typeof preset.fvgFilter === 'boolean') await agentPost('/actions/fib-fvg-filter', { on: preset.fvgFilter })
                    if (Array.isArray(preset.symbols) && preset.symbols.length > 0) await agentPost('/actions/symbols', { symbols: preset.symbols })
                    await load()
                    flash('Preset imported')
                  } catch (err) { setError(`Preset import failed: ${err.message}`) }
                }} />
                <Button size="sm" variant="subtle" onClick={() => document.getElementById('preset-import').click()}>Import settings</Button>
              </label>
            </div>
            <p className="mt-2 text-[9px] text-[var(--color-text-sub)]">
              Everything on this page (risk limits, timeframes, RSI filter, watchlist) as one shareable JSON file. Autotrade arming is deliberately NOT included.
            </p>
          </div>
        )}
      </FolioTabs>
    </div>
  )
}
