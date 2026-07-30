// useTableClock — the captured "now" behind the rolling 24-hour table.
//
// Owner (2026-07-30) on the old FX-day table: "you should always show the
// current time as the top row and the past hour below it, currently is static."
// It was static because the only "now" the table had was `loadedAt`, stamped
// when data arrived; between loads the live marker and the row order were
// frozen at whatever the last fetch happened to see.
//
// Owner (2026-07-31), setting the cadence for the rolling version: "now is
// 6:20 AM (trading in the block of 10 minutes) the next refresh is 6:30 AM."
//
// WHY TEN MINUTES AND NOT SIXTY. The hour-aligned table could only change on
// the hour, so waking more often was pure churn — that reasoning is why this
// used to be useHourTick. Rolling windows are anchored on the live minute, so
// the labels AND the buckets genuinely move between ticks; a slower clock would
// leave the table quietly describing a window that has drifted out from under
// it. Ten minutes is the owner's figure.
//
// Aligned to the wall clock rather than to page load, so two tabs open side by
// side relabel together instead of a few minutes apart.
//
// This deliberately does NOT refetch. The window follows the clock; the figures
// follow the page's own poll. Mixing them would turn a tick into a network
// request.
import { useEffect, useState } from 'react'
import { nextTickBoundary } from './hourly-order.js'

/**
 * @param {number} stepMs tick cadence; default 10 minutes (the owner's).
 * @returns {number} a timestamp that changes once per step, on the step.
 */
export function useTableClock(stepMs = 10 * 60 * 1000) {
  const [ms, setMs] = useState(() => Date.now())

  useEffect(() => {
    let timer = null
    let alive = true
    const arm = () => {
      const now = Date.now()
      // A small cushion past the boundary so the timer never fires a
      // millisecond EARLY and computes the outgoing step as still current —
      // which would leave the table one step stale until the next tick.
      // Floored so a clock jump cannot schedule a zero-delay loop.
      const delay = Math.max(1000, nextTickBoundary(now, stepMs) - now + 500)
      timer = setTimeout(() => {
        if (!alive) return
        // Date.now() rather than the expected boundary: if the machine slept
        // through several steps this fires late, and the truth is the clock,
        // not the schedule. One late tick with the right value beats an
        // on-time tick with a stale one.
        setMs(Date.now())
        arm()
      }, delay)
    }
    arm()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [stepMs])

  return ms
}
