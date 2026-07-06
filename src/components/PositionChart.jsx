// PositionChart — SVG candlestick chart for one symbol, with optional
// entry/SL/TP overlay lines (for an open position) and the agent's current
// fib read (61.8% level + swing leg). Polls the agent for fresh bars while
// mounted, so it acts as a live feed.
//
// Colour rules: up = blue, down = red (owner is red/green colourblind —
// NEVER green). Candle colours use the shared CSS tokens.
import { useEffect, useRef, useState } from 'react'
import { agentPost, agentStreamPrices } from '../lib/agent-api.js'

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d']
const POLL_MS = 15_000

const W = 720
const H = 260
const PAD = { top: 10, right: 56, bottom: 20, left: 8 }

function niceFmt(v, ref) {
  if (v == null) return ''
  const digits = ref >= 1000 ? 1 : ref >= 10 ? 2 : 5
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits })
}

export default function PositionChart({ symbol, timeframe: tf0 = '1h', lines = {} }) {
  const [timeframe, setTimeframe] = useState(tf0)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)
  const [tick, setTick] = useState(null)      // live {bid, ask, t} from SSE
  const [live, setLive] = useState(false)     // stream connected?
  const timer = useRef(null)

  useEffect(() => {
    let dead = false
    const load = async () => {
      try {
        const r = await agentPost('/actions/chart', { symbol, timeframe, bars: 120 })
        if (!dead) { setData(r); setError(''); setUpdatedAt(new Date()) }
      } catch (e) {
        if (!dead) setError(e.message)
      }
    }
    load()
    timer.current = setInterval(load, POLL_MS)
    return () => { dead = true; clearInterval(timer.current) }
  }, [symbol, timeframe])

  // Live tick stream (SSE). If the agent doesn't support it yet or the
  // stream drops, the 15s bar poll above remains the feed.
  useEffect(() => {
    const stream = agentStreamPrices(
      [symbol],
      t => { setTick(t); setLive(true) },
      () => setLive(false),
    )
    return () => stream.close()
  }, [symbol])

  const bars = data?.bars || []
  if (error) return <div className="text-[12px] text-[var(--color-warning-text)] py-2">Chart unavailable: {error}</div>
  if (bars.length === 0) return <div className="text-[12px] text-[var(--color-text-sub)] py-2">Loading {symbol} {timeframe} bars…</div>

  // ---- scales -------------------------------------------------------------
  const overlayVals = [lines.entry, lines.sl, lines.tp, data?.fib?.level618].filter(v => v != null)
  const lo = Math.min(...bars.map(b => b.l), ...overlayVals)
  const hi = Math.max(...bars.map(b => b.h), ...overlayVals)
  const span = hi - lo || 1
  const y = v => PAD.top + (1 - (v - lo) / span) * (H - PAD.top - PAD.bottom)
  const plotW = W - PAD.left - PAD.right
  const step = plotW / bars.length
  const cw = Math.max(1.5, step * 0.62)
  const x = i => PAD.left + i * step + step / 2

  const last = bars[bars.length - 1]
  // Live price: mid of the freshest tick when streaming, else last bar close
  const livePrice = tick?.bid != null && tick?.ask != null
    ? (tick.bid + tick.ask) / 2
    : (tick?.bid ?? tick?.ask ?? last.c)
  const OVERLAYS = [
    lines.entry != null && { v: lines.entry, label: 'entry', cls: 'var(--color-text)' },
    lines.sl != null && { v: lines.sl, label: 'SL', cls: 'var(--color-down)' },
    lines.tp != null && { v: lines.tp, label: 'TP', cls: 'var(--color-up)' },
    data?.fib?.level618 != null && { v: data.fib.level618, label: '61.8%', cls: '#a855f7' },
  ].filter(Boolean)

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
          {live && tick
            ? <>bid {niceFmt(tick.bid, last?.c)} / ask {niceFmt(tick.ask, last?.c)} · <span className="text-[var(--color-accent)] font-semibold">LIVE ticks</span></>
            : <>{niceFmt(last?.c, last?.c)} · bars refresh 15s{updatedAt ? ` · ${updatedAt.toLocaleTimeString()}` : ''}</>}
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img" aria-label={`${symbol} ${timeframe} candlestick chart`}>
          {/* horizontal gridlines */}
          {[0.25, 0.5, 0.75].map(f => {
            const v = lo + span * f
            return <g key={f}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--color-border)" strokeWidth="0.5" />
              <text x={W - PAD.right + 4} y={y(v) + 3} fontSize="9" fill="var(--color-text-sub)">{niceFmt(v, last?.c)}</text>
            </g>
          })}
          {/* candles: blue up / red down (colourblind-safe, no green) */}
          {bars.map((b, i) => {
            const up = b.c >= b.o
            const col = up ? 'var(--color-up)' : 'var(--color-down)'
            return (
              <g key={b.t}>
                <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth="1" />
                <rect
                  x={x(i) - cw / 2}
                  y={y(Math.max(b.o, b.c))}
                  width={cw}
                  height={Math.max(1, Math.abs(y(b.o) - y(b.c)))}
                  fill={col}
                />
              </g>
            )
          })}
          {/* overlay lines */}
          {OVERLAYS.map(o => (
            <g key={o.label}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(o.v)} y2={y(o.v)} stroke={o.cls} strokeWidth="1" strokeDasharray="5 3" />
              <text x={PAD.left + 2} y={y(o.v) - 3} fontSize="9" fontWeight="700" fill={o.cls}>{o.label} {niceFmt(o.v, last?.c)}</text>
            </g>
          ))}
          {/* live price marker (tick-driven when streaming, else last close) */}
          <line x1={PAD.left} x2={W - PAD.right} y1={y(livePrice)} y2={y(livePrice)} stroke="var(--color-accent)" strokeWidth="0.75" />
          <rect x={W - PAD.right + 1} y={y(livePrice) - 7} width={PAD.right - 2} height={14} rx="3" fill="var(--color-accent)" />
          <text x={W - PAD.right + 5} y={y(livePrice) + 3} fontSize="9" fontWeight="700" fill="#fff">{niceFmt(livePrice, last.c)}</text>
        </svg>
      </div>
      {data?.fib && (
        <div className="text-[11px] text-[var(--color-text-sub)] mt-1">
          Fib read ({timeframe}): {data.fib.bias?.toUpperCase()} fade at 61.8% {niceFmt(data.fib.level618, last?.c)} — entry {niceFmt(data.fib.entry, last?.c)}, SL {niceFmt(data.fib.sl, last?.c)}, TP1 {niceFmt(data.fib.tp1, last?.c)}, TP2 {niceFmt(data.fib.tp2, last?.c)}
        </div>
      )}
    </div>
  )
}
