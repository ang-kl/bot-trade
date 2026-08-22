// node --test agent/login-code-ungated.test.js
//
// Owner, 22-08-2026: "i ask for Telegram code but is suppress by the
// notification off" — and then, precisely: "it use to work until we have
// /status /notify /digest".
//
// That is the whole diagnosis in one sentence. The digest was added as a CHOKE
// POINT (telegram.js:156) deliberately routing every send through one gate,
// "because routing 78 call sites means 78 chances to miss one". It caught 79.
// The 79th was the login code — which is not a notification at all, but the
// synchronous reply to a button the owner is sitting in front of.
//
// TWO FAILURES STACKED. The code was queued into an hourly digest while its own
// validity is five minutes, so it could never arrive in time even when the
// digest eventually flushed. And /auth/telegram/request still answered
// `{ ok: true, sentVia: 'telegram' }` with a 200, so the button reported
// success. A guard whose trigger is out of reach of what it guards (#3),
// wearing a green light.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { routeDecision } from './services/telegram-digest.js'

// The hazard, proved against the real router ---------------------------------

test('THE GATE WOULD HAVE SWALLOWED IT — notify off queues even urgent', () => {
  // This is why marking the code `priority: 'urgent'` would NOT have been a
  // fix: notify_off is checked before the urgent bypass (telegram-digest.js:139).
  // Nothing short of leaving the gate entirely gets the code out.
  const off = { enabled: false, mode: 'live', quiet: null, urgentBypass: true }
  for (const priority of ['urgent', 'normal', undefined]) {
    const d = routeDecision(off, { text: '🔑 bot-trade login code: *123456*', priority, nowMs: Date.now() })
    assert.equal(d.action, 'queue', `priority ${priority} still queues`)
    assert.equal(d.reason, 'notify_off')
  }
})

test('and the hourly digest would hold it well past its five-minute life', () => {
  const digest = { enabled: true, mode: 'hourly', quiet: null, urgentBypass: true }
  const d = routeDecision(digest, { text: '🔑 bot-trade login code: *123456*', nowMs: Date.now() })
  assert.equal(d.action, 'queue')
  assert.equal(d.reason, 'hourly_digest')
})

// The wiring, pinned ---------------------------------------------------------
//
// Reading source is a last resort and is treated as one: the auth routes live
// inside index.js, which boots the whole agent on import, so there is no seam
// to inject through. Comments are stripped first — this file's own prose names
// `sendMessage` several times, and a test that passes by matching its own
// commentary is failure mode #2.

function authRoutesSource() {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const start = src.indexOf("app.post('/auth/telegram/request'")
  const end = src.indexOf("app.get('/icon.png'")
  assert.ok(start > 0 && end > start, 'the auth routes moved — this test must be re-pointed, not deleted')
  return src.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('the login code is sent RAW, and sendMessage appears nowhere in the auth routes', () => {
  const code = authRoutesSource()
  assert.match(code, /sendMessageRaw/, 'the ungated sender must be the one imported')
  // The strict half. `sendMessageRaw` contains `sendMessage`, so a substring
  // search would pass on the broken version too — match the call, not the name.
  assert.ok(!/\bsendMessage\s*\(/.test(code.replace(/sendMessageRaw/g, 'RAW')),
    'a gated send survives in the auth routes')
  assert.ok(!/\{\s*sendMessage\s*\}/.test(code), 'the gated sender is still being destructured')
})

test('the code is still short-lived and single-use — the reason gating is fatal', () => {
  // If either of these ever stopped being true the digest would merely be
  // annoying rather than disqualifying, so they belong in this file.
  const code = authRoutesSource()
  assert.match(code, /login_code_expires/)
  assert.match(code, /5 \* 60_000/, 'a five-minute code cannot survive an hourly digest')
})

test('the mutation this file guards is actually reachable', () => {
  // #1: a check that cannot fail proves nothing. Confirm the string being
  // asserted on is PRESENT, so a rename silently emptying the slice fails here
  // rather than passing everything above.
  const code = authRoutesSource()
  assert.ok(code.length > 500, 'the extracted slice is too small to contain the routes')
  assert.match(code, /auth\/telegram\/verify/, 'both auth routes must be inside the slice')
})
