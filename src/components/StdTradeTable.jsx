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
import { dateTimeParts, nextOpenLabel, priceDp } from '../lib/std-trade-rows.js'

const PAGE = 8
const COL1_W = 76 // px — frozen date/time column; col 2 offset builds on it

export default function StdTradeTable({ rows, countLabel = 'rows', onSymbolClick = null, panel = null, marketHours = null }) {
  const [page, setPage] = useState(0)
  const [chartFor, setChartFor] = useState(null)
  const [panelFor, setPanelFor] = useState(null)

  // The Manage sheet is a pop-up over the page, not an inline row — if the
  // row vanishes on a refresh (closed/cancelled) the modal closes itself.
  const panelRow = panelFor == null ? null : rows.find(r => r.id === panelFor) ?? null

  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const p = Math.min(page, pages - 1)
  const slice = rows.slice(p * PAGE, p * PAGE + PAGE)

  if (rows.length === 0) return <div className="text-[13px] text-[var(--color-text-sub)]">None yet.</div>

  const num = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: priceDp(v) }))
  const money2 = (v) => (v == null ? '—' : `${Number(v) >= 0 ? '' : '−'}${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
  const timeCell = (v) => { const w2 = dateTimeParts(v); return w2 ? `${w2.day} ${w2.time}` : '—' }
  // cTrader's compulsory position columns (owner spec) appear only when the
  // rows actually carry them — closed deals and order-log rows stay lean.
  const OPT_COLS = [
    { key: 'updatedAt', label: 'Updated', fmt: timeCell },
    { key: 'margin', label: 'Margin', fmt: money2 },
    { key: 'bid', label: 'Bid', fmt: num },
    { key: 'ask', label: 'Ask', fmt: num },
    { key: 'commission', label: 'Commission', fmt: money2 },
    { key: 'swap', label: 'Swap', fmt: money2 },
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
        <table className="min-w-[880px] w-full text-[12px] tabular-nums">
          <thead className="text-left text-[var(--color-text-sub)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className={`py-1.5 pr-2 font-semibold ${stick1}`} style={{ minWidth: COL1_W }}>Time</th>
              <th className={`py-1.5 pr-3 font-semibold ${stick2}`} style={{ left: COL1_W }}>Symbol</th>
              <th className="py-1.5 pr-3 font-semibold">Result</th>
              <th className="py-1.5 pr-3 font-semibold">Reason</th>
              <th className="py-1.5 pr-3 font-semibold">Source</th>
              <th className="py-1.5 pr-3 font-semibold">Side</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Qty</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Entry</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Stop Loss</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Take Profit</th>
              <th className="py-1.5 pr-3 font-semibold text-right">P&amp;L</th>
              <th className="py-1.5 pr-3 font-semibold text-right">To TP/SL</th>
              {activeOpt.map(c => <th key={c.key} className="py-1.5 pr-3 font-semibold text-right whitespace-nowrap">{c.label}</th>)}
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
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(r.entry)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                      {num(r.sl)}
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
                        : num(r.tp)}
                      {r.tpAt && (() => {
                        const s = dateTimeParts(r.tpAt)
                        return s ? <span className="block text-[10px] leading-tight text-[var(--color-text-sub)]" title="take profit last set">{s.day} {s.time}</span> : null
                      })()}
                    </td>
                    <td className={`py-1.5 pr-3 text-right whitespace-nowrap font-semibold ${r.pnl == null ? 'text-[var(--color-text-sub)]' : r.pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                      {r.pnl != null ? `${r.pnl >= 0 ? '+' : '−'}${Math.abs(Number(r.pnl)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
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
                        {r[c.key] != null ? c.fmt(r[c.key]) : '—'}
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
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setPanelFor(null)}
        >
          <div className="w-full max-w-xl my-auto" onClick={e => e.stopPropagation()}>
            {panel.render(panelRow, () => setPanelFor(null))}
          </div>
        </div>
      )}
    </div>
  )
}

