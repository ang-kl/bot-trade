// error-log — one place that owns the `errors_today` counter.
//
// Why this exists (owner-visible defect, 2026-07-28): production reported
// `errorsToday: 21` while `lastError` still carried an April timestamp. Two
// separate call sites incremented the counter, and only one of them wrote
// `last_error`:
//
//   loop.js catch      → errors_today++  AND  last_error = "<iso> <msg>"
//   loop.js scan errs  → errors_today++  but only api_ctrader_last_error
//
// So every scan-fetch failure bumped the number the owner sees without
// recording what failed anywhere the owner looks. Twenty-one failures, zero
// explanation. A counter you cannot resolve to causes is worse than no
// counter: it reads as noise, and then a real spike reads as noise too.
//
// Two changes fix that for good:
//
// 1. Every increment goes through recordError(), which always writes
//    `last_error` as well. There is no way to bump the count silently.
// 2. `last_error` alone is still only the MOST RECENT one. So we also keep a
//    bounded ring of the last RING_MAX distinct errors, with repeats collapsed
//    into a count. 21 failures now render as, say, three lines with n=14/5/2 —
//    which is the actual diagnosis, not a number to squint at.
//
// The ring lives in agent_state as JSON rather than a table: it is capped,
// read whole, never joined, and needs no migration.

import { getState, setState } from '../db.js'

export const RING_KEY = 'recent_errors_json'
export const RING_MAX = 20

/** Read the ring, newest first. Never throws — health routes depend on it. */
export function readRecentErrors(db) {
  try {
    const parsed = JSON.parse(getState(db, RING_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Record one failure: bump `errors_today`, write `last_error`, and push onto
 * the ring (collapsing a repeat of the same source+message into `n`).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} source — which subsystem failed, e.g. 'loop' or 'scan-fetch'.
 *   Shows up in `last_error` as a bracketed tag so the owner can tell a broker
 *   fetch failure from a loop crash without reading code.
 * @param {string} message
 * @param {{ extraKey?: string }} [opts] — extraKey also receives the stamped
 *   message (used to keep `api_ctrader_last_error` working as before).
 * @returns {number} the new errors_today value
 */
export function recordError(db, source, message, opts = {}) {
  const at = new Date().toISOString()
  const msg = String(message ?? '').slice(0, 500) || 'unknown error'
  const src = String(source || 'unknown')
  const stamped = `${at} [${src}] ${msg}`

  const count = Number(getState(db, 'errors_today') || 0) + 1
  setState(db, 'errors_today', String(count))
  setState(db, 'last_error', stamped)
  if (opts.extraKey) setState(db, opts.extraKey, `${at} ${msg}`)

  const ring = readRecentErrors(db)
  const head = ring[0]
  if (head && head.source === src && head.message === msg) {
    // Same failure again — a repeat is a stronger signal than a new line, but
    // it must not push the OTHER causes out of a 20-slot window.
    head.n = Number(head.n || 1) + 1
    head.lastAt = at
  } else {
    ring.unshift({ at, lastAt: at, source: src, message: msg, n: 1 })
  }
  setState(db, RING_KEY, JSON.stringify(ring.slice(0, RING_MAX)))

  return count
}

/** Clear the counter, `last_error` and the ring together — used by the reset routes. */
export function clearErrorLog(db) {
  setState(db, 'errors_today', '0')
  setState(db, 'last_error', null)
  setState(db, RING_KEY, '[]')
}
