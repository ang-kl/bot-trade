// node --test agent/lib/llm-provider.test.js
//
// Provider abstraction: OpenAI is primary when OPENAI_API_KEY is set (owner's
// key), else Anthropic. Both expose the same messages.create shape.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  llmProviderInfo, toOpenAIBody, fromOpenAIResponse, createLLMClient,
} from './llm-provider.js'

test('provider selection: OpenAI when its key is set, else Anthropic', () => {
  assert.deepEqual(llmProviderInfo({ OPENAI_API_KEY: 'sk-x' }), { provider: 'openai', model: 'gpt-4o-mini' })
  assert.deepEqual(llmProviderInfo({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'gpt-4o' }), { provider: 'openai', model: 'gpt-4o' })
  assert.deepEqual(llmProviderInfo({ CLAUDE_API_KEY: 'k' }), { provider: 'anthropic', model: 'claude-sonnet-4-5' })
  assert.deepEqual(llmProviderInfo({ ANTHROPIC_MODEL: 'claude-haiku-4-5' }), { provider: 'anthropic', model: 'claude-haiku-4-5' })
})

test('toOpenAIBody: system + flattened content, uses the OpenAI model', () => {
  const body = toOpenAIBody(
    { max_tokens: 200, system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
    'gpt-4o-mini'
  )
  assert.deepEqual(body, {
    model: 'gpt-4o-mini', max_tokens: 200,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
  })
})

test('toOpenAIBody flattens Anthropic block content to text', () => {
  const body = toOpenAIBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }, 'gpt-4o')
  assert.equal(body.messages[0].content, 'ab')
})

test('fromOpenAIResponse maps to the Anthropic shape', () => {
  const r = fromOpenAIResponse({
    choices: [{ message: { content: '{"action":"HOLD"}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    model: 'gpt-4o-mini',
  }, 'gpt-4o-mini')
  assert.deepEqual(r.content, [{ type: 'text', text: '{"action":"HOLD"}' }])
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 })
})

test('OpenAI client: messages.create round-trips through a fake fetch', async () => {
  const calls = []
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization })
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 }, model: 'gpt-4o-mini' }) }
  }
  const client = createLLMClient({ OPENAI_API_KEY: 'sk-test' }, { fetch: fakeFetch })
  assert.equal(client.provider, 'openai')
  // a claude model id is passed by the caller — the OpenAI client ignores it
  const resp = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 128, messages: [{ role: 'user', content: 'q' }] })
  assert.equal(resp.content[0].text, 'ok')
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(calls[0].body.model, 'gpt-4o-mini') // NOT the claude id
  assert.equal(calls[0].auth, 'Bearer sk-test')
})

test('OpenAI client surfaces API errors', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' })
  const client = createLLMClient({ OPENAI_API_KEY: 'sk-bad' }, { fetch: fakeFetch })
  await assert.rejects(() => client.messages.create({ max_tokens: 1, messages: [] }), /OpenAI 401/)
})
