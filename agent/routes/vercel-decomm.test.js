// node --test agent/routes/vercel-decomm.test.js
//
// Vercel decommission (owner, 17-08-2026: "I am paying a lot at vercel. I want
// to decomm. the bot-trade at Vercel").
//
// Vercel served the ONLY browser UI — GET / on Railway returned 502, nothing
// was mounted — plus /api/ctrader, the OAuth exchange the Connect page needs to
// link an account. Both move here so the project can be deleted with nothing
// lost. The trading loop and, checked first because it is the one that would
// have mattered, the cTrader TOKEN REFRESH already ran on Railway against
// Spotware directly.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync } from 'node:fs'
import ctraderOauthRouter, { resolveOrigin, tokenError } from './ctrader-oauth.js'

function server(deps = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/ctrader', ctraderOauthRouter(deps))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}
const OLD = { CTRADER_CLIENT_ID: process.env.CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET: process.env.CTRADER_CLIENT_SECRET }
const withCreds = (fn) => async () => {
  process.env.CTRADER_CLIENT_ID = 'cid'
  process.env.CTRADER_CLIENT_SECRET = 'csecret'
  try { await fn() } finally {
    for (const [k, v] of Object.entries(OLD)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

// ---------------------------------------------------------------------------
// The redirect URI. Spotware compares it LITERALLY against the registered one,
// so deriving it wrong is the whole feature failing.
// ---------------------------------------------------------------------------

test('origin comes from the forwarded headers, not just Origin', () => {
  // Browsers omit Origin on same-origin GETs — exactly the auth-url call.
  assert.equal(resolveOrigin({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'sg-trade.up.railway.app' } }),
    'https://sg-trade.up.railway.app')
  assert.equal(resolveOrigin({ headers: { origin: 'https://example.com/' } }), 'https://example.com')
  assert.equal(resolveOrigin({ headers: {} }), null)
})

test('a missing proto behind a proxy means https, except on localhost', () => {
  // Guessing http would build a redirect_uri Spotware rejects.
  assert.equal(resolveOrigin({ headers: { host: 'sg-trade.up.railway.app' } }), 'https://sg-trade.up.railway.app')
  assert.equal(resolveOrigin({ headers: { host: 'localhost:4173' } }), 'http://localhost:4173')
  assert.equal(resolveOrigin({ headers: { host: '127.0.0.1:3000' } }), 'http://127.0.0.1:3000')
})

test('auth-url returns the SAME redirectUri it built into the URL', withCreds(async () => {
  // exchange-token must send back a byte-identical string; re-deriving it there
  // would break the moment one header differed between the two calls.
  const h = await server()
  try {
    const r = await fetch(h.url('/api/ctrader?action=auth-url'), { headers: { origin: 'https://sg-trade.up.railway.app' } })
    const j = await r.json()
    assert.equal(j.redirectUri, 'https://sg-trade.up.railway.app/link-up')
    assert.ok(j.url.includes(encodeURIComponent(j.redirectUri)), 'the URL must carry that exact redirect')
    assert.ok(j.url.includes('scope=trading'))
  } finally { h.close() }
}))

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

test('exchange-token passes the authorization_code grant and returns the tokens', withCreds(async () => {
  let seen = null
  const h = await server({ fetch: async (u) => { seen = u; return { json: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresIn: 2628000 }) } } })
  try {
    const r = await fetch(h.url('/api/ctrader'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'exchange-token', code: 'abc', redirectUri: 'https://x/link-up' }),
    })
    assert.deepEqual(await r.json(), { accessToken: 'at', refreshToken: 'rt', expiresIn: 2628000 })
    assert.match(seen, /grant_type=authorization_code/)
    assert.match(seen, /code=abc/)
    assert.doesNotMatch(seen, /undefined/, 'no undefined must reach Spotware')
  } finally { h.close() }
}))

test('a refresh that omits the rotated token keeps the one we sent', withCreds(async () => {
  // Returning null here would DISCARD the only refresh token we have.
  const h = await server({ fetch: async () => ({ json: async () => ({ accessToken: 'at2' }) }) })
  try {
    const r = await fetch(h.url('/api/ctrader'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh-token', refreshToken: 'keep-me' }),
    })
    const j = await r.json()
    assert.equal(j.accessToken, 'at2')
    assert.equal(j.refreshToken, 'keep-me')
  } finally { h.close() }
}))

test('Spotware errors surface, in whichever shape they arrive', withCreds(async () => {
  for (const body of [{ errorDescription: 'bad code' }, { description: 'nope' }, { error: 'invalid_grant' }, { errorCode: 'E1' }]) {
    const h = await server({ fetch: async () => ({ json: async () => body }) })
    try {
      const r = await fetch(h.url('/api/ctrader'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'exchange-token', code: 'x', redirectUri: 'y' }),
      })
      assert.equal(r.status, 400)
      assert.ok((await r.json()).error, `no error surfaced for ${JSON.stringify(body)}`)
    } finally { h.close() }
  }
  assert.equal(tokenError({ accessToken: 'at' }), null, 'a success is not an error')
}))

test('a 200 with no access token is a failure, not a silent success', withCreds(async () => {
  const h = await server({ fetch: async () => ({ json: async () => ({}) }) })
  try {
    const r = await fetch(h.url('/api/ctrader'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'exchange-token', code: 'x', redirectUri: 'y' }),
    })
    assert.equal(r.status, 400)
  } finally { h.close() }
}))

test('an unknown action is refused rather than falling through', withCreds(async () => {
  const h = await server()
  try {
    const g = await fetch(h.url('/api/ctrader?action=whatever'))
    assert.equal(g.status, 400)
    const p = await fetch(h.url('/api/ctrader'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'drop-tables' }),
    })
    assert.equal(p.status, 400)
  } finally { h.close() }
}))

// ---------------------------------------------------------------------------
// The SPA fallback's ordering is the correctness argument, so pin it.
// ---------------------------------------------------------------------------

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const code = index.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

test('the SPA fallback never swallows an API path', () => {
  // index.js CANNOT be imported here — it starts a listening server and the
  // test run hangs. (It did, for five minutes, on the first version of this
  // file.) So the predicate is asserted from source: the regex IS the contract
  // and it is what a refactor would break.
  for (const prefix of ['api', 'state', 'actions', 'auth', 'health']) {
    assert.ok(code.includes(prefix), `the exclusion list must name ${prefix}`)
  }
  assert.match(code, /export function isSpaPath/, 'the predicate must exist and be named')
  assert.match(code, /if \(!isSpaPath\(req\.path\)\) return next\(\)/,
    'the fallback must defer to next() for API paths rather than serving HTML')
})

test('the fallback is mounted BEFORE authMiddleware', () => {
  // I GOT THIS BACKWARDS FIRST, and the earlier version of this test asserted
  // the wrong thing while passing.
  //
  // The original argument was "mount it last, after the API routers, so
  // ordering stops it swallowing /state". Every unit test passed and the UI
  // returned 401 on every path — authMiddleware sits between, so a request for
  // /connect was rejected before the fallback saw it. The page was unreachable
  // while the tests were green: measured with a real boot, GET / -> 401.
  //
  // What makes it safe is isSpaPath, an EXPLICIT exclusion list, not position.
  // With that, running early is both safe and required.
  const spa = code.indexOf('mountSpaFallback()')
  const auth = code.indexOf('app.use(authMiddleware)')
  assert.ok(spa > -1 && auth > -1, 'anchors missing — this test needs re-anchoring')
  assert.ok(spa < auth,
    'mountSpaFallback() must run BEFORE authMiddleware, or every HTML path 401s')
})

test('static serving resolves / to index.html', () => {
  // `index: false` was the other half of the same bug: without it GET / matches
  // no static file, falls through to auth, and 401s.
  assert.doesNotMatch(code, /express\.static\(DIST_DIR, \{ index: false/,
    'index: false leaves GET / unserved')
  assert.match(code, /express\.static\(DIST_DIR, \{ index: 'index\.html'/,
    'static must map / to index.html')
})

test('a missing dist/ does not break the API', () => {
  // A dev container that never built, or a deploy that skipped it: the agent's
  // job is trading and it must boot without a frontend.
  assert.match(code, /HAS_DIST/, 'static serving must be conditional on dist/ existing')
  assert.match(code, /if \(!HAS_DIST\) return/, 'the fallback must no-op without dist/')
})
