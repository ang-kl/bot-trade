// ---------------------------------------------------------------------------
// agent/services/browser-sessions.js — the authoritative browser-session
// record, and the only place a session may be revoked.
//
// Owner brief (instr/footer_issue.md): "Protect the current browser session
// from being disconnected through its own session-management interface",
// "Allow authenticated users to revoke and disconnect other browser sessions",
// "Ensure a revoked remote session cannot continue connecting, receiving
// events, submitting commands or consuming queued/spooled data."
//
// ===========================================================================
// WHAT A "SESSION" ACTUALLY IS IN THIS APP — read this before extending it
// ===========================================================================
// The brief is written for a WebSocket/SSE architecture. This app does not
// have one, and pretending otherwise would be the kind of claim the owner
// has told me not to make. The facts, from the code:
//
//   * The authenticated session IS a device-session bearer token, minted by
//     the Telegram login flow (agent/index.js addSession) and stored in
//     agent_state under `device_sessions` as { rawToken: expiresAtMs }.
//   * The browser reaches the agent by POLLING (src/lib/agent-api.js). There
//     is no WebSocket and no EventSource anywhere on the browser path — the
//     only WebSockets in this repo talk to the BROKER, from the Node agent
//     and the C++ sidecar, and have nothing to do with a browser session.
//   * So the transport is `polling`, honestly reported as such. "Close mapped
//     WebSocket connections" has no browser-side referent here; the
//     equivalent — and it is a STRONGER guarantee, not a weaker one — is that
//     the token stops authenticating, so the very next poll gets a 401 and
//     every subsequent request is refused at the auth middleware, before any
//     route, cache or queue is touched.
//
// Revocation is therefore: delete the raw token from `device_sessions` (that
// is what actually blocks it) and keep a metadata row marked revoked so the
// UI can still show WHEN and BY WHOM. Deleting is atomic under SQLite's
// single-writer model, and it survives a restart because it is a durable
// state write — an offline device stays revoked, which is exactly what the
// brief asks for.
//
// TOKENS ARE NEVER STORED HERE AND NEVER LEAVE. This module keys everything
// on sha256(token) and exposes only the first 16 hex of it as a public id.
// The UI receives that id and a masked tail; the raw token exists only in the
// `device_sessions` map that the auth middleware reads.
//
// The master AGENT_SECRET is NOT a session and cannot be revoked here. It has
// no per-device identity, so revoking it would sign out every device at once.
// sessionsView reports such a caller as an un-revokable `master` session and
// says rotating the env var is the only way to invalidate it, rather than
// offering a button that would quietly do something much larger than asked.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { getState, setState } from '../db.js'

const META_KEY = 'browser_sessions'
const AUTH_KEY = 'device_sessions'

// Lifecycle thresholds — "Make all thresholds configurable" (brief). Seconds.
const num = (v, d) => {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : d
}
export const THRESHOLDS = Object.freeze({
  activeS: num(process.env.SESSION_ACTIVE_S, 15),
  idleS: num(process.env.SESSION_IDLE_S, 60),
  staleS: num(process.env.SESSION_STALE_S, 120),
  heartbeatS: num(process.env.SESSION_HEARTBEAT_S, 5),
})

/** Public, non-reversible id for a raw bearer token. */
export function publicSessionId(token) {
  if (!token) return null
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
}

/** "…7A21" — enough to tell two sessions apart, not enough to be an id leak. */
export function maskSessionId(publicId) {
  const s = String(publicId || '')
  return s ? `…${s.slice(-4).toUpperCase()}` : '—'
}

function readMeta(db) {
  try {
    const raw = JSON.parse(getState(db, META_KEY) || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}
function writeMeta(db, meta) {
  setState(db, META_KEY, JSON.stringify(meta))
}
function readAuth(db) {
  try {
    const raw = JSON.parse(getState(db, AUTH_KEY) || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}

// ---------------------------------------------------------------------------
// User-agent → browser / OS / device. Deliberately small and honest: an
// unrecognised UA yields nulls, which the UI renders as "Unknown browser",
// NOT a confident guess. "Do not use browser fingerprinting as the sole
// session identity" (brief) — this is display metadata only; identity is the
// cryptographically random token minted at login.
// ---------------------------------------------------------------------------
const BROWSERS = [
  // Order matters: Edge/Opera/Brave UAs all contain "Chrome".
  [/Edg\/([\d.]+)/, 'Edge'],
  [/OPR\/([\d.]+)/, 'Opera'],
  [/Firefox\/([\d.]+)/, 'Firefox'],
  [/Chrome\/([\d.]+)/, 'Chrome'],
  [/Version\/([\d.]+).*Safari/, 'Safari'],
]
const OSES = [
  [/Windows NT 10/, 'Windows'], [/Windows/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X/, 'macOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
]
export function parseUserAgent(ua) {
  const s = String(ua || '')
  let browserFamily = null
  let browserVersion = null
  for (const [re, name] of BROWSERS) {
    const m = s.match(re)
    if (m) { browserFamily = name; browserVersion = (m[1] || '').split('.')[0] || null; break }
  }
  let operatingSystem = null
  for (const [re, name] of OSES) if (re.test(s)) { operatingSystem = name; break }
  const deviceType = /iPad|Tablet/.test(s)
    ? 'tablet'
    : /iPhone|Android.*Mobile|Mobile/.test(s)
      ? 'mobile'
      : operatingSystem ? 'desktop' : null
  return { browserFamily, browserVersion, operatingSystem, deviceType }
}

/** "Chrome 138 on macOS", degrading gracefully rather than inventing. */
export function describeSession(s) {
  if (!s) return 'Unknown browser'
  const b = s.browserFamily
    ? s.browserVersion ? `${s.browserFamily} ${s.browserVersion}` : s.browserFamily
    : 'Unknown browser'
  return s.operatingSystem ? `${b} on ${s.operatingSystem}` : b
}

// A metadata write on EVERY authenticated request would turn a JSON blob
// rewrite into the hottest path in the process. Throttle per session; the
// displayed last-seen age only needs heartbeat resolution.
const lastTouchAt = new Map()
const TOUCH_THROTTLE_MS = 5_000

/**
 * Record server-authoritative activity for the token that made this request.
 * Creates the metadata row the first time a token is seen, so sessions minted
 * before this module existed still appear (with createdAt from the auth map's
 * expiry, back-derived, and flagged `createdAtEstimated`).
 *
 * Server timestamps only — "Do not rely only on a client-side flag" (brief).
 */
export function touchSession(db, token, { ua, ip, appBuild, nowMs = Date.now() } = {}) {
  const id = publicSessionId(token)
  if (!id) return null
  const last = lastTouchAt.get(id) || 0
  const meta = readMeta(db)
  const known = meta[id]
  // Always write the first sighting; throttle only the repeat updates.
  if (known && nowMs - last < TOUCH_THROTTLE_MS) return id
  lastTouchAt.set(id, nowMs)

  if (!known) {
    const auth = readAuth(db)
    const expiresAt = Number(auth[token] || 0)
    // A session is minted with a 90-day life (index.js addSession), so the
    // expiry back-derives a createdAt for pre-existing tokens. Flagged as an
    // estimate rather than presented as a measurement.
    const derived = expiresAt ? expiresAt - 90 * 86_400_000 : nowMs
    meta[id] = {
      createdAt: derived,
      createdAtEstimated: true,
      authenticatedAt: derived,
      lastSeenAt: nowMs,
      lastActivityAt: nowMs,
      generation: 1,
      revokedAt: null,
      revokedBySessionId: null,
      revocationReason: null,
      ...parseUserAgent(ua),
      ua: String(ua || '').slice(0, 200) || null,
      ip: String(ip || '').slice(0, 64) || null,
      appBuild: appBuild ? String(appBuild).slice(0, 40) : null,
    }
  } else {
    meta[id] = {
      ...known,
      lastSeenAt: nowMs,
      lastActivityAt: nowMs,
      // Refresh device details when a UA arrives (the first sighting may have
      // been a non-browser call), but never overwrite known with unknown.
      ...(ua ? { ...parseUserAgent(ua), ua: String(ua).slice(0, 200) } : {}),
      ...(ip ? { ip: String(ip).slice(0, 64) } : {}),
      ...(appBuild ? { appBuild: String(appBuild).slice(0, 40) } : {}),
    }
  }
  writeMeta(db, meta)
  return id
}

/**
 * Server-side acknowledgement stamp, set by the presence heartbeat route.
 *
 * It CREATES the row if one is missing rather than no-oping. The first draft
 * returned early instead, which quietly made the whole session list depend on
 * the auth middleware having run touchSession first — so the heartbeat route
 * could register a tab against a session id that appeared nowhere in the list,
 * and the session was un-revokable until some other request happened to create
 * it. The route tests caught it. A heartbeat is evidence of a live session on
 * its own; it should not need a second witness.
 */
export function recordHeartbeat(db, token, { ua, ip, nowMs = Date.now() } = {}) {
  const id = publicSessionId(token)
  if (!id) return null
  if (!readMeta(db)[id]) touchSession(db, token, { ua, ip, nowMs })
  const meta = readMeta(db)
  if (!meta[id]) return id
  meta[id] = { ...meta[id], lastHeartbeatAt: nowMs, lastAcknowledgementAt: nowMs }
  writeMeta(db, meta)
  return id
}

/**
 * active / idle / stale / disconnected from the last server-verified
 * activity — and `revoked` immediately after revocation, "regardless of the
 * last heartbeat" (brief).
 */
export function connectionState(s, nowMs = Date.now(), t = THRESHOLDS) {
  if (s?.revokedAt) return 'revoked'
  const seen = Number(s?.lastActivityAt ?? s?.lastSeenAt ?? 0)
  if (!seen) return 'disconnected'
  const age = (nowMs - seen) / 1000
  if (age <= t.activeS) return 'active'
  if (age <= t.idleS) return 'idle'
  if (age <= t.staleS) return 'stale'
  return 'disconnected'
}

// Sort order is prescribed by the brief: current, then active, idle, stale,
// then revoked/disconnected.
const STATE_RANK = { active: 0, idle: 1, stale: 2, disconnected: 3, revoked: 4 }

/**
 * The session list for the UI. SAFE DISPLAY FIELDS ONLY — no tokens, no
 * cookies, no complete internal identifiers.
 *
 * @param db            better-sqlite3 handle
 * @param currentToken  the bearer token on THIS request. The current session
 *                      is identified from it server-side; a client-supplied
 *                      isCurrent flag is never trusted (brief).
 * @param presence      clientSummary() from client-presence.js, so each
 *                      session can report the tabs open under it.
 * @param masterTiers   set true when currentToken is the master secret.
 */
export function sessionsView(db, { currentToken = null, presence = null, isMaster = false, nowMs = Date.now() } = {}) {
  const meta = readMeta(db)
  const auth = readAuth(db)
  const currentId = publicSessionId(currentToken)
  // Which public ids still authenticate? Anything in device_sessions and
  // unexpired. This is the same predicate the auth middleware uses, so the
  // list cannot claim a session is live when it no longer is.
  const liveIds = new Set()
  for (const [tok, exp] of Object.entries(auth)) {
    if (Number(exp) > nowMs) liveIds.add(publicSessionId(tok))
  }

  const tabsBySid = new Map()
  for (const t of presence?.tabs || []) {
    if (!t.sid) continue
    if (!tabsBySid.has(t.sid)) tabsBySid.set(t.sid, [])
    tabsBySid.get(t.sid).push(t)
  }

  const rows = Object.entries(meta).map(([id, s]) => {
    const isCurrent = !!currentId && id === currentId
    const expired = !liveIds.has(id)
    // An expired-or-deleted token with no recorded revocation is simply gone;
    // showing it as "active" because its last heartbeat was recent would be a
    // lie the brief explicitly warns against.
    const state = s.revokedAt ? 'revoked' : expired ? 'disconnected' : connectionState(s, nowMs)
    const tabs = tabsBySid.get(id) || []
    return {
      id,
      maskedId: maskSessionId(id),
      isCurrent,
      // "Do not show an enabled Disconnect button" for the current session,
      // and nothing to disconnect on one that is already gone.
      canDisconnect: !isCurrent && !s.revokedAt && !expired,
      label: describeSession(s),
      browserFamily: s.browserFamily ?? null,
      browserVersion: s.browserVersion ?? null,
      operatingSystem: s.operatingSystem ?? null,
      deviceType: s.deviceType ?? null,
      createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
      createdAtEstimated: s.createdAtEstimated === true,
      authenticatedAt: s.authenticatedAt ? new Date(s.authenticatedAt).toISOString() : null,
      lastSeenAt: s.lastActivityAt || s.lastSeenAt ? new Date(s.lastActivityAt ?? s.lastSeenAt).toISOString() : null,
      lastHeartbeatAt: s.lastHeartbeatAt ? new Date(s.lastHeartbeatAt).toISOString() : null,
      lastAcknowledgementAt: s.lastAcknowledgementAt ? new Date(s.lastAcknowledgementAt).toISOString() : null,
      // Alive duration is measured from the AUTHENTICATED session's creation,
      // never reset by a reconnect — a poll cycle is not a new session.
      aliveMs: s.createdAt ? Math.max(0, nowMs - s.createdAt) : null,
      lastSeenAgeMs: (s.lastActivityAt ?? s.lastSeenAt) ? Math.max(0, nowMs - (s.lastActivityAt ?? s.lastSeenAt)) : null,
      state,
      // Honest: this app's browser transport is HTTP polling, not WS/SSE.
      transport: state === 'revoked' || state === 'disconnected' ? 'disconnected' : 'polling',
      appBuild: s.appBuild ?? null,
      generation: Number(s.generation || 1),
      authenticated: !expired && !s.revokedAt,
      expiresAt: null, // filled below only for the current session
      revokedAt: s.revokedAt ? new Date(s.revokedAt).toISOString() : null,
      revokedBySessionId: s.revokedBySessionId ? maskSessionId(s.revokedBySessionId) : null,
      revocationReason: s.revocationReason ?? null,
      openTabs: tabs.length,
      pages: [...new Set(tabs.map(t => t.page).filter(Boolean))],
      country: tabs[0]?.country ?? null,
      // Masked — "Remote IP, masked unless operationally necessary" (brief).
      ip: maskIp(s.ip),
    }
  })

  // Token expiry is the caller's own business; do not publish other devices'.
  if (currentId) {
    const own = rows.find(r => r.id === currentId)
    if (own) {
      const exp = Object.entries(auth).find(([tok]) => publicSessionId(tok) === currentId)?.[1]
      own.expiresAt = Number(exp) ? new Date(Number(exp)).toISOString() : null
    }
  }

  rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    const r = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9)
    if (r) return r
    return (b.lastSeenAgeMs ?? Infinity) - (a.lastSeenAgeMs ?? Infinity) === 0
      ? 0
      : (a.lastSeenAgeMs ?? Infinity) - (b.lastSeenAgeMs ?? Infinity)
  })

  return {
    serverTime: new Date(nowMs).toISOString(),
    thresholds: { ...THRESHOLDS },
    currentSessionId: currentId,
    // The master secret has no device identity. Say so plainly instead of
    // showing a Disconnect button that would sign out every device at once.
    currentIsMaster: !!isMaster,
    masterNote: isMaster
      ? 'This browser is authenticated with the master AGENT_SECRET, which is not a per-device session. It cannot be revoked from here — rotate AGENT_SECRET to invalidate it.'
      : null,
    sessions: rows,
  }
}

/** 203.0.113.7 → 203.0.113.x ; IPv6 → first three groups. */
export function maskIp(ip) {
  const s = String(ip || '')
  if (!s) return null
  if (s.includes(':')) {
    const parts = s.split(':').filter(Boolean)
    return parts.length > 3 ? `${parts.slice(0, 3).join(':')}:…` : s
  }
  const parts = s.split('.')
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.x` : s
}

/**
 * Revoke ONE other session. Returns a result object rather than throwing, so
 * the route can map it to a status code without string-matching an Error.
 *
 * Codes: ok | self | not_found | already | master
 */
export function revokeSession(db, { sessionId, actorToken = null, reason = 'user_requested', dropTabs = null, nowMs = Date.now() } = {}) {
  const id = String(sessionId || '')
  const actorId = publicSessionId(actorToken)
  if (!id) return { code: 'not_found', ok: false }

  // ---- CURRENT-SESSION PROTECTION ----------------------------------------
  // "Do not permit self-revocation through the session-list endpoint …
  // Return HTTP 409 … Record the rejected attempt in the security audit
  // log." The check is on the server's own view of who is calling; the UI
  // also hides the button, but a stale UI must not be able to do this.
  if (actorId && id === actorId) {
    audit(db, {
      event: 'self_disconnect_rejected', actorSessionId: actorId, targetSessionId: id,
      result: 'rejected', reasonCode: 'self_revoke_forbidden', nowMs,
    })
    return { code: 'self', ok: false }
  }

  const meta = readMeta(db)
  const row = meta[id]
  if (!row) {
    audit(db, { event: 'disconnect_requested', actorSessionId: actorId, targetSessionId: id, result: 'not_found', reasonCode: 'unknown_session', nowMs })
    return { code: 'not_found', ok: false }
  }
  // Idempotent: a duplicate request is a success, not an error (brief).
  if (row.revokedAt) {
    return {
      code: 'already', ok: true, sessionId: id, state: 'revoked',
      revokedAt: new Date(row.revokedAt).toISOString(), transportClosed: true, queuedItemsCancelled: 0,
    }
  }

  // ---- THE ACTUAL REVOCATION --------------------------------------------
  // Delete every raw token that hashes to this id. This is the step that
  // stops the session: `isValidSession` in the auth middleware fails on the
  // next request, before any route runs. Durable, so an offline device stays
  // revoked and cannot reconnect with the same credential.
  const auth = readAuth(db)
  let removed = 0
  for (const tok of Object.keys(auth)) {
    if (publicSessionId(tok) === id) { delete auth[tok]; removed++ }
  }
  setState(db, AUTH_KEY, JSON.stringify(auth))

  meta[id] = {
    ...row,
    revokedAt: nowMs,
    revokedBySessionId: actorId || null,
    revocationReason: String(reason || 'user_requested').slice(0, 120),
    // Bumping the generation means any credential minted under the old one is
    // refused even if a token were somehow reintroduced.
    generation: Number(row.generation || 1) + 1,
  }
  writeMeta(db, meta)

  // ---- SESSION-OWNED EPHEMERAL WORK -------------------------------------
  // "Cancel session-owned queued work / clear session-owned temporary server
  // buffers." What that means HERE, precisely, having looked: the only
  // server-side state owned by a browser session is its presence roster
  // entries (in-memory, 90s TTL). There are no per-session job queues, no
  // outbound message queues and no event-replay buffers on the browser path
  // — trading queues belong to ACCOUNTS and the loop, not to a browser, and
  // the brief is explicit that accepted or broker-submitted orders must never
  // be touched. So this drops the tabs and nothing else.
  //
  // The dropper is INJECTED by the route rather than imported here, so this
  // module has no dependency on the in-memory roster and stays unit-testable.
  let queuedItemsCancelled = 0
  try {
    queuedItemsCancelled = typeof dropTabs === 'function' ? (dropTabs(id, nowMs) || 0) : 0
  } catch { /* presence is best-effort; revocation already took effect */ }

  audit(db, {
    event: 'disconnect_confirmed', actorSessionId: actorId, targetSessionId: id,
    result: 'ok', reasonCode: String(reason || 'user_requested'),
    detail: { tokensRemoved: removed, tabsDropped: queuedItemsCancelled }, nowMs,
  })

  return {
    code: 'ok', ok: true, sessionId: id, state: 'revoked',
    revokedAt: new Date(nowMs).toISOString(),
    // Truthful: there is no browser socket to close, so what was closed is
    // the token's ability to authenticate. The UI renders this as
    // "credential invalidated" rather than claiming a socket was torn down.
    transportClosed: false,
    transportNote: 'This app polls over HTTPS — there is no browser socket to close. The session credential no longer authenticates, so the next request from that browser is refused.',
    queuedItemsCancelled,
  }
}

/**
 * Structured security audit. Rides on the existing action_log table, which is
 * already the generic HTTP/security journal — no new table for a handful of
 * events per week. Never records tokens or cookies.
 */
export function audit(db, { event, actorSessionId, targetSessionId, result, reasonCode, detail, nowMs = Date.now() } = {}) {
  try {
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
      'SECURITY',
      `/session/${event}`,
      JSON.stringify({
        event,
        timestampUtc: new Date(nowMs).toISOString(),
        actorSessionId: actorSessionId ? maskSessionId(actorSessionId) : null,
        targetSessionId: targetSessionId ? maskSessionId(targetSessionId) : null,
        result: result ?? null,
        reasonCode: reasonCode ?? null,
        ...(detail ? { detail } : {}),
      }),
    )
  } catch { /* an audit write must never break the action it describes */ }
}

/**
 * Drop metadata for sessions that are long gone, so the JSON blob cannot grow
 * without bound. Revoked rows are kept for a while on purpose — they are the
 * security record of what happened.
 */
export function pruneSessions(db, { keepRevokedMs = 30 * 86_400_000, nowMs = Date.now() } = {}) {
  const meta = readMeta(db)
  const auth = readAuth(db)
  const live = new Set(Object.keys(auth).map(publicSessionId))
  let dropped = 0
  for (const [id, s] of Object.entries(meta)) {
    const gone = !live.has(id)
    const oldRevocation = s.revokedAt && nowMs - s.revokedAt > keepRevokedMs
    const oldDead = gone && !s.revokedAt && nowMs - (s.lastActivityAt ?? s.lastSeenAt ?? 0) > keepRevokedMs
    if (oldRevocation || oldDead) { delete meta[id]; dropped++ }
  }
  if (dropped) writeMeta(db, meta)
  return dropped
}
