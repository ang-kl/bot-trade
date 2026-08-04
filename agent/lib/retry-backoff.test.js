// node --test agent/lib/retry-backoff.test.js
//
// #123, the throttle half. The old policy was a flat 2s/4s ramp for every
// failure. A dropped socket and a breached rate limit need opposite responses,
// and retrying a throttle on the cadence that caused it is how a brief limit
// becomes a sustained one.

import test from 'node:test'
import assert from 'node:assert/strict'
import { isThrottleError, retryAfterMs, backoffMs, THROTTLE_BASE_MS, THROTTLE_MAX_MS } from './ctrader-ws.js'

const e = (m) => new Error(m)

test('throttle markers are recognised across the shapes a broker uses', () => {
  for (const m of [
    'REQUEST_FREQUENCY_EXCEEDED',
    'Too many requests',
    'rate limit exceeded',
    'Request throttled',
    'HTTP 429 from sidecar',
    'TOO_MANY_ORDERS',
  ]) assert.equal(isThrottleError(e(m)), true, `${m} should read as a throttle`)
})

test('ordinary faults are NOT read as throttles', () => {
  for (const m of [
    'socket hang up',
    'connect ETIMEDOUT',
    'after sending 2106',
    'POSITION_NOT_FOUND',
    'order rejected',
    '',
  ]) assert.equal(isThrottleError(e(m)), false, `${m} should not read as a throttle`)
  assert.equal(isThrottleError(null), false)
  assert.equal(isThrottleError(undefined), false)
})

test('an ordinary fault keeps the linear ramp it always had', () => {
  // Deliberately unchanged: a dropped socket wants a prompt retry, and this
  // change must not slow down the common case to fix the rare one.
  assert.equal(backoffMs(0, e('socket hang up')), 2000)
  assert.equal(backoffMs(1, e('socket hang up')), 4000)
})

test('a throttle backs off exponentially, and much further than 2s', () => {
  const at = (n) => backoffMs(n, e('rate limit exceeded'), () => 1)
  assert.equal(at(0), THROTTLE_BASE_MS)
  assert.equal(at(1), THROTTLE_BASE_MS * 2)
  assert.equal(at(2), THROTTLE_BASE_MS * 4)
  assert.ok(at(0) > 4000, 'a throttle must not retry on the old 2s/4s beat')
})

test('the exponential is capped', () => {
  assert.equal(backoffMs(20, e('throttled'), () => 1), THROTTLE_MAX_MS)
})

test('jitter spreads the retry but never below half the interval', () => {
  // Several controllers share one broker session. An undithered backoff
  // re-synchronises them and the second attempt lands as one burst, exactly
  // like the first.
  const lo = backoffMs(1, e('throttled'), () => 0)
  const hi = backoffMs(1, e('throttled'), () => 1)
  const full = THROTTLE_BASE_MS * 2
  assert.equal(hi, full)
  assert.equal(lo, full / 2)
  assert.ok(lo >= full / 2, 'never collapses to an instant retry')
})

test('an explicit retry-after from the broker wins over our own curve', () => {
  // It is the only number in the exchange that comes from the side actually
  // enforcing the limit.
  assert.equal(retryAfterMs(e('throttled, retry after 30s')), 30_000)
  assert.equal(retryAfterMs(e('Retry-After: 1500ms')), 1500)
  assert.equal(retryAfterMs(e('retry after 2 seconds')), 2000)
  assert.equal(backoffMs(0, e('throttled, retry after 30s')), 30_000)
  // and it applies even when the error does not otherwise look like a throttle
  assert.equal(backoffMs(0, e('busy — retry after 7s')), 7000)
})

test('a hostile or malformed retry-after cannot park a call indefinitely', () => {
  assert.equal(retryAfterMs(e('retry after 99999s')), 120_000, 'capped at two minutes')
  assert.equal(retryAfterMs(e('retry after 0s')), null)
  assert.equal(retryAfterMs(e('retry after -5s')), null)
  assert.equal(retryAfterMs(e('retry after soon')), null)
  assert.equal(retryAfterMs(e('no such hint here')), null)
})
