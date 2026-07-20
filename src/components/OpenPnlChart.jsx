// OpenPnlChart — live floating P&L across every open broker position, drawn
// as a LINE chart (owner: "first chart should be oscillator chart... line
// chart of all trades (active) whether profit or loss"). Two views, both
// built (owner: "have both choices"):
//   combined  — one line: every open position's floating P&L added together
//   per-position — one line per position, so you can see which one is
//                  carrying the account
//
// Session-only history: there is no server-side P&L time-series (yet) — this
// accumulates a sample every time Desk's own poll delivers a fresh broker
// snapshot (no extra network calls), so the line starts empty on page load
// and grows while the tab stays open. Reloading the page starts a fresh line.
//
// Owner is red-green colour-blind: blue family only, shade + line style
// carry the "which position is this" distinction (never hue alone); the
// ±sign on the readout numbers carries profit/loss, matching every other
// P&L figure in the app (blue up, orange down).
import { useEffect, useRef, useState } from 'react'
import { createChart, LineSeries } from 'lightweight-charts'

const UP = '#2563eb'
const DOWN = '#c2410c'
const ZERO_LINE = '#94a3b8'
const MAX_SAMPLES = 360 // ~2h at a 20s poll — a session-length window, not a database
// Per-position lines: shade × style combinations so 20 open positions still
// read as distinct lines without ever leaving the blue family.
const SHADES = ['#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd']
const STYLES = [0, 2, 1, 3] // solid, dashed, dotted, large-dash
function lineLookFor(i) {
  return { color: SHADES[i % SHADES.length], lineStyle: STYLES[Math.floor(i / SHADES.length) % STYLES.length] }
}
const money = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

export default function OpenPnlChart({ positions = [] }) {
  const [mode, setMode] = useState('combined') // 'combined' | 'per'
  const boxRef = useRef(null)
  const chartRef = useRef(null)   // { chart, seriesById: Map, combinedSeries }
  const historyRef = useRef([])   // [{ t (sec), combined, byId: { positionId: value } }]
  const [, forceTick] = useState(0)

  // Sample the CURRENT snapshot into session history — only when the
  // underlying P&L numbers actually changed, not on every unrelated re-render.
  const signature = positions.map(p => `${p.positionId}:${Math.round((p.netPnl ?? p.estNetPnl ?? 0) * 100)}`).join('|')
  useEffect(() => {
    if (positions.length === 0) return
    const t = Math.floor(Date.now() / 1000)
    const byId = {}
    let combined = 0
    for (const p of positions) {
      const v = Number(p.netPnl ?? p.estNetPnl ?? p.estPnlQuote)
      if (!Number.isFinite(v)) continue
      byId[p.positionId] = v
      combined += v
    }
    const hist = historyRef.current
    // A poll that lands within a second of the last sample (rapid remount /
    // duplicate fetch) replaces it instead of stacking a near-duplicate point.
    if (hist.length && hist[hist.length - 1].t === t) hist[hist.length - 1] = { t, combined, byId }
    else hist.push({ t, combined, byId })
    if (hist.length > MAX_SAMPLES) hist.splice(0, hist.length - MAX_SAMPLES)
    forceTick(n => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // Create/destroy the chart with the container — same lifecycle pattern as
  // PositionChart.jsx.
  useEffect(() => {
    if (!boxRef.current) return undefined
    const style = getComputedStyle(document.documentElement)
    const textColor = style.getPropertyValue('--color-text-sub').trim() || '#8a8fa3'
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(128,128,160,0.12)' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = { chart, seriesById: new Map(), combinedSeries: null }
    return () => { chart.remove(); chartRef.current = null }
  }, [])

  // Redraw whenever a new sample lands or the view mode changes.
  useEffect(() => {
    const ref = chartRef.current
    if (!ref) return
    const hist = historyRef.current

    if (mode === 'combined') {
      for (const s of ref.seriesById.values()) ref.chart.removeSeries(s)
      ref.seriesById.clear()
      if (!ref.combinedSeries) {
        ref.combinedSeries = ref.chart.addSeries(LineSeries, { color: UP, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
        ref.combinedSeries.createPriceLine({ price: 0, color: ZERO_LINE, lineStyle: 2, lineWidth: 1, axisLabelVisible: false })
      }
      ref.combinedSeries.setData(hist.map(s => ({ time: s.t, value: Math.round(s.combined * 100) / 100 })))
    } else {
      if (ref.combinedSeries) { ref.chart.removeSeries(ref.combinedSeries); ref.combinedSeries = null }
      const liveIds = positions.map(p => String(p.positionId))
      // Drop series for positions no longer open; add series for new ones.
      for (const [id, s] of [...ref.seriesById.entries()]) {
        if (!liveIds.includes(id)) { ref.chart.removeSeries(s); ref.seriesById.delete(id) }
      }
      liveIds.forEach((id, i) => {
        if (!ref.seriesById.has(id)) {
          const look = lineLookFor(i)
          ref.seriesById.set(id, ref.chart.addSeries(LineSeries, { ...look, lineWidth: 2, priceLineVisible: false, lastValueVisible: false }))
        }
      })
      if (liveIds.length > 0 && !ref.zeroLined) {
        const first = ref.seriesById.get(liveIds[0])
        first?.createPriceLine({ price: 0, color: ZERO_LINE, lineStyle: 2, lineWidth: 1, axisLabelVisible: false })
        ref.zeroLined = true
      }
      for (const [id, s] of ref.seriesById.entries()) {
        const pts = hist
          .filter(h => h.byId[id] != null)
          .map(h => ({ time: h.t, value: Math.round(h.byId[id] * 100) / 100 }))
        s.setData(pts)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, signature])

  const combinedNow = positions.reduce((s2, p) => {
    const v = Number(p.netPnl ?? p.estNetPnl ?? p.estPnlQuote)
    return s2 + (Number.isFinite(v) ? v : 0)
  }, 0)
  const flat = positions.length === 0

  // The chart container must ALWAYS mount, even when flat — the
  // create-chart effect below only ever runs ONCE ([] deps) and bails
  // silently if the container isn't in the DOM yet; an early return here
  // (as this used to do, before ANY position had loaded) meant that on a
  // fresh page load the chart never got created at all, and never got a
  // second chance once positions arrived a few seconds later. The "Flat"
  // message renders alongside the (empty) chart instead of replacing it.
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <div className="flex rounded-[7px] overflow-hidden border border-[var(--color-border)]" role="radiogroup" aria-label="P&L chart view">
          {[{ k: 'combined', label: 'Combined' }, { k: 'per', label: 'Per-position' }].map(({ k, label }) => (
            <button
              key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)}
              className={`px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${mode === k ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg)] text-[var(--color-text-sub)]'}`}
            >{label}</button>
          ))}
        </div>
        {!flat && mode === 'combined' && (
          <span className={`text-[13px] font-bold ${combinedNow >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
            {money(combinedNow)}
          </span>
        )}
        <span className="ml-auto text-[10px] text-[var(--color-text-sub)]">this session only — starts fresh on page reload</span>
      </div>
      {flat && <p className="text-[13px] text-[var(--color-text-sub)] py-1">Flat — no open positions.</p>}
      {/* Always in the DOM (never behind display:none) — a hide/show cycle
          risks the chart's ResizeObserver seeing a stale 0×0 box. */}
      <div ref={boxRef} style={{ height: 160 }} />
      {!flat && mode === 'per' && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          {positions.map((p, i) => {
            const look = lineLookFor(i)
            const v = Number(p.netPnl ?? p.estNetPnl ?? p.estPnlQuote)
            return (
              <span key={p.positionId} className="flex items-center gap-1">
                <span aria-hidden="true" style={{
                  display: 'inline-block', width: 12, height: 0, borderTopWidth: 2, borderTopColor: look.color,
                  borderTopStyle: look.lineStyle === 0 ? 'solid' : look.lineStyle === 1 ? 'dotted' : 'dashed',
                }} />
                <span className="font-semibold">{p.symbol}</span>
                <span className={Number.isFinite(v) ? (v >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]') : 'text-[var(--color-text-sub)]'}>
                  {Number.isFinite(v) ? money(v) : '—'}
                </span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
