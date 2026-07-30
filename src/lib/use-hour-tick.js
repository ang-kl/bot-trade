// useHourTick — a clock that ticks once per hour, on the hour.
//
// Owner (2026-07-30) on the 24-hour table: "you should always show the current
// time as the top row and the past hour below it, currently is static."
//
// It was static because the only "now" the table had was `loadedAt`, stamped
// when data arrived. Between loads the live-hour marker and the row order were
// frozen at whatever the last fetch happened to see.
//
// WHY NOT A SHORT TIMER. The obvious fix — re-render every 30 seconds — is the
// one the owner has objected to before: it churns the table and lets text drift
// between hours for no gain. The row order can only change at an hour boundary,
// so that is the only moment worth waking for. One timer, aimed at the next
// exact hour, then re-armed.
//
// This deliberately does NOT refetch. The ordering follows the clock; the
// figures follow the page's own poll. Mixing them would turn an hour boundary
// into a network request.
import { useEffect, useState } from 'react'
import { nextHourBoundary } from './hourly-order.js'

/**
 * @returns {number} a timestamp that changes only when the hour changes.
 */
export function useHourTick() {
  const [hourMs, setHourMs] = useState(() => Date.now())

  useEffect(() => {
    let timer = null
    let alive = true
    const arm = () => {
      const now = Date.now()
      // A small cushion past the boundary so the timer never fires a
      // millisecond EARLY and computes the outgoing hour as still current —
      // which would leave the wrong row marked NOW until the next tick, an
      // hour later. Floored so a clock jump cannot schedule a zero-delay loop.
      const delay = Math.max(1000, nextHourBoundary(now) - now + 500)
      timer = setTimeout(() => {
        if (!alive) return
        // Date.now() rather than the expected boundary: if the machine slept
        // through several hours this fires late, and the truth is the clock,
        // not the schedule. One late tick with the right value beats an
        // on-time tick with a stale one.
        setHourMs(Date.now())
        arm()
      }, delay)
    }
    arm()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])

  return hourMs
}
