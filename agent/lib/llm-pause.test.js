// Pausing must be indistinguishable from having no key — that path is already
// exercised in production, which is why it is the one to reuse.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { llmPaused, availableProviders, createLLMClientFor } from './llm-provider.js'

const KEYED = { OPENAI_API_KEY: 'sk-x', CLAUDE_API_KEY: 'sk-y' }

test('off by default — an absent flag changes nothing', () => {
  assert.equal(llmPaused({}), false)
  assert.deepEqual(availableProviders(KEYED), { openai: true, anthropic: true, paused: false })
})

test('the usual truthy spellings all pause', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
    assert.equal(llmPaused({ LLM_PAUSED: v }), true, `${JSON.stringify(v)} should pause`)
  }
})

test('and the falsy ones do not', () => {
  for (const v of ['0', 'false', 'no', 'off', '', '   ']) {
    assert.equal(llmPaused({ LLM_PAUSED: v }), false, `${JSON.stringify(v)} must not pause`)
  }
})

test('paused reports no providers even with both keys present', () => {
  const a = availableProviders({ ...KEYED, LLM_PAUSED: '1' })
  assert.deepEqual(a, { openai: false, anthropic: false, paused: true })
})

test('`paused` is distinct from `no key` in the report, so the reason is legible', () => {
  assert.equal(availableProviders({}).paused, false, 'no key is not the same fact as paused')
  assert.equal(availableProviders({ LLM_PAUSED: '1' }).paused, true)
})

test('the client factory refuses for both providers while paused', () => {
  for (const p of ['openai', 'anthropic']) {
    assert.throws(
      () => createLLMClientFor(p, 'some-model', { ...KEYED, LLM_PAUSED: '1' }),
      /LLM_PAUSED/,
      `${p} must refuse`,
    )
  }
})

test('the refusal says how to undo it and that keys are safe', () => {
  assert.throws(() => createLLMClientFor('openai', 'm', { ...KEYED, LLM_PAUSED: '1' }), (err) => {
    assert.match(err.message, /unset it to resume/i)
    assert.match(err.message, /keys are untouched/i)
    return true
  })
})

test('unpausing restores the client without touching the keys', () => {
  const c = createLLMClientFor('openai', 'gpt-5-nano', { ...KEYED, LLM_PAUSED: '0' })
  assert.ok(c, 'a client is built again once the flag is cleared')
})
