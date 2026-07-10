// PositionChart — professional candlestick chart powered by Lightweight
// Charts (TradingView's open-source engine, bundled locally — no CDN).
// Shows OHLC bars for a symbol with price lines for the position's
// entry/SL/TP and the scanner's 61.8% fib level, plus live tick updates
// from the agent's SSE stream. Colours: blue up / red down (no green).
import { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, createSeriesMarkers } from 'lightweight-charts'
import { agentPost, agentStreamPrices } from '../lib/agent-api.js'

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d']
const POLL_MS = 15_000
const UP = '#2563eb', DOWN = '#dc2626', VIOLET = '#a855f7'

function niceFmt(v, ref) {
  if (v == null) return ''
  const digits = ref >= 1000 ? 1 : ref >= 10 ? 2 : 5
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits })
}

// Historical mode: pass `at` (epoch ms of a past trade) — bars are fetched
// AROUND that moment (no polling, no live ticks, no fib overlay) and
// `markers` ({ entryT, exitT } epoch ms) pins the fill/exit on the candles.
// grid: true = many-charts mode — no live tick stream (16 SSE connections
// would hammer the agent), 60s polls, shorter canvas.
export default function PositionChart({ symbol, timeframe: tf0 = '1h', lines = {}, at = null, markers = null, grid = false }) {
  const [timeframe, setTimeframe] = useState(tf0)
  const [error, setError] = useState('')
  const [fib, setFib] = useState(null)
  const [tick, setTick] = useState(null)
  const [live, setLive] = useState(false)
  const [lastClose, setLastClose] = useState(null)

  const boxRef = useRef(null)
  const chartRef = useRef(null)     // { chart, series, priceLines: [] }
  const lastBarRef = useRef(null)   // forming bar, updated by live ticks

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
    chartRef.current = { chart, series, priceLines: [] }
    return () => { chart.remove(); chartRef.current = null }
  }, [])

  // Bars: fetch now and every 15s (the poll also keeps SL/TP overlays fresh).
  useEffect(() => {
    let dead = false
    const load = async () => {
      try {
        const r = await agentPost('/actions/chart', { symbol, timeframe, bars: 200, ...(at ? { centerT: at } : {}) })
        if (dead || !chartRef.current) return
        const bars = (r.bars || []).map(b => ({
          time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c,
        }))
        chartRef.current.series.setData(bars)
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
            markers.exitT && { time: snap(markers.exitT), position: 'aboveBar', shape: 'square', color: VIOLET, text: 'exit' },
          ].filter(Boolean)
          createSeriesMarkers(chartRef.current.series, defs)
        }
        setLastClose(r.lastPrice ?? null)
        setFib(r.fib || null)
        setError('')
      } catch (e) { if (!dead) setError(e.message) }
    }
    load()
    if (at) return () => { dead = true } // historical: one fetch, no polling
    const t = setInterval(load, grid ? 60_000 : POLL_MS)
    return () => { dead = true; clearInterval(t) }
  }, [symbol, timeframe, at, grid])

  // Price lines: entry/SL/TP from the position + the scanner's 61.8% level.
  useEffect(() => {
    const ref = chartRef.current
    if (!ref) return
    for (const pl of ref.priceLines) ref.series.removePriceLine(pl)
    ref.priceLines = []
    const defs = [
      lines.entry != null && { price: Number(lines.entry), color: '#94a3b8', title: 'entry' },
      lines.sl != null && { price: Number(lines.sl), color: DOWN, title: 'SL' },
      lines.tp != null && { price: Number(lines.tp), color: UP, title: 'TP' },
      fib?.level618 != null && { price: Number(fib.level618), color: VIOLET, title: '61.8%' },
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
        }
      },
      () => setLive(false),
    )
    return () => stream.close()
  }, [symbol, at, grid])

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        {TIMEFRAMES.map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTimeframe(t)}
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold cursor-pointer ${
              t === timeframe ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'
            }`}
          >{t}</button>
        ))}
        <span className="ml-auto text-[11px] text-[var(--color-text-sub)]">
          {at
            ? <>historical — window around {new Date(at).toLocaleString()}</>
            : live && tick
              ? <>bid {niceFmt(tick.bid, lastClose)} / ask {niceFmt(tick.ask, lastClose)} · <span className="text-[var(--color-accent)] font-semibold">LIVE ticks</span></>
              : <>{niceFmt(lastClose, lastClose)} · bars refresh 15s</>}
        </span>
      </div>
      {error && <div className="text-[12px] text-[var(--color-warning-text)] py-2">Chart unavailable: {error}</div>}
      <div ref={boxRef} className={grid ? 'w-full h-[190px]' : 'w-full h-[300px]'} />
      {fib && (
        <div className="text-[11px] text-[var(--color-text-sub)] mt-1">
          Fib read ({timeframe}): {String(fib.bias || '').toUpperCase()} fade at 61.8% {niceFmt(fib.level618, lastClose)} — entry {niceFmt(fib.entry, lastClose)}, SL {niceFmt(fib.sl, lastClose)}, TP1 {niceFmt(fib.tp1, lastClose)}, TP2 {niceFmt(fib.tp2, lastClose)}
        </div>
      )}
    </div>
  )
}
