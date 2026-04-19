import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wsAmendPosition, wsClosePosition, PT } from './ctrader-ws.js'

// These tests exercise the input-validation paths that run *before* any
// WebSocket handshake — so we can assert them without mocking `ws`. The
// broker-facing happy paths are exercised by live integration against a
// Pepperstone demo account as part of the PR acceptance checklist.

test('PT payload constants match Spotware OpenAPI', () => {
  assert.equal(PT.APP_AUTH_REQ, 2100)
  assert.equal(PT.ACCOUNT_AUTH_REQ, 2102)
  assert.equal(PT.NEW_ORDER_REQ, 2106)
  assert.equal(PT.AMEND_POSITION_SLTP_REQ, 2110)
  assert.equal(PT.CLOSE_POSITION_REQ, 2111)
  assert.equal(PT.SYMBOL_BY_ID_REQ, 2116)
  assert.equal(PT.SYMBOL_BY_ID_RES, 2117)
  assert.equal(PT.RECONCILE_REQ, 2124)
  assert.equal(PT.RECONCILE_RES, 2125)
  assert.equal(PT.EXECUTION_EVENT, 2126)
  assert.equal(PT.ORDER_ERROR_EVENT, 2132)
})

test('wsAmendPosition rejects missing positionId', async () => {
  await assert.rejects(
    () => wsAmendPosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: null, stopLoss: 100,
    }),
    /positionId required/,
  )
})

test('wsAmendPosition rejects when neither SL nor TP supplied', async () => {
  await assert.rejects(
    () => wsAmendPosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: 42,
    }),
    /stopLoss or takeProfit required/,
  )
})

test('wsAmendPosition accepts SL only', async () => {
  // Argument check passes → throws a network/timeout error instead. That's
  // enough to confirm the guard let us through; we don't actually dial.
  await assert.rejects(
    () => wsAmendPosition('invalid-host.localhost', 'cid', 'csec', 'tok', '123', {
      positionId: 42, stopLoss: 100,
    }, 100),
    (err) => !/positionId required|stopLoss or takeProfit/.test(err.message),
  )
})

test('wsClosePosition rejects missing positionId', async () => {
  await assert.rejects(
    () => wsClosePosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: null, volume: 10000,
    }),
    /positionId required/,
  )
})

test('wsClosePosition rejects non-positive volume', async () => {
  await assert.rejects(
    () => wsClosePosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: 42, volume: 0,
    }),
    /volume must be a positive number/,
  )
  await assert.rejects(
    () => wsClosePosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: 42, volume: -100,
    }),
    /volume must be a positive number/,
  )
})

test('wsClosePosition rejects non-numeric volume', async () => {
  await assert.rejects(
    () => wsClosePosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: 42, volume: '10000',
    }),
    /volume must be a positive number/,
  )
})
