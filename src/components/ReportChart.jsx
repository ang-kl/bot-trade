import { performanceCurve } from '../lib/performance-curve.js'
// ReportChart — rebuilt 2026-07-25 after the owner asked whether the old
// control set made sense to a reader. My answer was no, and this is the
// consequence.
//
// WHAT WENT, AND WHY
//  · Area/Line toggle — changed nothing you could read or conclude. A
//    preference dressed as an analysis control.
//  · Lin/Log toggle — built that same morning because it was asked for, and it
//    was correct, but log scale earns its keep across ORDERS OF MAGNITUDE. This
//    equity spans roughly one. It compressed nothing useful and it flattened
//    the one shape an equity curve exists to show: how deep a drawdown is
//    relative to the growth around it.
//  · 8 range pills — with a fortnight of history, 30D/60D/90D/180D/All all
//    rendered the identical chart and 2D rendered a dot. A control that cannot
//    change what you see is furniture. Four remain.
//  · The dual axis — decisions/day are discrete daily counts, equity is a
//    cumulative curve. They shared an x-axis and nothing else: different units,
//    different natural mark, different question. One frame with two y-axes
//    implies a relationship between veto counts and equity that nothing here
//    demonstrates. That is the textbook misuse of a second axis.
//
// WHAT ARRIVED
//  · Two stacked panels, one shared x-axis, one range control.
//  · Equity panel answers "is the account growing, and how deep are the
//    holes": the curve, its own high-water mark, and the drawdown shaded
//    between them. Max drawdown was already in the tiles and appeared nowhere
//    on the chart — it is the most important shape in the picture.
//  · Decisions panel answers "is the bot deciding, and what share does it
//    refuse": approved/vetoed as stacked daily bars, which is the mark daily
//    counts actually want, with the veto rate as the headline.
import { useEffect, useMemo, useRef, useState } from 'react'
import { agentGet, pageAsleep } from '../lib/agent-api.js'
import Card from './common/Card.jsx'
import Segmented from './common/Segmented.jsx'

// Owner (2026-07-25): "where are the axes, gridlines, markings and why so big
// chart" — the axes existed but were drawn at 0.5px in the faint border
// colour, invisible on the glass background; and the SVG scaled with the
// container, so a wide screen blew it up. Now: gridlines at every nice-valued
// tick in a colour that survives the glass, tick MARKS on both axes, and the
// rendered width is capped (CHART_MAX_W) so the chart stays chart-sized.
const W = 860
const EQ_H = 150, DEC_H = 76, PL = 58, PR = 18, PT = 14, PB = 26
const CHART_MAX_W = 900
const GRID = 'var(--color-text-sub)' // gridlines: visible, but at low opacity

// Four ranges, not eight. Add more when there is history that distinguishes
// them — a pill that renders the same chart as its neighbour is noise.
const RANGE_DAYS = { '7D': 7, '30D': 30, '90D': 90, All: null }

function fmtN(v, d = 2) {
  if (v == null || Number.isNaN(v)) return '—'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: d })
}
const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short', timeZone: 'UTC' })
const NICE = [1, 2, 5]
function niceCeil(v) {
  if (!(v > 0)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  for (const n of NICE) if (v <= n * base) return n * base
  return 10 * base
}
// Ticks at round values (…-500, 0, 500…), not at arbitrary fractions of the
// data range — a gridline you can't name is a decoration, not a marking.
function niceTicks(lo, hi, target = 4) {
  const step = niceCeil(((hi - lo) || 1) / target)
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v)
  return out.length >= 2 ? out : [lo, hi]
}

export default function ReportChart({ populationReport, accountId = 'all', daily, accounts = [] }) {
  const [range, setRange] = useState('30D')
  const [selected, setSelected] = useState(null), [decisions, setDecisions] = useState(null)
  const chartAccount = accountId !== 'all' ? accountId : accounts.some(a => String(a.account_id) === selected)
    ? selected : accounts[0]?.account_id || 'all'
  const zone = populationReport?.timeZone || 'UTC'
  useEffect(() => {
    if (accountId !== 'all' || chartAccount === 'all') return
    let stopped = false, running = false
    const refresh = async () => {
      if (stopped || running || pageAsleep()) return
      running = true
      try {
        const r = await agentGet(`/state/decisions-daily?days=90&account=${encodeURIComponent(chartAccount)}&timeZone=${encodeURIComponent(zone)}`)
        if (!stopped) setDecisions({ accountId: chartAccount, zone, rows: r.accountId === String(chartAccount) ? r.rows : null })
      } catch { if (!stopped) setDecisions(null) }
      finally { running = false }
    }
    const kick = setTimeout(refresh, 0), timer = setInterval(refresh, 60000)
    window.addEventListener('agent-wake', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { stopped = true; clearTimeout(kick); clearInterval(timer)
      window.removeEventListener('agent-wake', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [accountId, chartAccount, zone])
  const [hover, setHover] = useState(null)
  const svgRef = useRef(null)

  const scopedDaily = accountId !== 'all' ? daily : decisions?.accountId === chartAccount && decisions?.zone === zone ? decisions.rows : null
  const curve = useMemo(() => performanceCurve(populationReport, chartAccount, scopedDaily, RANGE_DAYS[range]), [populationReport, chartAccount, scopedDaily, range])
  const model = curve.rows

  const hasData = model.length >= 1
  // 1–2 active days: dots, no path. Two points joined by a line is a straight
  // line pretending to be a trend.
  const sparse = model.length < 3

  const geom = useMemo(() => {
    if (!hasData) return null
    const x0 = model[0].t, x1 = model[model.length - 1].t
    const X = t => PL + ((t - x0) / (x1 - x0 || 1)) * (W - PL - PR)
    const eLo = Math.min(0, ...model.map(r => r.equity))
    const eHi = Math.max(1e-9, ...model.map(r => r.peak))
    const Ye = v => PT + (1 - (v - eLo) / ((eHi - eLo) || 1)) * (EQ_H - PT - PB)
    const dMax = niceCeil(Math.max(1, ...model.map(r => r.approved + r.vetoed)))
    const decTop = EQ_H + 6
    const decBase = decTop + DEC_H - PB
    const barH = v => ((v / dMax) * (DEC_H - PB - 6))
    const step = (W - PL - PR) / Math.max(1, model.length)
    const barW = Math.max(2, Math.min(18, step * 0.62))
    const line = (get) => model.map((r, i) => `${i ? 'L' : 'M'}${X(r.t).toFixed(1)},${Ye(get(r)).toFixed(1)}`).join(' ')
    return {
      X, Ye, eLo, eHi, dMax, decTop, decBase, barH, barW, x0, x1,
      eqPath: line(r => r.equity),
      peakPath: line(r => r.peak),
      // Drawdown band: along the peak, back along equity.
      ddArea: `${line(r => r.peak)} ${[...model].reverse().map(r => `L${X(r.t).toFixed(1)},${Ye(r.equity).toFixed(1)}`).join(' ')} Z`,
      ticksE: niceTicks(eLo, eHi).map(v => ({ y: Ye(v), label: fmtN(v, 0), zero: v === 0 })),
      ticksX: model.filter((_, i) => i % Math.max(1, Math.ceil(model.length / 8)) === 0),
    }
  }, [model, hasData])

  const totals = useMemo(() => {
    const appr = model.reduce((s, r) => s + r.approved, 0)
    const veto = model.reduce((s, r) => s + r.vetoed, 0)
    const maxDd = model.reduce((m, r) => Math.min(m, r.dd), 0)
    return { appr, veto, decisions: appr + veto, vetoPct: appr + veto ? Math.round((veto / (appr + veto)) * 100) : null, maxDd }
  }, [model])

  const onMove = (e) => {
    if (!hasData || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = 0, bestD = Infinity
    model.forEach((r, i) => {
      const d = Math.abs(geom.X(r.t) - px)
      if (d < bestD) { bestD = d; best = i }
    })
    setHover(best)
  }
  const hv = hover != null && hasData ? model[hover] : null

  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-2 mb-1">
        <h2 className="text-(length:--fs-h) font-extrabold text-[var(--color-accent)]">Recorded realised P&amp;L · Decisions per Day chart</h2>
        <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">
          top: cumulative recorded realised P&L from zero · bottom: risk decisions (upstream stops appear in the blocker report) · {zone}
        </span>
        <div className="ml-auto">
          <Segmented label="Chart range" value={range} onChange={setRange}
            options={Object.keys(RANGE_DAYS).map(r => ({ value: r, label: r }))} />
        </div>
      </div>
      {accountId === 'all' && accounts.length > 0 && <label className="block my-2">Chart account <select value={chartAccount} onChange={e => setSelected(e.target.value)}>
        {accounts.map(a => <option key={a.account_id} value={a.account_id}>{a.is_live ? 'Live' : 'Demo'} · {a.account_id}</option>)}
      </select> · All {accounts.length} accounts are available individually; their historical units are not pooled.</label>}

      {hasData && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-1 text-(length:--fs-body)">
          <span className="text-[var(--color-text-sub)]">daily realised-P&L drawdown in range <span className="tabular-nums" style={{ color: 'var(--color-down)' }}>{curve.moneyAvailable ? fmtN(totals.maxDd) : '—'}</span></span>
          <span className="text-[var(--color-text-sub)]">{curve.decisionState === 'unavailable' ? 'Daily decisions unavailable' : `${totals.decisions} recorded decisions · ${totals.vetoPct == null ? '—' : totals.vetoPct + '% vetoed'}`}</span>
        </div>
      )}

      {!hasData && (
        <div className="text-(length:--fs-body) text-[var(--color-text-sub)] py-6">
          {populationReport ? 'No recorded closes or supplied daily decisions in this range.' : 'Performance evidence unavailable.'}
        </div>
      )}

      {hasData && (
        <div className="relative overflow-x-auto" style={{ maxWidth: CHART_MAX_W }}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${EQ_H + DEC_H + 6}`} className="w-full min-w-[680px] select-none" role="img"
            aria-label="recorded realised profit, daily drawdown and decisions" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            <defs>
              <linearGradient id="rcDd" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-down)" stopOpacity="0.26" />
                <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0.05" />
              </linearGradient>
            </defs>

            {/* ---- equity panel ---- */}
            {curve.moneyAvailable && geom.ticksE.map(t => (
              <g key={t.y}>
                <line x1={PL} x2={W - PR} y1={t.y} y2={t.y} stroke={GRID} strokeWidth="1" opacity={t.zero ? 0.55 : 0.22} strokeDasharray={t.zero ? '5 4' : undefined} />
                <line x1={PL - 4} x2={PL} y1={t.y} y2={t.y} stroke="var(--color-text-sub)" strokeWidth="1" />
                <text x={PL - 7} y={t.y + 4} fontSize="10" textAnchor="end" fill="var(--color-text-sub)">{t.label}</text>
              </g>
            ))}
            {geom.ticksX.map(r => (
              <line key={`v${r.t}`} x1={geom.X(r.t)} x2={geom.X(r.t)} y1={PT} y2={EQ_H - PB}
                stroke={GRID} strokeWidth="1" opacity="0.16" strokeDasharray="2 4" />
            ))}
            {curve.moneyAvailable && !sparse && <path d={geom.ddArea} fill="url(#rcDd)" />}
            {curve.moneyAvailable && !sparse && <path d={geom.peakPath} fill="none" stroke="var(--color-text-sub)" strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />}
            {curve.moneyAvailable && !sparse && <path d={geom.eqPath} fill="none" stroke="var(--color-accent)" strokeWidth="2.4" strokeLinejoin="round" />}
            {curve.moneyAvailable && sparse && model.map(r => <circle key={r.t} cx={geom.X(r.t)} cy={geom.Ye(r.equity)} r="4" fill="var(--color-accent)" />)}
            <line x1={PL} x2={PL} y1={PT} y2={EQ_H - PB} stroke="var(--color-text-sub)" strokeWidth="1" />
            <line x1={PL} x2={W - PR} y1={EQ_H - PB} y2={EQ_H - PB} stroke="var(--color-text-sub)" strokeWidth="1" />
            <text x={PL - 44} y={PT + (EQ_H - PT - PB) / 2} fontSize="10" textAnchor="middle" fill="var(--color-text-sub)"
              transform={`rotate(-90 ${PL - 44} ${PT + (EQ_H - PT - PB) / 2})`}>Realised P&L</text>

            {/* ---- decisions panel ---- */}
            {curve.decisionState !== 'unavailable' && model.map(r => {
              const ah = geom.barH(r.approved), vh = geom.barH(r.vetoed)
              const x = geom.X(r.t) - geom.barW / 2
              return (
                <g key={`d${r.t}`}>
                  <rect x={x} y={geom.decBase - ah} width={geom.barW} height={Math.max(0, ah)} fill="var(--color-up)" opacity="0.85" />
                  <rect x={x} y={geom.decBase - ah - vh} width={geom.barW} height={Math.max(0, vh)} fill="var(--color-down)" opacity="0.8" />
                </g>
              )
            })}
            <line x1={PL} x2={W - PR} y1={geom.decTop + 6} y2={geom.decTop + 6} stroke={GRID} strokeWidth="1" opacity="0.22" />
            <line x1={PL} x2={PL} y1={geom.decTop} y2={geom.decBase} stroke="var(--color-text-sub)" strokeWidth="1" />
            <line x1={PL} x2={W - PR} y1={geom.decBase} y2={geom.decBase} stroke="var(--color-text-sub)" strokeWidth="1" />
            <line x1={PL - 4} x2={PL} y1={geom.decBase} y2={geom.decBase} stroke="var(--color-text-sub)" strokeWidth="1" />
            <line x1={PL - 4} x2={PL} y1={geom.decTop + 6} y2={geom.decTop + 6} stroke="var(--color-text-sub)" strokeWidth="1" />
            <text x={PL - 7} y={geom.decBase + 4} fontSize="10" textAnchor="end" fill="var(--color-text-sub)">0</text>
            <text x={PL - 7} y={geom.decTop + 10} fontSize="10" textAnchor="end" fill="var(--color-text-sub)">{fmtN(geom.dMax, 0)}</text>
            <text x={PL - 44} y={geom.decTop + (DEC_H - PB) / 2} fontSize="10" textAnchor="middle" fill="var(--color-text-sub)"
              transform={`rotate(-90 ${PL - 44} ${geom.decTop + (DEC_H - PB) / 2})`}>Decisions</text>
            {geom.ticksX.map(r => (
              <g key={`x${r.t}`}>
                <line x1={geom.X(r.t)} x2={geom.X(r.t)} y1={geom.decBase} y2={geom.decBase + 4} stroke="var(--color-text-sub)" strokeWidth="1" />
                <text x={geom.X(r.t)} y={geom.decBase + 15} fontSize="10" textAnchor="middle" fill="var(--color-text-sub)">{shortDate(r.t)}</text>
              </g>
            ))}

            {hv && (
              <>
                <line x1={geom.X(hv.t)} x2={geom.X(hv.t)} y1={PT} y2={geom.decBase} stroke="var(--color-text-sub)" strokeWidth="0.8" strokeDasharray="3 3" />
                {curve.moneyAvailable && <circle cx={geom.X(hv.t)} cy={geom.Ye(hv.equity)} r="4" fill="var(--color-accent)" />}
              </>
            )}
          </svg>
          {hv && (
            <div className="pointer-events-none absolute pos-absolute top-1 glass-panel rounded-[10px] px-3 py-1.5 text-(length:--fs-body) leading-5"
              style={{ left: `${Math.min(74, Math.max(2, (geom.X(hv.t) / W) * 100))}%` }}>
              <div>{shortDate(hv.t)}</div>
              <div>realised P&amp;L <span className="tabular-nums">{fmtN(hv.equity)}</span></div>
              <div style={{ color: 'var(--color-down)' }}>drawdown <span className="tabular-nums">{curve.moneyAvailable ? fmtN(hv.dd) : '—'}</span></div>
              <div>{curve.decisionState === 'unavailable' ? 'Daily decisions unavailable' : <><span style={{ color: 'var(--color-up)' }}>●</span> {hv.approved} approved · <span style={{ color: 'var(--color-down)' }}>●</span> {hv.vetoed} vetoed</>}</div>
            </div>
          )}
        </div>
      )}
      <p className="mt-1 text-(length:--fs-body) text-[var(--color-text-sub)]">
        {curve.moneyAvailable ? `The curve includes every priced recorded close in the selected ${zone} days. Its drawdown uses daily realised totals and can miss intraday moves.` : `The money curve is unavailable: ${curve.reason.replaceAll('_', ' ')}.`}
        {' '}This is not broker balance, floating equity or a cashflow-adjusted account return. Deposits and withdrawals are excluded.
        {' '}Decision bars use the supplied daily aggregate; an unavailable daily feed is not replaced with the capped event journal.
        {curve.decisionState === 'unavailable' && ' Daily decision evidence is unavailable.'}

      </p>
    </Card>
  )
}
