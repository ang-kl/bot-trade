// ReportChart — professional analytics chart for Monitor, in the style of
// the analytics dashboard the owner referenced: multi-series with a violet
// equity area, blue (approved) and red (vetoed) decision lines, gridlines,
// date axis, legend, 7D/30D/All range pills, line/area toggle, and a hover
// tooltip with period-over-period change. Colours: blue/violet/red only.
import { useMemo, useRef, useState } from 'react'
import Card from './common/Card.jsx'

// Padding: PL leaves room for the decisions axis + its rotated label, PR for
// the equity axis on the right (owner: "missing gridline, axes, axis label"),
// PB for the date ticks + the axis title under them.
const W = 860, H = 320, PL = 60, PR = 74, PT = 16, PB = 46
const DAY = 86_400_000

// Owner (2026-07-24): "set one filter for 2 days, therefore is
// 2,7,14,30,60,90,180,all" — replaces the old 7D/30D/All trio.
const RANGE_DAYS = { '2D': 2, '7D': 7, '14D': 14, '30D': 30, '60D': 60, '90D': 90, '180D': 180, All: null }

function fmtN(v, d = 2) {
  if (v == null || Number.isNaN(v)) return '—'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: d })
}
function dayKey(iso) { return String(iso || '').slice(0, 10) }

// Owner (2026-07-25): "logarithmic chart way". Equity here is cumulative P&L,
// so it goes negative and a plain log10 is undefined for half its domain.
// This is a SIGNED (symmetric) log — sign(v) * log10(1 + |v|) — which is
// defined everywhere including 0, keeps losses below the axis where they
// belong, and still compresses a big range. The footnote says so, because a
// symlog axis is not the same thing as a log axis and shouldn't be labelled
// as one.
const symlog = (v) => Math.sign(v) * Math.log10(1 + Math.abs(v))
const NICE = [1, 2, 5]
/** Round axis maximum up to a 1/2/5 × 10^n step, so tick labels stay readable. */
function niceCeil(v) {
  if (!(v > 0)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  for (const n of NICE) if (v <= n * base) return n * base
  return 10 * base
}
function shortDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

export default function ReportChart({ allTrades, events }) {
  const [range, setRange] = useState('30D')
  const [style, setStyle] = useState('area')
  const [logScale, setLogScale] = useState(false)
  const [hover, setHover] = useState(null) // {i, px}
  const svgRef = useRef(null)

  const model = useMemo(() => {
    const rangeDays = RANGE_DAYS[range]
    const cutoff = rangeDays == null ? 0 : Date.now() - rangeDays * DAY

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
  const hasData = model.length >= 1
  // 1-2 active days: plot DOTS ONLY. No path is drawn, so nothing can
  // pretend to be a trend, but the range stops looking broken.
  const sparse = model.length < 3
  let geom = null
  if (hasData) {
    const x0 = model[0].t, x1 = model[model.length - 1].t
    const dMax = niceCeil(Math.max(1, ...model.map(r => Math.max(r.approved, r.vetoed))))
    const eLo = Math.min(0, ...model.map(r => r.equity))
    const eHi = Math.max(1e-9, ...model.map(r => r.equity))
    const tr = logScale ? symlog : (v => v)
    const plotH = H - PT - PB
    const X = t => PL + ((t - x0) / (x1 - x0 || 1)) * (W - PL - PR)
    // Decisions (left axis) and equity (right axis) keep independent scales —
    // counts and money share no units. Both honour the log toggle.
    const dSpan = tr(dMax) || 1
    const Yd = v => PT + (1 - tr(v) / dSpan) * plotH
    const eSpanLo = tr(eLo), eSpanHi = tr(eHi)
    const Ye = v => PT + (1 - (tr(v) - eSpanLo) / ((eSpanHi - eSpanLo) || 1)) * plotH
    const line = (get, Y) => model.map((r, i) => `${i ? 'L' : 'M'}${X(r.t).toFixed(1)},${Y(get(r)).toFixed(1)}`).join(' ')
    // 5 gridlines rather than 3, and each carries a value on BOTH axes:
    // decisions on the left, equity on the right, read at the same height.
    const FRACS = [0, 0.25, 0.5, 0.75, 1]
    const invD = (f) => {
      const t = dSpan * (1 - f)
      return logScale ? Math.pow(10, t) - 1 : t
    }
    const invE = (f) => {
      const t = eSpanLo + (eSpanHi - eSpanLo) * (1 - f)
      return logScale ? Math.sign(t) * (Math.pow(10, Math.abs(t)) - 1) : t
    }
    geom = {
      X, Yd, Ye, dMax, x0, x1,
      zeroEquityY: eLo < 0 && eHi > 0 ? Ye(0) : null,
      eqPath: line(r => r.equity, Ye),
      eqArea: `${line(r => r.equity, Ye)} L${X(x1).toFixed(1)},${Ye(Math.max(eLo, 0)).toFixed(1)} L${X(x0).toFixed(1)},${Ye(Math.max(eLo, 0)).toFixed(1)} Z`,
      apPath: line(r => r.approved, Yd),
      vePath: line(r => r.vetoed, Yd),
      ticksY: FRACS.map(f => ({
        y: PT + f * plotH,
        label: fmtN(invD(f), 0),
        labelR: fmtN(invE(f), 0),
      })),
      ticksX: model.filter((_, i) => i % Math.max(1, Math.ceil(model.length / 8)) === 0),
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
          {Object.keys(RANGE_DAYS).map(r => (
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
        <div className="flex gap-1">
          {[[false, 'Lin'], [true, 'Log']].map(([k, label]) => (
            <button key={label} type="button" onClick={() => setLogScale(k)}
              title={k ? 'Signed log scale — sign(v)·log10(1+|v|), so a negative equity curve still plots' : 'Linear scale'}
              className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold cursor-pointer ${logScale === k ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}>{label}</button>
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
          No activity in this range — this chart draws from the bot's decisions and closed trades. Widen the range to see more.
        </div>
      )}

      {hasData && (
        <div className="relative overflow-x-auto">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[700px] select-none" role="img"
            aria-label="bot activity chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            <defs>
              <linearGradient id="rcFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#a855f7" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#a855f7" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {/* Horizontal gridlines, with a value on BOTH axes at the same
                height: decisions/day on the left, equity on the right. */}
            {geom.ticksY.map(t => (
              <g key={t.y}>
                <line x1={PL} x2={W - PR} y1={t.y} y2={t.y} stroke="var(--color-border)" strokeWidth="0.6" />
                <text x={PL - 7} y={t.y + 4} fontSize="12" textAnchor="end" fill="var(--color-text-sub)">{t.label}</text>
                <text x={W - PR + 7} y={t.y + 4} fontSize="12" textAnchor="start" fill="#a855f7">{t.labelR}</text>
              </g>
            ))}
            {/* Vertical gridlines on the date ticks — they were missing, so a
                point could not be read back to its day without hovering. */}
            {geom.ticksX.map(r => (
              <line key={`v${r.t}`} x1={geom.X(r.t)} x2={geom.X(r.t)} y1={PT} y2={H - PB}
                stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="2 4" />
            ))}
            {/* Equity zero line — where cumulative P&L crosses break-even. */}
            {geom.zeroEquityY != null && (
              <line x1={PL} x2={W - PR} y1={geom.zeroEquityY} y2={geom.zeroEquityY}
                stroke="#a855f7" strokeWidth="0.9" strokeDasharray="5 4" opacity="0.55" />
            )}
            {/* The three axis lines themselves. */}
            <line x1={PL} x2={PL} y1={PT} y2={H - PB} stroke="var(--color-text-sub)" strokeWidth="1" />
            <line x1={W - PR} x2={W - PR} y1={PT} y2={H - PB} stroke="#a855f7" strokeWidth="1" opacity="0.7" />
            <line x1={PL} x2={W - PR} y1={H - PB} y2={H - PB} stroke="var(--color-text-sub)" strokeWidth="1" />
            {geom.ticksX.map(r => (
              <g key={r.t}>
                <line x1={geom.X(r.t)} x2={geom.X(r.t)} y1={H - PB} y2={H - PB + 4} stroke="var(--color-text-sub)" strokeWidth="1" />
                <text x={geom.X(r.t)} y={H - PB + 16} fontSize="12" textAnchor="middle" fill="var(--color-text-sub)">{shortDate(r.t)}</text>
              </g>
            ))}
            {/* Axis titles — every axis now says what it measures. */}
            <text x={PL - 46} y={PT + (H - PT - PB) / 2} fontSize="12" textAnchor="middle" fill="var(--color-text-sub)"
              transform={`rotate(-90 ${PL - 46} ${PT + (H - PT - PB) / 2})`}>decisions / day</text>
            <text x={W - PR + 58} y={PT + (H - PT - PB) / 2} fontSize="12" textAnchor="middle" fill="#a855f7"
              transform={`rotate(90 ${W - PR + 58} ${PT + (H - PT - PB) / 2})`}>equity ({logScale ? 'signed log' : 'linear'})</text>
            <text x={PL + (W - PL - PR) / 2} y={H - 6} fontSize="12" textAnchor="middle" fill="var(--color-text-sub)">
              day (UTC){logScale ? ' · both axes signed-log' : ''}
            </text>
            {!sparse && style === 'area' && <path d={geom.eqArea} fill="url(#rcFill)" />}
            {!sparse && <path d={geom.eqPath} fill="none" stroke="#a855f7" strokeWidth="2.5" strokeLinejoin="round" />}
            {!sparse && <path d={geom.apPath} fill="none" stroke="var(--color-up)" strokeWidth="2" strokeLinejoin="round" />}
            {!sparse && <path d={geom.vePath} fill="none" stroke="var(--color-down)" strokeWidth="2" strokeLinejoin="round" />}
            {sparse && model.map(r => (
              <g key={r.t}>
                <circle cx={geom.X(r.t)} cy={geom.Ye(r.equity)} r="4.5" fill="#a855f7" />
                <circle cx={geom.X(r.t)} cy={geom.Yd(r.approved)} r="4" fill="var(--color-up)" />
                <circle cx={geom.X(r.t)} cy={geom.Yd(r.vetoed)} r="4" fill="var(--color-down)" />
              </g>
            ))}
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
      <p className="mt-1 text-[12px] text-[var(--color-text-sub)]">
        Left axis decisions/day · right axis violet equity, its own scale · dashed violet line is equity break-even · live-updates every 20s.
        {logScale && ' Log here is a SIGNED log — sign(v)·log10(1+|v|) — because cumulative equity goes negative and a plain log10 is undefined there.'}
        {sparse && hasData && ' Only 1–2 active days in this range, so points are shown as dots — a connecting line would imply a trend that is not there.'}
      </p>
    </Card>
  )
}
