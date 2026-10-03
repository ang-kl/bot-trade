// node --test agent/site-gate-wiring.test.js
//
// The wiring of the login gate, pinned. index.js boots the whole agent on
// import, so there is no seam to inject through; reading source is the last
// resort and is treated as one: comments are stripped before any assertion
// (failure mode #2: a test that passes by matching its own commentary).
//
// What must hold:
//   1. the gate is mounted BEFORE express.static and the SPA fallback — a gate
//      mounted after them guards nothing (failure mode #3);
//   2. POST /auth/login exists, checks the SECRET against the env secrets only
//      (a device session is not a secret), and sets the session cookie;
//   3. the gate's session check is index.js's own isValidSession, so a
//      revoked session loses the page on its next request.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source() {
  return readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('the gate is mounted before the static server and the SPA fallback', () => {
  const src = source()
  const gate = src.indexOf('app.use(siteGateMiddleware({ isValidSession }))')
  const statik = src.indexOf('app.use(express.static(DIST_DIR')
  const spa = src.indexOf('mountSpaFallback();')
  assert.ok(gate > 0, 'the gate is mounted')
  assert.ok(statik > 0 && spa > 0, 'the static server and the fallback are where this test expects')
  assert.ok(gate < statik, 'the gate must precede express.static')
  assert.ok(gate < spa, 'the gate must precede the SPA fallback')
})

test('POST /auth/login checks the secret against the env secrets only, then the code, then sets the cookie', () => {
  const src = source()
  const start = src.indexOf("app.post('/auth/login'")
  const end = src.indexOf("app.post('/auth/logout'")
  assert.ok(start > 0 && end > start, 'both routes exist in order')
  const route = src.slice(start, end)
  assert.match(route, /classifyToken\(secret, \{ agentSecret: AGENT_SECRET, agentSecretRead: AGENT_SECRET_READ \}\)/,
    'the secret is classified without isValidSession: a session token must not stand in for the secret')
  assert.match(route, /verifyLoginCode\(code\)/)
  assert.match(route, /sessionCookieHeader\(token/)
  assert.match(route, /issueLoginCode\(\)/)
})

test('logout deletes the raw token itself, then clears the cookie (a session with no metadata row is still revoked)', () => {
  const src = source()
  const start = src.indexOf("app.post('/auth/logout'")
  assert.ok(start > 0)
  const route = src.slice(start, start + 900)
  assert.match(route, /removeSession\(token\)/, 'the raw token must be deleted from device_sessions directly')
  assert.match(route, /revokeSession\(db, \{ sessionId: publicSessionId\(token\)/)
  assert.match(route, /clearSessionCookieHeader\(\)/)
})

test('the code-only verify route never sets the gate cookie (Codex P1 on #1215)', () => {
  const src = source()
  const start = src.indexOf("app.post('/auth/telegram/verify'")
  const end = src.indexOf("app.post('/auth/login'")
  assert.ok(start > 0 && end > start)
  const route = src.slice(start, end)
  assert.ok(!/sessionCookieHeader/.test(route), 'a code alone must not open the page')
  assert.match(route, /addSession\(\)/)
})

test('the secret lockout is time-windowed, not a counter only a success can reset', () => {
  const src = source()
  const start = src.indexOf("app.post('/auth/login'")
  const end = src.indexOf("app.post('/auth/logout'")
  const route = src.slice(start, end)
  assert.match(src, /createLockout\(\{ max: 10, windowMs: 15 \* 60_000 \}\)/)
  assert.match(route, /secretLockout\.locked\(\)/)
  assert.match(route, /secretLockout\.fail\(\)/)
  assert.ok(!/loginSecretFailures/.test(route), 'the bare counter is gone')
})

test('the mutation this file guards is reachable', () => {
  const src = source()
  assert.match(src, /siteGateMiddleware/)
  assert.match(src, /from '\.\/lib\/site-gate\.js'/)
})
