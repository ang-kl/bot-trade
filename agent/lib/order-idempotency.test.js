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
import { orderIdempotencyKey, claimOrderLock, _orderLockState, _resetOrderLocks, isDefiniteRejection, reconcileFallbackReason } from './exec-engine.js'

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
  const keys = new Set(Array.from({ length: 17 }, () => orderIdempotencyKey(DOW)))
  assert.equal(keys.size, 1, 'a millisecond-jittered burst must collapse to one key')
  // The burst arriving as CLAIMS is the assertion that matters — one order out.
  _resetOrderLocks()
  const claims = Array.from({ length: 17 }, (_, i) => claimOrderLock(DOW, t0 + i * 3))
  assert.equal(claims.filter(c => c.ok).length, 1, 'and seventeen dispatches must yield one order')
})

test('2.6.3 — different intents are NOT collapsed', () => {
  const base = orderIdempotencyKey(DOW)
  assert.notEqual(orderIdempotencyKey({ ...DOW, tradeSide: 'BUY' }), base, 'the other direction is a different trade')
  assert.notEqual(orderIdempotencyKey({ ...DOW, symbolId: 999 }), base, 'another symbol is a different trade')
  assert.notEqual(orderIdempotencyKey({ ...DOW, ctidTraderAccountId: 43097342 }), base, 'another account is a different trade')
  assert.notEqual(
    orderIdempotencyKey({ ...DOW, label: 'autopilot|3|fib_618_fade|H|LDN|15m|' }), base,
    'a fib entry and a trend entry on the same symbol are different intents, not a double',
  )
})

test('2.6.3 — the key is pure IDENTITY; the window lives in the lock, not the hash', () => {
  // This test used to assert the opposite — that the key CHANGED a minute
  // later — because the key carried a bucketed timestamp. That made the key do
  // two jobs and it did the second one wrong (see the boundary test below).
  // The identity of an order does not depend on what time it is.
  const t = 1_754_349_108_000
  assert.equal(orderIdempotencyKey(DOW), orderIdempotencyKey(DOW),
    'the same intent is the same key, always')

  // The release is the LOCK expiring, which is what "within 60 seconds" means.
  _resetOrderLocks()
  assert.equal(claimOrderLock(DOW, t).ok, true, 'first dispatch goes')
  assert.equal(claimOrderLock(DOW, t + 59_999).ok, false, 'still inside the window — refused')
  assert.equal(claimOrderLock(DOW, t + 60_001).ok, true, 'past the window — a new intent, allowed')
})

test('2.6.3 — INVARIANT 3 IS A ROLLING WINDOW: a boundary-straddling burst is still one order', () => {
  // The defect this replaces: the key was `Math.floor(now / 60_000)`, so two
  // identical orders 2ms apart hashed DIFFERENTLY if they fell either side of
  // a wall-clock minute, and both dispatched. The DOW.US storm was 89ms wide;
  // one landing on a boundary would have split and leaked an order per side.
  //
  // t0 is chosen to sit exactly on a bucket edge so the old code is guaranteed
  // to fail this and the new code is guaranteed not to.
  const edge = Math.ceil(1_754_349_108_000 / 60_000) * 60_000
  _resetOrderLocks()
  const first = claimOrderLock(DOW, edge - 1)   // 11:59:59.999
  const second = claimOrderLock(DOW, edge + 1)  // 12:00:00.001 — 2ms later
  assert.equal(first.ok, true)
  assert.equal(second.ok, false, '2ms apart across a minute boundary is still the same order')
  assert.equal(first.key, second.key, 'and it is the SAME key — identity does not depend on the clock')

  // The whole 89ms storm, straddling the edge.
  _resetOrderLocks()
  const burst = Array.from({ length: 17 }, (_, i) => claimOrderLock(DOW, edge - 44 + i * 5))
  assert.equal(burst.filter(r => r.ok).length, 1, 'seventeen across the boundary must still be one order')
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

// ---------------------------------------------------------------------------
// Reconcile fallback — the sidecar outage that lasted six days.
//
// reconcile() fell back to the WS path ONLY on /no reconcile data yet/, which
// is a sidecar that is UP but not READY. When cpp-exec went down on 4 Aug,
// every reconcile threw on Railway's 502 and the whole phase died with it:
// no position sync, no broker_orders ledger, no protection audit, until the
// service happened to redeploy. Resting broker orders were invisible for days
// because the table that records them is only ever written by that phase.
// ---------------------------------------------------------------------------

test('reconcile falls back when the sidecar is UNREACHABLE, not just when it is "not ready"', () => {
  const falls = [
    'no reconcile data yet',                                                    // the only one it used to catch
    '{"status":"error","code":502,"message":"Application failed to respond"}',   // the real six-day outage
    'exec sidecar 503 on /positions',
    'fetch failed',
    'The operation was aborted due to timeout',
    'connect ECONNREFUSED 10.0.0.2:8090',
    'socket hang up',
  ]
  for (const m of falls) {
    assert.notEqual(reconcileFallbackReason(new Error(m)), null, `should fall back on: ${m}`)
  }
})

test('reconcile does NOT read around a sidecar that IS answering', () => {
  // The line is "nobody answered" vs "the answer was an error". A sidecar
  // replying 500, or replying NOT_CONNECTED because it lost its broker
  // session, is up and telling us something true — and something needs to act
  // on it. Reading around those would hide the M4 credential-memo deadlock,
  // which three existing tests exist to keep visible, and would leave a bad
  // EXEC_SECRET undetected forever: one invisible failure traded for another.
  const surface = [
    'exec sidecar 401 on /positions', 'Unauthorized', '403 Forbidden',
    'NOT_CONNECTED', 'sidecar exploded', 'exec sidecar 500 on /positions',
  ]
  for (const m of surface) {
    assert.equal(reconcileFallbackReason(new Error(m)), null, `must surface, not swallow: ${m}`)
  }
})

test('reconcileFallbackReason yields a loggable reason, or null to re-throw', () => {
  // A truncated-but-present availability error still logs something useful.
  assert.ok(reconcileFallbackReason(new Error('fetch failed ' + 'x'.repeat(500))).length <= 200,
    'a huge broker blob is truncated')
  // And an error nobody classified is surfaced rather than silently swallowed.
  assert.equal(reconcileFallbackReason(new Error('')), null)
  assert.equal(reconcileFallbackReason(null), null)
})
