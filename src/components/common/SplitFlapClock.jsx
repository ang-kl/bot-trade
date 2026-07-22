// ---------------------------------------------------------------------------
// SplitFlapClock — airport-departure-board style HH:MM:SS readout.
//
// Owner: "hh:mm:ss effects like airport flight flip and ':' blink" for the
// live heartbeat table. Each digit renders as a flip tile (a brief
// rotate/fade on change, like a split-flap card turning over); the colon
// blinks every second the same way a departure board's does.
//
// Pass `iso` for a fixed timestamp (e.g. a controller's last beat) or leave
// it null to tick the wall clock live once per second.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'

function partsFrom(iso) {
  const t = iso ? Date.parse(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z') : Date.now()
  const d = Number.isFinite(t) ? new Date(t) : new Date()
  const p = (n) => String(n).padStart(2, '0')
  return [p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())]
}

// Remounting the span (via `key`) on every digit change re-triggers the CSS
// animation from scratch — a split-flap "turn over" with no JS-driven state.
function FlipDigit({ ch }) {
  return (
    <span
      key={ch}
      className="split-flap-digit"
      style={{
        display: 'inline-block', width: '1ch', textAlign: 'center',
        animation: 'split-flap-turn 140ms ease-out',
      }}
    >
      {ch}
    </span>
  )
}

export default function SplitFlapClock({ iso = null, tickLive = false, className = '', title }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!tickLive) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [tickLive])
  const [hh, mm, ss] = partsFrom(iso ?? (tickLive ? new Date(now).toISOString() : null))
  const full = `${hh}:${mm}:${ss}`
  return (
    <span
      className={`inline-flex items-center gap-[1px] font-mono tabular-nums rounded px-1 py-px ${className}`}
      style={{ background: 'var(--color-bg-inset, rgba(127,127,127,0.12))', border: '1px solid var(--color-border)' }}
      title={title ?? full}
      aria-label={full}
    >
      {hh.split('').map((c, i) => <FlipDigit key={`h${i}`} ch={c} />)}
      <span aria-hidden="true" className="split-flap-colon" style={{ animation: 'split-flap-blink 1s steps(1) infinite' }}>:</span>
      {mm.split('').map((c, i) => <FlipDigit key={`m${i}`} ch={c} />)}
      <span aria-hidden="true" className="split-flap-colon" style={{ animation: 'split-flap-blink 1s steps(1) infinite' }}>:</span>
      {ss.split('').map((c, i) => <FlipDigit key={`s${i}`} ch={c} />)}
      <style>{`
        @keyframes split-flap-blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0.15 } }
        @keyframes split-flap-turn { 0% { transform: scaleY(0.15); opacity: 0.3 } 100% { transform: scaleY(1); opacity: 1 } }
      `}</style>
    </span>
  )
}
