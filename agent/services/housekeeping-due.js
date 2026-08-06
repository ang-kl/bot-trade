// ---------------------------------------------------------------------------
// agent/services/housekeeping-due.js — is the housekeeping pass due?
//
// WHY THIS IS A MODULE AND NOT AN `if`.
//
// The condition it replaces was `loopCount % 100 === 0`, where `loopCount` is
// module state in loop.js initialised to 0 at import. A hundred loops is about
// eight hours — so the pass fires eight hours after **process start**, and the
// counter goes back to zero on every restart.
//
// The agent restarts on every deploy. On 2026-08-06 there were seven merges to
// main before noon, and `GET /health` reported `uptime: 7505` — two hours. The
// block had not run. Nor, on the evidence, had it run for a long time:
//
//   GET /state/dispositions?days=7  ->  counts {}   pendingNow 54,815
//
// Every risk_event in the window carried `disposition IS NULL`. The sweep that
// settles them lives in that block, and so does data retention, which is why
// risk_events had grown to ~59,505 rows against a 90-day cutoff that never ran.
//
// The failure is silent by construction: a pass that never fires logs nothing,
// and `loopCount % 100` looks correct in review. It reads as "every 100 loops"
// and means "100 loops after the last restart, and never on a busy day".
//
// So the cadence is now WALL-CLOCK and PERSISTED, and it lives here where a
// test can drive it without a database, a loop, or eight hours.
// ---------------------------------------------------------------------------

/** Default gap between passes. Matches the old intent: ~8 hours. */
export const DEFAULT_INTERVAL_MS = 8 * 60 * 60 * 1000

/** The agent_state key holding the last successful pass, as an ISO string. */
export const LAST_RUN_KEY = 'housekeeping_last_at'

/**
 * Should the housekeeping pass run now?
 *
 * A NEVER-RUN DATABASE RUNS IMMEDIATELY, and deliberately: that is both the
 * fresh-install case and the case this fix exists for — a system whose backlog
 * has been accumulating precisely because the pass never fired. Waiting eight
 * more hours to start clearing 54,815 unsettled rows would be a strange
 * reading of "due".
 *
 * An UNPARSEABLE stamp is treated as never-run rather than as now. The failure
 * modes are not symmetric: treating junk as "just ran" reproduces the original
 * bug (silently skips forever), while treating it as "never ran" costs one
 * extra pass and then self-corrects on the next write.
 *
 * A stamp in the FUTURE also runs. Clocks move backwards — a container restart
 * on a corrected clock should not disable housekeeping until the future
 * catches up.
 *
 * @param {string|null|undefined} lastAt   ISO stamp of the last pass
 * @param {number} nowMs
 * @param {number} intervalMs
 * @returns {boolean}
 */
export function housekeepingDue(lastAt, nowMs = Date.now(), intervalMs = DEFAULT_INTERVAL_MS) {
  if (lastAt == null || lastAt === '') return true
  const t = Date.parse(String(lastAt))
  if (!Number.isFinite(t)) return true
  if (t > nowMs) return true
  return nowMs - t >= intervalMs
}
