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
import { orderStrategy, orderStatusLabel, orderTriggerPrice, isoWeek } from '../lib/order-ledger-rows.js'
import OrderManager from './OrderManager.jsx'
import Button from './common/Button.jsx'

const parseTs = (iso) => Date.parse(String(iso || '').includes('T') ? iso : String(iso || '').replace(' ', 'T') + 'Z')

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
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-text-sub)]">{ago(o.first_seen)} ago</td>
      <td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{o.symbol || '—'}</td>
      <td className={`py-1.5 pr-3 font-semibold ${long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
        {o.side ? (long ? 'Long' : 'Short') : '—'}
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{o.order_type || '—'}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(o.volume)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(orderTriggerPrice(o))}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(o.sl)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(o.tp)}</td>
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

function QueuedRow({ q }) {
  const long = String(q.side).toUpperCase() === 'BUY'
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-text-sub)]">{ago(q.queued_at)} ago</td>
      <td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{q.symbol || '—'}</td>
      <td className={`py-1.5 pr-3 font-semibold ${long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
        {q.side ? (long ? 'Long' : 'Short') : '—'}
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{q.kind === 'closed_market_limit' ? 'LIMIT (mkt closed)' : 'SIGNAL (queued)'}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(q.volume)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(q.limit_price)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(q.sl)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(q.tp)}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{q.strategy || q.timeframe || '—'}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">Bot</td>
      <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-text-sub)]">
        waiting{q.expires_at ? ` · expires ${ago(q.expires_at)}` : ''}{q.note ? ` · ${String(q.note).slice(0, 60)}` : ''}
      </td>
      <td className="py-1.5" />
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
        {['Placed', 'Symbol', 'Side', 'Type', 'Vol', 'Trigger', 'SL', 'TP', 'Strategy', 'Source', 'Status', ''].map((h, i) => (
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
              <tbody>{queued.map((q, i) => <QueuedRow key={`q-${i}`} q={q} />)}</tbody>
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
                          <td colSpan={12} className="py-1 text-[11px] font-semibold text-[var(--color-text-sub)]">
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
          <td colSpan={12} className="py-2">
            <OrderManager o={manageShape} onDone={() => { setOpen(false); onDone?.() }} />
          </td>
        </tr>
      )}
    </>
  )
}
