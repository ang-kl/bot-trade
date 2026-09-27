// loop-breaker — the main loop's consecutive-failure counter, backoff and
// circuit breaker, as a state machine the loop drives once per cycle.
//
// Why this is its own module (27-09-2026, owner-approved): in loop.js the
// counter was incremented in the cycle's catch and then zeroed on the line
// right after it, which every cycle below the backoff threshold fell through
// to. The count therefore never exceeded 1, so the backoff (at 5) and the
// hard breaker (at 10) were on, configured and unreachable. The reset now
// belongs to endCycle(), which refuses to clear a cycle that recorded a
// failure — and that refusal is testable here, where runLoop is not.
//
// The values are the loop's, passed in unchanged; this module owns the
// sequencing only.

/**
 * @param {object} o
 * @param {number} o.maxConsecutive  failing cycles in a row that trip the breaker
 * @param {number} o.backoffAfter    failing cycles in a row from which the loop backs off
 * @param {number} o.backoffCapMs    ceiling on one backoff sleep
 */
export function createLoopBreaker({ maxConsecutive, backoffAfter, backoffCapMs }) {
  let count = 0
  let cycleFailed = false

  return {
    /** Consecutive failing cycles so far. */
    get count() { return count },

    /** True once `maxConsecutive` failing cycles have run back to back. */
    isTripped() { return count >= maxConsecutive },

    /** Start of a cycle's main block: no failure recorded for it yet. */
    beginCycle() { cycleFailed = false },

    /**
     * The cycle's main block threw. Returns the new count and how long the
     * loop must sleep before the next cycle (0 = the normal schedule).
     */
    recordFailure(intervalMs) {
      cycleFailed = true
      count++
      const backoffMs = count >= backoffAfter ? Math.min(backoffCapMs, intervalMs * count) : 0
      return { count, backoffMs, tripped: count >= maxConsecutive }
    },

    /**
     * End of a cycle that did not back off. Clears the count ONLY when the
     * cycle recorded no failure. `reset` is true when a non-zero streak was
     * cleared, so the loop can say so; `was` is the streak it cleared.
     */
    endCycle() {
      if (cycleFailed) return { clean: false, reset: false, was: count, count }
      const was = count
      count = 0
      return { clean: true, reset: was > 0, was, count }
    },

    /** Manual reset (POST /actions/reset-breaker). */
    reset() { count = 0; cycleFailed = false },
  }
}
