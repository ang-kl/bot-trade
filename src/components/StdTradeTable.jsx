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
import { isLong, sideLabel } from '../lib/side.js'
import SymbolTarget from '../cockpit/SymbolTarget.jsx'

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
    case 'price': return r.current ?? r.exit ?? null
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

  if (rows.length === 0) return <div className="text-[9px] text-[var(--color-text-sub)]">None yet.</div>

  const num = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: priceDp(v) }))
  const money2 = (v) => (v == null ? '—' : `${Number(v) >= 0 ? '' : '−'}${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
  // SL/TP distance-from-entry as a %, next to the absolute price (owner:
  // smaller font, lighter colour than black/blue/red — long-sighted and
  // red/green colour-blind, so text-sub grey rather than a tone colour).
  const pctOf = (entry, price) => {
    const e = Number(entry)
    const p = Number(price)
    if (!Number.isFinite(e) || e === 0 || !Number.isFinite(p)) return null
    return (Math.abs(e - p) / e * 100).toFixed(2) + '%'
  }
  const PctTag = ({ entry, price }) => {
    const pct = pctOf(entry, price)
    return pct ? <span className="text-[7px] text-[var(--color-text-sub)]"> {pct}</span> : null
  }
  // What the bracket is WORTH, on its own line under the price (owner
  // 2026-07-29: "[SL Loss in $] to existing Stop Loss on second line and
  // [TP Profit in $] to Take Profit on second line"). Coloured by SIGN, not
  // by which bracket it is — a stop trailed past entry is locked-in profit
  // and prints green, because that is what it actually is.
  const MoneyLine = ({ v, label, est, ccy }) => {
    if (v == null || !Number.isFinite(Number(v))) return null
    const n = Number(v)
    // Broker-computed impacts land in the DEPOSIT currency net of swap and
    // commission; the client-side fallback is a USD price-move estimate. The
    // cell says which, so the two are never read as the same number.
    const unit = est ? 'USD' : (ccy || '')
    return (
      <span
        className={`block leading-tight text-[8px] ${n >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}
        title={est
          ? `estimated ${label} if this level is hit, at this size — price move only, excludes swap and commission`
          : `${label} if this level is hit, at this size — broker figure, includes swap and commission`}
      >
        {n >= 0 ? '+' : '−'}{Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        {unit && <span className="ml-0.5 text-[7px] text-[var(--color-text-sub)]">{unit}</span>}
        {est && <span className="ml-0.5 text-[7px] text-[var(--color-text-sub)]">est</span>}
      </span>
    )
  }
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
    { key: 'margin', label: 'Margin Used', fmt: money2, money: true, estKey: 'marginEst' },
    { key: 'bid', label: 'Bid', fmt: num },
    { key: 'ask', label: 'Ask', fmt: num },
    { key: 'commission', label: 'Commission', fmt: money2, money: true },
    { key: 'swap', label: 'Swap', fmt: money2, money: true },
    { key: 'positionId', label: 'Position ID', fmt: (v) => String(v) },
    // DB↔broker cross-check (owner: verify each open position individually
    // after the LLM-monitor broker-close bug) — only present when the caller
    // passed a dbByPid map to brokerPositionRows(); 'OK' or a plain-English
    // drift description.
    {
      key: 'integrity', label: 'Integrity',
      fmt: (v) => <span className={v === 'OK' ? 'text-[var(--color-text-sub)]' : 'text-[var(--color-warning-text)] font-semibold'}>{v}</span>,
    },
  ]
  const activeOpt = OPT_COLS.filter(c => rows.some(r => r[c.key] != null))
  // Updated/Duration ride right after Symbol (owner spec: "move the Updated
  // column [to be] the second column and duration column, do the same for
  // all tables") — Time+Symbol stay the two frozen/sticky columns, these two
  // are the next fixed columns, shown only when some row actually carries them.
  const anyUpdated = rows.some(r => r.updatedAt != null)
  const anyDuration = rows.some(r => r.durationMs != null)
  // The To-TP/SL trio doesn't need a LIVE price specifically — once a trade
  // closes, its recorded EXIT price is the final reference point, so "how
  // close did it come to TP/SL" is still real, computable data (owner
  // pushback: "you can recompute when the live ends"). Every row-builder
  // sets `current` while open and `exit` once closed; this trio only goes
  // blank when NEITHER exists anywhere in the table (e.g. a pending-order
  // table with no fill history at all).
  const anyRef = rows.some(r => r.current != null || r.exit != null)
  // Owner audit (2026-07-24): "ensure there are entry price and current
  // OHLC and current price columns" — Price rides beside Entry, same
  // ref (live while open, exit once closed) the To-TP/SL trio already uses.
  const colCount = (anyRef ? 16 : 12) + activeOpt.length + (anyUpdated ? 1 : 0) + (anyDuration ? 1 : 0)
  // Frozen columns need a SOLID background or scrolled cells show through.
  const stick1 = 'sticky left-0 z-10 bg-[var(--color-bg)]'
  const stick2 = `sticky z-10 bg-[var(--color-bg)]`

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="std-cols min-w-[880px] w-full text-[9px] tabular-nums">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th aria-sort={ariaSort('time')} className={`py-1 pr-2 ${stick1}`} style={{ minWidth: COL1_W }}>{sortBtn('time', 'Time')}</th>
              <th aria-sort={ariaSort('symbol')} className={`py-1 pr-3 ${stick2}`} style={{ left: COL1_W }}>{sortBtn('symbol', 'Symbol')}</th>
              {anyUpdated && <th aria-sort={ariaSort('updatedAt')} className="py-1 pr-3 whitespace-nowrap">{sortBtn('updatedAt', 'Updated')}</th>}
              {anyDuration && <th aria-sort={ariaSort('durationMs')} className="py-1 pr-3 whitespace-nowrap">{sortBtn('durationMs', 'Duration')}</th>}
              <th aria-sort={ariaSort('result')} className="py-1 pr-3">{sortBtn('result', 'Result')}</th>
              <th aria-sort={ariaSort('reason')} className="py-1 pr-3">{sortBtn('reason', 'Reason')}</th>
              <th aria-sort={ariaSort('source')} className="py-1 pr-3">{sortBtn('source', 'Source')}</th>
              <th aria-sort={ariaSort('side')} className="py-1 pr-3">{sortBtn('side', 'Side')}</th>
              <th aria-sort={ariaSort('qty')} className="py-1 pr-3">{sortBtn('qty', 'Qty')}</th>
              <th aria-sort={ariaSort('entry')} className="py-1 pr-3">{sortBtn('entry', 'Entry')}</th>
              {anyRef && <th aria-sort={ariaSort('price')} className="py-1 pr-3 whitespace-nowrap" title="live price while open, exit price once closed">{sortBtn('price', 'Price')}</th>}
              <th aria-sort={ariaSort('sl')} className="py-1 pr-3">{sortBtn('sl', 'Stop Loss')}</th>
              <th aria-sort={ariaSort('tp')} className="py-1 pr-3">{sortBtn('tp', 'Take Profit')}</th>
              <th aria-sort={ariaSort('pnl')} className="py-1 pr-3">{sortBtn('pnl', 'P&L')}</th>
              {anyRef && <th className="py-1 pr-3">To TP/SL</th>}
              {/* Absolute price distances (owner: entry $1, now $1.20, TP $2,
                  SL $0.80 → "to TP" 0.80 and "to SL" (0.40)) — shown whenever
                  a reference price + level exist: the LIVE price while open,
                  or the recorded EXIT price once closed (owner: "you can
                  recompute when the live ends"). */}
              {anyRef && <th className="py-1 pr-3 whitespace-nowrap" title="price distance from the current price (or exit price, once closed) to the take profit">📈 to TP</th>}
              {anyRef && <th className="py-1 pr-3 whitespace-nowrap" title="price distance from the current price (or exit price, once closed) to the stop loss (in parentheses — the amount at risk)">📉 to SL</th>}
              {activeOpt.map(c => <th key={c.key} aria-sort={ariaSort(c.key)} className="py-1 pr-3 whitespace-nowrap">{sortBtn(c.key, c.label)}</th>)}
              <th className="py-1" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {slice.map(r => {
              const w = r.at ? dateTimeParts(r.at) : null
              // Shared side vocabulary — `=== 'BUY'` printed every DB row
              // ('long'/'short') as "Short", including outright longs.
              const long = isLong(r.side)
              const mh = marketHours?.[String(r.symbol || '').toUpperCase()]
              // Progress read: in profit → remaining distance to each TP
              // ladder level (nearest, 2nd, 3rd); in loss → distance left
              // before the stop. Needs a reference price on the row — the
              // LIVE price while open, or the recorded EXIT price once
              // closed (a closed trade's exit IS its final reference point,
              // so this stays real, computable data instead of going blank).
              const dir = long ? 1 : -1
              const ref = r.current ?? r.exit
              const hasRef = ref != null && r.entry != null && r.side
              const inProfit = !hasRef ? null : r.pnl != null ? r.pnl >= 0 : (ref - r.entry) * dir >= 0
              const tpDists = hasRef && inProfit
                ? (r.tps?.length ? r.tps : (r.tp != null ? [{ n: 1, price: r.tp }] : []))
                    .slice(0, 3)
                    .map(t => ({ n: t.n, d: (Number(t.price) - ref) * dir }))
                    .filter(x => Number.isFinite(x.d))
                : []
              const slDist = hasRef && inProfit === false && r.sl != null ? (ref - r.sl) * dir : null
              return (
                <Fragment key={r.id}>
                  <tr className="border-b border-[var(--color-border)] align-middle">
                    <td className={`py-1 pr-2 whitespace-nowrap ${stick1}`} style={{ minWidth: COL1_W }}>
                      {w
                        ? <>
                            <span className="block leading-tight">{w.day}</span>
                            <span className="block leading-tight text-[var(--color-text-sub)]">{w.time}</span>
                          </>
                        : '—'}
                    </td>
                    <td className={`py-1 pr-3 whitespace-nowrap ${stick2}`} style={{ left: COL1_W }}>
                      {mh && mh.open === false && (
                        <span className="block text-[9px] leading-none" title="market closed" aria-label="market closed">🔒</span>
                      )}
                      {onSymbolClick
                        ? <button type="button" className="font-bold cursor-pointer underline-offset-2 hover:underline" onClick={() => onSymbolClick(r.symbol)}>{r.symbol}</button>
                        : (
                          // symbol-click-spec §1: every symbol is a cockpit
                          // target by default; explicit onSymbolClick callers
                          // (Desk) keep their existing behaviour.
                          <SymbolTarget symbol={r.symbol} positionId={r.id} source="std-trade-table"
                            // Durable identity + broker facts (owner 2026-08-01,
                            // fake-journal fix): without these the cockpit opened
                            // snapshotless and wore the demo panels.
                            accountId={r.accountId ?? null} dbPositionId={r.dbPositionId ?? null}
                            position={{
                              sym: r.symbol, side: isLong(r.side) ? 'LONG' : 'SHORT',
                              lots: r.qty ?? null, strategy: r.strategy ?? null,
                              entry: r.entry ?? null, sl: r.sl ?? null, tp: r.tp ?? null,
                              price: r.current ?? null, pnl: r.pnl ?? null,
                            }}>
                            <span className="font-bold">{r.symbol}</span>
                          </SymbolTarget>
                        )}
                      {mh && mh.open === false && mh.next_open_at && (
                        <span className="block text-[9px] leading-tight font-normal text-[var(--color-text-sub)]" title="next market open (your timezone)">
                          {nextOpenLabel(mh.next_open_at)}
                        </span>
                      )}
                    </td>
                    {anyUpdated && <td className="py-1 pr-3 whitespace-nowrap">{r.updatedAt != null ? timeCell(r.updatedAt) : '—'}</td>}
                    {anyDuration && <td className="py-1 pr-3 whitespace-nowrap">{r.durationMs != null ? fmtDuration(r.durationMs) : '—'}</td>}
                    <td className="py-1 pr-3"><Badge tone={r.result.tone}>{r.result.text}</Badge></td>
                    {/* Reason rides right after the result (owner: the WHY
                        belongs beside the verdict, not at the far end). */}
                    <td className="py-1 pr-3 max-w-[280px] truncate text-[var(--color-text-sub)]" title={r.reasonTitle ?? r.reason ?? ''}>
                      {r.reason || '—'}
                    </td>
                    <td className="py-1 pr-3"><Badge tone={r.source.tone}>{r.source.text}</Badge></td>
                    <td className={`py-1 pr-3 ${long === null ? 'text-[var(--color-text-sub)]' : long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                      {/* An unrecognised side prints '—', not "Short". */}
                      {sideLabel(r.side) ?? '—'}
                    </td>
                    <td className="py-1 pr-3 text-right whitespace-nowrap">{r.qtyText ?? num(r.qty)}</td>
                    <td className="py-1 pr-3 text-right whitespace-nowrap">{num(r.entry)}{ccyTag(r.ccy)}</td>
                    {anyRef && (
                      <td className="py-1 pr-3 text-right whitespace-nowrap">
                        {ref != null ? <>{num(ref)}{ccyTag(r.ccy)}</> : '—'}
                      </td>
                    )}
                    <td className="py-1 pr-3 text-right whitespace-nowrap">
                      {num(r.sl)}{ccyTag(r.ccy)}
                      {r.sl != null && <PctTag entry={r.entry} price={r.sl} />}
                      <MoneyLine v={r.slMoney} label="loss" est={r.moneyEst} ccy={r.moneyCcy} />
                      {r.slAt && (() => {
                        const s = dateTimeParts(r.slAt)
                        return s ? <span className="block text-[9px] leading-tight text-[var(--color-text-sub)]" title="stop loss last set">{s.day} {s.time}</span> : null
                      })()}
                    </td>
                    {/* Take Profit — cTrader supports laddered TPs, so the
                        cell holds the whole ladder: numero · price · lot. */}
                    <td className="py-1 pr-3 text-right whitespace-nowrap">
                      {r.tps?.length
                        ? r.tps.map(t => (
                            <span key={t.n} className="block leading-tight">
                              <span className="text-[var(--color-text-sub)]">#{t.n}</span>
                              {' '}{num(t.price)}
                              {t.price != null && <PctTag entry={r.entry} price={t.price} />}
                              {t.lots != null && <span className="text-[var(--color-text-sub)]"> · {num(t.lots)}</span>}
                              {t.done && <span title="partial already taken"> ✓</span>}
                            </span>
                          ))
                        : <>{num(r.tp)}{ccyTag(r.ccy)}{r.tp != null && <PctTag entry={r.entry} price={r.tp} />}</>}
                      <MoneyLine v={r.tpMoney} label="profit" est={r.moneyEst} ccy={r.moneyCcy} />
                      {r.tpAt && (() => {
                        const s = dateTimeParts(r.tpAt)
                        return s ? <span className="block text-[9px] leading-tight text-[var(--color-text-sub)]" title="take profit last set">{s.day} {s.time}</span> : null
                      })()}
                    </td>
                    <td className={`py-1 pr-3 text-right whitespace-nowrap ${r.pnl == null ? 'text-[var(--color-text-sub)]' : r.pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                      {r.pnl != null ? <>{`${r.pnl >= 0 ? '+' : '−'}${Math.abs(Number(r.pnl)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}{ccyTag(r.moneyCcy)}</> : '—'}
                    </td>
                    {anyRef && (
                      <td className="py-1 pr-3 text-right whitespace-nowrap">
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
                    )}
                    {/* 📈 to TP / 📉 to SL — absolute distances from the
                        reference price (current while open, exit once closed) */}
                    {anyRef && (
                      <td className="py-1 pr-3 text-right whitespace-nowrap">
                        {hasRef && r.tp != null ? num(Math.abs(Number(r.tp) - ref)) : '—'}
                      </td>
                    )}
                    {anyRef && (
                      <td className="py-1 pr-3 text-right whitespace-nowrap">
                        {hasRef && r.sl != null ? `(${num(Math.abs(ref - Number(r.sl)))})` : '—'}
                      </td>
                    )}
                    {activeOpt.map(c => (
                      <td key={c.key} className="py-1 pr-3 text-right whitespace-nowrap">
                        {r[c.key] != null
                          ? <>
                              {c.fmt(r[c.key])}
                              {c.money ? ccyTag(r.moneyCcy) : null}
                              {/* An estimate must never look like broker truth. */}
                              {c.estKey && r[c.estKey] ? <span className="text-[7px] text-[var(--color-text-sub)]" title="estimated from notional ÷ leverage at entry — the broker stops reporting margin once a position closes"> est</span> : null}
                            </>
                          : '—'}
                      </td>
                    ))}
                    <td className="py-1 whitespace-nowrap">
                      {r.chart && (
                        <Button size="sm" variant="ghost" aria-expanded={chartFor === r.id}
                          onClick={() => setChartFor(chartFor === r.id ? null : r.id)}>
                          {chartFor === r.id ? 'Hide' : 'Chart'}
                        </Button>
                      )}
                      {panel && r.panel && (
                        <Button size="sm" variant="ghost" aria-haspopup="dialog"
                          onClick={() => setPanelFor(r.id)}>
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
          {(rows.some(r => r.pnl != null) || rows.some(r => r.margin != null) || rows.some(r => r.slMoney != null || r.tpMoney != null)) && (() => {
            const pnlSum = rows.reduce((a, r) => a + (Number(r.pnl) || 0), 0)
            const marginSum = rows.reduce((a, r) => a + (Number(r.margin) || 0), 0)
            const hasMargin = rows.some(r => r.margin != null)
            // Total money at risk and total money on the table across EVERY
            // row (owner: sub-totals wherever Margin Used / TP / SL appear) —
            // the two numbers that say what this whole book is playing for.
            const slSum = rows.reduce((a, r) => a + (Number(r.slMoney) || 0), 0)
            const tpSum = rows.reduce((a, r) => a + (Number(r.tpMoney) || 0), 0)
            const hasSl = rows.some(r => r.slMoney != null)
            const hasTp = rows.some(r => r.tpMoney != null)
            const sumCell = (v) => (
              <span className={v >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>
                {`${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </span>
            )
            return (
              <tfoot>
                <tr className="border-t-2 border-[var(--color-border)] font-semibold">
                  <td colSpan={8 + (anyRef ? 1 : 0) + (anyUpdated ? 1 : 0) + (anyDuration ? 1 : 0)} className="py-1 pr-3 text-right text-[var(--color-text-sub)]">
                    Sub-total ({rows.length} rows)
                  </td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap text-[8px]">{hasSl ? sumCell(slSum) : ''}</td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap text-[8px]">{hasTp ? sumCell(tpSum) : ''}</td>
                  <td className={`py-1 pr-3 text-right whitespace-nowrap ${pnlSum >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                    {`${pnlSum >= 0 ? '+' : '−'}${Math.abs(pnlSum).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </td>
                  {anyRef && <td className="py-1 pr-3" />}
                  {anyRef && <td className="py-1 pr-3" />}
                  {anyRef && <td className="py-1 pr-3" />}
                  {activeOpt.map(c => (
                    <td key={c.key} className="py-1 pr-3 text-right whitespace-nowrap">
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
      <div className="mt-2 flex items-center gap-2 text-[9px] text-[var(--color-text-sub)]">
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

