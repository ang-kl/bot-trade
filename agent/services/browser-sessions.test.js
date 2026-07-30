// node --test agent/services/browser-sessions.test.js
//
// The security-relevant assertions the owner's brief is emphatic about:
//   * the current session cannot revoke itself, and the attempt is audited
//   * revocation actually removes the credential (not just a display flag)
//   * a revoked or offline device stays revoked — durably
//   * no raw token is ever stored in, or returned from, this module
//   * isCurrent is decided by the server, never by a client field
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  publicSessionId, maskSessionId, maskIp, parseUserAgent, describeSession,
  connectionState, sessionsView, revokeSession, touchSession, pruneSessions,
  THRESHOLDS,
} from './browser-sessions.js'

const TOKEN_A = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'sess_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

function freshDb() {
  const db = initDB(':memory:')
  const in90d = Date.now() + 90 * 86_400_000
  setState(db, 'device_sessions', JSON.stringify({ [TOKEN_A]: in90d, [TOKEN_B]: in90d }))
  return db
}

test('publicSessionId is a stable, non-reversible id and never the token', () => {
  const id = publicSessionId(TOKEN_A)
  assert.equal(id.length, 16)
  assert.equal(id, publicSessionId(TOKEN_A))          // stable
  assert.notEqual(id, publicSessionId(TOKEN_B))       // distinguishing
  assert.ok(!TOKEN_A.includes(id))                    // not a substring of the token
  assert.equal(publicSessionId(''), null)
})

test('no raw token is ever written to the metadata blob', () => {
  const db = freshDb()
  touchSession(db, TOKEN_A, { ua: UA_CHROME, ip: '203.0.113.7' })
  const raw = getState(db, 'browser_sessions')
  assert.ok(raw.length > 0)
  assert.ok(!raw.includes(TOKEN_A), 'the token must not appear in browser_sessions')
})

test('no raw token, IP or internal id leaks into the view', () => {
  const db = freshDb()
  touchSession(db, TOKEN_A, { ua: UA_CHROME, ip: '203.0.113.7' })
  const json = JSON.stringify(sessionsView(db, { currentToken: TOKEN_A }))
  assert.ok(!json.includes(TOKEN_A))
  assert.ok(!json.includes('203.0.113.7'), 'the full IP must be masked')
  assert.ok(json.includes('203.0.113.x'))
})

test('parseUserAgent: recognises what it can and never guesses', () => {
  assert.deepEqual(parseUserAgent(UA_CHROME), {
    browserFamily: 'Chrome', browserVersion: '138', operatingSystem: 'macOS', deviceType: 'desktop',
  })
  const ip = parseUserAgent(UA_IPHONE)
  assert.equal(ip.browserFamily, 'Safari')
  assert.equal(ip.operatingSystem, 'iOS')
  assert.equal(ip.deviceType, 'mobile')
  // Edge and Opera both carry "Chrome" in their UA — order matters.
  assert.equal(parseUserAgent('Mozilla/5.0 Chrome/126 Edg/126.0.1').browserFamily, 'Edge')
  // Unknown stays unknown rather than becoming a confident label.
  const junk = parseUserAgent('curl/8.4.0')
  assert.equal(junk.browserFamily, null)
  assert.equal(junk.deviceType, null)
  assert.equal(describeSession(junk), 'Unknown browser')
  assert.equal(describeSession(null), 'Unknown browser')
})

test('connectionState honours the configurable thresholds and revocation wins', () => {
  const now = 1_000_000_000
  const at = (secondsAgo) => ({ lastActivityAt: now - secondsAgo * 1000 })
  assert.equal(connectionState(at(1), now), 'active')
  assert.equal(connectionState(at(THRESHOLDS.activeS), now), 'active')
  assert.equal(connectionState(at(THRESHOLDS.activeS + 1), now), 'idle')
  assert.equal(connectionState(at(THRESHOLDS.idleS + 1), now), 'stale')
  assert.equal(connectionState(at(THRESHOLDS.staleS + 1), now), 'disconnected')
  assert.equal(connectionState({}, now), 'disconnected')
  // "Consider it revoked immediately after server-side revocation, regardless
  // of the last heartbeat."
  assert.equal(connectionState({ ...at(1), revokedAt: now }, now), 'revoked')
})

test('the CURRENT session is marked by the server and cannot be disconnected', () => {
  const db = freshDb()
  touchSession(db, TOKEN_A, { ua: UA_CHROME })
  touchSession(db, TOKEN_B, { ua: UA_IPHONE })
  const view = sessionsView(db, { currentToken: TOKEN_A })

  const mine = view.sessions.find(s => s.isCurrent)
  assert.equal(mine.id, publicSessionId(TOKEN_A))
  assert.equal(mine.canDisconnect, false, 'no enabled Disconnect on the current session')
  assert.equal(view.currentSessionId, publicSessionId(TOKEN_A))
  // The other one is a real, revocable session.
  const other = view.sessions.find(s => !s.isCurrent)
  assert.equal(other.canDisconnect, true)
  // Current session sorts first (the brief's sort order).
  assert.equal(view.sessions[0].isCurrent, true)
})

test('self-revocation is refused with a distinct code and is audited', () => {
  const db = freshDb()
  touchSession(db, TOKEN_A, { ua: UA_CHROME })
  const id = publicSessionId(TOKEN_A)

  const res = revokeSession(db, { sessionId: id, actorToken: TOKEN_A })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'self')

  // The credential must be untouched — a refused request changes nothing.
  const auth = JSON.parse(getState(db, 'device_sessions'))
  assert.ok(auth[TOKEN_A], 'the current session must still authenticate')

  // "Record the rejected attempt in the security audit log."
  const row = db.prepare("SELECT path, body FROM action_log WHERE path LIKE '/session/%' ORDER BY id DESC LIMIT 1").get()
  assert.equal(row.path, '/session/self_disconnect_rejected')
  const body = JSON.parse(row.body)
  assert.equal(body.result, 'rejected')
  assert.equal(body.reasonCode, 'self_revoke_forbidden')
  assert.ok(!row.body.includes(TOKEN_A), 'the audit record must not contain the token')
})

test('revoking another session removes its credential, durably', () => {
  const db = freshDb()
  touchSession(db, TOKEN_A, { ua: UA_CHROME })
  touchSession(db, TOKEN_B, { ua: UA_IPHONE })
  const target = publicSessionId(TOKEN_B)

  const res = revokeSession(db, { sessionId: target, actorToken: TOKEN_A, reason: 'user_requested' })
  assert.equal(res.ok, true)
  assert.equal(res.state, 'revoked')

  // THIS is the enforcement point: the raw token is gone from the map the auth
  // middleware reads, so the revoked browser's next request cannot authenticate.
  const auth = JSON.parse(getState(db, 'device_sessions'))
  assert.equal(auth[TOKEN_B], undefined, 'the revoked token must not remain')
  assert.ok(auth[TOKEN_A], 'the actor must be unaffected')

  // The row survives as the security record, and reports who did it.
  const view = sessionsView(db, { currentToken: TOKEN_A })
  const row = view.sessions.find(s => s.id === target)
  assert.equal(row.state, 'revoked')
  assert.equal(row.canDisconnect, false)
  assert.equal(row.authenticated, false)
  assert.equal(row.revokedBySessionId, maskSessionId(publicSessionId(TOKEN_A)))
  assert.equal(row.generation, 2, 'the security generation is bumped')
})

test('a revoked session stays revoked even if it was offline at the time', () => {
  const db = freshDb()
  touchSession(db, TOKEN_B, { ua: UA_IPHONE })
  revokeSession(db, { sessionId: publicSessionId(TOKEN_B), actorToken: TOKEN_A })

  // Simulate the offline device coming back and trying to be seen again.
  // touchSession must not resurrect it: the credential is gone from
  // device_sessions, so the middleware rejects it before this ever runs — and
  // even a direct call leaves the revocation standing.
  touchSession(db, TOKEN_B, { ua: UA_IPHONE, nowMs: Date.now() + 60_000 })
  const view = sessionsView(db, { currentToken: TOKEN_A })
  const row = view.sessions.find(s => s.id === publicSessionId(TOKEN_B))
  assert.equal(row.state, 'revoked')
  assert.equal(row.canDisconnect, false)
  assert.equal(JSON.parse(getState(db, 'device_sessions'))[TOKEN_B], undefined)
})

test('revocation is idempotent — a duplicate request is a success, not an error', () => {
  const db = freshDb()
  touchSession(db, TOKEN_B, { ua: UA_IPHONE })
  const target = publicSessionId(TOKEN_B)
  const first = revokeSession(db, { sessionId: target, actorToken: TOKEN_A })
  const second = revokeSession(db, { sessionId: target, actorToken: TOKEN_A })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.code, 'already')
  assert.equal(second.state, 'revoked')
})

test('an unknown session id is a 404-shaped result, not a throw', () => {
  const db = freshDb()
  const res = revokeSession(db, { sessionId: 'deadbeefdeadbeef', actorToken: TOKEN_A })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'not_found')
  assert.equal(revokeSession(db, {}).code, 'not_found')
})

test('session-owned tabs are dropped through the injected dropper only', () => {
  const db = freshDb()
  touchSession(db, TOKEN_B, { ua: UA_IPHONE })
  let askedFor = null
  const res = revokeSession(db, {
    sessionId: publicSessionId(TOKEN_B),
    actorToken: TOKEN_A,
    dropTabs: (id) => { askedFor = id; return 3 },
  })
  assert.equal(askedFor, publicSessionId(TOKEN_B))
  assert.equal(res.queuedItemsCancelled, 3)
  // And a dropper that throws must not undo the revocation.
  touchSession(db, TOKEN_A, { ua: UA_CHROME })
  const db2 = freshDb()
  touchSession(db2, TOKEN_B, { ua: UA_IPHONE })
  const res2 = revokeSession(db2, {
    sessionId: publicSessionId(TOKEN_B), actorToken: TOKEN_A,
    dropTabs: () => { throw new Error('roster exploded') },
  })
  assert.equal(res2.ok, true)
  assert.equal(res2.queuedItemsCancelled, 0)
  assert.equal(JSON.parse(getState(db2, 'device_sessions'))[TOKEN_B], undefined)
})

test('the transport is reported honestly — no claim that a socket was closed', () => {
  const db = freshDb()
  touchSession(db, TOKEN_A, { ua: UA_CHROME })
  const view = sessionsView(db, { currentToken: TOKEN_A })
  assert.equal(view.sessions[0].transport, 'polling')

  touchSession(db, TOKEN_B, { ua: UA_IPHONE })
  const res = revokeSession(db, { sessionId: publicSessionId(TOKEN_B), actorToken: TOKEN_A })
  assert.equal(res.transportClosed, false, 'there is no browser socket to close')
  assert.match(res.transportNote, /no browser socket/i)
})

test('an expired token reads as disconnected, never as active', () => {
  const db = freshDb()
  touchSession(db, TOKEN_B, { ua: UA_IPHONE })
  // Expire it in the auth map while its last heartbeat is a second ago.
  setState(db, 'device_sessions', JSON.stringify({ [TOKEN_A]: Date.now() + 1000, [TOKEN_B]: Date.now() - 1000 }))
  const row = sessionsView(db, { currentToken: TOKEN_A }).sessions.find(s => s.id === publicSessionId(TOKEN_B))
  assert.equal(row.state, 'disconnected')
  assert.equal(row.canDisconnect, false)
  assert.equal(row.transport, 'disconnected')
})

test('alive duration comes from session creation, not from the last poll', () => {
  const db = freshDb()
  const created = Date.now() - 3 * 3600_000
  setState(db, 'browser_sessions', JSON.stringify({
    [publicSessionId(TOKEN_A)]: { createdAt: created, lastActivityAt: Date.now(), generation: 1 },
  }))
  const row = sessionsView(db, { currentToken: TOKEN_A }).sessions[0]
  // ~3h alive, seen just now — a reconnect must not reset the former.
  assert.ok(row.aliveMs >= 3 * 3600_000 - 5000)
  assert.ok(row.lastSeenAgeMs < 5000)
})

test('the master secret is reported as un-revokable rather than given a button', () => {
  const db = freshDb()
  touchSession(db, TOKEN_A, { ua: UA_CHROME })
  const view = sessionsView(db, { currentToken: null, isMaster: true })
  assert.equal(view.currentIsMaster, true)
  assert.match(view.masterNote, /rotate AGENT_SECRET/)
  assert.equal(view.currentSessionId, null)
  // With no current session identified, nothing is marked current — and so
  // self-protection cannot be sidestepped by claiming to be someone else.
  assert.equal(view.sessions.some(s => s.isCurrent), false)
})

test('touchSession creates a row for pre-existing tokens and flags the estimate', () => {
  const db = freshDb()
  const id = touchSession(db, TOKEN_A, { ua: UA_CHROME })
  const row = sessionsView(db, { currentToken: TOKEN_A }).sessions.find(s => s.id === id)
  assert.equal(row.createdAtEstimated, true, 'a back-derived createdAt must say so')
  assert.equal(row.browserFamily, 'Chrome')
  // A later sighting without a UA must not overwrite known details with nulls.
  touchSession(db, TOKEN_A, { nowMs: Date.now() + 10_000 })
  const again = sessionsView(db, { currentToken: TOKEN_A }).sessions.find(s => s.id === id)
  assert.equal(again.browserFamily, 'Chrome')
})

test('maskIp keeps IPv4 and IPv6 recognisable without publishing them', () => {
  assert.equal(maskIp('203.0.113.7'), '203.0.113.x')
  assert.equal(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3:…')
  assert.equal(maskIp(''), null)
  assert.equal(maskIp(null), null)
})

test('pruneSessions drops long-dead rows but keeps recent revocations', () => {
  const db = freshDb()
  const old = Date.now() - 60 * 86_400_000
  setState(db, 'browser_sessions', JSON.stringify({
    keepRevoked: { createdAt: Date.now(), revokedAt: Date.now() - 86_400_000 },
    dropRevoked: { createdAt: old, revokedAt: old },
    dropDead: { createdAt: old, lastActivityAt: old },
  }))
  const dropped = pruneSessions(db)
  const meta = JSON.parse(getState(db, 'browser_sessions'))
  assert.equal(dropped, 2)
  assert.ok(meta.keepRevoked, 'a recent revocation is the security record — keep it')
  assert.equal(meta.dropRevoked, undefined)
  assert.equal(meta.dropDead, undefined)
})

test('junk stored state cannot crash the view', () => {
  const db = freshDb()
  for (const junk of ['', 'not json', '[]', 'null', '42']) {
    setState(db, 'browser_sessions', junk)
    assert.doesNotThrow(() => sessionsView(db, { currentToken: TOKEN_A }))
    assert.ok(Array.isArray(sessionsView(db, { currentToken: TOKEN_A }).sessions))
  }
})
