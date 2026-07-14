// PositionManager — per-position trade-management sheet, laid out to mirror
// the cTrader mobile app screen for screen: Modify / Protect / Chart /
// Details tabs, SELL|BUY header, Quantity + used margin, Modify ("Leave size
// intact") · Double · Reverse · Close, and the Protect stack (Take profits,
// Stop loss with pips/price steppers, Trailing stop, Break-even with
// trigger/offset) — applied to ONE position only, never globally.
//
// Colour note: cTrader's greens map to the app accent (blue) — this repo
// bans green for accessibility (see scripts/check-no-green.sh).
//
// TP1 and SL are the broker's NATIVE protection. Trailing stop, break-even
// and TP2–4 (partial closes) are bot-enforced rules the agent applies every
// loop cycle — same mechanism cTrader itself uses client-side.

import { useEffect, useState } from 'react'
import Badge from './common/Badge.jsx'
import Button from './common/Button.jsx'
import PositionChart from './PositionChart.jsx'
import { agentPost } from '../lib/agent-api.js'

const TABS = ['Modify', 'Protect', 'Chart', 'Details']

const fmt = (v, d = 5) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(Math.min(d, 8)))
const money = (v) => (v == null ? '—' : `$ ${Number(v).toFixed(2)}`)

// Pips ⇄ price for a given side: SL sits BEHIND entry (negative pips), TP in
// front — matching cTrader's signed pips display.
function priceFromPips(entry, pips, pipSize, dir, kind) {
  if (entry == null || pipSize == null || !Number.isFinite(Number(pips))) return null
  const sign = kind === 'sl' ? -1 : 1
  return entry + dir * sign * Math.abs(Number(pips)) * pipSize
}
function pipsFromPrice(entry, price, pipSize, dir, kind) {
  if (entry == null || price == null || !pipSize) return null
  const sign = kind === 'sl' ? -1 : 1
  return Math.round(((price - entry) * dir * sign) / pipSize * 10) / 10 * (kind === 'sl' ? -1 : 1)
}

function Stepper({ label, value, onChange, step = 1, digits = 1 }) {
  return (
    <div className="flex items-center justify-between border-t border-[var(--color-border)] py-1.5">
      <span className="text-[13px]">{label}</span>
      <span className="flex items-center gap-2">
        <input
          className="w-24 text-right text-[13px] bg-transparent border border-[var(--color-border)] rounded-[6px] px-1.5 py-0.5"
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          inputMode="decimal"
          aria-label={label}
        />
        <span className="glass-inset rounded-[8px] inline-flex">
          <button type="button" className="px-2.5 py-0.5 cursor-pointer" aria-label={`${label} minus`}
            onClick={() => onChange(String(Math.round(((Number(value) || 0) - step) * 10 ** digits) / 10 ** digits))}>−</button>
          <span className="w-px bg-[var(--color-border)]" />
          <button type="button" className="px-2.5 py-0.5 cursor-pointer" aria-label={`${label} plus`}
            onClick={() => onChange(String(Math.round(((Number(value) || 0) + step) * 10 ** digits) / 10 ** digits))}>+</button>
        </span>
      </span>
    </div>
  )
}

function ToggleRow({ label, on, onToggle }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[13px] font-semibold">{label}</span>
      <button
        type="button" role="switch" aria-checked={on} onClick={onToggle}
        className={`w-11 h-6 rounded-full transition-colors cursor-pointer ${on ? 'bg-[var(--color-accent)]' : 'glass-inset'}`}
      >
        <span className={`block w-5 h-5 rounded-full bg-white shadow transform transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

export default function PositionManager({ p, onDone }) {
  const [tab, setTab] = useState('Modify')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const dir = p.side === 'BUY' ? 1 : -1

  // Protect state — native SL/TP prefilled from the broker snapshot.
  const [slOn, setSlOn] = useState(p.sl != null)
  const [slPrice, setSlPrice] = useState(p.sl != null ? String(p.sl) : '')
  const [tpOn, setTpOn] = useState(p.tp != null)
  const [tpPrice, setTpPrice] = useState(p.tp != null ? String(p.tp) : '')
  const [trailOn, setTrailOn] = useState(false)
  const [trailPips, setTrailPips] = useState('10')
  const [beOn, setBeOn] = useState(false)
  const [beTrigger, setBeTrigger] = useState('15')
  const [beOffset, setBeOffset] = useState('3')
  // TP 2–4 — bot-managed partial closes {on, price, lots}
  const [extraTps, setExtraTps] = useState([
    { on: false, price: '', lots: '' },
    { on: false, price: '', lots: '' },
    { on: false, price: '', lots: '' },
  ])

  useEffect(() => {
    let alive = true
    agentPost('/actions/position-guard-get', { positionId: p.positionId }).then(r => {
      if (!alive || !r?.guard) return
      const g = r.guard
      if (g.breakEven) { setBeOn(!!g.breakEven.on); setBeTrigger(String(g.breakEven.triggerPips ?? 15)); setBeOffset(String(g.breakEven.offsetPips ?? 3)) }
      if (g.trailing) { setTrailOn(!!g.trailing.on); setTrailPips(String(g.trailing.distancePips ?? 10)) }
      if (Array.isArray(g.takeProfits)) {
        setExtraTps([0, 1, 2].map(i => g.takeProfits[i]
          ? { on: !g.takeProfits[i].done, price: String(g.takeProfits[i].price ?? ''), lots: String(g.takeProfits[i].lots ?? '') }
          : { on: false, price: '', lots: '' }))
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [p.positionId])

  const run = async (fn, okMsg) => {
    setBusy(true); setMsg('')
    try { await fn(); setMsg(okMsg); onDone?.() } catch (e) { setMsg(`Error: ${e.message}`) }
    setBusy(false)
  }

  const applyProtection = () => run(async () => {
    if (slOn && Number(slPrice) > 0) {
      await agentPost('/actions/position-protect', { positionId: p.positionId, sl: Number(slPrice), ...(tpOn && Number(tpPrice) > 0 ? { tp: Number(tpPrice) } : {}) })
    } else if (tpOn && Number(tpPrice) > 0) {
      await agentPost('/actions/position-protect', { positionId: p.positionId, tp: Number(tpPrice) })
    }
    const takeProfits = extraTps
      .filter(t => t.on && Number(t.price) > 0 && Number(t.lots) > 0)
      .map(t => ({ price: Number(t.price), lots: Number(t.lots), done: false }))
    const guard = {
      ...(beOn ? { breakEven: { on: true, triggerPips: Number(beTrigger) || 0, offsetPips: Number(beOffset) || 0 } } : {}),
      ...(trailOn ? { trailing: { on: true, distancePips: Number(trailPips) || 0 } } : {}),
      ...(takeProfits.length ? { takeProfits } : {}),
    }
    await agentPost('/actions/position-guard', { positionId: p.positionId, guard: Object.keys(guard).length ? guard : null })
  }, 'Protection updated')

  const slPips = pipsFromPrice(p.entry, Number(slPrice) || null, p.pipSize, dir, 'sl')

  return (
    <div className="glass-panel rounded-[12px] p-3 mt-2">
      {/* Header — PID + symbol + lots, exactly like the cTrader sheet title */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[14px] font-bold">PID{p.positionId} {p.symbol} ({fmt(p.lots, 2)})</h3>
        <Button size="sm" variant="ghost" onClick={onDone}>✕</Button>
      </div>

      {/* Tab strip: Modify | Protect | Chart | Details */}
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
          {/* Side buttons — current side active, the other inert (info only) */}
          <div className="flex gap-2 mb-1.5">
            {['SELL', 'BUY'].map(s => (
              <span key={s} className={`flex-1 text-center rounded-[8px] border py-2 text-[14px] font-bold ${p.side === s ? (s === 'BUY' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-down)] text-[var(--color-down)]') : 'border-[var(--color-border)] text-[var(--color-text-sub)] opacity-40'}`}>
                {s}
              </span>
            ))}
          </div>
          <div className="text-center text-[12px] text-[var(--color-text-sub)] mb-2">
            Entry price: {fmt(p.entry, p.digits ?? 5)} · Now: {fmt(p.currentPrice, p.digits ?? 5)}
          </div>
          <div className="border-t border-[var(--color-border)] py-1.5 flex items-center justify-between text-[13px]">
            <span>Quantity (Lots)</span><span className="font-semibold">{fmt(p.lots, 2)}</span>
          </div>
          <div className="text-[12px] text-[var(--color-text-sub)] mb-2">Used margin: {money(p.usedMargin)}</div>

          <button type="button" disabled className="w-full rounded-[10px] glass-inset py-2.5 text-[15px] font-bold text-[var(--color-text-sub)] opacity-60">Modify</button>
          <div className="text-center text-[12px] text-[var(--color-text-sub)] my-1.5">Leave size intact</div>
          <div className="text-center text-[12px] text-[var(--color-text-sub)] mb-1.5">or</div>

          <div className="flex gap-2 mb-1.5">
            <Button className="flex-1" variant="subtle" disabled={busy}
              onClick={() => window.confirm(`Double ${p.symbol}: open ANOTHER ${p.side} ${fmt(p.lots, 2)} lots at market?`) &&
                run(() => agentPost('/actions/position-double', { positionId: p.positionId }), 'Position doubled')}>Double</Button>
            <Button className="flex-1" variant="subtle" disabled={busy}
              onClick={() => window.confirm(`Reverse ${p.symbol}: CLOSE this ${p.side} and open ${p.side === 'BUY' ? 'SELL' : 'BUY'} ${fmt(p.lots, 2)} lots at market?`) &&
                run(() => agentPost('/actions/position-reverse', { positionId: p.positionId }), 'Position reversed')}>Reverse</Button>
          </div>
          <div className="text-center text-[12px] text-[var(--color-text-sub)] mb-1.5">or</div>

          <button type="button" disabled={busy}
            className="w-full rounded-[10px] bg-[var(--color-down)] text-white py-2.5 text-[15px] font-bold cursor-pointer disabled:opacity-50"
            onClick={() => window.confirm(`Close ${p.symbol} ${p.side} ${fmt(p.lots, 2)} lots at market?`) &&
              run(() => agentPost('/actions/position-close', { positionId: p.positionId }), 'Position closed')}>
            Close ({fmt(p.currentPrice, p.digits ?? 5)})
          </button>
          <div className="text-center text-[12px] mt-1.5">
            Net P&L: <span className={(p.estNetPnl ?? p.estPnlQuote ?? 0) >= 0 ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>{money(p.estNetPnl ?? p.estPnlQuote)}</span>
          </div>
        </div>
      )}

      {tab === 'Protect' && (
        <div>
          {/* Take profit — TP1 is the broker's native TP */}
          <ToggleRow label="Take profit" on={tpOn} onToggle={() => setTpOn(v => !v)} />
          {tpOn && (
            <Stepper label="Price" value={tpPrice} onChange={setTpPrice} step={p.pipSize ?? 0.001} digits={p.digits ?? 5} />
          )}

          {/* TP 2–4 — bot-managed partial closes, like cTrader's extra TPs */}
          {extraTps.map((t, i) => (
            <div key={i}>
              <ToggleRow label={`Take profit ${i + 2}`} on={t.on}
                onToggle={() => setExtraTps(a => a.map((x, j) => j === i ? { ...x, on: !x.on } : x))} />
              {t.on && (
                <>
                  <Stepper label="Price" value={t.price} step={p.pipSize ?? 0.001} digits={p.digits ?? 5}
                    onChange={v => setExtraTps(a => a.map((x, j) => j === i ? { ...x, price: v } : x))} />
                  <Stepper label="Quantity (Lots)" value={t.lots} step={p.minLot ?? 0.01} digits={2}
                    onChange={v => setExtraTps(a => a.map((x, j) => j === i ? { ...x, lots: v } : x))} />
                </>
              )}
            </div>
          ))}

          {/* Stop loss — native, with signed pips + absolute price steppers */}
          <ToggleRow label="Stop loss" on={slOn} onToggle={() => setSlOn(v => !v)} />
          {slOn && (
            <>
              <Stepper label="Pips" value={slPips != null ? String(slPips) : ''} step={1} digits={1}
                onChange={v => {
                  const px = priceFromPips(p.entry, v, p.pipSize, dir, 'sl')
                  if (px != null) setSlPrice(String(Math.round(px * 10 ** (p.digits ?? 5)) / 10 ** (p.digits ?? 5)))
                }} />
              <Stepper label="Price" value={slPrice} onChange={setSlPrice} step={p.pipSize ?? 0.001} digits={p.digits ?? 5} />
              <div className="flex items-center justify-between border-t border-[var(--color-border)] py-1.5 text-[13px]">
                <span>Trigger</span><span className="text-[var(--color-text-sub)]">Trade ›</span>
              </div>
              <ToggleRow label="Trailing stop loss" on={trailOn} onToggle={() => setTrailOn(v => !v)} />
              {trailOn && (
                <Stepper label="Distance (pips)" value={trailPips} onChange={setTrailPips} step={1} digits={1} />
              )}
            </>
          )}

          {/* Break-even — bot-enforced, trigger + offset in pips */}
          <ToggleRow label="Break-even" on={beOn} onToggle={() => setBeOn(v => !v)} />
          {beOn && (
            <>
              <Stepper label="Trigger (pips)" value={beTrigger} onChange={setBeTrigger} step={1} digits={1} />
              <Stepper label="Offset (pips)" value={beOffset} onChange={setBeOffset} step={1} digits={1} />
            </>
          )}

          <button type="button" disabled={busy}
            className="w-full mt-2 rounded-[10px] bg-[var(--color-accent)] text-white py-2.5 text-[15px] font-bold cursor-pointer disabled:opacity-50"
            onClick={applyProtection}>
            Modify protection
          </button>
          <p className="mt-1.5 text-[11px] text-[var(--color-text-sub)]">
            SL and Take profit are held at the broker. Trailing, Break-even and Take profit 2–4 are enforced by the bot every scan cycle (they only ever tighten protection or take profit) — same as cTrader, where these run client-side.
          </p>
        </div>
      )}

      {tab === 'Chart' && (
        <PositionChart symbol={p.symbol} timeframe="1h" lines={{ entry: p.entry, sl: p.sl, tp: p.tp }} />
      )}

      {tab === 'Details' && (
        <div className="text-[13px] space-y-1">
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Position</span><span className="font-semibold">PID{p.positionId}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Side</span><Badge tone={p.side === 'BUY' ? 'up' : 'down'}>{p.side}</Badge></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Quantity</span><span>{fmt(p.lots, 2)} lots</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Entry</span><span>{fmt(p.entry, p.digits ?? 5)}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Swap</span><span>{money(p.swap)}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Commission</span><span>{money(p.commission)}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Used margin</span><span>{money(p.usedMargin)}</span></div>
          <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Opened</span><span>{p.openedAt ? new Date(p.openedAt).toLocaleString() : '—'}</span></div>
          {p.label && <div className="flex justify-between border-t border-[var(--color-border)] py-1"><span>Label</span><span className="truncate max-w-[200px]">{p.label}</span></div>}
        </div>
      )}
    </div>
  )
}
