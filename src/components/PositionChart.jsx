// PositionChart — professional candlestick chart powered by Lightweight
// Charts (TradingView's open-source engine, bundled locally — no CDN).
// Shows OHLC bars for a symbol with price lines for the position's
// entry/SL/TP and the scanner's 61.8% fib level, plus live tick updates
// from the agent's SSE stream, plus server-computed indicator overlays
// (SMA/EMA/VWAP/AVWAP/FVG/volume profile) so app charts match Telegram
// charts EXACTLY. Owner is red-green colour-blind: blue (#2563eb) and
// orange (#c2410c) ONLY — state also carried by words/shape, never hue.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts'
import { agentPost, agentStreamPrices } from '../lib/agent-api.js'
import { CHART_TF_GROUPS } from '../lib/chart-timeframes.js'
import { tfMs } from '../lib/timeframes.js'
import IndicatorPanel, { loadIndicatorPrefs } from './IndicatorPanel.jsx'

const POLL_MS = 15_000
const UP = '#2563eb'          // blue up
const DOWN = '#c2410c'        // orange down (never red/green)
const ORANGE = '#c2410c'

// Overlay line looks: blue family only, distinguished by SHADE + LINE STYLE
// (LineStyle: 0 solid, 1 dotted, 2 dashed, 3 large-dashed) — never a
// red/green pair. Titles label each axis tag so colour is never the only cue.
const OVERLAY_LINES = {
  sma20:  { color: '#60a5fa', lineStyle: 0, lineWidth: 1, title: 'SMA20' },
  sma50:  { color: '#3b82f6', lineStyle: 0, lineWidth: 1, title: 'SMA50' },
  sma200: { color: '#1d4ed8', lineStyle: 0, lineWidth: 2, title: 'SMA200' },
  ema20:  { color: '#60a5fa', lineStyle: 2, lineWidth: 1, title: 'EMA20' },
  ema50:  { color: '#3b82f6', lineStyle: 2, lineWidth: 1, title: 'EMA50' },
  vwap:   { color: '#2563eb', lineStyle: 1, lineWidth: 2, title: 'VWAP' },
  avwap:  { color: '#93c5fd', lineStyle: 3, lineWidth: 2, title: 'AVWAP' },
}

function niceFmt(v, ref) {
  if (v == null) return ''
  const digits = ref >= 1000 ? 1 : ref >= 10 ? 2 : 5
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits })
}

// Right-docked volume-profile histogram. Rows are equal-width price buckets,
// so even vertical spacing (sorted high→low price) mirrors the price axis
// closely enough without chart-coordinate coupling. Blue bars + labelled POC
// line (label carries the meaning — not colour).
function VolumeProfileSvg({ vp, height }) {
  if (!vp?.rows?.length) return null
  const W = 72
  const rows = [...vp.rows].sort((a, b) => b.price - a.price)
  const rh = height / rows.length
  const maxPct = Math.max(...rows.map(r => r.pct || 0), 1e-9)
  const pocIdx = rows.findIndex(r => r.price === vp.pocPrice)
  return (
    <svg
      width={W} height={height} aria-label="Volume profile"
      className="absolute top-0 right-0 pointer-events-none opacity-80"
    >
      {rows.map((r, i) => (
        <rect
          key={r.price}
          x={W - (r.pct / maxPct) * (W - 4)} y={i * rh + 0.5}
          width={(r.pct / maxPct) * (W - 4)} height={Math.max(rh - 1, 1)}
          fill={UP} fillOpacity={i === pocIdx ? 0.85 : 0.35}
        />
      ))}
      {pocIdx >= 0 && (
        <>
          <line x1={0} x2={W} y1={pocIdx * rh + rh / 2} y2={pocIdx * rh + rh / 2} stroke={ORANGE} strokeWidth={1} strokeDasharray="3 2" />
          <text x={2} y={Math.max(pocIdx * rh - 2, 9)} fontSize="9" fill={ORANGE}>POC {niceFmt(vp.pocPrice, vp.pocPrice)}</text>
        </>
      )}
    </svg>
  )
}

// Historical mode: pass `at` (epoch ms of a past trade) — bars are fetched
// AROUND that moment (no polling, no live ticks, no fib overlay) and
// `markers` ({ entryT, exitT } epoch ms) pins the fill/exit on the candles.
// grid: true = many-charts mode — no live tick stream (16 SSE connections
// would hammer the agent), 60s polls, shorter canvas, no TF ladder/panel.
export default function PositionChart({ symbol, timeframe: tf0 = '1h', lines = {}, at = null, markers = null, grid = false }) {
  const [timeframe, setTimeframe] = useState(tf0)
  const [error, setError] = useState('')
  const [fib, setFib] = useState(null)
  const [tick, setTick] = useState(null)
  const [live, setLive] = useState(false)
  const [lastClose, setLastClose] = useState(null)
  const [indPrefs, setIndPrefs] = useState(() => loadIndicatorPrefs())
  const [avwapAnchorT, setAvwapAnchorT] = useState(null)
  const [avwapArmed, setAvwapArmed] = useState(false)
  const [vp, setVp] = useState(null)

  const boxRef = useRef(null)
  const chartRef = useRef(null)     // { chart, series, priceLines: [], overlaySeries: Map, fvgLines: [], liveLine }
  const lastBarRef = useRef(null)   // forming bar, updated by live ticks
  const [dot, setDot] = useState(null)      // { x, y, fresh } — pulsing marker on the last bar
  const positionDotRef = useRef(() => {})   // latest closure, callable from subscriptions

  // Pin the live dot to the forming bar's close. `fresh` = the bar is recent
  // for its timeframe → the dot pulses; a stale bar (market closed / feed
  // stalled) renders it static grey — the blink itself is the live signal.
  // The ref is (re)assigned in an every-render effect so subscriptions always
  // call the closure with the current timeframe.
  useEffect(() => {
    positionDotRef.current = () => {
      const ref = chartRef.current
      const bar = lastBarRef.current
      if (!ref || !bar) { setDot(null); return }
      let x = null; let y = null
      try {
        x = ref.chart.timeScale().timeToCoordinate(bar.time)
        y = ref.series.priceToCoordinate(bar.close)
      } catch { /* chart mid-teardown */ }
      if (x == null || y == null) { setDot(null); return }
      const tfSec = (tfMs(timeframe) || 3_600_000) / 1000
      const fresh = (Date.now() / 1000 - Number(bar.time)) < Math.max(3 * tfSec, 180)
      setDot({ x, y, fresh })
    }
  })

  // Keep the live price line (solid, labelled "live") on the latest price.
  const updateLiveLine = useCallback((price) => {
    const ref = chartRef.current
    if (!ref || price == null || at) return
    if (!ref.liveLine) {
      ref.liveLine = ref.series.createPriceLine({
        price: Number(price), color: UP, lineWidth: 1, lineStyle: 0,
        axisLabelVisible: true, title: 'live',
      })
    } else {
      ref.liveLine.applyOptions({ price: Number(price) })
    }
  }, [at])

  const showPanel = !grid && !at    // indicators only on the full live chart
  const indKey = indPrefs.indicators.join(',')

  // Create/destroy the chart with the container.
  useEffect(() => {
    if (!boxRef.current) return undefined
    const style = getComputedStyle(document.documentElement)
    const textColor = style.getPropertyValue('--color-text-sub').trim() || '#8a8fa3'
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor, attributionLogo: false },
      grid: {
        vertLines: { color: 'rgba(128,128,160,0.12)' },
        horzLines: { color: 'rgba(128,128,160,0.12)' },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 0 },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN,
      borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
    })
    chartRef.current = { chart, series, priceLines: [], overlaySeries: new Map(), fvgLines: [] }
    return () => { chart.remove(); chartRef.current = null }
  }, [])

  // Re-pin the live dot on every pan/zoom/resize — coordinates shift with
  // the visible range (autoSize resizes also fire this).
  useEffect(() => {
    const ref = chartRef.current
    if (!ref) return undefined
    const onRange = () => positionDotRef.current()
    ref.chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    return () => { try { ref.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange) } catch { /* chart disposed */ } }
  }, [symbol, timeframe])

  // AVWAP anchor picking: while armed, the next chart click sets the anchor
  // timestamp (crosshair time is in SECONDS in lightweight-charts).
  useEffect(() => {
    const ref = chartRef.current
    if (!ref || !avwapArmed) return undefined
    const onClick = (param) => {
      if (param?.time != null) {
        setAvwapAnchorT(Number(param.time) * 1000)
        setAvwapArmed(false)
      }
    }
    ref.chart.subscribeClick(onClick)
    return () => { try { ref.chart.unsubscribeClick(onClick) } catch { /* chart already disposed */ } }
  }, [avwapArmed])

  // Bars + server-computed overlays: fetch now and every 15s (the poll also
  // keeps SL/TP overlays fresh). Overlays are computed on the AGENT so the
  // app and Telegram charts read from the same numbers.
  useEffect(() => {
    let dead = false
    const load = async () => {
      try {
        const body = { symbol, timeframe, bars: 200, ...(at ? { centerT: at } : {}) }
        if (showPanel && indPrefs.indicators.length) {
          body.indicators = indPrefs.indicators
          if (indPrefs.indicators.includes('vp')) {
            body.vpType = indPrefs.vpType
            // visible/fixed profiles need the on-screen range — without it the
            // server would compute the whole series (i.e. 'composite' mislabeled)
            if ((indPrefs.vpType === 'visible' || indPrefs.vpType === 'fixed') && chartRef.current) {
              const lr = chartRef.current.chart.timeScale().getVisibleLogicalRange()
              if (lr) {
                body.vpFromIdx = Math.max(0, Math.floor(lr.from))
                body.vpToIdx = Math.max(body.vpFromIdx, Math.ceil(lr.to))
              }
            }
          }
          if (indPrefs.indicators.includes('avwap') && avwapAnchorT != null) body.avwapAnchorT = avwapAnchorT
        }
        const r = await agentPost('/actions/chart', body)
        if (dead || !chartRef.current) return
        const ref = chartRef.current
        const bars = (r.bars || []).map(b => ({
          time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c,
        }))
        ref.series.setData(bars)
        lastBarRef.current = bars[bars.length - 1] || null
        if (markers && bars.length) {
          const snap = (ms) => {
            const target = Math.floor(ms / 1000)
            let best = bars[0].time
            for (const bb of bars) { if (bb.time <= target) best = bb.time; else break }
            return best
          }
          const defs = [
            markers.entryT && { time: snap(markers.entryT), position: 'belowBar', shape: 'arrowUp', color: UP, text: 'entry' },
            markers.exitT && { time: snap(markers.exitT), position: 'aboveBar', shape: 'square', color: ORANGE, text: 'exit' },
          ].filter(Boolean)
          createSeriesMarkers(ref.series, defs)
        }

        // ---- overlay line series (MAs / VWAP / AVWAP) ----
        const overlays = r.overlays || {}
        for (const [id, cfg] of Object.entries(OVERLAY_LINES)) {
          const wanted = indPrefs.indicators.includes(id) && Array.isArray(overlays[id])
          let s = ref.overlaySeries.get(id)
          if (!wanted) {
            if (s) { ref.chart.removeSeries(s); ref.overlaySeries.delete(id) }
            continue
          }
          if (!s) {
            s = ref.chart.addSeries(LineSeries, {
              ...cfg, priceLineVisible: false, lastValueVisible: false,
              crosshairMarkerVisible: false,
            })
            ref.overlaySeries.set(id, s)
          }
          s.setData(overlays[id]
            .map((v, i) => (v == null || !bars[i]) ? null : { time: bars[i].time, value: v })
            .filter(Boolean))
        }

        // ---- FVG zones: top/bottom price lines, orange dotted, unfilled
        // only, capped at the 3 nearest to last price ----
        for (const pl of ref.fvgLines) ref.series.removePriceLine(pl)
        ref.fvgLines = []
        if (indPrefs.indicators.includes('fvg') && Array.isArray(overlays.fvg)) {
          const px = r.lastPrice ?? bars[bars.length - 1]?.close ?? 0
          const zones = overlays.fvg
            .filter(z => z.filledIdx == null)
            .sort((a, b) => Math.abs((a.top + a.bottom) / 2 - px) - Math.abs((b.top + b.bottom) / 2 - px))
            .slice(0, 3)
          for (const z of zones) {
            for (const [price, edge] of [[z.top, 'top'], [z.bottom, 'bot']]) {
              ref.fvgLines.push(ref.series.createPriceLine({
                price, color: ORANGE, lineWidth: 1, lineStyle: 1,
                axisLabelVisible: false, title: `FVG ${z.dir} ${edge}`,
              }))
            }
          }
        }

        setVp(indPrefs.indicators.includes('vp') ? (overlays.vp || null) : null)
        setLastClose(r.lastPrice ?? null)
        updateLiveLine(r.lastPrice ?? bars[bars.length - 1]?.close)
        positionDotRef.current()
        setFib(r.fib || null)
        setError('')
      } catch (e) { if (!dead) setError(e.message) }
    }
    load()
    if (at) return () => { dead = true } // historical: one fetch, no polling
    const t = setInterval(load, grid ? 60_000 : POLL_MS)
    return () => { dead = true; clearInterval(t) }
  }, [symbol, timeframe, at, grid, showPanel, indKey, indPrefs.vpType, avwapAnchorT]) // eslint-disable-line react-hooks/exhaustive-deps

  // Price lines: entry/SL/TP from the position + the scanner's 61.8% level.
  // SL is orange + labelled "SL", TP blue + "TP" — words carry the meaning.
  useEffect(() => {
    const ref = chartRef.current
    if (!ref) return
    for (const pl of ref.priceLines) ref.series.removePriceLine(pl)
    ref.priceLines = []
    const defs = [
      lines.entry != null && { price: Number(lines.entry), color: '#94a3b8', title: 'entry' },
      lines.sl != null && { price: Number(lines.sl), color: DOWN, title: 'SL' },
      lines.tp != null && { price: Number(lines.tp), color: UP, title: 'TP' },
      fib?.level618 != null && { price: Number(fib.level618), color: ORANGE, title: '61.8%' },
    ].filter(Boolean)
    for (const d of defs) {
      ref.priceLines.push(ref.series.createPriceLine({
        ...d, lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
      }))
    }
  }, [lines.entry, lines.sl, lines.tp, fib?.level618])

  // Live ticks: update the forming candle in place (not for past trades).
  useEffect(() => {
    if (at || grid) return undefined
    const stream = agentStreamPrices(
      [symbol],
      t => {
        setTick(t); setLive(true)
        const mid = t.bid != null && t.ask != null ? (t.bid + t.ask) / 2 : (t.bid ?? t.ask)
        const bar = lastBarRef.current
        if (mid != null && bar && chartRef.current) {
          const next = { ...bar, close: mid, high: Math.max(bar.high, mid), low: Math.min(bar.low, mid) }
          lastBarRef.current = next
          chartRef.current.series.update(next)
          updateLiveLine(mid)
          positionDotRef.current()
        }
      },
      () => setLive(false),
    )
    return () => stream.close()
  }, [symbol, at, grid, updateLiveLine])

  const chartHeight = grid ? 190 : 300

  return (
    <div>
      {grid ? (
        // Grid mode: 16 mini charts — just name the current TF, no 20-button ladder.
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[11px] font-semibold text-[var(--color-text-sub)]">{timeframe}</span>
          <span className="ml-auto text-[11px] text-[var(--color-text-sub)]">{niceFmt(lastClose, lastClose)}</span>
        </div>
      ) : (
        // One wrapped row for the whole TF ladder (was 5 labelled rows —
        // owner: "spacing wasteful"). Groups separated by a middot; the
        // price/tick status rides on the same line, right-aligned.
        <div className="mb-1.5 flex flex-wrap items-center gap-x-1 gap-y-1" role="group" aria-label="Chart timeframe">
          {CHART_TF_GROUPS.map((g, gi) => (
            <span key={g.label} className="flex items-center gap-1" role="group" aria-label={`${g.label} timeframes`}>
              {gi > 0 && <span aria-hidden="true" className="px-0.5 text-[10px] text-[var(--color-text-sub)]">·</span>}
              {g.tfs.map(t => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={t === timeframe}
                  onClick={() => setTimeframe(t)}
                  className={`rounded-full px-1.5 min-h-[26px] text-[11px] font-semibold cursor-pointer ${
                    t === timeframe ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'
                  }`}
                >{t}</button>
              ))}
            </span>
          ))}
          <span className="ml-auto text-[11px] text-[var(--color-text-sub)]">
            {at
              ? <>historical — window around {new Date(at).toLocaleString()}</>
              : live && tick
                ? <>bid {niceFmt(tick.bid, lastClose)} / ask {niceFmt(tick.ask, lastClose)} · <span className="text-[var(--color-accent)] font-semibold">LIVE ticks</span></>
                : <>{niceFmt(lastClose, lastClose)} · bars refresh 15s</>}
          </span>
        </div>
      )}
      {showPanel && (
        <IndicatorPanel
          value={indPrefs}
          onChange={setIndPrefs}
          avwapArmed={avwapArmed}
          onArmAvwap={() => setAvwapArmed(a => !a)}
        />
      )}
      {error && <div className="text-[12px] text-[var(--color-warning-text)] py-2">Chart unavailable: {error}</div>}
      <div className="relative">
        <div ref={boxRef} className={grid ? 'w-full h-[190px]' : 'w-full h-[300px]'} />
        {showPanel && vp && <VolumeProfileSvg vp={vp} height={chartHeight} />}
        {/* Live dot on the forming bar — pulses while the feed is fresh,
            static grey when the market is closed / the feed stalls. */}
        {dot && !at && (
          <span
            aria-hidden="true"
            className="absolute pointer-events-none z-10"
            style={{ left: dot.x - 4, top: dot.y - 4 }}
            title={dot.fresh ? 'live' : 'stale'}
          >
            {dot.fresh && (
              <span className="absolute inline-flex h-2 w-2 rounded-full animate-ping" style={{ backgroundColor: UP, opacity: 0.7 }} />
            )}
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: dot.fresh ? UP : '#94a3b8' }} />
          </span>
        )}
      </div>
      {showPanel && avwapAnchorT != null && indPrefs.indicators.includes('avwap') && (
        <div className="text-[11px] text-[var(--color-text-sub)] mt-1">
          AVWAP anchored at {new Date(avwapAnchorT).toLocaleString()}
          {' · '}
          <button type="button" className="underline cursor-pointer" onClick={() => setAvwapAnchorT(null)}>clear</button>
        </div>
      )}
      {fib && (
        <div className="text-[11px] text-[var(--color-text-sub)] mt-1">
          Fib read ({timeframe}): {String(fib.bias || '').toUpperCase()} fade at 61.8% {niceFmt(fib.level618, lastClose)} — entry {niceFmt(fib.entry, lastClose)}, SL {niceFmt(fib.sl, lastClose)}, TP1 {niceFmt(fib.tp1, lastClose)}, TP2 {niceFmt(fib.tp2, lastClose)}
        </div>
      )}
    </div>
  )
}
