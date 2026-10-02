// node --test agent/lib/stop-policy.test.js
//
// The stop policy is a pure vocabulary: which fields the bot asks cTrader for
// on a stop (02-10-2026). These pin the rules the chokepoint, the C++ sidecar
// and the controller all lean on.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STOP_POLICY, normaliseStopPolicy, setStopPolicy, getStopPolicy, loadStopPolicy,
  triggerValue, triggerWire, sideDirection, locksProfit, policyFields, applyStopPolicyToAmend,
  trailConfigPolicy, POLICY_KEY,
} from './stop-policy.js'

test.beforeEach(() => setStopPolicy(null))
test.after(() => setStopPolicy(null))

test('the default is the owner order: enabled, Opposite, trailing once profit is locked, numeric wire', () => {
  assert.deepEqual({ ...DEFAULT_STOP_POLICY }, { enabled: true, triggerMethod: 'OPPOSITE', trailing: 'on_lock', encoding: 'number' })
  assert.equal(triggerValue(getStopPolicy()), 2)
  assert.equal(triggerWire(getStopPolicy()), 2)
})

test('normalise: invalid values fall back to the default, numbers and names both accepted, unknown keys dropped', () => {
  assert.equal(normaliseStopPolicy({ triggerMethod: 4 }).triggerMethod, 'DOUBLE_OPPOSITE')
  assert.equal(normaliseStopPolicy({ triggerMethod: 'trade' }).triggerMethod, 'TRADE')
  assert.equal(normaliseStopPolicy({ triggerMethod: 'sideways' }).triggerMethod, 'OPPOSITE')
  assert.equal(normaliseStopPolicy({ triggerMethod: 9 }).triggerMethod, 'OPPOSITE')
  assert.equal(normaliseStopPolicy({ trailing: 'always' }).trailing, 'on_lock')
  assert.equal(normaliseStopPolicy({ trailing: 'off' }).trailing, 'off')
  assert.equal(normaliseStopPolicy({ enabled: 'yes' }).enabled, true)
  assert.equal(normaliseStopPolicy({ enabled: false }).enabled, false)
  assert.deepEqual(Object.keys(normaliseStopPolicy({ x: 1 })).sort(), ['enabled', 'encoding', 'trailing', 'triggerMethod'])
  assert.equal(triggerWire(normaliseStopPolicy({ encoding: 'name' })), 'OPPOSITE')
})

test('load: reads the stored key, unreadable storage means the default policy (ON, as ordered)', () => {
  const p = loadStopPolicy({}, (_db, key) => { assert.equal(key, POLICY_KEY); return JSON.stringify({ trailing: 'off' }) })
  assert.equal(p.trailing, 'off')
  assert.equal(getStopPolicy().trailing, 'off')
  const bad = loadStopPolicy({}, () => '{not json')
  assert.equal(bad.enabled, true)
  assert.equal(bad.trailing, 'on_lock')
})

test('sideDirection reads the spellings the bot uses', () => {
  for (const s of ['BUY', 'buy', 'LONG', 'long', 1]) assert.equal(sideDirection(s), 1, String(s))
  for (const s of ['SELL', 'sell', 'SHORT', 'short', -1]) assert.equal(sideDirection(s), -1, String(s))
  for (const s of [null, undefined, '', 'HOLD', 0, 2]) assert.equal(sideDirection(s), 0, String(s))
})

test('locksProfit: at or past entry on the profit side, both directions, and unknown is not locked', () => {
  assert.equal(locksProfit('BUY', 100, 100), true, 'breakeven counts')
  assert.equal(locksProfit('BUY', 100, 101), true)
  assert.equal(locksProfit('BUY', 100, 99.99), false)
  assert.equal(locksProfit('SELL', 100, 100), true)
  assert.equal(locksProfit('SELL', 100, 99), true)
  assert.equal(locksProfit('SELL', 100, 100.01), false)
  assert.equal(locksProfit('BUY', 0, 101), false)
  assert.equal(locksProfit('BUY', 100, 0), false)
  assert.equal(locksProfit('BUY', null, 101), false)
  assert.equal(locksProfit('HOLD', 100, 101), false)
  assert.equal(locksProfit('BUY', 'x', 'y'), false)
})

test('policyFields: Opposite always; trailing only when on_lock, not book, and the stop locks profit; never false', () => {
  assert.deepEqual(policyFields({ side: 'BUY', entry: 100, stop: 95 }), { stopLossTriggerMethod: 2 })
  assert.deepEqual(policyFields({ side: 'BUY', entry: 100, stop: 101 }), { stopLossTriggerMethod: 2, trailingStopLoss: true })
  assert.deepEqual(policyFields({ side: 'SELL', entry: 100, stop: 99 }), { stopLossTriggerMethod: 2, trailingStopLoss: true })
  assert.deepEqual(policyFields({ side: 'BUY', entry: 100, stop: 101, book: true }), { stopLossTriggerMethod: 2 }, 'book rows: Opposite, no broker trailing')
  assert.deepEqual(policyFields({ side: 'BUY', stop: 101 }), { stopLossTriggerMethod: 2 }, 'no entry → cannot tell → no trailing')
  assert.deepEqual(policyFields({ policy: normaliseStopPolicy({ trailing: 'off' }), side: 'BUY', entry: 100, stop: 101 }), { stopLossTriggerMethod: 2 })
  assert.deepEqual(policyFields({ policy: normaliseStopPolicy({ enabled: false }), side: 'BUY', entry: 100, stop: 101 }), {})
  assert.deepEqual(policyFields({ policy: normaliseStopPolicy({ encoding: 'name' }), side: 'BUY', entry: 100, stop: 95 }), { stopLossTriggerMethod: 'OPPOSITE' })
  for (const f of [policyFields({ side: 'BUY', entry: 100, stop: 95 }), policyFields({ side: 'BUY', entry: 100, stop: 101 })]) {
    assert.notEqual(f.trailingStopLoss, false)
  }
})

test('applyStopPolicyToAmend: stamps the fields, strips the instructions, explicit fields win, target-only amends get nothing', () => {
  const out = applyStopPolicyToAmend({ positionId: 7, stopLoss: 101, takeProfit: 110, stopContext: { side: 'BUY', entry: 100 } })
  assert.deepEqual(out, { positionId: 7, stopLoss: 101, takeProfit: 110, stopLossTriggerMethod: 2, trailingStopLoss: true })
  assert.equal('stopContext' in out, false)
  // no context: trigger only
  assert.deepEqual(applyStopPolicyToAmend({ positionId: 7, stopLoss: 95, takeProfit: 110 }), { positionId: 7, stopLoss: 95, takeProfit: 110, stopLossTriggerMethod: 2 })
  // explicit wins
  const explicit = applyStopPolicyToAmend({ positionId: 7, stopLoss: 101, stopLossTriggerMethod: 1, stopContext: { side: 'BUY', entry: 100 } })
  assert.equal(explicit.stopLossTriggerMethod, 1)
  // target-only: nothing, but the instructions are still stripped
  assert.deepEqual(applyStopPolicyToAmend({ positionId: 7, takeProfit: 110, stopContext: { side: 'BUY', entry: 100 } }), { positionId: 7, takeProfit: 110 })
  // opt-out
  assert.deepEqual(applyStopPolicyToAmend({ positionId: 7, stopLoss: 95, noStopPolicy: true }), { positionId: 7, stopLoss: 95 })
  // policyOnly carries no stop yet still gets the trigger (the sidecar fills the stop in)
  assert.deepEqual(applyStopPolicyToAmend({ positionId: 7, policyOnly: true }), { positionId: 7, policyOnly: true, stopLossTriggerMethod: 2 })
  // disabled
  assert.deepEqual(applyStopPolicyToAmend({ positionId: 7, stopLoss: 95 }, normaliseStopPolicy({ enabled: false })), { positionId: 7, stopLoss: 95 })
  // the input object is not mutated
  const input = { positionId: 7, stopLoss: 95, stopContext: { side: 'BUY', entry: 100 } }
  applyStopPolicyToAmend(input)
  assert.ok('stopContext' in input)
})

test('trailConfigPolicy: the /trail-config block, absent when the policy is off', () => {
  assert.deepEqual(trailConfigPolicy(), { stopLossTriggerMethod: 2, trailing: 'on_lock' })
  assert.equal(trailConfigPolicy(normaliseStopPolicy({ enabled: false })), null)
})
