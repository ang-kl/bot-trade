// ---------------------------------------------------------------------------
// OrderLedger — the DURABLE record of broker resting (set) orders.
//
// The broker section's "Pending (set) orders" table shows only what's on the
// book right now and disappears the instant an order fills or is cancelled.
// This ledger reads /state/orders (the broker_orders table) so every set-order
// keeps a lifecycle record — WORKING now, or recently GONE (filled/cancelled)
// in the last 24h — because resting orders fill even while the bot's switches
// are OFF (owner: "keep records of these" + "two controllers ... one to
// monitor the trigger take place").
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { orderStrategy, orderTimeframe, orderStatusLabel, orderTriggerPrice, orderTpSlDistance, orderPendingMs, fmtDuration, isoWeek } from '../lib/order-ledger-rows.js'
import { dateTimeParts } from '../lib/std-trade-rows.js'
import OrderManager from './OrderManager.jsx'
import Button from './common/Button.jsx'

const parseTs = (iso) => Date.parse(String(iso || '').includes('T') ? iso : String(iso || '').replace(' ', 'T') + 'Z')
const enteredCell = (iso) => { const w = iso ? dateTimeParts(iso) : null; return w ? `${w.day} ${w.time}` : '—' }
const COLS = 17 // Entered, Duration, Symbol, Side, Type, Vol, Trigger, SL, TP, To TP/SL, to TP, to SL, TF, Strategy, Source, Status, Action

const num = (v) => {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const dp = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : 5
  return n.toLocaleString(undefined, { maximumFractionDigits: dp })
}

function ago(iso) {
  if (!iso) return ''
  const t = Date.parse(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z')
  if (!Number.isFinite(t)) return ''
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

function Row({ o, gone, action = null }) {
  const long = String(o.side).toUpperCase() === 'BUY' || String(o.side).toLowerCase() === 'long'
  const strat = orderStrategy(o.label)
  const tf = orderTimeframe(o.label)
  const { toTp, toSl } = orderTpSlDistance(o)
  const pendingMs = orderPendingMs(o, { gone })
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-text-sub)]">{enteredCell(o.first_seen)}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{pendingMs != null ? fmtDuration(pendingMs) : '—'}</td>
      <td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{o.symbol || '—'}</td>
      <td className={`py-1.5 pr-3 font-semibold ${long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
        {o.side ? (long ? 'Long' : 'Short') : '—'}
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{o.order_type || '—'}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(o.volume)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(orderTriggerPrice(o))}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(o.sl)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(o.tp)}</td>
      {/* Planned distances from the order's own trigger price to its TP/SL —
          real even before the order fills (owner spec). */}
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">
        {toTp != null && toSl != null ? `TP ${num(toTp)} · SL (${num(toSl)})` : toTp != null ? `TP ${num(toTp)}` : toSl != null ? `SL (${num(toSl)})` : '—'}
      </td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{toTp != null ? num(toTp) : '—'}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{toSl != null ? `(${num(toSl)})` : '—'}</td>
      {/* TF then Strategy — same column order as the open-positions table
          (owner: fix the discrepancy between the two). */}
      <td className="py-1.5 pr-3 whitespace-nowrap">{tf || '—'}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{strat || '—'}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{o.is_bot ? 'Bot' : 'Manual'}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">
        <span className={gone ? 'text-[var(--color-text-sub)]' : 'text-[var(--color-accent)] font-semibold'}>
          {orderStatusLabel(o)}
        </span>
        {gone && o.gone_at ? <span className="ml-1 text-[var(--color-text-sub)]">· {ago(o.gone_at)} ago</span> : null}
      </td>
      <td className="py-1.5 whitespace-nowrap">{action}</td>
    </tr>
  )
}

function QueuedRow({ q, onDone }) {
  const long = String(q.side).toUpperCase() === 'BUY'
  const [busy, setBusy] = useState(false)
  const toTp = q.limit_price != null && q.tp != null ? Math.abs(Number(q.tp) - Number(q.limit_price)) : null
  const toSl = q.limit_price != null && q.sl != null ? Math.abs(Number(q.limit_price) - Number(q.sl)) : null
  const pendingMs = (() => {
    const t = Date.parse(String(q.queued_at || '').includes('T') ? q.queued_at : String(q.queued_at || '').replace(' ', 'T') + 'Z')
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null
  })()
  const cancel = async () => {
    if (!window.confirm(`Cancel queued ${q.kind === 'closed_market_limit' ? 'limit order' : 'signal'} — ${q.symbol} ${q.side}?`)) return
    setBusy(true)
    try {
      const { agentPost } = await import('../lib/agent-api.js')
      await agentPost('/actions/queued-cancel', { kind: q.kind, id: q.id })
      onDone?.()
    } catch (e) { window.alert(`Cancel failed: ${e.message}`) }
    setBusy(false)
  }
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-text-sub)]">{enteredCell(q.queued_at)}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{pendingMs != null ? fmtDuration(pendingMs) : '—'}</td>
      <td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{q.symbol || '—'}</td>
      <td className={`py-1.5 pr-3 font-semibold ${long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
        {q.side ? (long ? 'Long' : 'Short') : '—'}
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{q.kind === 'closed_market_limit' ? 'LIMIT (mkt closed)' : 'SIGNAL (queued)'}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(q.volume)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(q.limit_price)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(q.sl)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(q.tp)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">
        {toTp != null && toSl != null ? `TP ${num(toTp)} · SL (${num(toSl)})` : toTp != null ? `TP ${num(toTp)}` : toSl != null ? `SL (${num(toSl)})` : '—'}
      </td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{toTp != null ? num(toTp) : '—'}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{toSl != null ? `(${num(toSl)})` : '—'}</td>
      {/* TF then Strategy — separate columns, matching Row above and the
          open-positions table (owner: fix the discrepancy between the two;
          these used to be combined into one cell here only). */}
      <td className="py-1.5 pr-3 whitespace-nowrap">{q.timeframe || '—'}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{q.strategy || '—'}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">Bot</td>
      <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-text-sub)]">
        waiting{q.expires_at ? ` · expires ${ago(q.expires_at)}` : ''}{q.note ? ` · ${String(q.note).slice(0, 60)}` : ''}
      </td>
      <td className="py-1.5 whitespace-nowrap">
        {q.id != null && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>{busy ? '…' : 'Cancel'}</Button>
        )}
      </td>
    </tr>
  )
}

export default function OrderLedger({ orders, onChanged = null }) {
  const working = orders?.working || []
  const recentlyGone = orders?.recentlyGone || []
  const queued = orders?.queued || []
  if (working.length === 0 && recentlyGone.length === 0 && queued.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-text-sub)]">
        No set-orders on record — nothing resting on the book, nothing queued by the bot, and nothing filled or cancelled in the last 24h.
      </p>
    )
  }
  const head = (
    <thead>
      <tr className="text-left text-[var(--color-text-sub)]">
        {['Entered', 'Duration', 'Symbol', 'Side', 'Type', 'Vol', 'Trigger', 'SL', 'TP', 'To TP/SL', '📈 to TP', '📉 to SL', 'TF', 'Strategy', 'Source', 'Status', ''].map((h, i) => (
          <th key={`${h}-${i}`} className="py-1.5 pr-3 font-semibold whitespace-nowrap">{h}</th>
        ))}
      </tr>
    </thead>
  )
  return (
    <div className="space-y-3">
      {queued.length > 0 && (
        <div>
          <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Queued by the bot — not yet at the broker ({queued.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              {head}
              <tbody>{queued.map((q, i) => <QueuedRow key={`q-${i}`} q={q} onDone={onChanged} />)}</tbody>
            </table>
          </div>
        </div>
      )}
      {working.length > 0 && (
        <div>
          <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Working now ({working.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              {head}
              <tbody>
                {working.map((o) => (
                  <WorkingRow key={`w-${o.order_id}`} o={o} onDone={onChanged} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {recentlyGone.length > 0 && (
        <div>
          <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Recently gone — filled or cancelled (24h · {recentlyGone.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              {head}
              <tbody>
                {/* Pivot-style grouping: a tiny subheader per DAY, carrying the
                    ISO week — done orders read like a pivot table by
                    day → week (owner spec). */}
                {(() => {
                  const out = []
                  let lastDay = null
                  for (const o of recentlyGone) {
                    const t = parseTs(o.gone_at || o.last_seen)
                    const d = Number.isFinite(t) ? new Date(t) : null
                    const dayKey = d ? d.toISOString().slice(0, 10) : 'unknown'
                    if (dayKey !== lastDay) {
                      lastDay = dayKey
                      const n = recentlyGone.filter(x => {
                        const xt = parseTs(x.gone_at || x.last_seen)
                        return Number.isFinite(xt) && new Date(xt).toISOString().slice(0, 10) === dayKey
                      }).length
                      out.push(
                        <tr key={`day-${dayKey}`} className="border-t border-[var(--color-border)]">
                          <td colSpan={COLS} className="py-1 text-[11px] font-semibold text-[var(--color-text-sub)]">
                            {d ? `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · Week ${isoWeek(d)}` : 'unknown date'} — {n} order(s)
                          </td>
                        </tr>
                      )
                    }
                    out.push(<Row key={`g-${o.order_id}`} o={o} gone={true} />)
                  }
                  return out
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// A working broker-resting order row + its Manage sheet (cancel / chart) —
// owner: "ability for human to close pending orders and see chart". Reuses
// the same OrderManager pop-up the live broker table uses.
function WorkingRow({ o, onDone }) {
  const [open, setOpen] = useState(false)
  const manageShape = {
    orderId: o.order_id, symbol: o.symbol, side: o.side,
    limitPrice: o.limit_price, stopPrice: o.stop_price,
    volumeUnits: o.volume, sl: o.sl, tp: o.tp, label: o.label,
  }
  return (
    <>
      <Row o={o} gone={false} action={
        <Button size="sm" variant="ghost" onClick={() => setOpen(v => !v)}>{open ? 'Close' : 'Manage'}</Button>
      } />
      {open && (
        <tr>
          <td colSpan={COLS} className="py-2">
            <OrderManager o={manageShape} onDone={() => { setOpen(false); onDone?.() }} />
          </td>
        </tr>
      )}
    </>
  )
}
