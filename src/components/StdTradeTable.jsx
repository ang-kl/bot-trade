// THE standard trade table (owner: the Order log's table and columns are the
// standard for every trade/pending-trade list — Trade, Desk, and Accounts).
// TradingView-style: fixed header, right-aligned tabular numerics,
// Long/Short coloured, sideways scroll with the first two columns
// (date/time, symbol) FROZEN, 8-row pagination, expandable chart row.
//
// Callers map their rows to the shared shape:
// { id, at, symbol, result:{text,tone}, source:{text,tone}, side ('BUY'|
//   'SELL'|null), qty | qtyText, entry, sl, tp, tps?, reason, reasonTitle?,
//   chart?, panel? (bool — enables the host page's expandable panel), raw? }
//
// Optional props: onSymbolClick(symbol) makes the frozen symbol cell a
// button (Desk uses it to focus the chart wall); panel {label, render(row)}
// adds a second expandable row (Desk's Manage → PositionManager).
import { Fragment, useState } from 'react'
import Badge from './common/Badge.jsx'
import Button from './common/Button.jsx'
import PositionChart from './PositionChart.jsx'
import { dateTimeParts } from '../lib/std-trade-rows.js'

const PAGE = 8
const COL1_W = 76 // px — frozen date/time column; col 2 offset builds on it

export default function StdTradeTable({ rows, countLabel = 'rows', onSymbolClick = null, panel = null }) {
  const [page, setPage] = useState(0)
  const [chartFor, setChartFor] = useState(null)
  const [panelFor, setPanelFor] = useState(null)

  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const p = Math.min(page, pages - 1)
  const slice = rows.slice(p * PAGE, p * PAGE + PAGE)

  if (rows.length === 0) return <div className="text-[13px] text-[var(--color-text-sub)]">None yet.</div>

  const num = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 5 }))
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
              <th className="py-1.5 pr-3 font-semibold">Source</th>
              <th className="py-1.5 pr-3 font-semibold">Side</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Qty</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Entry</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Stop Loss</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Take Profit</th>
              <th className="py-1.5 pr-3 font-semibold">Reason</th>
              <th className="py-1.5 font-semibold" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {slice.map(r => {
              const w = r.at ? dateTimeParts(r.at) : null
              const long = r.side === 'BUY'
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
                      {onSymbolClick
                        ? <button type="button" className="font-bold cursor-pointer underline-offset-2 hover:underline" onClick={() => onSymbolClick(r.symbol)}>{r.symbol}</button>
                        : r.symbol}
                    </td>
                    <td className="py-1.5 pr-3"><Badge tone={r.result.tone}>{r.result.text}</Badge></td>
                    <td className="py-1.5 pr-3"><Badge tone={r.source.tone}>{r.source.text}</Badge></td>
                    <td className={`py-1.5 pr-3 font-semibold ${long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                      {r.side ? (long ? 'Long' : 'Short') : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{r.qtyText ?? num(r.qty)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(r.entry)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(r.sl)}</td>
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
                    </td>
                    <td className="py-1.5 pr-3 max-w-[280px] truncate text-[var(--color-text-sub)]" title={r.reasonTitle ?? r.reason ?? ''}>
                      {r.reason || '—'}
                    </td>
                    <td className="py-1.5 whitespace-nowrap">
                      {r.chart && (
                        <Button size="sm" variant="ghost" onClick={() => setChartFor(chartFor === r.id ? null : r.id)}>
                          {chartFor === r.id ? 'Hide' : 'Chart'}
                        </Button>
                      )}
                      {panel && r.panel && (
                        <Button size="sm" variant="ghost" onClick={() => setPanelFor(panelFor === r.id ? null : r.id)}>
                          {panelFor === r.id ? 'Hide' : panel.label}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {chartFor === r.id && r.chart && (
                    <tr className="border-b border-[var(--color-border)]">
                      <td colSpan={11} className="py-2">
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
                  {panel && r.panel && panelFor === r.id && (
                    <tr className="border-b border-[var(--color-border)]">
                      <td colSpan={11} className="py-2">
                        {panel.render(r, () => setPanelFor(null))}
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
    </div>
  )
}

