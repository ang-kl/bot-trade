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

// ---------------------------------------------------------------------------
// THE HARD SPEND CEILING (owner 09-08-2026). `llm_daily_cost_alert_usd` is an
// alert threshold and always was — production ran at ~$77/day against a "$5
// cap" for weeks while looking configured.
// ---------------------------------------------------------------------------

import { initDB, setState } from '../db.js'
import { SPEND_CAP_KEY, spendCapState } from '../services/llm-spend.js'

const spend = (db, day, cents) =>
  db.prepare(`INSERT INTO token_usage (day, purpose, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
              VALUES (?, 'position_monitor', 'gpt-5-nano-2025-08-07', 1, 0, ?, 0, 0)`).run(day, cents)

test('no cap configured is the default, and spends nothing on reading it', () => {
  const db = initDB(':memory:')
  const s = spendCapState(db)
  assert.equal(s.cap, null)
  assert.equal(s.exceeded, false)
})

test('a cap of 0 or empty is NOT a zero-dollar ceiling', () => {
  // Number(null) and Number('') are 0. Read as a cap, that is an instant and
  // permanent shutdown of the LLM layer from a key nobody set.
  const db = initDB(':memory:')
  for (const v of [null, '', '0', 'nonsense', '-5']) {
    setState(db, SPEND_CAP_KEY, v)
    assert.equal(spendCapState(db).cap, null, `${JSON.stringify(v)} must not configure a cap`)
  }
})

test('THE POINT: reaching the cap blocks, and it is reported as spend not as a switch', async () => {
  const db = initDB(':memory:')
  const today = new Date().toISOString().slice(0, 10)
  setState(db, SPEND_CAP_KEY, '0.10')
  const { getState } = await import('../db.js')
  const { llmBlocked } = await import('./llm-switch.js')

  assert.equal((await llmBlocked(db, getState, {})).blocked, false, 'under the cap, nothing is blocked')

  spend(db, today, 2_000_000)          // 2M output tokens on nano — well past $0.10
  const s = spendCapState(db)
  assert.ok(s.spent > 0.10, `spent ${s.spent}`)
  assert.equal(s.exceeded, true)

  const g = await llmBlocked(db, getState, {})
  assert.equal(g.blocked, true)
  assert.equal(g.kind, 'spend_cap', 'NOT "switch" — the owner must be able to tell these apart')
  assert.match(g.reason, /daily LLM spend cap reached/)
  assert.match(g.reason, /resets/, 'and that it clears itself')
})

test("yesterday's spend does not block today", () => {
  const db = initDB(':memory:')
  setState(db, SPEND_CAP_KEY, '0.10')
  spend(db, '2020-01-01', 9_000_000)
  assert.equal(spendCapState(db).exceeded, false)
})

test('the switch outranks the cap in the reported reason', async () => {
  // Both true: the standing decision is the more useful thing to show.
  const db = initDB(':memory:')
  const { getState } = await import('../db.js')
  const { llmBlocked } = await import('./llm-switch.js')
  setState(db, SPEND_CAP_KEY, '0.10')
  setState(db, 'llm_disabled', '1')
  spend(db, new Date().toISOString().slice(0, 10), 2_000_000)
  const g = await llmBlocked(db, getState, {})
  assert.equal(g.kind, 'switch')
})
