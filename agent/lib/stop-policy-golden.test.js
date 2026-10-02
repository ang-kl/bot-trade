// node --test agent/lib/stop-policy-golden.test.js
//
// One set of wire literals, three readers (02-10-2026, PR-3). The C++ sidecar
// and Node each encode the stop policy; a drift between them is invisible to
// either side's own tests. test_protection_ratchet.cpp asserts the broker wire
// and the `policy` block as exact strings; those strings are copied into
// test-support/fixtures/stop-policy-golden.json, and here:
//   1. the C++ test must still contain every literal (an edit there that is not
//      mirrored here fails THIS suite, with no C++ rebuild);
//   2. the fields Node stamps are the fields the golden wire carries;
//   3. the stateful broker model, which every Node integration test trusts,
//      answers with the golden `policy` block, key for key.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyStopPolicyToAmend, DEFAULT_STOP_POLICY } from './stop-policy.js'
import { startStopBrokerModel } from '../test-support/stop-broker-model.js'

const golden = JSON.parse(readFileSync(new URL('../test-support/fixtures/stop-policy-golden.json', import.meta.url), 'utf8'))
const cpp = readFileSync(new URL('../../cpp-exec/src/tests/test_protection_ratchet.cpp', import.meta.url), 'utf8')
const sorted = v => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v)
const dump = v => JSON.stringify(sorted(v))
const KEYS = ['wireWithPolicy', 'wireStripped', 'policyApplied', 'policyRefused']

test('the C++ sidecar test still asserts every golden literal', () => {
  for (const k of KEYS) assert.ok(cpp.includes(golden[k]), `test_protection_ratchet.cpp no longer contains the golden ${k}: ${golden[k]}`)
})

test('Node stamps exactly the policy fields the golden wire carries, with the same values', () => {
  const wire = JSON.parse(golden.wireWithPolicy)
  const out = applyStopPolicyToAmend({ positionId: 7, stopLoss: 101, takeProfit: 120, stopContext: { side: 'BUY', entry: 100, book: false } }, { ...DEFAULT_STOP_POLICY, enabled: true })
  const flags = Object.fromEntries(Object.entries(out).filter(([k]) => k === 'stopLossTriggerMethod' || k === 'trailingStopLoss'))
  assert.deepEqual(flags, { stopLossTriggerMethod: wire.stopLossTriggerMethod, trailingStopLoss: wire.trailingStopLoss })
  const stripped = JSON.parse(golden.wireStripped)
  assert.equal('stopLossTriggerMethod' in stripped || 'trailingStopLoss' in stripped, false, 'the stripped wire carries neither')
})

let model
after(async () => { if (model) await model.close() })
const amend = async body => (await fetch(`${model.url}/amend`, { method: 'POST', body: JSON.stringify(body) })).json()

test('the broker model answers with the golden policy block, applied and refused', async () => {
  model = await startStopBrokerModel({ account: '4002' })
  const p = model.open({ entry: 100, stopLoss: 90, takeProfit: 120 })
  const applied = await amend({ positionId: p.positionId, stopLoss: 95, takeProfit: 120, stopLossTriggerMethod: 2, trailingStopLoss: true, ratchetOnly: true, expectedDirection: 1 })
  assert.equal(dump(applied.policy), golden.policyApplied)
  await model.close()
  model = await startStopBrokerModel({ account: '4002', refuseFlags: true })
  const q = model.open({ entry: 100, stopLoss: 90, takeProfit: 120 })
  const refused = await amend({ positionId: q.positionId, stopLoss: 95, takeProfit: 120, stopLossTriggerMethod: 2, trailingStopLoss: true, ratchetOnly: true, expectedDirection: 1 })
  assert.equal(dump(refused.policy), golden.policyRefused)
})
