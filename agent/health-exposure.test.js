// node --test agent/health-exposure.test.js
//
// S-0, owner-approved 2026-07-30: "put clients / dbPathAbsolute / recentErrors
// behind auth on /health".
//
// WHAT THIS GUARDS. /health skips the auth middleware by design, because two
// consumers need an unauthenticated 200: Railway's healthcheck, and the web
// app's AgentDownBanner (src/App.jsx fetches /health with NO bearer and only
// tests res.ok — it is the owner's "the agent is unreachable" alarm). That
// exemption is fine; returning the FULL payload through it was not. An
// anonymous GET used to return `clients`, whose roster carries `ip` per browser
// tab (services/client-presence.js), i.e. the owner's own IP addresses, plus the
// container's absolute DB path and a ring of recent error strings.
//
// The rule this file pins: the PUBLIC body is a fixed liveness allowlist, and
// anything not on it requires a bearer. A source scan is the right shape of
// guard because the failure mode is a NEW field being added to the handler and
// silently becoming public — invisible in review, and only observable by
// diffing two HTTP responses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./index.js', import.meta.url).pathname, 'utf8')
// Comments must be stripped before any "this token must not appear" scan. The
// fix for the OTP explains in a comment WHY Math.random() is wrong, and a guard
// that fails on the explanation pushes the reasoning out of the codebase — the
// opposite of what it is for. (Same lesson as src/lib/css-token-syntax.test.js.)
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

/** The handler body, from `app.get('/health'` to the end of its res.json. */
function healthHandler() {
  const start = SRC.indexOf("app.get('/health'")
  assert.ok(start > 0, "the /health handler must exist — this test's anchor is gone")
  const end = SRC.indexOf('function clientSummaryOrNull', start)
  assert.ok(end > start, 'anchor for the end of the handler is gone')
  return SRC.slice(start, end)
}

// The ONLY fields an unauthenticated caller may see. Adding to this list is a
// deliberate act; the test exists so it cannot happen by accident.
const PUBLIC_ALLOWLIST = ['status', 'version', 'commit', 'uptime', 'authenticated']

test('the unauthenticated branch returns only the liveness allowlist', () => {
  const h = healthHandler()
  // The early-return block for !authed.
  const m = h.match(/if \(!authed\) \{\s*return res\.json\(\{([\s\S]*?)\}\)/)
  assert.ok(m, 'there must be an explicit unauthenticated early return')
  const fields = [...m[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm)].map(x => x[1])
  assert.ok(fields.length > 0, 'the public body must actually name its fields')
  for (const f of fields) {
    assert.ok(PUBLIC_ALLOWLIST.includes(f),
      `\`${f}\` would be returned to ANONYMOUS callers. Either add it to PUBLIC_ALLOWLIST deliberately, or move it into the authenticated body.`)
  }
})

test('the sensitive fields are NOT in the unauthenticated branch', () => {
  const h = healthHandler()
  const publicBlock = h.match(/if \(!authed\) \{[\s\S]*?\}\)/)[0]
  // Each of these leaked before this change; naming them individually makes a
  // regression report say WHICH one came back.
  for (const field of [
    'clients',          // the browser-presence roster — carries per-tab `ip`
    'dbPath',           // container filesystem layout
    'dbPathAbsolute',
    'recentErrors',     // internal error strings
    'lastError',
    'memoryMB',
    'loopPhaseLag',
    'loopCpuProfile',
    'historicalRate',
    'llmTiers',
  ]) {
    assert.ok(!new RegExp(`\\b${field}\\b`).test(publicBlock),
      `${field} must not be in the public liveness body`)
  }
})

test('the early return comes BEFORE the full payload, so new fields default to authenticated', () => {
  const h = healthHandler()
  const guard = h.indexOf('if (!authed)')
  const full = h.indexOf('authenticated: true')
  assert.ok(guard > 0 && full > guard,
    'the !authed early return must precede the full res.json — otherwise a field added to the full body could be reached anonymously')
})

test('the public body still carries what the down-banner and Railway need', () => {
  const h = healthHandler()
  const publicBlock = h.match(/if \(!authed\) \{[\s\S]*?\}\)/)[0]
  // The banner only tests res.ok, but a body with no status/version at all
  // would make the endpoint useless for a human curling it during an incident.
  assert.match(publicBlock, /\bstatus\b/)
  assert.match(publicBlock, /version: APP_VERSION/)
  assert.match(publicBlock, /uptime: process\.uptime\(\)/)
  // And it must say it is the reduced view, so a caller expecting detail knows
  // to send a token instead of reading absent fields as nulls.
  assert.match(publicBlock, /authenticated: false/)
})

test('auth is classified with the same function the middleware uses', () => {
  const h = healthHandler()
  // Not a bespoke string comparison against AGENT_SECRET — that is how a second,
  // subtly different auth rule gets introduced.
  assert.match(h, /classifyToken\(bearer, \{/)
  assert.match(h, /agentSecret: AGENT_SECRET/)
  assert.match(h, /isValidSession/)
})

// ---------------------------------------------------------------------------
// P1-5: the login OTP must come from a CSPRNG.
// ---------------------------------------------------------------------------

test('the login code is generated with crypto randomInt, never Math.random', () => {
  assert.ok(!/Math\.random/.test(CODE),
    'Math.random() must not appear in agent/index.js code — the login OTP used it, and it is not a CSPRNG')
  assert.match(CODE, /const code = String\(randomInt\(100000, 1000000\)\)/)
})

test('randomInt is imported from node:crypto, not taken off the global', () => {
  // The global `crypto` is WebCrypto: it has getRandomValues and randomUUID but
  // NO randomInt, so `crypto.randomInt(...)` is a TypeError that would only
  // surface when someone tried to log in.
  assert.match(CODE, /import \{ randomInt \} from 'node:crypto'/)
  assert.ok(!/crypto\.randomInt/.test(CODE), 'randomInt is not on the global crypto object')
})

test('the range is the full six-digit space, uniformly', () => {
  // randomInt(min, max) is [min, max), so 100000..999999 inclusive — every
  // 6-digit code, no modulo bias.
  const m = CODE.match(/randomInt\((\d+), (\d+)\)/)
  assert.equal(m[1], '100000')
  assert.equal(m[2], '1000000')
})

test('the session token still uses a CSPRNG too', () => {
  // This one was already correct; the test is here so a future tidy-up of the
  // OTP line cannot take it down with it.
  assert.match(CODE, /crypto\.getRandomValues\(new Uint8Array\(24\)\)/)
})
