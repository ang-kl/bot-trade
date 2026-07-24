// node --test agent/lib/ctrader-ws-retry.test.js
//
// L3 submission idempotency at the retry layer: NEW_ORDER_REQ (2106) must
// never be blindly resubmitted after it has gone out — a lost reply may
// mean a SILENT FILL, and a resubmit is a duplicate position (the 4x
// USDIDR incident). Pre-submission failures (connect/auth) stay retryable.

import test from 'node:test'
import assert from 'node:assert/strict'
import { withRetry } from './ctrader-ws.js'

const orderSent = (err) => (err?.message || '').includes('after sending 2106')

test('withRetry retries transient pre-submission failures', async () => {
  let calls = 0
  const out = await withRetry(async () => {
    calls++
    if (calls < 3) throw new Error('cTrader WS error: ECONNRESET')
    return 'ok'
  }, 2, 'test', orderSent)
  assert.equal(out, 'ok')
  assert.equal(calls, 3)
})

test('withRetry NEVER retries once the order request went out (timeout shape)', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => {
      calls++
      throw new Error('cTrader WS timeout after 20000ms — expecting 2126 after sending 2106 received=[2101,2103]')
    }, 2, 'test', orderSent),
    /after sending 2106/,
  )
  assert.equal(calls, 1, 'a post-submission timeout must not resubmit the order')
})

test('withRetry NEVER retries a socket drop after the order request went out', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => {
      calls++
      throw new Error('cTrader WS error: socket hang up — after sending 2106')
    }, 2, 'test', orderSent),
    /after sending 2106/,
  )
  assert.equal(calls, 1)
})

test('withRetry still hard-fails broker rejections without retrying', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => {
      calls++
      throw new Error('cTrader order rejected: MARKET_CLOSED — ')
    }, 2, 'test', orderSent),
    /order rejected/,
  )
  assert.equal(calls, 1)
})

test('auth-step timeout (before the order was sent) remains retryable', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => {
      calls++
      throw new Error('cTrader WS timeout after 20000ms — expecting 2101 after sending 2100')
    }, 2, 'test', orderSent),
    /after sending 2100/,
  )
  assert.equal(calls, 3, 'auth failures happen before submission — safe to retry')
})
