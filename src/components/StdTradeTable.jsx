// THE standard trade table (owner: the Order log's table and columns are the
// standard for every trade/pending-trade list — Trade, Desk, and Accounts).
// Columns: Time | Symbol | Result | Reason | Source | Side | Qty | Entry |
// Stop Loss | Take Profit | P&L | To TP/SL | Actions — the Reason (the WHY)
// sits right beside the Result verdict (owner spec).
// TradingView-style: fixed header, right-aligned tabular numerics,
// Long/Short coloured, sideways scroll with the first two columns
// (date/time, symbol) FROZEN, 8-row pagination, expandable chart row.
// The Manage panel opens as a POP-UP modal (cTrader-style sheet), not an
// inline row — owner: "pop-up window and not within the table like the chart".
//
// Callers map their rows to the shared shape:
// { id, at, symbol, result:{text,tone}, source:{text,tone}, side ('BUY'|
//   'SELL'|null), qty | qtyText, entry, sl, slAt?, tp, tps?, tpAt?, reason,
//   reasonTitle?, chart?, panel? (bool — arms the Manage pop-up), raw? }
// slAt/tpAt render as a small last-set time under the SL / TP cells.
//
// Optional props: onSymbolClick(symbol) makes the frozen symbol cell a
// button (Desk uses it to focus the chart wall); panel {label, render(row,
// close)} opens the pop-up (Manage → PositionManager / OrderManager).
import { Fragment, useState } from 'react'
import Badge from './common/Badge.jsx'
import Button from './common/Button.jsx'
import PositionChart from './PositionChart.jsx'
import { dateTimeParts, nextOpenLabel, priceDp, toMs } from '../lib/std-trade-rows.js'
import { stratShort } from '../lib/strategy-labels.js'

// Sort accessors per column key. null/undefined always sorts LAST in either
// direction so empty cells never float above real data.
function sortVal(r, k) {
  switch (k) {
    case 'time': return toMs(r.at)
    case 'symbol': return r.symbol || null
    case 'result': return r.result?.text || null
    case 'reason': return r.reason || null
    case 'source': return r.source?.text || null
    case 'side': return r.side || null
    case 'qty': return r.qty ?? (r.qtyText ? parseFloat(String(r.qtyText).replace(/[^0-9.]/g, '')) : null)
    case 'tp': return r.tp ?? r.tps?.[0]?.price ?? null
    case 'updatedAt': return toMs(r.updatedAt)
    default: return r[k] ?? null
  }
}

const PAGE = 8
const COL1_W = 76 // px — frozen date/time column; col 2 offset builds on it

export default function StdTradeTable({ rows, countLabel = 'rows', onSymbolClick = null, panel = null, marketHours = null, extraAction = null }) {
  const [page, setPage] = useState(0)
  const [chartFor, setChartFor] = useState(null)
  const [panelFor, setPanelFor] = useState(null)
  // Every column sorts on tap; default = newest change on top (owner spec).
  const [sort, setSort] = useState({ key: 'time', dir: 'desc' })
  const sorted = [...rows].sort((a, b) => {
    const va = sortVal(a, sort.key)
    const vb = sortVal(b, sort.key)
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    const c = typeof va === 'string' || typeof vb === 'string'
      ? String(va).localeCompare(String(vb))
      : va - vb
    return sort.dir === 'desc' ? -c : c
  })
  const pickSort = (k) => setSort(s => ({ key: k, dir: s.key === k && s.dir === 'desc' ? 'asc' : 'desc' }))
  // aria-sort was only ever wired to the Time header (audit finding) — every
  // sortable column needs it, not just the default-sorted one.
  const ariaSort = (k) => (sort.key === k ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none')
  // Plain JSX helper (not a component — react-refresh rules) for header sort buttons.
  const sortBtn = (k, label) => (
    <button type="button" className="cursor-pointer hover:underline font-semibold whitespace-nowrap" onClick={() => pickSort(k)}>
      {label}{sort.key === k ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )

  // The Manage sheet is a pop-up over the page, not an inline row — if the
  // row vanishes on a refresh (closed/cancelled) the modal closes itself.
  const panelRow = panelFor == null ? null : rows.find(r => r.id === panelFor) ?? null

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE))
  const p = Math.min(page, pages - 1)
  const slice = sorted.slice(p * PAGE, p * PAGE + PAGE)

  if (rows.length === 0) return <div className="text-[13px] text-[var(--color-text-sub)]">None yet.</div>

  const num = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: priceDp(v) }))
  const money2 = (v) => (v == null ? '—' : `${Number(v) >= 0 ? '' : '−'}${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
  const timeCell = (v) => { const w2 = dateTimeParts(v); return w2 ? `${w2.day} ${w2.time}` : '—' }
  // How long a position/order has been open (or was held before closing) —
  // owner: "all table should also have the duration ... so you can also
  // manage that or human can close". m → h → d, coarser as it grows.
  const fmtDuration = (ms) => {
    const mins = Math.round(ms / 60_000)
    if (mins < 60) return `${mins}m`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return mins % 60 ? `${hrs}h ${mins % 60}m` : `${hrs}h`
    const days = Math.floor(hrs / 24)
    return hrs % 24 ? `${days}d ${hrs % 24}h` : `${days}d`
  }
  // Trading currency beside the essential figures (owner spec): prices
  // carry the symbol's QUOTE ccy, money figures the DEPOSIT ccy.
  const ccyTag = (c) => (c ? <span className="ml-0.5 text-[9px] text-[var(--color-text-sub)]">{c}</span> : null)
  // cTrader's compulsory position columns (owner spec) appear only when the
  // rows actually carry them — closed deals and order-log rows stay lean.
  const OPT_COLS = [
    // Segment open/pending trades by their setup (owner spec). Shown only
    // when rows carry a parsed label — closed deals / attempts stay lean.
    { key: 'timeframe', label: 'TF', fmt: (v) => v || '—' },
    { key: 'strategy', label: 'Strategy', fmt: (v) => stratShort(v) || '—' },
    { key: 'updatedAt', label: 'Updated', fmt: timeCell },
    { key: 'durationMs', label: 'Duration', fmt: fmtDuration },
    { key: 'margin', label: 'Margin Used', fmt: money2, money: true },
    { key: 'bid', label: 'Bid', fmt: num },
    { key: 'ask', label: 'Ask', fmt: num },
    { key: 'commission', label: 'Commission', fmt: money2, money: true },
    { key: 'swap', label: 'Swap', fmt: money2, money: true },
    { key: 'positionId', label: 'Position ID', fmt: (v) => String(v) },
  ]
  const activeOpt = OPT_COLS.filter(c => rows.some(r => r[c.key] != null))
  const colCount = 13 + activeOpt.length
  // Frozen columns need a SOLID background or scrolled cells show through.
  const stick1 = 'sticky left-0 z-10 bg-[var(--color-bg)]'
  const stick2 = `sticky z-10 bg-[var(--color-bg)]`

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="std-cols min-w-[880px] w-full text-[12px] tabular-nums">
          <thead className="text-center text-[var(--color-text-sub)]">
            <tr className="border-b border-[var(--color-border)]">
              <th aria-sort={ariaSort('time')} className={`py-1.5 pr-2 font-semibold ${stick1}`} style={{ minWidth: COL1_W }}>{sortBtn('time', 'Time')}</th>
              <th aria-sort={ariaSort('symbol')} className={`py-1.5 pr-3 font-semibold ${stick2}`} style={{ left: COL1_W }}>{sortBtn('symbol', 'Symbol')}</th>
              <th aria-sort={ariaSort('result')} className="py-1.5 pr-3 font-semibold">{sortBtn('result', 'Result')}</th>
              <th aria-sort={ariaSort('reason')} className="py-1.5 pr-3 font-semibold">{sortBtn('reason', 'Reason')}</th>
              <th aria-sort={ariaSort('source')} className="py-1.5 pr-3 font-semibold">{sortBtn('source', 'Source')}</th>
              <th aria-sort={ariaSort('side')} className="py-1.5 pr-3 font-semibold">{sortBtn('side', 'Side')}</th>
              <th aria-sort={ariaSort('qty')} className="py-1.5 pr-3 font-semibold">{sortBtn('qty', 'Qty')}</th>
              <th aria-sort={ariaSort('entry')} className="py-1.5 pr-3 font-semibold">{sortBtn('entry', 'Entry')}</th>
              <th aria-sort={ariaSort('sl')} className="py-1.5 pr-3 font-semibold">{sortBtn('sl', 'Stop Loss')}</th>
              <th aria-sort={ariaSort('tp')} className="py-1.5 pr-3 font-semibold">{sortBtn('tp', 'Take Profit')}</th>
              <th aria-sort={ariaSort('pnl')} className="py-1.5 pr-3 font-semibold">{sortBtn('pnl', 'P&L')}</th>
              <th className="py-1.5 pr-3 font-semibold">To TP/SL</th>
              {activeOpt.map(c => <th key={c.key} aria-sort={ariaSort(c.key)} className="py-1.5 pr-3 font-semibold whitespace-nowrap">{sortBtn(c.key, c.label)}</th>)}
              <th className="py-1.5 font-semibold" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {slice.map(r => {
              const w = r.at ? dateTimeParts(r.at) : null
              const long = r.side === 'BUY'
              const mh = marketHours?.[String(r.symbol || '').toUpperCase()]
              // Progress read: in profit → remaining distance to each TP
              // ladder level (nearest, 2nd, 3rd); in loss → distance left
              // before the stop. Needs a live price on the row.
              const dir = long ? 1 : -1
              const hasLive = r.current != null && r.entry != null && r.side
              const inProfit = !hasLive ? null : r.pnl != null ? r.pnl >= 0 : (r.current - r.entry) * dir >= 0
              const tpDists = hasLive && inProfit
                ? (r.tps?.length ? r.tps : (r.tp != null ? [{ n: 1, price: r.tp }] : []))
                    .slice(0, 3)
                    .map(t => ({ n: t.n, d: (Number(t.price) - r.current) * dir }))
                    .filter(x => Number.isFinite(x.d))
                : []
              const slDist = hasLive && inProfit === false && r.sl != null ? (r.current - r.sl) * dir : null
              return (
                <Fragment key={r.id}>
                  <tr className="border-b border-[var(--color-border)] align-middle">
                    <td className={`py-1.5 pr-2 whitespace-nowrap ${stick1}`} style={{ minWidth: COL1_W }}>
                      {w
                        ? <>
                            <span className="block leading-tight">{w.day}</span>
                            <span className="block leading-tight text-[var(--color-text-sub)]">{w.time}</span>
                          </>
                        : '—'}
                    </td>
                    <td className={`py-1.5 pr-3 font-bold whitespace-nowrap ${stick2}`} style={{ left: COL1_W }}>
                      {mh && mh.open === false && (
                        <span className="block text-[9px] leading-none" title="market closed" aria-label="market closed">🔒</span>
                      )}
                      {onSymbolClick
                        ? <button type="button" className="font-bold cursor-pointer underline-offset-2 hover:underline" onClick={() => onSymbolClick(r.symbol)}>{r.symbol}</button>
                        : r.symbol}
                      {mh && mh.open === false && mh.next_open_at && (
                        <span className="block text-[10px] leading-tight font-normal text-[var(--color-text-sub)]" title="next market open (your timezone)">
                          {nextOpenLabel(mh.next_open_at)}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3"><Badge tone={r.result.tone}>{r.result.text}</Badge></td>
                    {/* Reason rides right after the result (owner: the WHY
                        belongs beside the verdict, not at the far end). */}
                    <td className="py-1.5 pr-3 max-w-[280px] truncate text-[var(--color-text-sub)]" title={r.reasonTitle ?? r.reason ?? ''}>
                      {r.reason || '—'}
                    </td>
                    <td className="py-1.5 pr-3"><Badge tone={r.source.tone}>{r.source.text}</Badge></td>
                    <td className={`py-1.5 pr-3 font-semibold ${long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                      {r.side ? (long ? 'Long' : 'Short') : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{r.qtyText ?? num(r.qty)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(r.entry)}{ccyTag(r.ccy)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                      {num(r.sl)}{ccyTag(r.ccy)}
                      {r.slAt && (() => {
                        const s = dateTimeParts(r.slAt)
                        return s ? <span className="block text-[10px] leading-tight text-[var(--color-text-sub)]" title="stop loss last set">{s.day} {s.time}</span> : null
                      })()}
                    </td>
                    {/* Take Profit — cTrader supports laddered TPs, so the
                        cell holds the whole ladder: numero · price · lot. */}
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                      {r.tps?.length
                        ? r.tps.map(t => (
                            <span key={t.n} className="block leading-tight">
                              <span className="text-[var(--color-text-sub)]">#{t.n}</span>
                              {' '}{num(t.price)}
                              {t.lots != null && <span className="text-[var(--color-text-sub)]"> · {num(t.lots)}</span>}
                              {t.done && <span title="partial already taken"> ✓</span>}
                            </span>
                          ))
                        : <>{num(r.tp)}{ccyTag(r.ccy)}</>}
                      {r.tpAt && (() => {
                        const s = dateTimeParts(r.tpAt)
                        return s ? <span className="block text-[10px] leading-tight text-[var(--color-text-sub)]" title="take profit last set">{s.day} {s.time}</span> : null
                      })()}
                    </td>
                    <td className={`py-1.5 pr-3 text-right whitespace-nowrap font-semibold ${r.pnl == null ? 'text-[var(--color-text-sub)]' : r.pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                      {r.pnl != null ? <>{`${r.pnl >= 0 ? '+' : '−'}${Math.abs(Number(r.pnl)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}{ccyTag(r.moneyCcy)}</> : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                      {tpDists.length > 0
                        ? tpDists.map(x => (
                            <span key={x.n} className="block leading-tight">
                              <span className="text-[var(--color-text-sub)]">#{x.n}</span> {num(Math.abs(x.d))}{x.d < 0 ? ' ✓' : ''}
                            </span>
                          ))
                        : slDist != null
                          ? <span className="text-[var(--color-down)]">SL {num(Math.max(0, slDist))}</span>
                          : '—'}
                    </td>
                    {activeOpt.map(c => (
                      <td key={c.key} className="py-1.5 pr-3 text-right whitespace-nowrap">
                        {r[c.key] != null ? <>{c.fmt(r[c.key])}{c.money ? ccyTag(r.moneyCcy) : null}</> : '—'}
                      </td>
                    ))}
                    <td className="py-1.5 whitespace-nowrap">
                      {r.chart && (
                        <Button size="sm" variant="ghost" onClick={() => setChartFor(chartFor === r.id ? null : r.id)}>
                          {chartFor === r.id ? 'Hide' : 'Chart'}
                        </Button>
                      )}
                      {panel && r.panel && (
                        <Button size="sm" variant="ghost" onClick={() => setPanelFor(r.id)}>
                          {panel.label}
                        </Button>
                      )}
                      {extraAction && extraAction(r)}
                    </td>
                  </tr>
                  {chartFor === r.id && r.chart && (
                    <tr className="border-b border-[var(--color-border)]">
                      <td colSpan={colCount} className="py-2">
                        <PositionChart
                          symbol={r.chart.symbol}
                          timeframe={r.chart.timeframe || '1h'}
                          lines={r.chart.lines}
                          at={r.chart.at}
                          markers={r.chart.markers}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          {/* Sub-totals over the WHOLE table (not just this page) — owner:
              "each of the table where there are Margin Used and TP and SL
              headers should have a sub-total". P&L and Margin sum; the rest
              aren't meaningfully summable. */}
          {(rows.some(r => r.pnl != null) || rows.some(r => r.margin != null)) && (() => {
            const pnlSum = rows.reduce((a, r) => a + (Number(r.pnl) || 0), 0)
            const marginSum = rows.reduce((a, r) => a + (Number(r.margin) || 0), 0)
            const hasMargin = rows.some(r => r.margin != null)
            return (
              <tfoot>
                <tr className="border-t-2 border-[var(--color-border)] font-semibold">
                  <td colSpan={10} className="py-1.5 pr-3 text-right text-[var(--color-text-sub)]">
                    Sub-total ({rows.length} rows)
                  </td>
                  <td className={`py-1.5 pr-3 text-right whitespace-nowrap ${pnlSum >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                    {`${pnlSum >= 0 ? '+' : '−'}${Math.abs(pnlSum).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </td>
                  <td className="py-1.5 pr-3" />
                  {activeOpt.map(c => (
                    <td key={c.key} className="py-1.5 pr-3 text-right whitespace-nowrap">
                      {c.key === 'margin' && hasMargin
                        ? marginSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : ''}
                    </td>
                  ))}
                  <td />
                </tr>
              </tfoot>
            )
          })()}
        </table>
      </div>
      {/* Pagination — keeps every panel the same height */}
      <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--color-text-sub)]">
        <Button size="sm" variant="subtle" disabled={p === 0} onClick={() => setPage(p - 1)}>‹ Newer</Button>
        <span>page {p + 1} / {pages} · {rows.length} {countLabel}</span>
        <Button size="sm" variant="subtle" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Older ›</Button>
      </div>
      {/* Manage POP-UP — the cTrader-style sheet floats over the page (owner:
          "pop-up window and not within the table"). Backdrop click closes. */}
      {panel && panelRow && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setPanelFor(null)}
        >
          {/* Bottom-sheet on phones, centred card on desktop. The SHEET itself
              scrolls (max-height + overflow), so a tall panel never pushes its
              own header off the top — the old `items-start + my-auto` centring
              clipped the title on small screens (owner: "iPhone UI are worst"). */}
          <div
            className="w-full max-w-xl max-h-[92dvh] overflow-y-auto overscroll-contain sm:max-h-[85vh]"
            onClick={e => e.stopPropagation()}
          >
            {panel.render(panelRow, () => setPanelFor(null))}
          </div>
        </div>
      )}
    </div>
  )
}

