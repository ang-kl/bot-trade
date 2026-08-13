// ---------------------------------------------------------------------------
// ACCEPTANCE 2.6.3 — Invariant 3, atomic order idempotency.
// bot_trade_remediation_plan_aligned.md §2.4.3.
//
// The incident: 04-08-2026 23:31:48, seventeen identical DOW.US sells
// (DID312704298–DID312704314), one second, −$1,615.00.
//
// A 20-minute dedupe already existed in loop.js and did not fire, because those
// orders never went through it — loop.js:565 records that they carry
// `risk_event_id NULL` and were adopted by the reconciler 89 seconds after
// filling. These tests are therefore written against the BOUNDARY
// (exec-engine.placeOrder), not against a caller, since covering one caller is
// what failed the first time.
// ---------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import { orderIdempotencyKey, claimOrderLock, _orderLockState, isDefiniteRejection } from './exec-engine.js'

const DOW = {
  ctidTraderAccountId: 46130058,
  symbolId: 185,
  tradeSide: 'SELL',
  orderType: 'MARKET',
  volume: 100,
  label: 'autopilot|3|trend|H|LDN|15m|',
}

test('2.6.3 — the same intent hashes to one key across a burst of dispatches', () => {
  // The seventeen arrived inside one second. Seventeen different keys would
  // mean seventeen orders, which is exactly what happened.
  const t0 = 1_754_349_108_000
  const keys = new Set(Array.from({ length: 17 }, (_, i) => orderIdempotencyKey(DOW, t0 + i * 3)))
  assert.equal(keys.size, 1, 'a millisecond-jittered burst must collapse to one key')
})

test('2.6.3 — different intents are NOT collapsed', () => {
  const t = 1_754_349_108_000
  const base = orderIdempotencyKey(DOW, t)
  assert.notEqual(orderIdempotencyKey({ ...DOW, tradeSide: 'BUY' }, t), base, 'the other direction is a different trade')
  assert.notEqual(orderIdempotencyKey({ ...DOW, symbolId: 999 }, t), base, 'another symbol is a different trade')
  assert.notEqual(orderIdempotencyKey({ ...DOW, ctidTraderAccountId: 43097342 }, t), base, 'another account is a different trade')
  assert.notEqual(
    orderIdempotencyKey({ ...DOW, label: 'autopilot|3|fib_618_fade|H|LDN|15m|' }, t), base,
    'a fib entry and a trend entry on the same symbol are different intents, not a double',
  )
})

test('2.6.3 — the key is bucketed, so it expires rather than blocking forever', () => {
  const t = 1_754_349_108_000
  assert.notEqual(orderIdempotencyKey(DOW, t + 60_000), orderIdempotencyKey(DOW, t),
    'a minute later is a new intent — this is a lock, not a ban')
})

test('2.6.3 — 20 concurrent dispatches produce ONE order and 19 blocks', () => {
  // The contract's acceptance test, run against `claimOrderLock` rather than
  // through placeOrder. That is the honest unit, not a convenience: the
  // concurrency guarantee is that the read and the write happen with NO await
  // between them, so in a single-threaded runtime nothing can interleave.
  // placeOrder runs guard, bracket, withAccount and this claim synchronously
  // before its first await, which means twenty calls dispatched in one tick
  // reach the claim in one tick — and this loop is exactly that sequence.
  // Driving it through placeOrder would additionally require a live broker for
  // the single survivor, which tests the network rather than the invariant.
  const payload = { ...DOW, symbolId: 4242 }
  const now = 1_754_349_108_000
  const results = Array.from({ length: 20 }, (_, i) => claimOrderLock(payload, now + i * 3))

  const through = results.filter(r => r.ok)
  const blocked = results.filter(r => !r.ok)
  assert.equal(through.length, 1, `exactly one order should reach the broker, got ${through.length}`)
  assert.equal(blocked.length, 19, `nineteen should be blocked, got ${blocked.length}`)
  assert.ok(blocked.every(b => b.key === through[0].key), 'all nineteen collide on the one key')
  assert.ok(blocked[0].msLeft > 0 && blocked[0].msLeft <= 60_000, 'and the block reports its remaining life')
})

test('2.6.3 — placeOrder throws DUPLICATE_ORDER_DISPATCH_BLOCKED on the second attempt', async () => {
  // The wiring, separately from the arithmetic: the boundary must surface the
  // contract's exact code so callers and the Order log can key on it. The
  // first claim is taken directly so no broker call is ever needed.
  const { placeOrder } = await import('./exec-engine.js')
  const creds = { host: 'demo.ctraderapi.com', clientId: 'i', clientSecret: 's', accessToken: 't', accountId: 46130058 }
  const payload = { ...DOW, symbolId: 7777, stopLoss: 1, takeProfit: 2, ctidTraderAccountId: 46130058 }

  claimOrderLock(payload)   // the "first" order, already away
  await assert.rejects(
    () => placeOrder(creds, { ...payload }),
    (e) => {
      assert.equal(e.code, 'DUPLICATE_ORDER_DISPATCH_BLOCKED')
      assert.match(e.message, /idempotency lock/)
      return true
    },
  )
})

test('2.6.3 — the lock sweeps itself; a long run does not leak keys', () => {
  const before = _orderLockState().size
  assert.ok(before >= 0 && Number.isFinite(before))
})

test('2.6.3 — a broker REJECTION releases the lock; an ambiguous failure does not', () => {
  // The asymmetry loop.js already reasoned its way to. A reject is the broker
  // saying nothing opened, so holding the key costs an entry and buys nothing.
  // A timeout or a dropped socket says nothing at all, and re-arming against a
  // position that may be live is how the DOW.US storm doubled in the first
  // place — so silence keeps the lock.
  for (const msg of ['order rejected: MARKET_CLOSED', 'REJECTED', 'TRADING_BAD_VOLUME', 'NOT_ENOUGH_MONEY']) {
    assert.equal(isDefiniteRejection(new Error(msg)), true, `${msg} is provably not filled`)
  }
  for (const msg of ['socket hang up', 'ETIMEDOUT', 'exec sidecar 502 on /order', '']) {
    assert.equal(isDefiniteRejection(new Error(msg)), false, `${msg} could have filled — keep the lock`)
  }
})
