// node --test agent/lib/site-gate.test.js
//
// The login gate in front of the website (owner, 03-10-2026): without a live
// session cookie the page and its assets are the sign-in page; the API keeps
// its bearer model and is never gated here.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_COOKIE, isApiPath, parseCookies, sessionCookieHeader, clearSessionCookieHeader,
  sessionFromRequest, siteGateMiddleware, loginPageHtml, createLockout,
} from './site-gate.js'

function run(mw, { method = 'GET', path = '/', cookie = '' } = {}) {
  const res = { statusCode: null, headers: {}, body: null, ended: false }
  res.status = (c) => { res.statusCode = c; return res }
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
  res.send = (b) => { res.body = b; res.ended = true; return res }
  res.end = () => { res.ended = true; return res }
  let nexted = false
  mw({ method, path, headers: cookie ? { cookie } : {} }, res, () => { nexted = true })
  return { res, nexted }
}

const live = (t) => t === 'sess_good'

test('cookie parsing: names, values, decoding, junk', () => {
  assert.deepEqual(parseCookies('a=1; bt_session=sess_x; b=%20y'), { a: '1', bt_session: 'sess_x', b: ' y' })
  assert.deepEqual(parseCookies(''), {})
  assert.deepEqual(parseCookies(undefined), {})
  assert.deepEqual(parseCookies('novalue; =x; k=v=w'), { k: 'v=w' })
  assert.equal(sessionFromRequest({ headers: { cookie: `${SESSION_COOKIE}=sess_q` } }), 'sess_q')
  assert.equal(sessionFromRequest({ headers: {} }), '')
})

test('the API is never the gate\'s business', () => {
  for (const p of ['/state/config', '/state', '/actions/x', '/auth/login', '/auth/telegram/request', '/health', '/icon.png', '/api/ctrader/cb']) {
    assert.ok(isApiPath(p), p)
  }
  for (const p of ['/', '/trade', '/assets/index-abc.js', '/fonts/inter.woff2', '/favicon.png', '/manifest.webmanifest', '/vendor/gsap/gsap.min.js', '/statement', '/healthy', '/authors']) {
    assert.ok(!isApiPath(p), p)
  }
})

test('no cookie: the page, its chunks, fonts and icons are the sign-in page (200, no-store, noindex)', () => {
  const mw = siteGateMiddleware({ isValidSession: live })
  for (const path of ['/', '/trade', '/assets/index-abc.js', '/fonts/inter-800.woff2', '/favicon.png', '/manifest.webmanifest']) {
    const { res, nexted } = run(mw, { path })
    assert.equal(nexted, false, path)
    assert.equal(res.statusCode, 200, path)
    assert.match(res.headers['content-type'], /text\/html/, path)
    assert.equal(res.headers['cache-control'], 'no-store', path)
    assert.match(res.headers['x-robots-tag'], /noindex/, path)
    assert.match(res.body, /<form id="f"/, path)
    assert.ok(!/<div id="root"/.test(res.body), 'the app shell must not leak')
  }
})

test('a stale or unknown cookie is the same as none', () => {
  const mw = siteGateMiddleware({ isValidSession: live })
  const { res, nexted } = run(mw, { path: '/', cookie: `${SESSION_COOKIE}=sess_revoked` })
  assert.equal(nexted, false)
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /Sign in/)
})

test('a live session cookie passes the page through untouched', () => {
  const mw = siteGateMiddleware({ isValidSession: live })
  for (const path of ['/', '/assets/index-abc.js', '/trade']) {
    const { res, nexted } = run(mw, { path, cookie: `other=1; ${SESSION_COOKIE}=sess_good` })
    assert.equal(nexted, true, path)
    assert.equal(res.ended, false, path)
  }
})

test('API paths pass through with or without a cookie; non-GET passes through', () => {
  const mw = siteGateMiddleware({ isValidSession: live })
  for (const path of ['/state/config', '/actions/x', '/auth/login', '/health', '/icon.png']) {
    assert.equal(run(mw, { path }).nexted, true, path)
  }
  assert.equal(run(mw, { method: 'POST', path: '/' }).nexted, true)
  assert.equal(run(mw, { method: 'OPTIONS', path: '/assets/x.js' }).nexted, true)
})

test('HEAD gets the headers and no body', () => {
  const mw = siteGateMiddleware({ isValidSession: live })
  const { res } = run(mw, { method: 'HEAD', path: '/' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, null)
  assert.equal(res.ended, true)
})

test('the cookie is HttpOnly, SameSite=Strict, 90 days, Secure when asked; the clear cookie expires it', () => {
  const h = sessionCookieHeader('sess_abc', { secure: true })
  assert.match(h, new RegExp(`^${SESSION_COOKIE}=sess_abc; `))
  for (const part of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=7776000', 'Secure']) assert.ok(h.includes(part), part)
  assert.ok(!sessionCookieHeader('t', { secure: false }).includes('Secure'))
  const c = clearSessionCookieHeader()
  assert.ok(c.startsWith(`${SESSION_COOKIE}=;`) && c.includes('Max-Age=0') && c.includes('HttpOnly'))
})

test('the sign-in page: both factors, the app\'s storage key, the login route, no green', () => {
  const html = loginPageHtml()
  assert.match(html, /id="secret"/)
  assert.match(html, /id="code"/)
  assert.match(html, /\/auth\/login/)
  assert.match(html, /localStorage\.setItem\('agent_secret'/, 'the token must land where the app reads it')
  assert.match(html, /name="robots" content="noindex/)
  assert.ok(!/#(16a34a|22c55e|15803d|4ade80|00ff00|008000|green)/i.test(html), 'no green on the sign-in page')
  assert.ok(!/<script src=/.test(html), 'the page loads no app code')
})

test('the middleware refuses to exist without a session check', () => {
  assert.throws(() => siteGateMiddleware({}), /isValidSession/)
})

test('the secret lockout trips at max inside the window and recovers on its own', () => {
  let t = 1_000_000
  const lock = createLockout({ max: 3, windowMs: 1000, now: () => t })
  assert.equal(lock.locked(), false)
  lock.fail(); lock.fail()
  assert.equal(lock.locked(), false)
  lock.fail()
  assert.equal(lock.locked(), true, 'three failures inside the window lock')
  t += 500
  assert.equal(lock.locked(), true, 'still inside the window')
  t += 600
  assert.equal(lock.locked(), false, 'the oldest failure aged out: the lockout clears without a success')
  lock.fail(); lock.fail(); lock.fail()
  assert.equal(lock.locked(), true)
  lock.reset()
  assert.equal(lock.locked(), false, 'a correct secret clears it at once')
})
