// TradeGaugeWall — per-open-position instrument cluster, replacing the P&L
// line chart (owner: "change ... from chart to gauges, each trade will have
// Attitude Indicator gauge style"). Two aviation-style gauges per trade,
// each paired with a graduated numeric scale (owner: "where are the numeric
// intervals, indicators, and text arranged on a dial chart to clearly
// communicate progress toward a KPI or target value"):
//
//   Attitude Indicator — the horizon tilts with this trade's progress in
//     RISK units (R-multiple: how far price has moved from entry, scaled by
//     the distance to this trade's own stop) — blue sky rises on the
//     profit side, orange ground on the loss side. R is computed straight
//     from a LIVE price tick against entry/SL, not from the broker's
//     polled dollar P&L, so it updates the instant a tick arrives and needs
//     no per-instrument contract-value conversion (unlike a dollar figure,
//     "price moved half its stop-distance" means the same thing on every
//     symbol). The scale strip below reads the current R directly. The
//     fixed aircraft "wings" don't rotate — their length reads position
//     SIZE (lots); the wingtip shows an arrow when trending, a dot when
//     choppy/flat.
//   Vertical Speed Indicator — needle + scale strip read how fast R is
//     changing right now (R per minute) — flat sits at 9 o'clock, a fast
//     mover swings toward 12 (accelerating in profit) or 6 (accelerating
//     against). Sampled from the SAME live ticks, so it moves sub-second
//     while the market's active instead of waiting on a poll.
//
// Grid selector semantics (owner: "one chart means one overview combination
// of all open trade symbols, four means four trade symbol"): 1 = a single
// COMBINED portfolio tile (lots-weighted average R across every open
// position); 4/8/16 = that many INDIVIDUAL trade tiles, capped (an overflow
// note shows if there are more open positions than the grid size).
//
// The dollar P&L printed under each tile is still the broker-truth polled
// figure (unchanged) — R and its rate are a live, instrument-agnostic
// PROXY for "how is this trade doing right now," not a replacement for the
// exact money number.
import { useEffect, useId, useState } from 'react'
import { useLiveTicks, liveMid } from '../lib/useLiveTicks.js'
import { STRAT_SHORT } from '../lib/strategy-labels.js'

const UP = 'var(--color-up)'
const DOWN = 'var(--color-down)'
const MAX_SAMPLES = 40 // ~2 min of tick-driven samples — enough for a rate-of-change
const SIZE = 116 // owner: "make it bigger for me to understand"

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const money = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const isLong = (side) => side === 'BUY' || side === 'Long' || side === 'long'

/** R-multiple: how far price has travelled from entry, in units of this trade's own stop distance. */
function rMultiple(entry, sl, side, price) {
  if (entry == null || sl == null || price == null) return null
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  const dir = isLong(side) ? 1 : -1
  return ((price - entry) * dir) / risk
}

// Graduated scale strip: tick marks + numbers + a filled bar from zero to
// the current value. This is the "numeric intervals/indicators" the plain
// dials were missing — the dial shows shape, this shows the actual number
// against a fixed, labelled range.
function ScaleStrip({ value, min, max, ticks, width = 108, height = 22 }) {
  const w = width - 6
  const x = (v) => 3 + clamp((v - min) / (max - min), 0, 1) * w
  const up = (value ?? 0) >= 0
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={value == null ? 'no reading yet' : `${value.toFixed(2)}`}>
      <line x1={x(min)} y1="8" x2={x(max)} y2="8" stroke="var(--color-border)" strokeWidth="2" />
      {ticks.map(t => (
        <g key={t}>
          <line x1={x(t)} y1="4" x2={x(t)} y2="12" stroke="var(--color-text-sub)" strokeWidth="1" />
          <text x={x(t)} y={height - 1} fontSize="6.5" textAnchor="middle" fill="var(--color-text-sub)">{t > 0 ? `+${t}` : t}</text>
        </g>
      ))}
      {value != null && (
        <>
          <line x1={x(0)} y1="8" x2={x(clamp(value, min, max))} y2="8" stroke={up ? UP : DOWN} strokeWidth="3.5" strokeLinecap="round" />
          <circle cx={x(clamp(value, min, max))} cy="8" r="4" fill={up ? UP : DOWN} stroke="var(--color-bg)" strokeWidth="1" />
        </>
      )}
    </svg>
  )
}

function AttitudeGauge({ r, volume, trending, size = SIZE }) {
  // ±2R maps to the dial's full ±42° tilt — tanh-free since R is already a
  // bounded, meaningful unit (unlike a raw dollar figure).
  const bank = clamp((r ?? 0) * 21, -42, 42)
  const wing = clamp(size * 0.08 + Math.sqrt(Math.max(volume || 0, 0)) * (size * 0.14), size * 0.08, size * 0.47)
  const up = (r ?? 0) >= 0
  const cx = size / 2
  const clipId = `ai-clip-${useId()}`
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Attitude: ${r == null ? 'no reading yet' : `${r.toFixed(2)}R`}, ${trending ? 'trending' : 'choppy'}, volume ${volume}`}>
        <circle cx={cx} cy={cx} r={cx - 3} fill="none" stroke="var(--color-border)" strokeWidth="2" />
        <clipPath id={clipId}><circle cx={cx} cy={cx} r={cx - 5} /></clipPath>
        <g clipPath={`url(#${clipId})`}>
          <g transform={`rotate(${bank} ${cx} ${cx})`}>
            <rect x={-cx * 0.4} y={-cx * 2} width={size * 1.4} height={size * 1.5} fill={UP} opacity="0.32" />
            <rect x={-cx * 0.4} y={cx} width={size * 1.4} height={size * 1.5} fill={DOWN} opacity="0.32" />
            <line x1={-cx * 0.4} y1={cx} x2={size * 1.2} y2={cx} stroke={up ? UP : DOWN} strokeWidth="2" />
          </g>
        </g>
        {/* fixed aircraft symbol — wings stay level; only the horizon behind them tilts */}
        <line x1={cx - wing} y1={cx} x2={cx - size * 0.06} y2={cx} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <line x1={cx + size * 0.06} y1={cx} x2={cx + wing} y2={cx} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <circle cx={cx} cy={cx} r={size * 0.03} fill="currentColor" />
        {trending
          ? <path d={`M ${cx + wing} ${cx} l ${size * 0.08} ${-size * 0.05} l 0 ${size * 0.1} z`} fill="currentColor" />
          : <circle cx={cx + wing + size * 0.05} cy={cx} r={size * 0.025} fill="currentColor" opacity="0.55" />}
      </svg>
      <ScaleStrip value={r} min={-2} max={2} ticks={[-2, -1, 0, 1, 2]} width={size - 6} />
      <span className="text-[9px] text-[var(--color-text-sub)] leading-tight text-center mt-0.5">
        Attitude — {r == null ? 'no SL set' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`}<br />{(volume || 0).toFixed(2)} lots · {trending ? 'trending' : 'choppy'}
      </span>
    </div>
  )
}

function VsiGauge({ rate, ratePerMin, size = SIZE }) {
  // rate is normalized -1..1 for the needle. 0 = 9 o'clock (dormant), +1 =
  // 12 o'clock (climbing fast), -1 = 6 o'clock (dropping fast).
  const deg = 180 - clamp(rate, -1, 1) * 90
  const rad = (deg * Math.PI) / 180
  const cx = size / 2
  const r = cx * 0.82
  const nx = cx + r * Math.cos(rad)
  const ny = cx - r * Math.sin(rad)
  const up = rate >= 0
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Activity: ${ratePerMin == null ? 'settling' : `${ratePerMin.toFixed(2)}R per minute`}`}>
        <circle cx={cx} cy={cx} r={cx - 3} fill="none" stroke="var(--color-border)" strokeWidth="2" />
        <path d={`M ${cx - r} ${cx} A ${r} ${r} 0 0 1 ${cx} ${cx - r}`} fill="none" stroke={UP} strokeWidth="3" opacity="0.45" />
        <path d={`M ${cx - r} ${cx} A ${r} ${r} 0 0 0 ${cx} ${cx + r}`} fill="none" stroke={DOWN} strokeWidth="3" opacity="0.45" />
        <line x1={cx} y1={cx} x2={nx} y2={ny} stroke={up ? UP : DOWN} strokeWidth="3" strokeLinecap="round" />
        <circle cx={cx} cy={cx} r={size * 0.035} fill="currentColor" />
      </svg>
      <ScaleStrip value={ratePerMin} min={-1} max={1} ticks={[-1, -0.5, 0, 0.5, 1]} width={size - 6} />
      <span className="text-[9px] text-[var(--color-text-sub)] leading-tight text-center mt-0.5">
        Activity — {ratePerMin == null ? 'settling…' : `${ratePerMin >= 0 ? '+' : ''}${ratePerMin.toFixed(2)}R/min`}
      </span>
    </div>
  )
}

/**
 * History-tracked R samples → current rate-of-change + trending flag. Each
 * GaugeTile instance owns its own ref (React keys the tile by position id),
 * so this is a plain array, not an id-keyed map. Samples are appended in an
 * EFFECT, not during render — mutating a ref straight in the render body
 * would double-sample under StrictMode's dev double-render.
 */
function useTileSeries(r) {
  // History itself is the state (appended on the external signal — a fresh
  // R arriving); rate/trending are PURE derivations from it at render time,
  // not a second round-trip through an effect+setState.
  const [hist, setHist] = useState([])
  useEffect(() => {
    if (r == null) return
    // Genuinely syncing an external signal (a fresh live-tick-derived R) into
    // an accumulated rolling buffer — there's no source of truth to derive
    // this from at render time, unlike the mirrored-prop case this lint rule
    // targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHist(prev => {
      const t = Date.now()
      const next = prev.length && t - prev[prev.length - 1].t < 500
        ? [...prev.slice(0, -1), { t, r }]
        : [...prev, { t, r }]
      return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
    })
  }, [r])
  const first = hist[0]
  const last = hist[hist.length - 1]
  const elapsedMin = first && last && last.t > first.t ? (last.t - first.t) / 60000 : 0
  const ratePerMin = elapsedMin > 0 ? (last.r - first.r) / elapsedMin : null
  return {
    rate: ratePerMin == null ? 0 : Math.tanh(ratePerMin / 0.5),
    ratePerMin,
    trending: ratePerMin != null && Math.abs(ratePerMin) > 0.15,
  }
}

// Minutes since an ISO timestamp, or null. Framework-free so the monitor-review
// line reads the same everywhere.
function minsSince(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((Date.now() - t) / 60000))
}

function GaugeTile({ label, side, r, volume, pnl, strategy, source, lastCheckAt, lastCheckAction, thesisStatus, monitorSl }) {
  const { rate, ratePerMin, trending } = useTileSeries(r)
  const pnlOk = Number.isFinite(pnl)
  // Proof the monitor is actually reviewing THIS position (owner: "how do I know
  // you are reviewing each one ... watch stop-loss"). Green when reviewed
  // recently, amber when the review is stale (>15m), red when never reviewed —
  // so a silent/stalled monitor is visible, not hidden behind a promise.
  const reviewAge = minsSince(lastCheckAt)
  const reviewColor = reviewAge == null ? 'var(--color-down)' : reviewAge > 15 ? 'var(--color-warning-text)' : 'var(--color-up)'
  const reviewText = reviewAge == null
    ? 'not yet reviewed'
    : `reviewed ${reviewAge === 0 ? 'just now' : `${reviewAge}m ago`}${lastCheckAction ? ` · ${String(lastCheckAction).toUpperCase()}` : ''}${thesisStatus ? ` · thesis ${thesisStatus}` : ''}`
  // Attribution: bot positions carry a strategy; adopted/manual broker fills
  // don't (owner: "why missing Strategies in the open trade"). Show the short
  // strategy code when known, else flag it as an external/manual position so a
  // blank isn't mistaken for a bug.
  const stratTag = strategy
    ? (STRAT_SHORT[strategy] || strategy)
    : (source && source !== 'autopilot' ? 'manual' : null)
  return (
    <div className={`rounded-[10px] p-2 glass-inset ${pnlOk ? (pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]') : 'text-[var(--color-text-sub)]'}`}>
      <div className="flex items-center justify-between text-[11px] mb-0.5">
        <span className="flex items-center gap-1 min-w-0">
          <span className="font-semibold text-[var(--color-text)]">{label}</span>
          {stratTag && (
            <span
              className="text-[9px] uppercase tracking-wide px-1 rounded bg-[var(--color-surface-2,rgba(120,120,120,0.15))] text-[var(--color-text-sub)] truncate"
              title={strategy ? `Opened by strategy: ${strategy}` : 'Manual / external position — no bot strategy attached'}
            >
              {stratTag}
            </span>
          )}
        </span>
        {side != null && <span className={isLong(side) ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>{isLong(side) ? 'Long' : 'Short'}</span>}
      </div>
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <AttitudeGauge r={r} volume={volume} trending={trending} />
        <VsiGauge rate={rate} ratePerMin={ratePerMin} />
      </div>
      <div className="text-center text-[13px] font-bold mt-1">{pnlOk ? money(pnl) : '—'}</div>
      {/* Monitor review record — the verifiable proof each position is watched. */}
      <div className="mt-1 pt-1 border-t border-[var(--color-border)] text-[9px] leading-tight flex items-center justify-between gap-1">
        <span style={{ color: reviewColor }} className="truncate" title={lastCheckAt ? `Last monitor review at ${lastCheckAt}` : 'The monitor has not reviewed this position yet'}>
          ● {reviewText}
        </span>
        <span className={`shrink-0 tabular-nums ${monitorSl != null ? 'text-[var(--color-text-sub)]' : 'text-[var(--color-down)]'}`} title={monitorSl != null ? 'Stop-loss the monitor is managing' : 'NO stop-loss tracked by the monitor'}>
          {monitorSl != null ? `SL ${Number(monitorSl).toLocaleString(undefined, { maximumFractionDigits: 5 })}` : 'no SL'}
        </span>
      </div>
    </div>
  )
}

export default function TradeGaugeWall({ positions = [], gridN = 4 }) {
  const symbols = [...new Set(positions.map(p => p.symbol).filter(Boolean))]
  const ticks = useLiveTicks(symbols)

  if (positions.length === 0) {
    return <p className="text-[13px] text-[var(--color-text-sub)] py-1">Flat — no open positions.</p>
  }

  const withR = positions.map(p => {
    const price = liveMid(ticks, p.symbol) ?? p.currentPrice ?? null
    const r = rMultiple(p.entry, p.sl, p.side, price)
    const pnl = Number(p.netPnl ?? p.estNetPnl ?? p.estPnlQuote)
    return { p, r, pnl: Number.isFinite(pnl) ? pnl : null }
  })

  if (gridN === 1) {
    // Combined portfolio view (owner: "one chart means one overview
    // combination of all open trade symbols") — lots-weighted average R
    // across every position that has a stop set to compute R from.
    const withValidR = withR.filter(x => x.r != null)
    const totalLots = withR.reduce((s, x) => s + (Number(x.p.lots) || 0), 0)
    const weightedR = withValidR.length
      ? withValidR.reduce((s, x) => s + x.r * (Number(x.p.lots) || 1), 0) / withValidR.reduce((s, x) => s + (Number(x.p.lots) || 1), 0)
      : null
    const totalPnl = withR.reduce((s, x) => s + (x.pnl || 0), 0)
    const longs = positions.filter(p => isLong(p.side)).length
    return (
      <div className="grid grid-cols-1 max-w-xs gap-2">
        <GaugeTile
          label={`Portfolio · ${positions.length} open (${longs}L/${positions.length - longs}S)`}
          side={null}
          r={weightedR}
          volume={totalLots}
          pnl={totalPnl}
        />
      </div>
    )
  }

  const shown = withR.slice(0, gridN)
  const overflow = withR.length - shown.length
  const cols = gridN === 4 ? 'grid-cols-1 sm:grid-cols-2'
    : gridN === 8 ? 'grid-cols-2 sm:grid-cols-4'
    : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-8'

  return (
    <div>
      <div className={`grid ${cols} gap-2`}>
        {shown.map(({ p, r, pnl }) => (
          <GaugeTile key={p.positionId} label={p.symbol} side={p.side} r={r} volume={p.lots ?? p.volume ?? 0} pnl={pnl} strategy={p.strategy} source={p.source} lastCheckAt={p.lastCheckAt} lastCheckAction={p.lastCheckAction} thesisStatus={p.thesisStatus} monitorSl={p.monitorSl ?? p.sl} />
        ))}
      </div>
      {overflow > 0 && (
        <p className="text-[11px] text-[var(--color-text-sub)] mt-1">+{overflow} more open position{overflow > 1 ? 's' : ''} not shown at this grid size — pick a bigger one, or 1 for the combined view.</p>
      )}
    </div>
  )
}
