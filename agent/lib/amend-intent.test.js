// node --test agent/lib/amend-intent.test.js
//
// WHY THIS EXISTS. cTrader's amend REPLACES protection: an absent takeProfit
// means "no take profit", not "leave it alone". ctrader-ws.js has documented
// that since the 4 Aug audit and console.warn'd on every stop-only amend —
// and the warning did not stop it happening, because the rule lived in prose
// while FOUR call sites each had to remember it. Only one of them did.
//
// Measured 2026-08-22: a live position read `1 targetless` on every audit
// pass, hours after the TP1-at-1R change made the runner-leg amend — one of
// the three that forgot — fire after every partial.
//
// So the rule moved into the call signature. These cases pin that a stop-only
// amend without a stated take-profit intent THROWS rather than silently
// deleting the target, that both ways of stating intent work, and that the
// assertion field never reaches the broker.

import test from 'node:test'
import assert from 'node:assert/strict'
import { assertAmendIntent, amendPosition } from './exec-engine.js'

// The rule ---------------------------------------------------------------

test('a stop-only amend with NO take-profit intent is REFUSED', () => {
  // The whole defect in one assertion: this used to succeed and silently
  // delete the position's target at the broker.
  assert.throws(
    () => assertAmendIntent({ positionId: 1, stopLoss: 1.05 }),
    /stop-only amend CLEARS the take profit/,
  )
})

test('the refusal names both ways out, so the fix does not need this file', () => {
  assert.throws(
    () => assertAmendIntent({ positionId: 1, stopLoss: 1.05 }),
    (err) => /takeProfit/.test(err.message) && /clearTakeProfit/.test(err.message),
  )
})

test('a take profit to KEEP is accepted and forwarded unchanged', () => {
  const out = assertAmendIntent({ positionId: 1, stopLoss: 1.05, takeProfit: 1.09 })
  assert.equal(out.takeProfit, 1.09)
  assert.equal(out.stopLoss, 1.05)
})

test('takeProfit: null means "I looked, there is none" — allowed, and not sent', () => {
  // A position that genuinely has no target must still be able to have its
  // stop moved. The key being PRESENT is what proves the caller considered it.
  const out = assertAmendIntent({ positionId: 1, stopLoss: 1.05, takeProfit: null })
  assert.ok(!('takeProfit' in out), 'a null target must not be sent as a field')
  assert.equal(out.stopLoss, 1.05)
})

test('clearTakeProfit: true is a deliberate drop, and never reaches the broker', () => {
  // Dropping a target is legitimate; it just has to be said out loud. The
  // flag is an assertion of intent, not a protocol field — sending it on
  // would be a malformed payload.
  const out = assertAmendIntent({ positionId: 1, stopLoss: 1.05, clearTakeProfit: true })
  assert.ok(!('clearTakeProfit' in out), 'the intent flag leaked into the broker payload')
  assert.ok(!('takeProfit' in out))
})

// ---------------------------------------------------------------------------
// THE OTHER DIRECTION (17-09-2026, second review).
//
// This file used to carry a test asserting that a TP-only amend "is unaffected
// — it clears no stop and needs no intent", with the comment "setting a target
// without touching the stop was never the problem". That was false, and the
// false belief was load-bearing: amend REPLACES, so an absent stopLoss is "no
// stop loss" exactly as an absent takeProfit is "no take profit". The guard was
// half a guard, and the missing half was the worse one — a lost target is
// upside forgone, a lost stop is unbounded downside on a live position.
//
// It was reachable: the targetless alert's one-tap Set-TP button routed to
// position-protect.js, which built `{positionId, takeProfit}` with no stop. One
// tap on a button offered BECAUSE the position still had its stop would have
// taken it naked.
// ---------------------------------------------------------------------------

test('a TARGET-ONLY amend now throws — an absent stopLoss CLEARS the stop', () => {
  assert.throws(
    () => assertAmendIntent({ positionId: 1, takeProfit: 1.09 }),
    /target-only amend CLEARS the stop loss/,
  )
})

test('passing the stop to KEEP is what makes a target amend legal', () => {
  const out = assertAmendIntent({ positionId: 1, takeProfit: 1.09, stopLoss: 1.05 })
  assert.equal(out.takeProfit, 1.09)
  assert.equal(out.stopLoss, 1.05)
})

test('stopLoss: null says "the caller looked and there is none"', () => {
  const out = assertAmendIntent({ positionId: 1, takeProfit: 1.09, stopLoss: null })
  assert.equal(out.takeProfit, 1.09)
  assert.ok(!('stopLoss' in out), 'a stated null must not reach the broker as a value')
})

test('clearStopLoss: true is a deliberate drop, and never reaches the broker', () => {
  const out = assertAmendIntent({ positionId: 1, takeProfit: 1.09, clearStopLoss: true })
  assert.ok(!('clearStopLoss' in out), 'the intent flag leaked into the broker payload')
  assert.ok(!('stopLoss' in out))
  assert.equal(out.takeProfit, 1.09)
})

test('an amend carrying BOTH legs needs no intent flag in either direction', () => {
  const out = assertAmendIntent({ positionId: 1, stopLoss: 1.05, takeProfit: 1.09 })
  assert.deepEqual(out, { positionId: 1, stopLoss: 1.05, takeProfit: 1.09 })
})

test("the caller's object is not mutated by the new flag either", () => {
  const args = { positionId: 1, takeProfit: 1.09, clearStopLoss: true }
  assertAmendIntent(args)
  assert.equal(args.clearStopLoss, true)
})

test('the caller\'s object is not mutated', () => {
  const args = { positionId: 1, stopLoss: 1.05, clearTakeProfit: true }
  assertAmendIntent(args)
  assert.equal(args.clearTakeProfit, true, 'assertAmendIntent must not edit its input')
})

// The wiring -------------------------------------------------------------

test('amendPosition ENFORCES the rule — the check is not merely exported', async () => {
  // assertAmendIntent is pure and every case above would stay green if
  // amendPosition never called it (failure mode #4). This reaches no broker:
  // the throw happens before any socket is opened.
  await assert.rejects(
    () => amendPosition(
      { host: 'demo.ctraderapi.com', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '46130058' },
      { positionId: 1, stopLoss: 1.05 },
    ),
    /stop-only amend CLEARS the take profit/,
  )
})

// ---------------------------------------------------------------------------
// A PRESENT KEY WITH A BAD VALUE IS NOT A CONSIDERED LEG (17-09-2026, third
// review). The guard asked only whether the key existed, which catches an
// omitted argument and misses what a ternary or a variable really produces.
// The live rule is ctrader-ws.js's `typeof x === 'number' && x > 0`, so all
// three of these reached the broker as a single-leg amend and cleared the other.
// ---------------------------------------------------------------------------

test('undefined / 0 / NaN do not count as "I considered the stop"', () => {
  for (const stopLoss of [undefined, 0, NaN, -1, '1.05', true]) {
    assert.throws(
      () => assertAmendIntent({ positionId: 1, takeProfit: 1.09, stopLoss }),
      /target-only amend CLEARS the stop loss/,
      `stopLoss=${String(stopLoss)} must not satisfy the guard`,
    )
  }
})

test('the same rule on the original direction — the half that already shipped', () => {
  for (const takeProfit of [undefined, 0, NaN, -1, '1.09', true]) {
    assert.throws(
      () => assertAmendIntent({ positionId: 1, stopLoss: 1.05, takeProfit }),
      /stop-only amend CLEARS the take profit/,
      `takeProfit=${String(takeProfit)} must not satisfy the guard`,
    )
  }
})

test('a finite positive number, or an explicit null, is what counts', () => {
  assert.doesNotThrow(() => assertAmendIntent({ positionId: 1, takeProfit: 1.09, stopLoss: 1.05 }))
  assert.doesNotThrow(() => assertAmendIntent({ positionId: 1, takeProfit: 1.09, stopLoss: null }))
  assert.doesNotThrow(() => assertAmendIntent({ positionId: 1, stopLoss: 1.05, takeProfit: null }))
})
