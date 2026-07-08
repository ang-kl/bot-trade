// ReportChart — professional analytics chart for Monitor, in the style of
// the analytics dashboard the owner referenced: multi-series with a violet
// equity area, blue (approved) and red (vetoed) decision lines, gridlines,
// date axis, legend, 7D/30D/All range pills, line/area toggle, and a hover
// tooltip with period-over-period change. Colours: blue/violet/red only.
import { useMemo, useRef, useState } from 'react'
import Card from './common/Card.jsx'

const W = 860, H = 300, PL = 46, PR = 16, PT = 14, PB = 30
const DAY = 86_400_000

function fmtN(v, d = 2) {
  if (v == null || Number.isNaN(v)) return '—'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: d })
}
function dayKey(iso) { return String(iso || '').slice(0, 10) }
function shortDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

export default function ReportChart({ allTrades, events }) {
  const [range, setRange] = useState('30D')
  const [style, setStyle] = useState('area')
  const [hover, setHover] = useState(null) // {i, px}
  const svgRef = useRef(null)

  const model = useMemo(() => {
    const cutoff = range === 'All' ? 0 : Date.now() - (range === '7D' ? 7 : 30) * DAY

    // Day buckets across all series so the x-axis is shared.
    const days = new Map() // key -> { t, approved, vetoed, pnl }
    const bucket = (k) => {
      if (!days.has(k)) days.set(k, { t: new Date(k).getTime(), approved: 0, vetoed: 0, pnl: 0 })
      return days.get(k)
    }
    for (const e of events) {
      const k = dayKey(e.created_at)
      if (!k || new Date(k).getTime() < cutoff) continue
      const b = bucket(k)
      if (e.approved) b.approved++; else b.vetoed++
    }
    for (const t of allTrades) {
      const k = dayKey(t.closed_at)
      if (!k || t.pnl == null || new Date(k).getTime() < cutoff) continue
      bucket(k).pnl += Number(t.pnl)
    }
    const rows = [...days.values()].sort((a, b) => a.t - b.t)
    let eq = 0
    for (const r of rows) { eq += r.pnl; r.equity = eq }
    return rows
  }, [allTrades, events, range])

  // Two points interpolate into meaningless straight lines that read as a
  // real trend (owner flagged exactly that) — draw only from 3 active days.
  const hasData = model.length >= 3
  let geom = null
  if (hasData) {
    const x0 = model[0].t, x1 = model[model.length - 1].t
    const dMax = Math.max(1, ...model.map(r => Math.max(r.approved, r.vetoed)))
    const eLo = Math.min(0, ...model.map(r => r.equity))
    const eHi = Math.max(1e-9, ...model.map(r => r.equity))
    const X = t => PL + ((t - x0) / (x1 - x0 || 1)) * (W - PL - PR)
    const Yd = v => PT + (1 - v / dMax) * (H - PT - PB)          // decisions scale
    const Ye = v => PT + (1 - (v - eLo) / (eHi - eLo || 1)) * (H - PT - PB) // equity scale
    const line = (get, Y) => model.map((r, i) => `${i ? 'L' : 'M'}${X(r.t).toFixed(1)},${Y(get(r)).toFixed(1)}`).join(' ')
    geom = {
      X, Yd, Ye, dMax,
      eqPath: line(r => r.equity, Ye),
      eqArea: `${line(r => r.equity, Ye)} L${X(x1).toFixed(1)},${H - PB} L${X(x0).toFixed(1)},${H - PB} Z`,
      apPath: line(r => r.approved, Yd),
      vePath: line(r => r.vetoed, Yd),
      ticksY: [0, 0.5, 1].map(f => ({ y: PT + f * (H - PT - PB), label: fmtN(dMax * (1 - f), 0) })),
      ticksX: model.filter((_, i) => i % Math.ceil(model.length / 8) === 0),
    }
  }

  const onMove = (e) => {
    if (!hasData || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = 0, bestD = Infinity
    model.forEach((r, i) => {
      const d = Math.abs(geom.X(r.t) - px)
      if (d < bestD) { bestD = d; best = i }
    })
    setHover({ i: best })
  }

  const hv = hover && hasData ? model[hover.i] : null
  const prev = hover && hover.i > 0 ? model[hover.i - 1] : null
  const pct = (a, b) => (b ? `${a - b >= 0 ? '+' : ''}${fmtN(((a - b) / Math.abs(b)) * 100, 1)}%` : '')

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h2 className="text-[13px] font-semibold">Activity — decisions & equity</h2>
        <div className="flex gap-1 ml-1">
          {['7D', '30D', 'All'].map(r => (
            <button key={r} type="button" onClick={() => setRange(r)}
              className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold cursor-pointer ${range === r ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}>{r}</button>
          ))}
        </div>
        <div className="flex gap-1">
          {[['area', 'Area'], ['line', 'Line']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setStyle(k)}
              className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold cursor-pointer ${style === k ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}>{label}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-[12px] text-[var(--color-text-sub)]">
          <span><span className="inline-block w-2.5 h-2.5 rounded-full align-middle mr-1" style={{ background: '#a855f7' }} />equity</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-full align-middle mr-1" style={{ background: 'var(--color-up)' }} />approved/day</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-full align-middle mr-1" style={{ background: 'var(--color-down)' }} />vetoed/day</span>
        </div>
      </div>

      {!hasData && (
        <div className="text-[13px] text-[var(--color-text-sub)] py-6">
          Not enough history yet — this chart draws from the bot's decisions and closed trades and appears after 3 active days in this range. Two points would just be a straight line pretending to be a trend.
        </div>
      )}

      {hasData && (
        <div className="relative">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full select-none" role="img"
            aria-label="bot activity chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            <defs>
              <linearGradient id="rcFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#a855f7" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#a855f7" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {geom.ticksY.map(t => (
              <g key={t.y}>
                <line x1={PL} x2={W - PR} y1={t.y} y2={t.y} stroke="var(--color-border)" strokeWidth="0.6" />
                <text x={PL - 6} y={t.y + 3} fontSize="10" textAnchor="end" fill="var(--color-text-sub)">{t.label}</text>
              </g>
            ))}
            {geom.ticksX.map(r => (
              <text key={r.t} x={geom.X(r.t)} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--color-text-sub)">{shortDate(r.t)}</text>
            ))}
            {style === 'area' && <path d={geom.eqArea} fill="url(#rcFill)" />}
            <path d={geom.eqPath} fill="none" stroke="#a855f7" strokeWidth="2.5" strokeLinejoin="round" />
            <path d={geom.apPath} fill="none" stroke="var(--color-up)" strokeWidth="2" strokeLinejoin="round" />
            <path d={geom.vePath} fill="none" stroke="var(--color-down)" strokeWidth="2" strokeLinejoin="round" />
            {hv && (
              <g>
                <line x1={geom.X(hv.t)} x2={geom.X(hv.t)} y1={PT} y2={H - PB} stroke="var(--color-text-sub)" strokeWidth="0.8" strokeDasharray="3 3" />
                <circle cx={geom.X(hv.t)} cy={geom.Ye(hv.equity)} r="4" fill="#a855f7" />
                <circle cx={geom.X(hv.t)} cy={geom.Yd(hv.approved)} r="3.5" fill="var(--color-up)" />
                <circle cx={geom.X(hv.t)} cy={geom.Yd(hv.vetoed)} r="3.5" fill="var(--color-down)" />
              </g>
            )}
          </svg>
          {hv && (
            <div className="pointer-events-none absolute top-2 glass-panel rounded-[10px] px-3 py-2 text-[12px] leading-5"
              style={{ left: `${Math.min(78, Math.max(2, (geom.X(hv.t) / W) * 100))}%` }}>
              <div className="font-semibold">{shortDate(hv.t)}</div>
              <div><span style={{ color: '#a855f7' }}>●</span> equity {fmtN(hv.equity)} {prev && <span className="text-[var(--color-text-sub)]">({pct(hv.equity, prev.equity)})</span>}</div>
              <div><span style={{ color: 'var(--color-up)' }}>●</span> approved {hv.approved}</div>
              <div><span style={{ color: 'var(--color-down)' }}>●</span> vetoed {hv.vetoed}</div>
            </div>
          )}
        </div>
      )}
      <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">Left axis: decisions/day · violet equity uses its own scale · live-updates every 20s.</p>
    </Card>
  )
}
