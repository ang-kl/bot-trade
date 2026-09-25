import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wsAmendPosition, wsClosePosition, wsGetSymbolsList, PT } from './ctrader-ws.js'

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

// V3 K2: the host-keyed symbol-list cache answers a read "for" account B with
// whichever account on the host was read first. The one writer of an
// account's own map asks for `perAccount`, which must never be served from,
// nor stored into, that cache. Asserted on promise identity while the reads
// are in flight (an unroutable host, so nothing reaches a broker); every
// other caller keeps the shared cache exactly as before.
test('an account-true symbol-list read is never served from, nor stored into, the host-shared cache', async () => {
  const host = 'k2-symbols-list.invalid-host.localhost'
  const first = wsGetSymbolsList(host, 'cid', 'csec', 'tok', '1', 50)
  const shared = wsGetSymbolsList(host, 'cid', 'csec', 'tok', '2', 50)
  assert.equal(shared, first, 'unchanged for every other caller: one read per host')
  const own = wsGetSymbolsList(host, 'cid', 'csec', 'tok', '2', 50, { perAccount: true })
  assert.notEqual(own, first, "RED if the per-account read returns the host entry (account 1's list)")
  const ownAgain = wsGetSymbolsList(host, 'cid', 'csec', 'tok', '2', 50, { perAccount: true })
  assert.notEqual(ownAgain, own, 'nor is it cached itself: the per-account map in the DB is its cache')
  assert.equal(wsGetSymbolsList(host, 'cid', 'csec', 'tok', '3', 50), first, 'the per-account reads did not replace the host entry')
  const settled = await Promise.allSettled([first, own, ownAgain])
  assert.deepEqual(settled.map(s => s.status), ['rejected', 'rejected', 'rejected'])
  // K2 fix round (B7's rule): a per-account read's failure names its account,
  // so the reactive refresh's skip predicate can match a refused account. The
  // host-shared promise is served to other accounts' callers, so it stays
  // untagged exactly as before.
  assert.deepEqual([settled[1].reason.accountId, settled[2].reason.accountId], ['2', '2'], 'RED if the per-account read\'s error is not tagged')
  assert.equal(settled[0].reason.accountId, undefined, 'the host-shared read is unchanged: untagged')
})
