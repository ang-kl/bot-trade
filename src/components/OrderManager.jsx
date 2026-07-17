// OrderManager — per-PENDING-order management sheet, mirroring the cTrader
// pop-up the same way PositionManager does for live positions: header with
// OID + symbol + lots, Modify | Chart | Details tabs, and the one action a
// resting order supports through the agent today — Cancel order. (Amending a
// resting order in place isn't wired to an endpoint yet; cancelling and
// letting the bot re-stage, or re-creating manually in cTrader, is the path.)
//
// Colour note: cTrader's greens map to the app accent (blue) — this repo
// bans green for accessibility (see scripts/check-no-green.sh).

import { useState } from 'react'
import Badge from './common/Badge.jsx'
import Button from './common/Button.jsx'
import PositionChart from './PositionChart.jsx'
import { agentPost } from '../lib/agent-api.js'
import { priceDp } from '../lib/std-trade-rows.js'

const TABS = ['Modify', 'Chart', 'Details']

// Canonical price display (owner): scale-aware — 4 dp, 2 dp in the
// hundreds, none at five figures; symbol digits below that keep their own.
const fmt = (v, d = 4) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(Math.min(d, priceDp(v))))

export default function OrderManager({ o, onDone }) {
  const [tab, setTab] = useState('Modify')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const trigger = o.limitPrice ?? o.stopPrice
  const type = o.type || (o.limitPrice != null ? 'LIMIT' : 'STOP')
  // Desk's snapshot carries lots; Trade's reconcile snapshot carries raw units.
  const qty = o.lots != null ? fmt(o.lots, 2) : o.volumeUnits != null ? `${Number(o.volumeUnits).toLocaleString()} u` : '—'

  const cancel = async () => {
    if (!window.confirm(`Cancel ${type} order ${o.symbol} ${o.side} ${qty} @ ${fmt(trigger, o.digits ?? 5)}?`)) return
    setBusy(true); setMsg('')
    try {
      await agentPost('/actions/order-cancel', { orderId: o.orderId })
      setMsg('Order cancelled')
      onDone?.()
    } catch (e) { setMsg(`Error: ${e.message}`) }
    setBusy(false)
  }

  return (
    <div className="glass-panel rounded-[12px] p-3 mt-2">
      {/* Header — OID + symbol + lots, like the cTrader sheet title */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[14px] font-bold">OID{o.orderId} {o.symbol} ({qty})</h3>
        <Button size="sm" variant="ghost" onClick={onDone}>✕</Button>
      </div>

      {/* Tab strip: Modify | Chart | Details */}
      <div className="glass-inset rounded-[10px] p-0.5 flex mb-2">
        {TABS.map(t => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`flex-1 rounded-[8px] px-2 py-1 text-[13px] font-semibold cursor-pointer ${tab === t ? 'bg-[var(--color-bg)] shadow' : 'text-[var(--color-text-sub)]'}`}>
            {t}
          </button>
        ))}
      </div>

      {msg && <div className={`mb-2 text-[12px] ${msg.startsWith('Error') ? 'text-[var(--color-down)]' : 'text-[var(--color-accent)]'}`}>{msg}</div>}

      {tab === 'Modify' && (
        <div>
          {/* Side buttons — the order's side active, the other inert */}
          <div className="flex gap-2 mb-1.5">
            {['SELL', 'BUY'].map(s => (
              <span key={s} className={`flex-1 text-center rounded-[8px] border py-2 text-[14px] font-bold ${o.side === s ? (s === 'BUY' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-down)] text-[var(--color-down)]') : 'border-[var(--color-border)] text-[var(--color-text-sub)] opacity-40'}`}>
                {s}
              </span>
            ))}
          </div>
          <div className="text-center text-[12px] text-[var(--color-text-sub)] mb-2">
            {type} @ {fmt(trigger, o.digits ?? 5)} · Now: {fmt(o.currentPrice, o.digits ?? 5)}
          </div>
          <div className="border-t border-[var(--color-border)] py-1.5 flex items-center justify-between text-[13px]">
            <span>Quantity</span><span className="font-semibold">{qty}</span>
          </div>
          <div className="border-t border-[var(--color-border)] py-1.5 flex items-center justify-between text-[13px]">
            <span>Stop loss</span><span className="font-semibold">{fmt(o.sl, o.digits ?? 5)}</span>
          </div>
          <div className="border-t border-[var(--color-border)] py-1.5 flex items-center justify-between text-[13px]">
            <span>Take profit</span><span className="font-semibold">{fmt(o.tp, o.digits ?? 5)}</span>
          </div>

          <button type="button" disabled className="w-full mt-2 rounded-[10px] glass-inset py-2.5 text-[15px] font-bold text-[var(--color-text-sub)] opacity-60">Modify</button>
          <div className="text-center text-[12px] text-[var(--color-text-sub)] my-1.5">
            Amend-in-place isn't wired yet — cancel and let the bot re-stage (or edit in cTrader)
          </div>
          <div className="text-center text-[12px] text-[var(--color-text-sub)] mb-1.5">or</div>

          <button type="button" disabled={busy}
            className="w-full rounded-[10px] bg-[var(--color-down)] text-white py-2.5 text-[15px] font-bold cursor-pointer disabled:opacity-50"
            onClick={cancel}>
            Cancel order
          </button>
        </div>
      )}

      {tab === 'Chart' && (
        <PositionChart symbol={o.symbol} timeframe="1h" lines={{ entry: trigger, sl: o.sl, tp: o.tp }} />
      )}

      {tab === 'Details' && (
        <div className="text-[13px] space-y-1">
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Order</span><span className="font-semibold">OID{o.orderId}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Type</span><span>{type}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Side</span><Badge tone={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</Badge></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Quantity</span><span>{qty}{o.lots != null ? ' lots' : ''}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Trigger price</span><span>{fmt(trigger, o.digits ?? 5)}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Stop loss</span><span>{fmt(o.sl, o.digits ?? 5)}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Take profit</span><span>{fmt(o.tp, o.digits ?? 5)}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Expires</span><span>{o.expiresAt ? new Date(o.expiresAt).toLocaleString() : 'Good till cancelled'}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Last modified</span><span>{o.updatedAt ? new Date(o.updatedAt).toLocaleString() : '—'}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Source</span><Badge tone={(o.label || o.bot) ? 'special' : 'neutral'}>{(o.label || o.bot) ? 'BOT' : 'MANUAL'}</Badge></div>
          {o.label && <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Label</span><span className="truncate max-w-[200px]">{o.label}</span></div>}
        </div>
      )}
    </div>
  )
}
