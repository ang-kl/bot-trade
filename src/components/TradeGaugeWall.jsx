// TradeGaugeWall — per-open-position instrument cluster, replacing the P&L
// line chart (owner: "change ... from chart to gauges, each trade will have
// Attitude Indicator gauge style"). Two aviation-style gauges per trade:
//
//   Attitude Indicator — the horizon tilts with this trade's P&L: blue sky
//     rises on the profit side, orange ground rises on the loss side (never
//     literal red/green, matching every other P&L readout in the app). The
//     fixed aircraft "wings" crossing the horizon don't rotate — their
//     length reads the position's SIZE (lots), independent of direction, so
//     a big losing trade reads as long orange-tilted wings (higher stakes)
//     vs a small one (short wings, same tilt). The wingtip marker points
//     right when the trade is trending (P&L has moved consistently one way
//     over the last minute or so) or sits as a dot when it's choppy/flat.
//   Vertical Speed Indicator — needle deflection reads how FAST this
//     trade's P&L is moving right now (not its size): flat sits at 9
//     o'clock, a fast mover swings toward 12 (accelerating profit) or 6
//     (accelerating loss) — same mental model as an aircraft VSI, relabelled
//     "activity now."
//
// Session-only history, same pattern as the chart it replaces: sampled
// whenever Desk's own poll delivers a fresh snapshot (no extra network
// calls), reset on page reload.
import { useEffect, useRef, useState } from 'react'

const UP = 'var(--color-up)'
const DOWN = 'var(--color-down)'
const MAX_SAMPLES = 24 // ~2 min at the 5s active-poll rate — just enough for a rate-of-change

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const money = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

function AttitudeGauge({ pnl, volume, trending, size = 72 }) {
  // Bank angle isn't a literal reading — tanh keeps one outsized trade from
  // pinning the dial at a useless, always-maxed 90°.
  const bank = clamp(Math.tanh((pnl || 0) / 200) * 42, -42, 42)
  const wing = clamp(6 + Math.sqrt(Math.max(volume || 0, 0)) * 10, 6, 34)
  const up = (pnl || 0) >= 0
  const clipId = `ai-clip-${Math.round(size)}-${up ? 'u' : 'd'}`
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`Attitude indicator: ${up ? 'profit' : 'loss'} tilt, ${trending ? 'trending' : 'choppy'}`}>
      <circle cx="50" cy="50" r="46" fill="none" stroke="var(--color-border)" strokeWidth="2" />
      <clipPath id={clipId}><circle cx="50" cy="50" r="44" /></clipPath>
      <g clipPath={`url(#${clipId})`}>
        <g transform={`rotate(${bank} 50 50)`}>
          <rect x="-20" y="-100" width="140" height="150" fill={UP} opacity="0.32" />
          <rect x="-20" y="50" width="140" height="150" fill={DOWN} opacity="0.32" />
          <line x1="-20" y1="50" x2="120" y2="50" stroke={up ? UP : DOWN} strokeWidth="2" />
        </g>
      </g>
      {/* fixed aircraft symbol — wings stay level; only the horizon behind them tilts */}
      <line x1={50 - wing} y1="50" x2="44" y2="50" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <line x1="56" y1="50" x2={50 + wing} y2="50" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="50" cy="50" r="3" fill="currentColor" />
      {trending
        ? <path d={`M ${50 + wing} 50 l 7 -4.5 l 0 9 z`} fill="currentColor" />
        : <circle cx={50 + wing + 4.5} cy="50" r="2.5" fill="currentColor" opacity="0.55" />}
    </svg>
  )
}

function VsiGauge({ rate, size = 72 }) {
  // rate is normalized -1..1. 0 = 9 o'clock (dormant), +1 = 12 o'clock
  // (climbing fast), -1 = 6 o'clock (dropping fast).
  const deg = 180 - clamp(rate, -1, 1) * 90
  const rad = (deg * Math.PI) / 180
  const r = 38
  const nx = 50 + r * Math.cos(rad)
  const ny = 50 - r * Math.sin(rad)
  const up = rate >= 0
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Activity now">
      <circle cx="50" cy="50" r="46" fill="none" stroke="var(--color-border)" strokeWidth="2" />
      <path d="M 12 50 A 38 38 0 0 1 50 12" fill="none" stroke={UP} strokeWidth="3" opacity="0.45" />
      <path d="M 12 50 A 38 38 0 0 0 50 88" fill="none" stroke={DOWN} strokeWidth="3" opacity="0.45" />
      <line x1="50" y1="50" x2={nx} y2={ny} stroke={up ? UP : DOWN} strokeWidth="3" strokeLinecap="round" />
      <circle cx="50" cy="50" r="3.5" fill="currentColor" />
    </svg>
  )
}

export default function TradeGaugeWall({ positions = [], gridN = 4 }) {
  const historyRef = useRef({}) // positionId -> [{ t, pnl }]
  const [, forceTick] = useState(0)

  const signature = positions.map(p => `${p.positionId}:${Math.round((p.netPnl ?? p.estNetPnl ?? 0) * 100)}`).join('|')
  useEffect(() => {
    const t = Date.now()
    const hist = historyRef.current
    const liveIds = new Set(positions.map(p => String(p.positionId)))
    for (const id of Object.keys(hist)) if (!liveIds.has(id)) delete hist[id]
    for (const p of positions) {
      const v = Number(p.netPnl ?? p.estNetPnl ?? p.estPnlQuote)
      if (!Number.isFinite(v)) continue
      const id = String(p.positionId)
      const arr = hist[id] || (hist[id] = [])
      if (arr.length && t - arr[arr.length - 1].t < 1000) arr[arr.length - 1] = { t, pnl: v }
      else arr.push({ t, pnl: v })
      if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES)
    }
    forceTick(n => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  if (positions.length === 0) {
    return <p className="text-[13px] text-[var(--color-text-sub)] py-1">Flat — no open positions.</p>
  }

  const cols = gridN === 1 ? 'grid-cols-1 max-w-xs'
    : gridN === 4 ? 'grid-cols-1 sm:grid-cols-2'
    : gridN === 8 ? 'grid-cols-2 sm:grid-cols-4'
    : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-8'

  return (
    <div className={`grid ${cols} gap-2`}>
      {positions.map(p => {
        const id = String(p.positionId)
        const hist = historyRef.current[id] || []
        const pnl = Number(p.netPnl ?? p.estNetPnl ?? p.estPnlQuote)
        const first = hist[0]
        const last = hist[hist.length - 1]
        const elapsedMin = first && last && last.t > first.t ? (last.t - first.t) / 60000 : 0
        const rawRate = elapsedMin > 0 ? (last.pnl - first.pnl) / elapsedMin : 0
        const rate = Math.tanh(rawRate / 50)
        const trending = Math.abs(rate) > 0.15
        const long = p.side === 'BUY' || p.side === 'Long'
        const pnlOk = Number.isFinite(pnl)
        return (
          <div key={id} className={`rounded-[10px] p-2 glass-inset ${pnlOk ? (pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]') : 'text-[var(--color-text-sub)]'}`}>
            <div className="flex items-center justify-between text-[11px] mb-0.5">
              <span className="font-semibold text-[var(--color-text)]">{p.symbol}</span>
              <span className={long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>{long ? 'Long' : 'Short'}</span>
            </div>
            <div className="flex items-center justify-center gap-1">
              <AttitudeGauge pnl={pnl} volume={p.lots ?? p.volume ?? 0} trending={trending} />
              <VsiGauge rate={rate} />
            </div>
            <div className="text-center text-[12px] font-bold mt-0.5">{pnlOk ? money(pnl) : '—'}</div>
          </div>
        )
      })}
    </div>
  )
}
