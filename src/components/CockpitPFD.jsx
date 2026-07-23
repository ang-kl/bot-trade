// CockpitPFD — one open trade rendered as a Primary Flight Display
// (owner spec, Gulfstream G700 cockpit layout / McLaren F1 dash reference):
//
//   ATTITUDE (centre) — the artificial horizon IS the trade:
//     · PITCH: entry price is the level-flight horizon. Price above entry
//       pitches the nose up into profit sky; below entry sinks into loss
//       ground. Scaled in R (±2R = full deflection) so every symbol reads
//       the same.
//     · ROLL: heading vs the TP. Wings level = holding course; banked
//       RIGHT = price is CONVERGING on the TP (closing the distance);
//       banked LEFT = diverging (moving away). Computed from live tick
//       samples of |TP − price| over the last ~2 minutes.
//   LEFT TAPE (airspeed position) — P&L in R, sliding tape centred on the
//     current value, digital box readout.
//   RIGHT TAPE (altimeter position) — PRICE tape centred on the live
//     price, with TP / entry / SL bugs at their true positions.
//   BOTTOM STRIP (heading position) — track-to-target: entry→TP progress
//     with the remaining price distance, DME-style.
//
// GSAP (CDN, guarded on window.gsap) tweens the horizon so pitch/roll
// glide rather than snap; without the CDN the instrument still renders and
// updates — just without inertia.
import { useEffect, useId, useRef, useState } from 'react'
import { pfdR, rollFromSamples, isLongSide as isLong } from '../lib/pfd-math.js'

const UP = 'var(--color-up)'
const DOWN = 'var(--color-down)'
const SUB = 'var(--color-text-sub)'
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const gsap = () => (typeof window !== 'undefined' ? window.gsap : null)

const MAX_SAMPLES = 40
/** Rolling {t, d}-samples of the normalized distance to TP → current roll angle. */
function useTpRoll(price, tp, riskDist) {
  const [samples, setSamples] = useState([])
  useEffect(() => {
    if (price == null || tp == null || !(riskDist > 0)) return
    // Syncing an external live-price signal into a rolling buffer — same
    // pattern (and lint exemption reasoning) as TradeGaugeWall's useTileSeries.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSamples(prev => {
      const t = Date.now()
      const d = Math.abs(tp - price) / riskDist
      const next = prev.length && t - prev[prev.length - 1].t < 500
        ? [...prev.slice(0, -1), { t, d }]
        : [...prev, { t, d }]
      return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
    })
  }, [price, tp, riskDist])
  return rollFromSamples(samples)
}

function fmtPrice(v) {
  return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 5 })
}

export default function CockpitPFD({
  entry, sl, tp, side, price, pnl = null, lots = null,
  width = 200, noReason = null,
}) {
  const uid = useId()
  const W = 200, H = 172 // internal coordinate system; scales via width
  const AX = 34, AW = W - 68 // attitude square: x 34..166
  const AY = 6, AH = 122
  const acx = AX + AW / 2, acy = AY + AH / 2
  const r = pfdR(entry, sl, side, price)
  const riskDist = entry != null && sl != null ? Math.abs(entry - sl) : null
  const roll = useTpRoll(price, tp, riskDist)
  // ±2R = full-scale pitch. Horizon moves DOWN as profit rises (nose up).
  const pitchPx = clamp((r ?? 0) / 2, -1, 1) * (AH / 2) * 0.85

  // GSAP-smoothed horizon: tween a proxy and write the transform on update.
  const horizonRef = useRef(null)
  const cur = useRef({ p: 0, roll: 0 })
  useEffect(() => {
    const el = horizonRef.current
    if (!el) return
    const apply = (p, ro) => el.setAttribute('transform', `rotate(${-ro} ${acx} ${acy}) translate(0 ${p})`)
    const g = gsap()
    const from = { ...cur.current }
    const to = { p: pitchPx, roll }
    cur.current = to
    if (!g) { apply(to.p, to.roll); return }
    const proxy = { ...from }
    g.to(proxy, { p: to.p, roll: to.roll, duration: 0.8, ease: 'power2.out', onUpdate: () => apply(proxy.p, proxy.roll) })
  }, [pitchPx, roll, acx, acy])

  // Right tape window: span = 2.5× the risk distance either side of price.
  const span = riskDist != null && riskDist > 0 ? riskDist * 2.5 : (price || 1) * 0.01
  const priceY = (p) => acy - ((p - (price ?? entry ?? 0)) / span) * (AH / 2)
  const dirUp = isLong(side)
  // Left tape: R scale, ±2R window around current R.
  const rY = (val) => acy - ((val - (r ?? 0)) / 2) * (AH / 2)

  // Bottom track-to-target strip.
  const prog = (entry != null && tp != null && price != null && entry !== tp)
    ? clamp((price - entry) / (tp - entry), -0.5, 1)
    : null
  const distToTp = tp != null && price != null ? Math.abs(tp - price) : null

  const clipA = `pfd-a-${uid}`
  const clipL = `pfd-l-${uid}`
  const clipRt = `pfd-r-${uid}`
  const up = (r ?? 0) >= 0

  // Explicit height (derived from the internal W:H ratio) — an <svg> with a
  // viewBox but no height attribute defaults inconsistently across browsers
  // (Safari falls back to a fixed ~150px box instead of honouring the
  // viewBox aspect ratio), squashing the whole instrument vertically and
  // smearing every glyph into unreadable overlapping shapes (owner: "See
  // the instrument very awful"). block+preserveAspectRatio locks it down.
  const height = Math.round(width * (H / W))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={width} height={height} preserveAspectRatio="xMidYMid meet" role="img"
      aria-label={`PFD: ${r == null ? (noReason || 'no reading') : `${r.toFixed(2)}R`}, ${roll > 5 ? 'converging on TP' : roll < -5 ? 'diverging from TP' : 'holding course'}`}
      style={{ display: 'block', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))' }}>
      <defs>
        <clipPath id={clipA}><rect x={AX} y={AY} width={AW} height={AH} rx="8" /></clipPath>
        <clipPath id={clipL}><rect x={2} y={AY} width={28} height={AH} rx="4" /></clipPath>
        <clipPath id={clipRt}><rect x={W - 30} y={AY} width={28} height={AH} rx="4" /></clipPath>
      </defs>

      {/* bezel plate */}
      <rect x="0" y="0" width={W} height={H} rx="10" fill="var(--color-bg)" stroke="var(--color-border)" strokeWidth="1.5" />

      {/* ---- ATTITUDE ---- */}
      <g clipPath={`url(#${clipA})`}>
        <g ref={horizonRef}>
          {/* sky = profit side, ground = loss side; oversized for roll/pitch travel */}
          <rect x={AX - AW} y={acy - AH * 2} width={AW * 3} height={AH * 2} fill={UP} opacity="0.32" />
          <rect x={AX - AW} y={acy} width={AW * 3} height={AH * 2} fill={DOWN} opacity="0.32" />
          <line x1={AX - AW} y1={acy} x2={AX + 2 * AW} y2={acy} stroke="var(--color-text)" strokeWidth="1.6" />
          {/* pitch ladder: ±0.5R and ±1R rungs */}
          {[0.5, 1, -0.5, -1].map(rr => {
            const y = acy + (rr / 2) * (AH / 2) * 0.85 * -1
            const wRung = Math.abs(rr) === 1 ? 34 : 22
            return (
              <g key={rr}>
                <line x1={acx - wRung} y1={y} x2={acx + wRung} y2={y} stroke="var(--color-text)" strokeWidth="0.8" opacity="0.75" />
                <text x={acx + wRung + 3} y={y + 2.5} fontSize="6.5" fill="var(--color-text)" opacity="0.8">{rr > 0 ? `+${rr}` : rr}R</text>
              </g>
            )
          })}
        </g>
      </g>
      {/* roll scale + pointer (fixed) */}
      {[-30, -20, -10, 0, 10, 20, 30].map(d => {
        const rad = ((d - 90) * Math.PI) / 180
        const rOut = AH / 2 - 2, rIn = rOut - (d === 0 ? 7 : 4)
        return <line key={d}
          x1={acx + rOut * Math.cos(rad)} y1={acy + rOut * Math.sin(rad)}
          x2={acx + rIn * Math.cos(rad)} y2={acy + rIn * Math.sin(rad)}
          stroke={SUB} strokeWidth={d === 0 ? 1.4 : 0.8} />
      })}
      {/* fixed aircraft symbol */}
      <path d={`M ${acx - 26} ${acy} l 16 0 l 5 5 l 5 -5 l 16 0`} fill="none" stroke="var(--color-warning-text)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx={acx} cy={acy} r="1.8" fill="var(--color-warning-text)" />
      <rect x={AX} y={AY} width={AW} height={AH} rx="8" fill="none" stroke="var(--color-border)" strokeWidth="1" />
      {noReason && (
        <text x={acx} y={AY + 12} textAnchor="middle" fontSize="7" fill={SUB}>{noReason}</text>
      )}

      {/* ---- LEFT TAPE: P&L in R ---- */}
      <g clipPath={`url(#${clipL})`}>
        <rect x={2} y={AY} width={28} height={AH} fill="var(--color-surface-2,rgba(127,127,127,0.10))" />
        {r != null && [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3].map(v => (
          <g key={v}>
            <line x1={22} y1={rY(v)} x2={28} y2={rY(v)} stroke={SUB} strokeWidth="0.8" />
            <text x={19} y={rY(v) + 2.5} textAnchor="end" fontSize="6.5" fill={v === 0 ? 'var(--color-text)' : SUB}>{v > 0 ? `+${v}` : v}</text>
          </g>
        ))}
      </g>
      {/* R readout box */}
      <rect x={1} y={acy - 8} width={30} height={16} rx="3" fill="var(--color-bg)" stroke={up ? UP : DOWN} strokeWidth="1.2" />
      <text x={16} y={acy + 3.2} textAnchor="middle" fontSize="8" fontWeight="700" fill={up ? UP : DOWN}>
        {r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`}
      </text>
      <text x={16} y={AY - 0.5} textAnchor="middle" fontSize="6" fill={SUB}>P/L (R)</text>

      {/* ---- RIGHT TAPE: price with TP / entry / SL bugs ---- */}
      <g clipPath={`url(#${clipRt})`}>
        <rect x={W - 30} y={AY} width={28} height={AH} fill="var(--color-surface-2,rgba(127,127,127,0.10))" />
        {[{ p: tp, lbl: 'TP', c: UP }, { p: entry, lbl: 'E', c: SUB }, { p: sl, lbl: 'SL', c: DOWN }].map(({ p, lbl, c }) => (
          p != null && Number.isFinite(Number(p)) && (
            <g key={lbl}>
              <path d={`M ${W - 30} ${priceY(p)} l 5 -4 l 0 8 z`} fill={c} />
              <text x={W - 23} y={priceY(p) + 2.5} fontSize="6.5" fontWeight="700" fill={c}>{lbl}</text>
            </g>
          )
        ))}
      </g>
      {/* price readout box */}
      <rect x={W - 31} y={acy - 8} width={30} height={16} rx="3" fill="var(--color-bg)" stroke="var(--color-text)" strokeWidth="1" />
      <text x={W - 16} y={acy + 3.2} textAnchor="middle" fontSize="6.4" fontWeight="700" fill="var(--color-text)">{fmtPrice(price)}</text>
      <text x={W - 16} y={AY - 0.5} textAnchor="middle" fontSize="6" fill={SUB}>PRICE {dirUp ? '↑TP' : '↓TP'}</text>

      {/* ---- BOTTOM: track to target ---- */}
      <g>
        <rect x={AX} y={H - 36} width={AW} height={12} rx="3" fill="var(--color-surface-2,rgba(127,127,127,0.10))" stroke="var(--color-border)" strokeWidth="0.6" />
        {prog != null && (
          <rect x={AX + 1} y={H - 35} width={clamp(prog, 0, 1) * (AW - 2)} height={10} rx="2.5" fill={prog >= 0 ? UP : DOWN} opacity="0.5" />
        )}
        <line x1={AX + AW} y1={H - 38} x2={AX + AW} y2={H - 22} stroke={UP} strokeWidth="1.4" />
        <text x={AX} y={H - 26} fontSize="6" fill={SUB}>ENTRY</text>
        <text x={AX + AW} y={H - 26} textAnchor="end" fontSize="6" fill={UP}>TP</text>
        <text x={acx} y={H - 14} textAnchor="middle" fontSize="7" fontWeight="600" fill="var(--color-text)">
          {distToTp == null ? 'no TP set — no track guidance' : `DIST→TP ${fmtPrice(distToTp)} · ${prog == null ? '—' : `${Math.round(clamp(prog, -0.5, 1) * 100)}%`}`}
        </text>
        <text x={acx} y={H - 5} textAnchor="middle" fontSize="6" fill={roll > 5 ? UP : roll < -5 ? DOWN : SUB}>
          {tp == null ? '' : roll > 5 ? '▶ converging on TP' : roll < -5 ? '◀ diverging from TP' : 'holding course'}
        </text>
      </g>

      {/* lots annunciator, top-left of attitude (small FMS-style tag) */}
      {lots != null && <text x={AX + 3} y={AY + 10} fontSize="6" fill={SUB}>{Number(lots).toFixed(2)} lots</text>}
      {/* P&L $ annunciator, top-right */}
      {Number.isFinite(pnl) && (
        <text x={AX + AW - 3} y={AY + 10} textAnchor="end" fontSize="6.5" fontWeight="700" fill={pnl >= 0 ? UP : DOWN}>
          {pnl >= 0 ? '+' : '−'}{Math.abs(pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </text>
      )}
    </svg>
  )
}
