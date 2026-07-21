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
import { orderStrategy, orderStatusLabel, orderTriggerPrice } from '../lib/order-ledger-rows.js'

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

function Row({ o, gone }) {
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
    </tr>
  )
}

export default function OrderLedger({ orders }) {
  const working = orders?.working || []
  const recentlyGone = orders?.recentlyGone || []
  if (working.length === 0 && recentlyGone.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-text-sub)]">
        No set-orders on record — nothing resting on the book and nothing filled or cancelled in the last 24h.
      </p>
    )
  }
  const head = (
    <thead>
      <tr className="text-left text-[var(--color-text-sub)]">
        {['Placed', 'Symbol', 'Side', 'Type', 'Vol', 'Trigger', 'SL', 'TP', 'Strategy', 'Source', 'Status'].map((h) => (
          <th key={h} className="py-1.5 pr-3 font-semibold whitespace-nowrap">{h}</th>
        ))}
      </tr>
    </thead>
  )
  return (
    <div className="space-y-3">
      {working.length > 0 && (
        <div>
          <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Working now ({working.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              {head}
              <tbody>{working.map((o) => <Row key={`w-${o.order_id}`} o={o} gone={false} />)}</tbody>
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
              <tbody>{recentlyGone.map((o) => <Row key={`g-${o.order_id}`} o={o} gone={true} />)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
