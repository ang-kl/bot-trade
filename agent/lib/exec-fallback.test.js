// exec-fallback — the decision that stands between an outage and a duplicate
// position. Every test here is about REFUSING, because the failure mode this
// guards is placing the same live order twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  mayFallbackToJs, preSubmitFailure, sidecarAttestsNotSent,
  isWriteOp, WRITE_OPS, fallbackNote,
} from './exec-fallback.js'

const netErr = (code, extra = {}) => Object.assign(new Error(`fetch failed`), { cause: { code }, ...extra })

// The sidecar's own 502 body, thrown verbatim by exec-engine.js's sidecar().
// engine.cpp returns this from a check that runs BEFORE ws_.sendText.
const notConnected = () => new Error('{"errorCode":"NOT_CONNECTED","description":"websocket is not connected"}')

test('the incident case: the sidecar refuses THIS request with NOT_CONNECTED — writes may fall back', () => {
  // "C++ exec engine STALLED · broker session down — sidecar is reconnecting."
  // The order call itself came back NOT_CONNECTED, which engine.cpp emits
  // before writing a single byte to the broker socket. That is a per-request
  // attestation of non-submission, so re-routing is provably safe.
  for (const op of WRITE_OPS) {
    const v = mayFallbackToJs({ op, err: notConnected() })
    assert.equal(v.fallback, true, `${op} should fall back on NOT_CONNECTED`)
    assert.match(v.reason, /provably did not execute/)
  }
  assert.equal(sidecarAttestsNotSent(notConnected()), true)
})

test('a connected sidecar is never bypassed', () => {
  for (const op of WRITE_OPS) {
    assert.equal(mayFallbackToJs({ op, sidecarConnected: true }).fallback, false)
  }
})

// ---------------------------------------------------------------------------
// TWO THINGS THAT LOOK LIKE PROOF AND ARE NOT. Both shipped in the first
// version of this file; both would have placed live orders twice. Codex review
// on PR #477 caught them.
// ---------------------------------------------------------------------------

test('a health probe saying connected:false must NOT authorise a write', () => {
  // exec-engine.js pings /health AFTER the failing call. If the sidecar's
  // broker socket dropped mid-request — order out, reply lost — the order may
  // be live at the broker and the probe still reports disconnected. The
  // snapshot describes the sidecar NOW, not the moment of submission.
  for (const op of WRITE_OPS) {
    const v = mayFallbackToJs({ op, sidecarConnected: false, err: new Error('exec sidecar 502 on /order') })
    assert.equal(v.fallback, false, `${op} must not re-route on a post-hoc health snapshot`)
    assert.match(v.reason, /may already be live at the broker/)
  }
})

test('ECONNRESET is ambiguous on a write and must NOT fall back', () => {
  // A reset can arrive after the sidecar read and executed the request, with
  // only the response lost. undici does not say which side of execution it
  // fell on. The first version guarded this with a `responseStarted` flag
  // that nothing ever set, so every reset looked pre-submit.
  assert.equal(preSubmitFailure(netErr('ECONNRESET')), false)
  assert.equal(preSubmitFailure(netErr('ECONNRESET', { responseStarted: false })), false)
  for (const op of WRITE_OPS) {
    assert.equal(mayFallbackToJs({ op, err: netErr('ECONNRESET') }).fallback, false)
  }
})

test('NOT_CONNECTED is matched as the sidecar own error CODE, not any mention of it', () => {
  // A broker description that happens to contain the phrase is not the
  // sidecar attesting anything.
  assert.equal(sidecarAttestsNotSent(new Error('{"errorCode":"MARKET_CLOSED","description":"NOT_CONNECTED to venue"}')), false)
  assert.equal(sidecarAttestsNotSent(new Error('NOT_CONNECTED')), false)
  assert.equal(sidecarAttestsNotSent(null), false)
})

// ------------------------------------------------- THE REFUSALS THAT MATTER

test('THE DANGEROUS CASE: a timeout on a write must NOT fall back', () => {
  // The request body went out. The sidecar may have filled the order and only
  // the reply was lost. Re-sending on the JS path would place it twice — the
  // exact shape behind the 4x duplicate USDIDR incident.
  const timeout = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  const v = mayFallbackToJs({ op: 'order', sidecarConnected: true, err: timeout })
  assert.equal(v.fallback, false)
  assert.match(v.reason, /may already be live at the broker/)
})

test('a 5xx from the sidecar on a write must NOT fall back', () => {
  const v = mayFallbackToJs({ op: 'order', sidecarConnected: true, err: new Error('exec sidecar 500 on /order') })
  assert.equal(v.fallback, false)
})

test('unknown connection state on a write must NOT fall back', () => {
  // null = we could not determine whether it has a session. Absence of
  // evidence is not evidence the order never went out.
  const v = mayFallbackToJs({ op: 'close', sidecarConnected: null, err: new Error('boom') })
  assert.equal(v.fallback, false)
})

// --------------------------------------------- provably-never-sent failures

test('connection refused means nothing was submitted — writes may fall back', () => {
  // These mean no TCP connection was ever established, so no request bytes
  // can have been written. That is a different claim from "the connection
  // died", which is what ECONNRESET says.
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']) {
    const err = netErr(code)
    assert.equal(preSubmitFailure(err), true, code)
    const v = mayFallbackToJs({ op: 'order', sidecarConnected: null, err })
    assert.equal(v.fallback, true, `${code} should be safe to re-route`)
    assert.match(v.reason, /never reached the sidecar/)
  }
})

test('an error with no recognisable code is not treated as pre-submit', () => {
  assert.equal(preSubmitFailure(new Error('something odd')), false)
  assert.equal(preSubmitFailure(null), false)
  assert.equal(preSubmitFailure(undefined), false)
})

// ------------------------------------------------------------------- reads

test('reads may always fall back — a retry cannot move money', () => {
  const v = mayFallbackToJs({ op: 'positions', sidecarConnected: true, err: new Error('timeout') })
  assert.equal(v.fallback, true)
  assert.match(v.reason, /cannot change any position/)
})

test('a successful read does not fall back', () => {
  assert.equal(mayFallbackToJs({ op: 'positions', sidecarConnected: true }).fallback, false)
})

test('a health snapshot may steer a READ, since a read cannot move money', () => {
  const v = mayFallbackToJs({ op: 'positions', sidecarConnected: false })
  assert.equal(v.fallback, true)
  assert.match(v.reason, /read operation/)
})

test('write ops are exactly the money-moving ones', () => {
  assert.deepEqual([...WRITE_OPS].sort(), ['amend', 'cancel', 'close', 'order'])
  for (const op of WRITE_OPS) assert.equal(isWriteOp(op), true)
  for (const op of ['positions', 'reconcile', 'health', 'trail-status']) {
    assert.equal(isWriteOp(op), false, `${op} must not be treated as a write`)
  }
  // An operation nobody thought of defaults to READ, which is the permissive
  // branch — so any NEW money-moving call MUST be added to WRITE_OPS. This
  // assertion exists to make that omission visible in review.
  assert.equal(isWriteOp('some_future_op'), false)
})

test('every fallback produces a log line — switching engines is never silent', () => {
  const note = fallbackNote('order', 'sidecar has no broker session')
  assert.match(note, /exec fallback/)
  assert.match(note, /order/)
  assert.match(note, /Node WS path/)
})

test('no arguments at all is a refusal, not a crash', () => {
  const v = mayFallbackToJs()
  assert.equal(v.fallback, false)
})
