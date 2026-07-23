// TradeChronograph — full COCKPIT panel for ONE open trade, opened from a
// gauge tile (owner 2026-07-23: "redo the Open Trades Dial/bezel and
// pop-up ... Gulfstream G700 cockpit layout"; the earlier watch-dial
// design is replaced). Centre: a large CockpitPFD — horizon level at
// ENTRY (profit sky above, loss ground below), bank RIGHT = converging on
// the TP, LEFT = diverging; P&L-in-R tape left; price tape with TP/E/SL
// bugs right; track-to-target strip bottom. Below it: digital flight-data
// rows (price, velocity, distance-to-stop, time in trade) and the same
// server-computed indicator dropdown as before. The pop-up enters with
// W3.CSS's zoom animation + a GSAP settle (guarded on window.gsap).
import { useEffect, useRef, useState } from 'react'
import { useLiveTicks, liveMid } from '../lib/useLiveTicks.js'
import { STRAT_SHORT } from '../lib/strategy-labels.js'
import { rMultiple, slProximity, velocityRPerHr, fmtDuration, elapsedMs, isLong } from '../lib/chrono-math.js'
import { agentPost } from '../lib/agent-api.js'
import CockpitPFD from './CockpitPFD.jsx'

// Real technical overlays (server-computed, agent/lib/indicators.js — same
// maths as every other chart in the app), owner: "any of these in the
// picture (tradingview) that I can choose using the UI dropdown". Always
// fetches ema20 too, since that's what the trend annunciator reads.
const INDICATOR_OPTIONS = [
  { key: 'none', label: 'None' },
  { key: 'ema20', label: 'EMA 20' },
  { key: 'rsi14', label: 'RSI (14)' },
  { key: 'macd', label: 'MACD (12,26,9)' },
  { key: 'stochastic', label: 'Stochastic (%K/%D)' },
  { key: 'pivots', label: 'Pivot points (prior bar)' },
]

const UP = 'var(--color-up)'
const DOWN = 'var(--color-down)'

export default function TradeChronograph({ pos, onClose }) {
  const [, force] = useState(0)
  useEffect(() => { const t = setInterval(() => force(n => n + 1), 1000); return () => clearInterval(t) }, [])
  const ticks = useLiveTicks(pos?.symbol ? [pos.symbol] : [])
  const [indicator, setIndicator] = useState('none')
  const [chartData, setChartData] = useState(null)
  const panelRef = useRef(null)

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

  // GSAP settle-in on open (W3.CSS's w3-animate-zoom covers the no-CDN case).
  useEffect(() => {
    const g = typeof window !== 'undefined' ? window.gsap : null
    if (g && panelRef.current) {
      g.fromTo(panelRef.current, { opacity: 0, scale: 0.92, y: 14 }, { opacity: 1, scale: 1, y: 0, duration: 0.35, ease: 'power2.out' })
    }
  }, [])

  if (!pos) return null

  const entry = Number(pos.entry ?? pos.entry_price)
  const sl = Number(pos.monitorSl ?? pos.current_sl ?? pos.sl)
  const tp1 = Number(pos.tp1 ?? pos.current_tp ?? pos.tp)
  const side = pos.side
  const volume = pos.lots ?? pos.volume ?? 0
  const price = liveMid(ticks, pos.symbol) ?? pos.currentPrice ?? entry
  const openedAt = pos.opened_at ?? pos.openedAt
  const tf = pos.timeframe || pos.tf
  const strat = pos.strategy ? (STRAT_SHORT[pos.strategy] || pos.strategy) : (pos.source && pos.source !== 'autopilot' ? 'manual' : null)

  const r = rMultiple({ entry, sl, side, price })
  const ms = elapsedMs(openedAt)
  const vel = velocityRPerHr({ r, ms })
  const slProx = slProximity({ entry, sl, side, price })
  const price5 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 5 }))

  // Trend annunciator — EMA20 slope over the fetched bars (real, not fabricated).
  const ema20 = chartData?.overlays?.ema20
  const trendVals = ema20?.filter(v => v != null) ?? []
  const trendDelta = trendVals.length >= 2 ? trendVals[trendVals.length - 1] - trendVals[0] : null
  const trend = trendDelta == null ? null : trendDelta > 0 ? 'UP' : trendDelta < 0 ? 'DOWN' : 'FLAT'

  // Selected indicator's latest value, plain digits — real, server-computed,
  // never fabricated; blank until bars have actually loaded.
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

  const pnl = Number(pos.netPnl ?? pos.estNetPnl ?? pos.estPnlQuote)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      {/* SOLID surface, not glass — a see-through card washes the PFD out. */}
      <div ref={panelRef} className="w3-animate-zoom bg-[var(--color-bg)] border border-[var(--color-border)] shadow-2xl rounded-2xl p-4 max-w-[420px] w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-bold">{pos.symbol}</span>
            <span className={isLong(side) ? 'text-[var(--color-up)] text-[12px]' : 'text-[var(--color-down)] text-[12px]'}>{isLong(side) ? 'Long' : 'Short'}</span>
            {strat && <span className="text-[10px] uppercase px-1 rounded bg-[var(--color-surface-2,rgba(120,120,120,0.15))] text-[var(--color-text-sub)]">{strat}</span>}
            {tf && <span className="text-[10px] text-[var(--color-text-sub)]">{tf}</span>}
            {trend && <span className="text-[10px]" style={{ color: trend === 'UP' ? UP : trend === 'DOWN' ? DOWN : 'var(--color-text-sub)' }}>EMA20 {trend}</span>}
          </div>
          <button type="button" onClick={onClose} className="text-[var(--color-text-sub)] text-[16px] leading-none px-1" aria-label="Close">×</button>
        </div>

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

        {/* The primary flight display — full width of the pop-up. */}
        <div className="flex justify-center">
          <CockpitPFD
            entry={Number.isFinite(entry) ? entry : null}
            sl={Number.isFinite(sl) ? sl : null}
            tp={Number.isFinite(tp1) ? tp1 : null}
            side={side} price={price}
            pnl={Number.isFinite(pnl) ? pnl : null} lots={volume}
            width={380}
          />
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px] mt-2">
          <span className="text-[var(--color-text-sub)]">Current price</span><span className="tabular-nums text-right font-semibold">{price5(price)}</span>
          <span className="text-[var(--color-text-sub)]">Velocity</span><span className="tabular-nums text-right font-semibold">{vel == null ? '—' : `${vel.toFixed(2)} R/hr`}</span>
          <span className="text-[var(--color-text-sub)]">Risk used (to stop)</span><span className="tabular-nums text-right font-semibold">{slProx == null ? '—' : `${Math.round(slProx * 100)}%`}</span>
          <span className="text-[var(--color-text-sub)]">Time in trade</span><span className="tabular-nums text-right font-semibold">{fmtDuration(ms)}</span>
          <span className="text-[var(--color-text-sub)]">Entry time</span><span className="tabular-nums text-right font-semibold">{openedAt ? new Date(openedAt).toLocaleString() : '—'}</span>
        </div>
        {indicator !== 'none' && (
          <p className="tabular-nums text-[12px] font-semibold mt-1.5 pt-1.5 border-t border-[var(--color-border)]">
            {indicatorLine ?? 'loading…'}
          </p>
        )}
        {/* Legend — what the instrument means, in words (never colour-only). */}
        <p className="text-[11px] leading-snug text-[var(--color-text-sub)] mt-1.5">
          Horizon level = your ENTRY price · nose up into sky = in profit, below into ground = in loss (±2R full scale) ·
          banked RIGHT = price converging on your TP, banked LEFT = diverging, wings level = holding ·
          left tape = P/L in R · right tape = live price with TP / entry / SL bugs · bottom strip = distance still to travel to the TP.
        </p>
      </div>
    </div>
  )
}
