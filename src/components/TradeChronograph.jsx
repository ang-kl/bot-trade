// TradeChronograph — full chronograph instrument for ONE open trade, opened
// from a gauge card (owner design: "different sub-dials ... multiple hands for
// different purposes", chrono/tachymeter reference).
//
//   · Outer TACHYMETER ring  → velocity (R/hr) sweep + volume (lots) readout
//   · Main sweep hand        → current price between SL and TP, with SL / TP1 /
//                              TP2 tick marks and live price labels
//   · Sub-dial (left)        → time-in-trade (stopwatch)
//   · Sub-dial (right)       → R progress toward the target
//   · Sub-dial (bottom)      → distance to SL (danger)
//   · Centre digital         → elapsed + entry time + timeframe/strategy
import { useEffect, useState } from 'react'
import { useLiveTicks, liveMid } from '../lib/useLiveTicks.js'
import { STRAT_SHORT } from '../lib/strategy-labels.js'
import { polar, priceTravel, rMultiple, slProximity, velocityRPerHr, fmtDuration, elapsedMs, isLong } from '../lib/chrono-math.js'

const C = 160 // centre
const UP = 'var(--color-up)'
const DOWN = 'var(--color-down)'
const SUB = 'var(--color-text-sub)'

// A dial spans 240° (from -120° to +120°, i.e. 7-o'clock to 5-o'clock).
const A0 = -120, A1 = 120
const at = (f) => A0 + (A1 - A0) * Math.max(0, Math.min(1, f)) // fraction → angle

function Hand({ cx, cy, len, angle, width = 2, color = 'var(--color-text)' }) {
  const [x, y] = polar(cx, cy, len, angle)
  const [xb, yb] = polar(cx, cy, -len * 0.18, angle)
  return <line x1={xb} y1={yb} x2={x} y2={y} stroke={color} strokeWidth={width} strokeLinecap="round" />
}

function SubDial({ cx, cy, r, frac, label, value, color = 'var(--color-text)', ticks = 6 }) {
  const marks = Array.from({ length: ticks + 1 }, (_, i) => i / ticks)
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="var(--color-surface-2,rgba(127,127,127,0.06))" stroke="var(--color-border)" strokeWidth="0.75" />
      {marks.map((m, i) => {
        const [x1, y1] = polar(cx, cy, r - 2, at(m))
        const [x2, y2] = polar(cx, cy, r - (i % (ticks / 2 || 1) === 0 ? 6 : 4), at(m))
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={SUB} strokeWidth="0.75" />
      })}
      <text x={cx} y={cy - r * 0.34} textAnchor="middle" fontSize="6" fill={SUB} style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</text>
      <text x={cx} y={cy + r * 0.55} textAnchor="middle" fontSize="8" fontWeight="700" fill={color}>{value}</text>
      {frac != null && <Hand cx={cx} cy={cy} len={r - 5} angle={at(frac)} width={1.5} color={color} />}
      <circle cx={cx} cy={cy} r="1.6" fill={color} />
    </g>
  )
}

export default function TradeChronograph({ pos, onClose }) {
  const [, force] = useState(0)
  useEffect(() => { const t = setInterval(() => force(n => n + 1), 1000); return () => clearInterval(t) }, [])
  const ticks = useLiveTicks(pos?.symbol ? [pos.symbol] : [])
  if (!pos) return null

  const entry = Number(pos.entry ?? pos.entry_price)
  const sl = Number(pos.monitorSl ?? pos.current_sl ?? pos.sl)
  const tp1 = Number(pos.tp1 ?? pos.current_tp ?? pos.tp)
  const tp2 = pos.tp2 ?? pos.tp2_price
  const side = pos.side
  const volume = pos.lots ?? pos.volume ?? 0
  const price = liveMid(ticks, pos.symbol) ?? pos.currentPrice ?? entry
  const openedAt = pos.opened_at ?? pos.openedAt
  const tf = pos.timeframe || pos.tf
  const strat = pos.strategy ? (STRAT_SHORT[pos.strategy] || pos.strategy) : (pos.source && pos.source !== 'autopilot' ? 'manual' : null)

  const travel = priceTravel({ entry, sl, tp: tp1, side, price })
  const r = rMultiple({ entry, sl, side, price })
  const rTp = Number.isFinite(tp1) ? rMultiple({ entry, sl, side, price: tp1 }) : 2
  const ms = elapsedMs(openedAt)
  const vel = velocityRPerHr({ r, ms })
  const slProx = slProximity({ entry, sl, side, price })
  const pnlUp = r != null && r >= 0

  // Tachymeter: velocity R/hr mapped onto the ring (0 → 6 R/hr full sweep).
  const velFrac = vel == null ? null : Math.min(1, Math.abs(vel) / 6)
  // Time-in-trade sub-dial sweeps once per 60 minutes.
  const timeFrac = ms == null ? null : (ms % 3_600_000) / 3_600_000
  // R-progress sub-dial: 0 → rTp (target).
  const rFrac = r == null || !rTp ? null : Math.max(0, Math.min(1, r / rTp))

  const RING = 148
  const price5 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 5 }))

  // Price marks on the main dial (SL / TP1 / TP2 / entry) at their travel fracs.
  const marks = []
  if (travel) {
    marks.push({ f: travel.sl, label: 'SL', price: sl, color: DOWN })
    marks.push({ f: travel.entry, label: 'entry', price: entry, color: SUB })
    if (Number.isFinite(tp1)) marks.push({ f: travel.tp, label: 'TP1', price: tp1, color: UP })
    if (tp2 != null && Number.isFinite(Number(tp2))) {
      const t2 = priceTravel({ entry, sl, tp: Number(tp2), side, price })
      if (t2) marks.push({ f: Math.max(0, Math.min(1, (Number(tp2) - (isLong(side) ? sl : tp1)) / ((isLong(side) ? Number(tp2) : sl) - (isLong(side) ? sl : Number(tp2))))), label: 'TP2', price: Number(tp2), color: UP })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="glass-inset rounded-2xl p-3 max-w-[360px] w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-bold">{pos.symbol}</span>
            <span className={isLong(side) ? 'text-[var(--color-up)] text-[12px]' : 'text-[var(--color-down)] text-[12px]'}>{isLong(side) ? 'Long' : 'Short'}</span>
            {strat && <span className="text-[10px] uppercase px-1 rounded bg-[var(--color-surface-2,rgba(120,120,120,0.15))] text-[var(--color-text-sub)]">{strat}</span>}
            {tf && <span className="text-[10px] text-[var(--color-text-sub)]">{tf}</span>}
          </div>
          <button type="button" onClick={onClose} className="text-[var(--color-text-sub)] text-[16px] leading-none px-1" aria-label="Close">×</button>
        </div>

        <svg viewBox="0 0 320 320" className="w-full" role="img" aria-label={`${pos.symbol} chronograph`}>
          {/* Tachymeter ring — velocity R/hr */}
          <circle cx={C} cy={C} r={RING} fill="none" stroke="var(--color-border)" strokeWidth="1" />
          <circle cx={C} cy={C} r={RING - 14} fill="none" stroke="var(--color-border)" strokeWidth="0.5" />
          {Array.from({ length: 25 }, (_, i) => i / 24).map((f, i) => {
            const [x1, y1] = polar(C, C, RING, at(f))
            const [x2, y2] = polar(C, C, RING - (i % 4 === 0 ? 12 : 7), at(f))
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={SUB} strokeWidth={i % 4 === 0 ? 1.25 : 0.6} />
          })}
          {[0, 1, 2, 3, 4, 5, 6].map((v) => {
            const [x, y] = polar(C, C, RING - 22, at(v / 6))
            return <text key={v} x={x} y={y + 3} textAnchor="middle" fontSize="8" fill={SUB}>{v}</text>
          })}
          <text x={C} y={30} textAnchor="middle" fontSize="8" fill={SUB} style={{ letterSpacing: '0.08em' }}>R / HR (velocity)</text>

          {/* Volume readout on the tachymeter */}
          <g>
            <text x={C} y={C + RING - 26} textAnchor="middle" fontSize="9" fill={SUB} style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Volume</text>
            <text x={C} y={C + RING - 14} textAnchor="middle" fontSize="13" fontWeight="800" fill="var(--color-text)">{Number(volume).toLocaleString(undefined, { maximumFractionDigits: 2 })} lots</text>
          </g>

          {/* Main price marks (SL / entry / TP1 / TP2) on an inner arc */}
          {marks.map((m, i) => {
            const [x1, y1] = polar(C, C, RING - 16, at(m.f))
            const [x2, y2] = polar(C, C, RING - 30, at(m.f))
            const [lx, ly] = polar(C, C, RING - 42, at(m.f))
            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={m.color} strokeWidth="2" />
                <text x={lx} y={ly} textAnchor="middle" fontSize="7" fontWeight="700" fill={m.color}>{m.label}</text>
                <text x={lx} y={ly + 8} textAnchor="middle" fontSize="6.5" fill={SUB}>{price5(m.price)}</text>
              </g>
            )
          })}

          {/* Sub-dials */}
          <SubDial cx={C - 56} cy={C + 4} r={30} frac={timeFrac} label="In trade" value={fmtDuration(ms)} color="var(--color-text)" ticks={12} />
          <SubDial cx={C + 56} cy={C + 4} r={30} frac={rFrac} label="→ target" value={r == null ? '—' : `${r.toFixed(2)}R`} color={pnlUp ? UP : DOWN} ticks={Math.max(2, Math.round(rTp) || 2)} />
          <SubDial cx={C} cy={C + 66} r={28} frac={slProx} label="to stop" value={slProx == null ? '—' : `${Math.round((1 - slProx) * 100)}%`} color={slProx != null && slProx > 0.66 ? DOWN : SUB} ticks={5} />

          {/* Main velocity sweep hand (thin red chrono hand) */}
          {velFrac != null && <Hand cx={C} cy={C} len={RING - 6} angle={at(velFrac)} width={1.4} color={DOWN} />}
          {/* Bold price hand = current price on the SL→TP travel */}
          {travel && <Hand cx={C} cy={C} len={RING - 34} angle={at(travel.price)} width={3.2} color={pnlUp ? UP : DOWN} />}
          <circle cx={C} cy={C} r="4" fill="var(--color-text)" />

          {/* Centre digital */}
          <text x={C} y={C - 84} textAnchor="middle" fontSize="16" fontWeight="800" fill="var(--color-text)" fontFamily="ui-monospace, monospace">{fmtDuration(ms)}</text>
        </svg>

        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] mt-1">
          <span className="text-[var(--color-text-sub)]">Current</span><span className="tabular-nums text-right">{price5(price)}</span>
          <span className="text-[var(--color-text-sub)]">Velocity</span><span className="tabular-nums text-right">{vel == null ? '—' : `${vel.toFixed(2)} R/hr`}</span>
          <span className="text-[var(--color-text-sub)]">Entry time</span><span className="tabular-nums text-right">{openedAt ? new Date(openedAt).toLocaleString() : '—'}</span>
        </div>
      </div>
    </div>
  )
}
