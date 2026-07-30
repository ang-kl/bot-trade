// session-format.js — presentation logic for the browser-session control.
//
// Split out from the component on purpose: the vitest environment in this repo
// is `node` (vite.config.js), so anything that needs a DOM cannot be unit
// tested here. Everything that decides WHAT the session line says lives in
// this file and is tested directly; the component only renders it.
//
// Owner brief (instr/footer_issue.md): "Show how long each browser session has
// been alive and when it was last seen", "Do not reset the alive duration
// merely because a WebSocket reconnects", "Use server timestamps internally.
// Send ISO 8601 UTC timestamps to the client and localise them only for
// presentation."

/** Compact duration: 45s · 18m · 2h 14m · 3d 4h. Null in, null out. */
export function durationText(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** "seen 3s ago" / "seen just now" / null when never seen. */
export function seenText(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return null
  if (ageMs < 1500) return 'seen just now'
  return `seen ${durationText(ageMs)} ago`
}

/**
 * "Active for 2h 14m" — from session creation, never reset by a reconnect.
 *
 * The tense follows the state. Measured in Chromium against seeded sessions,
 * the first version rendered "Disconnected · active for 10d", which asserts
 * two contradictory things in one line; a session that is not connected is not
 * "active for" anything. Only a genuinely live state gets the present tense.
 */
const LIVE_STATES = new Set(['active', 'idle', 'stale'])
export function aliveText(aliveMs, state) {
  const d = durationText(aliveMs)
  if (!d) return null
  return LIVE_STATES.has(state) ? `Active for ${d}` : `Existed ${d}`
}

// Status is NEVER communicated by colour alone (WCAG 1.4.1 and the brief):
// every state carries its own word, and the dot is aria-hidden decoration.
export const STATE_LABEL = {
  active: 'Active',
  idle: 'Idle',
  stale: 'Stale',
  disconnected: 'Disconnected',
  revoked: 'Revoked',
}

// Semantic tokens, not raw hex — so light/dark and high-contrast follow the
// theme the rest of the app already defines.
export const STATE_TONE = {
  active: 'var(--color-up)',
  idle: 'var(--color-warning-text)',
  stale: 'var(--color-warning-text)',
  disconnected: 'var(--color-text-sub)',
  revoked: 'var(--color-down)',
}

export const STATE_HELP = {
  active: 'this browser has checked in within the heartbeat window.',
  idle: 'no check-in for a little while — it is probably in a background tab.',
  stale: 'no check-in for over a minute; it may have been closed or lost network.',
  disconnected: 'no valid check-in, or the credential has expired. It is not receiving anything.',
  revoked: 'signed out from here. Its credential no longer authenticates, so it cannot reconnect.',
}

/**
 * The one visible line: "● Chrome · Active · 3s ago ›" (brief's exact shape).
 * Returns parts rather than a string so the component can style the dot and
 * truncate the middle without re-parsing text.
 */
export function statusLine(session) {
  if (!session) return { browser: 'No session', state: 'disconnected', stateLabel: 'Unknown', age: null }
  const state = session.state || 'disconnected'
  return {
    browser: session.browserFamily || 'Unknown browser',
    state,
    stateLabel: STATE_LABEL[state] || state,
    // Short form for the collapsed line — the popover carries "seen … ago".
    age: durationText(session.lastSeenAgeMs) ? `${durationText(session.lastSeenAgeMs)} ago` : null,
  }
}

/** Local time for display; ISO stays the wire format. */
export function localTime(iso) {
  if (!iso) return '—'
  try {
    // Validate BEFORE formatting. `new Date('nope').toLocaleString()` does not
    // throw — it returns the literal string "Invalid Date", so a try/catch
    // alone would have put that in front of the user on any malformed stamp.
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return '—'
    return new Date(t).toLocaleString([], {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
  } catch { return '—' }
}

/**
 * The current session, and the others, from a /state/sessions payload.
 * `current` is whatever the SERVER marked isCurrent — the client never decides
 * this, which is the point of the endpoint.
 */
export function splitSessions(view) {
  const all = Array.isArray(view?.sessions) ? view.sessions : []
  return {
    current: all.find(s => s.isCurrent) || null,
    others: all.filter(s => !s.isCurrent),
  }
}

/**
 * Confirmation copy for a remote disconnect, per the brief. Named here so the
 * wording is testable and cannot drift into something vaguer.
 */
export function confirmCopy(session) {
  const who = session?.label || 'this browser'
  return {
    title: `Disconnect ${who}?`,
    body: 'This signs that browser out and stops further data reaching it. Orders the server has already accepted are unaffected — they stay under the normal trading safety policy.',
    confirm: 'Disconnect session',
    cancel: 'Cancel',
  }
}
