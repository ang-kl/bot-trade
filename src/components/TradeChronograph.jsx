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
import { polar, priceTravel, rMultiple, slProximity, velocityRPerHr, fmtDuration, elapsedMs, isLong, safeTargetR } from '../lib/chrono-math.js'
import { agentPost } from '../lib/agent-api.js'

// Real technical overlays (server-computed, agent/lib/indicators.js — same
// maths as every other chart in the app), owner: "any of these in the
// picture (tradingview) that I can choose using the UI dropdown". Always
// fetches ema20 too, since that's what the Volume/Trend sub-dial reads.
const INDICATOR_OPTIONS = [
  { key: 'none', label: 'None' },
  { key: 'ema20', label: 'EMA 20' },
  { key: 'rsi14', label: 'RSI (14)' },
  { key: 'macd', label: 'MACD (12,26,9)' },
  { key: 'stochastic', label: 'Stochastic (%K/%D)' },
  { key: 'pivots', label: 'Pivot points (prior bar)' },
]

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

// Every sub-dial states its UNIT (owner: "I don't understand the dials
// without label each unit") and uses larger, full-contrast text.
function SubDial({ cx, cy, r, frac, label, unit, value, color = 'var(--color-text)', ticks = 6 }) {
  const marks = Array.from({ length: ticks + 1 }, (_, i) => i / ticks)
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="var(--color-surface-2,rgba(127,127,127,0.06))" stroke="var(--color-border)" strokeWidth="0.75" />
      {marks.map((m, i) => {
        const [x1, y1] = polar(cx, cy, r - 2, at(m))
        const [x2, y2] = polar(cx, cy, r - (i % (ticks / 2 || 1) === 0 ? 6 : 4), at(m))
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={SUB} strokeWidth="0.75" />
      })}
      <text x={cx} y={cy - r * 0.30} textAnchor="middle" fontSize="7.5" fill="var(--color-text)" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</text>
      <text x={cx} y={cy + r * 0.48} textAnchor="middle" fontSize="10.5" fontWeight="700" fill={color}>{value}</text>
      {unit && <text x={cx} y={cy + r * 0.78} textAnchor="middle" fontSize="6.5" fill={SUB}>{unit}</text>}
      {frac != null && <Hand cx={cx} cy={cy} len={r - 5} angle={at(frac)} width={1.5} color={color} />}
      <circle cx={cx} cy={cy} r="1.6" fill={color} />
    </g>
  )
}

export default function TradeChronograph({ pos, onClose }) {
  const [, force] = useState(0)
  useEffect(() => { const t = setInterval(() => force(n => n + 1), 1000); return () => clearInterval(t) }, [])
  const ticks = useLiveTicks(pos?.symbol ? [pos.symbol] : [])
  const [indicator, setIndicator] = useState('none')
  const [chartData, setChartData] = useState(null)

  useEffect(() => {
    if (!pos?.symbol) return
    let dead = false
    agentPost('/actions/chart', {
      symbol: pos.symbol,
      timeframe: pos.timeframe || pos.tf || '1h',
      bars: 60,
      indicators: ['ema20', 'rsi14', 'macd', 'stochastic', 'pivots'],
    }).then(r => { if (!dead) setChartData(r) }).catch(() => { if (!dead) setChartData(null) })
    return () => { dead = true }
  }, [pos?.symbol, pos?.timeframe, pos?.tf])

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

  // Dial scale runs SL → the FARTHEST stored target, so TP2 (when present)
  // sits at the dial end and TP1 at its true interior position. The old
  // SL→TP1 scale put TP2 beyond the dial and its mark landed wrong.
  const tpFar = (tp2 != null && Number.isFinite(Number(tp2))) ? Number(tp2) : tp1
  const travel = priceTravel({ entry, sl, tp: tpFar, side, price })
  const r = rMultiple({ entry, sl, side, price })
  // Guarded: an SL sitting at/near entry (untracked/adopted position with no
  // real stop, or bad data) makes this ratio explode into a meaningless
  // number (owner screenshot: "full = -384.6R") — safeTargetR rejects it
  // rather than display a number that looks precise but means nothing.
  const rTpRaw = Number.isFinite(tp1) ? rMultiple({ entry, sl, side, price: tp1 }) : 2
  const rTp = safeTargetR(rTpRaw)
  const ms = elapsedMs(openedAt)
  const vel = velocityRPerHr({ r, ms })
  const slProx = slProximity({ entry, sl, side, price })
  const pnlUp = r != null && r >= 0
  const price5 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 5 }))

  // Real trend read for the sub-dial — EMA20 slope over the fetched bars
  // (not a fabricated label), owner: "sub-dial should be current volume, trend".
  const ema20 = chartData?.overlays?.ema20
  const trendVals = ema20?.filter(v => v != null) ?? []
  const trendDelta = trendVals.length >= 2 ? trendVals[trendVals.length - 1] - trendVals[0] : null
  const trend = trendDelta == null ? null : trendDelta > 0 ? 'UP' : trendDelta < 0 ? 'DOWN' : 'FLAT'

  // Selected indicator's latest value, plain digits (owner: "is it better in
  // digits than dial?") — real, server-computed, never fabricated; blank
  // until bars have actually loaded.
  const indicatorLine = (() => {
    if (indicator === 'none' || !chartData) return null
    const ov = chartData.overlays || {}
    const last = (arr) => arr?.filter(v => v != null).at(-1) ?? null
    if (indicator === 'ema20') { const v = last(ov.ema20); return v == null ? null : `EMA20: ${price5(v)}` }
    if (indicator === 'rsi14') { const v = last(ov.rsi14); return v == null ? null : `RSI(14): ${v.toFixed(1)}${v >= 70 ? ' (overbought)' : v <= 30 ? ' (oversold)' : ''}` }
    if (indicator === 'macd') {
      const m = last(ov.macd?.macdLine), s = last(ov.macd?.signalLine)
      return m == null ? null : `MACD ${m.toFixed(5)} · signal ${s == null ? '—' : s.toFixed(5)}`
    }
    if (indicator === 'stochastic') {
      const k = last(ov.stochastic?.k), d = last(ov.stochastic?.d)
      return k == null ? null : `%K ${k.toFixed(1)} · %D ${d == null ? '—' : d.toFixed(1)}`
    }
    if (indicator === 'pivots') {
      const pv = ov.pivots
      return pv == null ? null : `P ${price5(pv.p)} · R1 ${price5(pv.r1)} · S1 ${price5(pv.s1)}`
    }
    return null
  })()

  // Tachymeter: velocity R/hr mapped onto the ring (0 → 6 R/hr full sweep).
  const velFrac = vel == null ? null : Math.min(1, Math.abs(vel) / 6)
  // R-progress sub-dial: 0 → rTp (target).
  const rFrac = r == null || !rTp ? null : Math.max(0, Math.min(1, r / rTp))

  const RING = 148

  // Price marks on the main dial (SL / TP1 / TP2 / entry) at their travel fracs.
  const marks = []
  if (travel) {
    marks.push({ f: travel.sl, label: 'SL', price: sl, color: DOWN })
    marks.push({ f: travel.entry, label: 'entry', price: entry, color: SUB })
    if (Number.isFinite(tp1)) {
      // TP1's true position on the SL→tpFar scale (interior when TP2 exists).
      const t1 = priceTravel({ entry, sl, tp: tpFar, side, price: tp1 })
      if (t1) marks.push({ f: t1.price, label: 'TP1', price: tp1, color: UP })
    }
    if (tp2 != null && Number.isFinite(Number(tp2))) {
      marks.push({ f: travel.tp, label: 'TP2', price: Number(tp2), color: UP })
    }
    // Current price on the bezel too (owner: "where on the bezel are the
    // TP/SL, current price, entry price") — the bold hand already tracks it,
    // this labels the exact spot.
    marks.push({ f: travel.price, label: 'now', price, color: pnlUp ? UP : DOWN })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      {/* SOLID surface, not glass — the see-through card washed the dial out
          (owner: "the pop-up font colour font size"). */}
      <div className="bg-[var(--color-bg)] border border-[var(--color-border)] shadow-2xl rounded-2xl p-4 max-w-[400px] w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-bold">{pos.symbol}</span>
            <span className={isLong(side) ? 'text-[var(--color-up)] text-[12px]' : 'text-[var(--color-down)] text-[12px]'}>{isLong(side) ? 'Long' : 'Short'}</span>
            {strat && <span className="text-[10px] uppercase px-1 rounded bg-[var(--color-surface-2,rgba(120,120,120,0.15))] text-[var(--color-text-sub)]">{strat}</span>}
            {tf && <span className="text-[10px] text-[var(--color-text-sub)]">{tf}</span>}
          </div>
          <button type="button" onClick={onClose} className="text-[var(--color-text-sub)] text-[16px] leading-none px-1" aria-label="Close">×</button>
        </div>

        {/* Indicator dropdown — owner: "any of these in the picture
            (tradingview) that I can choose by using the UI dropdown". Real,
            server-computed values only; blank until bars load. */}
        <div className="flex items-center gap-1.5 mb-1.5">
          <label htmlFor="chrono-indicator" className="text-[10px] text-[var(--color-text-sub)] uppercase tracking-wide">Indicator</label>
          <select
            id="chrono-indicator"
            value={indicator}
            onChange={e => setIndicator(e.target.value)}
            className="glass-inset rounded-[6px] px-1.5 py-0.5 text-[11px]"
          >
            {INDICATOR_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
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
            return <text key={v} x={x} y={y + 3} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--color-text)">{v}</text>
          })}
          <text x={C} y={30} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--color-text)" style={{ letterSpacing: '0.08em' }}>R / HR (velocity)</text>

          {/* Main price marks (SL / entry / TP1 / TP2 / now) on an inner arc */}
          {marks.map((m, i) => {
            const [x1, y1] = polar(C, C, RING - 16, at(m.f))
            const [x2, y2] = polar(C, C, RING - 30, at(m.f))
            const [lx, ly] = polar(C, C, RING - 42, at(m.f))
            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={m.color} strokeWidth="2.5" />
                <text x={lx} y={ly} textAnchor="middle" fontSize="9" fontWeight="700" fill={m.color}>{m.label}</text>
                <text x={lx} y={ly + 10} textAnchor="middle" fontSize="8.5" fontWeight="600" fill="var(--color-text)">{price5(m.price)}</text>
              </g>
            )
          })}
          {marks.length === 0 && (
            <text x={C} y={C - RING + 30} textAnchor="middle" fontSize="9" fill={SUB}>
              SL/TP marks unavailable — missing SL or TP1 price for this position
            </text>
          )}

          {/* Sub-dials — each labelled with its UNIT. Time-in-trade already
              has its own digit row below (owner: the dial's digit was too
              cramped to read), so this sub-dial reads Volume + real trend
              (EMA20 slope over the fetched bars) instead. */}
          <SubDial cx={C - 56} cy={C + 4} r={30} frac={null} label="Volume · trend" unit={trend ? `trend: ${trend}` : 'trend: —'} value={`${Number(volume).toLocaleString(undefined, { maximumFractionDigits: 2 })} lots`} color={trend === 'UP' ? UP : trend === 'DOWN' ? DOWN : 'var(--color-text)'} ticks={12} />
          <SubDial cx={C + 56} cy={C + 4} r={30} frac={rFrac} label="→ target" unit={rTp != null ? `R units · full = ${rTp.toFixed(1)}R` : 'target R undefined — check TP1/SL'} value={r == null ? '—' : `${r.toFixed(2)}R`} color={pnlUp ? UP : DOWN} ticks={Math.max(2, Math.round(rTp ?? 2) || 2)} />
          <SubDial cx={C} cy={C + 66} r={28} frac={slProx} label="to stop" unit="% of risk left" value={slProx == null ? '—' : `${Math.round((1 - slProx) * 100)}%`} color={slProx != null && slProx > 0.66 ? DOWN : SUB} ticks={5} />

          {/* Main velocity sweep hand (thin red chrono hand) */}
          {velFrac != null && <Hand cx={C} cy={C} len={RING - 6} angle={at(velFrac)} width={1.4} color={DOWN} />}
          {/* Bold price hand = current price on the SL→TP travel */}
          {travel && <Hand cx={C} cy={C} len={RING - 34} angle={at(travel.price)} width={3.2} color={pnlUp ? UP : DOWN} />}
          <circle cx={C} cy={C} r="4" fill="var(--color-text)" />

          {/* Centre digital */}
          <text x={C} y={C - 84} textAnchor="middle" fontSize="16" fontWeight="800" fill="var(--color-text)" fontFamily="ui-monospace, monospace">{fmtDuration(ms)}</text>
        </svg>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px] mt-2">
          <span className="text-[var(--color-text-sub)]">Current price</span><span className="tabular-nums text-right font-semibold">{price5(price)}</span>
          <span className="text-[var(--color-text-sub)]">Velocity</span><span className="tabular-nums text-right font-semibold">{vel == null ? '—' : `${vel.toFixed(2)} R/hr`}</span>
          {/* Owner: "is it better in digits than dial" — the In-trade sub-dial's
              digit is cramped at this size; a plain row is unambiguous. */}
          <span className="text-[var(--color-text-sub)]">Time in trade</span><span className="tabular-nums text-right font-semibold">{fmtDuration(ms)}</span>
          <span className="text-[var(--color-text-sub)]">Entry time</span><span className="tabular-nums text-right font-semibold">{openedAt ? new Date(openedAt).toLocaleString() : '—'}</span>
        </div>
        {indicator !== 'none' && (
          <p className="tabular-nums text-[12px] font-semibold mt-1.5 pt-1.5 border-t border-[var(--color-border)]">
            {indicatorLine ?? 'loading…'}
          </p>
        )}
        {/* Legend — what each element means, in words (never colour-only) */}
        <p className="text-[11px] leading-snug text-[var(--color-text-sub)] mt-1.5">
          Bold hand = current price on the SL→TP1 travel · thin hand = velocity on the outer R/hr ring · marks show SL / entry / TP1 / TP2 / now with live prices.
        </p>
      </div>
    </div>
  )
}
