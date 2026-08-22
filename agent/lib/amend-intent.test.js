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

test('a TP-ONLY amend is unaffected — it clears no stop and needs no intent', () => {
  // The guard is about the direction that loses data. Setting a target
  // without touching the stop was never the problem.
  const out = assertAmendIntent({ positionId: 1, takeProfit: 1.09 })
  assert.equal(out.takeProfit, 1.09)
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
