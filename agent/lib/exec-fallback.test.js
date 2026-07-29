// exec-fallback — the decision that stands between an outage and a duplicate
// position. Every test here is about REFUSING, because the failure mode this
// guards is placing the same live order twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mayFallbackToJs, preSubmitFailure, isWriteOp, WRITE_OPS, fallbackNote } from './exec-fallback.js'

const netErr = (code, extra = {}) => Object.assign(new Error(`fetch failed`), { cause: { code }, ...extra })

test('the incident case: sidecar up but no broker session — writes may fall back', () => {
  // "C++ exec engine STALLED · broker session down — sidecar is reconnecting."
  // It answered us, and it told us it holds no broker link. It cannot have
  // executed anything, so re-routing is provably safe.
  for (const op of WRITE_OPS) {
    const v = mayFallbackToJs({ op, sidecarConnected: false })
    assert.equal(v.fallback, true, `${op} should fall back when the sidecar has no broker session`)
    assert.match(v.reason, /cannot have executed/)
  }
})

test('a connected sidecar is never bypassed', () => {
  for (const op of WRITE_OPS) {
    assert.equal(mayFallbackToJs({ op, sidecarConnected: true }).fallback, false)
  }
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

test('a reset AFTER the response started is ambiguous and must NOT fall back', () => {
  const err = netErr('ECONNRESET', { responseStarted: true })
  assert.equal(preSubmitFailure(err), false)
  assert.equal(mayFallbackToJs({ op: 'order', sidecarConnected: true, err }).fallback, false)
})

// --------------------------------------------- provably-never-sent failures

test('connection refused means nothing was submitted — writes may fall back', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']) {
    const err = netErr(code)
    assert.equal(preSubmitFailure(err), true, code)
    const v = mayFallbackToJs({ op: 'order', sidecarConnected: null, err })
    assert.equal(v.fallback, true, `${code} should be safe to re-route`)
    assert.match(v.reason, /never reached the sidecar/)
  }
})

test('a reset before any response byte counts as never-sent', () => {
  assert.equal(preSubmitFailure(netErr('ECONNRESET')), true)
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
