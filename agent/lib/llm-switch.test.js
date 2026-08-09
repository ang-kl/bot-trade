// node --test agent/lib/llm-switch.test.js
//
// The behaviour that matters here is the ASYMMETRY. Two independent brakes,
// either of which disables; and a read failure that leaves the layer ON,
// which is the opposite of the fail-safe used everywhere else in this repo
// and therefore the thing most likely to be "corrected" by mistake later.

import test from 'node:test'
import assert from 'node:assert/strict'
import { llmDisabledFrom, llmDisabled, llmDisabledReason } from './llm-switch.js'

test('enabled by default — an absent key and an absent env change nothing', () => {
  assert.equal(llmDisabledFrom(null, {}), false)
  assert.equal(llmDisabledFrom(undefined, {}), false)
  assert.equal(llmDisabledFrom('', {}), false)
})

test('either brake alone disables', () => {
  assert.equal(llmDisabledFrom(null, { LLM_DISABLED: '1' }), true)
  assert.equal(llmDisabledFrom('true', {}), true)
})

test("the string 'false' does not disable — Boolean('false') is true and that trap is live here", () => {
  // The state key arrives as TEXT from SQLite. A coercion would read 'false',
  // 'no' and '0' as switched off, silencing position review on the exact
  // values an operator would type to keep it running.
  for (const v of ['false', 'no', '0', 'off', 'enabled', 'nonsense']) {
    assert.equal(llmDisabledFrom(v, {}), false, `${v} must not disable`)
  }
  for (const v of ['1', 'TRUE', ' yes ', 'On', 'disabled']) {
    assert.equal(llmDisabledFrom(v, {}), true, `${v} must disable`)
  }
})

test('the env brake cannot be released by the state key', () => {
  // The durable brake outranks the fast one, in one direction only.
  assert.equal(llmDisabledFrom('false', { LLM_DISABLED: '1' }), true)
  assert.equal(llmDisabledFrom('0', { LLM_DISABLED: 'yes' }), true)
})

test('a failed state read leaves the layer ENABLED, not disabled', () => {
  // Deliberately not the fail-safe direction used elsewhere: losing position
  // review because a read blipped is worse than one wasted API call.
  const boom = () => { throw new Error('SQLITE_BUSY') }
  assert.equal(llmDisabled({}, boom, {}), false)
  // …and the env brake still holds through the same failure.
  assert.equal(llmDisabled({}, boom, { LLM_DISABLED: '1' }), true)
})

test('the reason names WHICH brake, so the panel can say why', () => {
  const get = (_db, k) => (k === 'llm_disabled' ? '1' : null)
  assert.equal(llmDisabledReason({}, get, {}), 'llm_disabled state key')
  assert.equal(llmDisabledReason({}, get, { LLM_DISABLED: '1' }), 'LLM_DISABLED env var')
  assert.equal(llmDisabledReason({}, () => null, {}), null, 'enabled has no reason')
})
