// ---------------------------------------------------------------------------
// agent/services/llm-monitor-health.js — owner (2026-07-27): "I need to be
// alerted if any of the LLM failed and you still continue" — the monitor
// phase's per-position LLM check (agent/loop.js, runMonitorCheck) used to
// fail completely silently: caught, logged to the Railway console, nothing
// else. Trading was never at risk (the deterministic rules already ran
// first and the broker-side SL/TP keep protecting regardless), but the
// owner had zero visibility that it was happening.
//
// This module tracks a simple consecutive-failure streak (one blip is
// normal — a rate limit, a network hiccup; several in a row means the LLM
// is genuinely unavailable, e.g. an exhausted credit balance) and decides
// when to alert. Mirrors the mute-window pattern already used for veto
// alerts (agent/loop.js's alertVetoOnce) so a sustained outage doesn't
// spam Telegram every single loop.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

export const FAIL_STREAK_ALERT_THRESHOLD = 3
export const ALERT_MUTE_MS = 3600_000 // 1h — a sustained outage re-alerts hourly, not every loop

const STATE_KEY = 'llm_monitor_health_json'

function readState(db) {
  try {
    const raw = JSON.parse(getState(db, STATE_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

/**
 * Record one monitor-check outcome. `ok:false` increments the streak;
 * `ok:true` resets it to 0. Never throws — a health-tracking failure must
 * not touch trading.
 */
export function recordLlmMonitorResult(db, { ok, reason = null } = {}) {
  try {
    const prev = readState(db)
    const next = ok
      ? { failStreak: 0, lastOkAt: new Date().toISOString(), lastFailAt: prev.lastFailAt ?? null, lastFailReason: prev.lastFailReason ?? null, lastAlertAt: prev.lastAlertAt ?? null }
      : {
          failStreak: (Number(prev.failStreak) || 0) + 1,
          lastOkAt: prev.lastOkAt ?? null,
          lastFailAt: new Date().toISOString(),
          lastFailReason: reason != null ? String(reason).slice(0, 300) : null,
          lastAlertAt: prev.lastAlertAt ?? null,
        }
    setState(db, STATE_KEY, JSON.stringify(next))
    return next
  } catch { return null }
}

/** Current health snapshot, plus a derived `degraded` flag for the UI. */
export function getLlmMonitorHealth(db) {
  const s = readState(db)
  const failStreak = Number(s.failStreak) || 0
  return {
    failStreak,
    degraded: failStreak >= FAIL_STREAK_ALERT_THRESHOLD,
    lastOkAt: s.lastOkAt ?? null,
    lastFailAt: s.lastFailAt ?? null,
    lastFailReason: s.lastFailReason ?? null,
  }
}

/** Pure decision: should this failure trigger a (re-)alert right now? */
export function shouldAlert(failStreak, lastAlertAt, now = Date.now()) {
  if (failStreak < FAIL_STREAK_ALERT_THRESHOLD) return false
  if (!lastAlertAt) return true
  const last = Date.parse(lastAlertAt)
  if (!Number.isFinite(last)) return true
  return now - last >= ALERT_MUTE_MS
}

/**
 * Stamp the alert timestamp after actually sending one — separate from
 * `shouldAlert` so the caller controls exactly when the mute window
 * starts (only after a real send, not a failed one).
 */
export function markAlerted(db, now = new Date()) {
  try {
    const prev = readState(db)
    setState(db, STATE_KEY, JSON.stringify({ ...prev, lastAlertAt: now.toISOString() }))
  } catch { /* best effort — a missed stamp just re-alerts sooner */ }
}
