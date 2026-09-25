// ---------------------------------------------------------------------------
// agent/lib/autopilot-cadence.js — WHEN the strategy autopilot sweeps, in one
// place that both the evaluator and the heartbeat read.
//
// Moved here from services/strategy-autopilot.js (V3 I2, 25-09-2026) with the
// function bodies unchanged; strategy-autopilot.js re-exports every name, so
// its callers and tests import what they imported before. The move exists
// because the heartbeat needs the cadence and cannot import the evaluator:
// strategy-autopilot.js imports lib/exec-engine.js, which imports
// services/heartbeat.js, so the direct import would be a cycle. This module
// imports only the db reader and the session table.
//
// WHY THE HEARTBEAT NEEDS IT (measured on production 25-09-2026). The
// autopilot's record is `autopilot_last_run_ms`, stamped when a sweep
// launches. The heartbeat judged it against the SCHEDULER's window, one loop
// period × 3 = 180 s, while the sweep runs every 10 min in a busy window and
// every 30 min otherwise. So /state/heartbeats read `warn` / `record_stale`
// ("RECORD 26m OLD — past the 3m limit") for 27 of every 30 minutes calm and 7 of 10 busy,
// while action_log showed a completed /evaluate row every 10.0–11.0 min
// (busy) and 30.0–32.2 min (calm) with 0 errors, and /state/config showed
// the same stamp minutes old. The sweep was running; the limit was wrong.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { getActiveSessions } from './sessions.js'

export const BUSY_MS = 10 * 60_000        // US session — the action window
export const CALM_MS = 30 * 60_000        // otherwise

export function autopilotMode(db) {
  const m = getState(db, 'autopilot_mode')
  return m === 'auto' || m === 'suggest' ? m : 'off'
}

// `now` defaults to the clock, which is what every existing caller used.
export function hourInTz(tz, now = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now))
  } catch { return null }
}

/**
 * Is the clock inside an "active" window that warrants the fast cadence? Pure —
 * the caller injects the current sessions + Tokyo hour so it's unit-testable.
 * Two owner windows:
 *   · US: Chicago/NY open until Sydney opens (NY session live, or the thin
 *     NY→Sydney handover before Asia opens).
 *   · JPN225: premarket 1h + first 4 trading hours → 08:00–13:00 JST.
 */
export function isBusyWindow(sessionLabels = [], tokyoHour = null) {
  const nyActive = sessionLabels.includes('New York')
  const asiaOpen = sessionLabels.includes('Sydney') || sessionLabels.includes('Tokyo') || sessionLabels.includes('Singapore')
  const usBusy = nyActive || (sessionLabels.length === 0 && !asiaOpen)
  const jpnBusy = tokyoHour != null && tokyoHour >= 8 && tokyoHour < 13
  return usBusy || jpnBusy
}

/**
 * Re-run cadence. An explicit autopilot_interval_ms (≥ 5 min) overrides;
 * otherwise SESSION-ADAPTIVE (owner): every 10 min inside a busy window
 * (see isBusyWindow), every 30 min otherwise.
 *
 * `opts.now` (a Date) asks the question at another instant; omitted, it is
 * the clock, exactly as before. `opts.sessions` / `opts.tokyoHour` still win
 * when given.
 */
export function autopilotIntervalMs(db, opts = {}) {
  const override = Number(getState(db, 'autopilot_interval_ms'))
  if (Number.isFinite(override) && override >= 300_000) return override
  const now = opts.now ?? new Date()
  const labels = (opts.sessions ?? getActiveSessions(now)).map(s => s.label)
  const tokyoHour = opts.tokyoHour ?? hourInTz('Asia/Tokyo', now)
  return isBusyWindow(labels, tokyoHour) ? BUSY_MS : CALM_MS
}

/**
 * The longest the evaluator may legitimately leave its record unwritten, in
 * seconds, EXCLUDING the scheduler's own grace (the heartbeat adds that).
 *
 * The evaluator launches on the first loop cycle where
 * `now − last ≥ autopilotIntervalMs(now)`. The interval changes at window
 * edges, so the interval in force NOW is not enough: a record stamped in a
 * calm window is legitimately up to 30 min old at the moment a busy window
 * opens (measured 25-09: 13:33:39 → 14:01:19 UTC, 27.7 min, across the NY
 * open), and judging it by the busy 10 min would print record_stale for the
 * cycle it takes to launch. The larger of the interval at the record's own
 * instant and the interval now covers both edges.
 *
 * A stamp of 0 (POST /actions/autopilot runNow resets it to request a run)
 * or an unreadable one is judged by the interval now.
 */
export function autopilotRecordCadenceSec(db, { nowMs = Date.now(), recordAtMs = null } = {}) {
  const atNow = autopilotIntervalMs(db, { now: new Date(nowMs) })
  const atRecord = Number.isFinite(recordAtMs) && recordAtMs > 0
    ? autopilotIntervalMs(db, { now: new Date(recordAtMs) })
    : atNow
  return Math.max(atNow, atRecord) / 1000
}

/**
 * Dormant BY DESIGN: autopilot_mode 'off' schedules no sweep
 * (maybeRunAutopilot returns `skipped: 'off'` every cycle), so an aging
 * record is the expected state, not a stale one. Only the owner's switch
 * counts; missing credentials are a fault and stay judged.
 * @returns {string|null} the reason, or null when a sweep is expected
 */
export function autopilotDormantReason(db) {
  if (autopilotMode(db) !== 'off') return null
  return 'autopilot_mode is off — no evidence sweep is scheduled, so no record is expected (POST /actions/autopilot sets the mode)'
}
