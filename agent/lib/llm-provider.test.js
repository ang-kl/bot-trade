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
  // The OpenAI model now comes from the tier router (lib/model-router.js), so
  // these assert provider + model and ignore the extra tier/source fields.
  const openai = (env, task) => {
    const i = llmProviderInfo(env, task)
    return { provider: i.provider, model: i.model }
  }
  // Nothing configured → the router's cheap built-in. NOT an expensive id:
  // principle 3 of the routing doc.
  assert.deepEqual(openai({ OPENAI_API_KEY: 'sk-x' }), { provider: 'openai', model: 'gpt-5-nano' })
  // OPENAI_MODEL_DEFAULT is the standardised name (owner renamed it 2026-07-30).
  assert.deepEqual(openai({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL_DEFAULT: 'gpt-5-nano' }), { provider: 'openai', model: 'gpt-5-nano' })
  // The PREVIOUS name still works, so the rename cannot silently change which
  // model reviews positions on a box where only the old var is set.
  assert.deepEqual(openai({ OPENAI_API_KEY: 'sk-x', OPENAI_DEFAULT_MODEL: 'gpt-5.6-luna' }), { provider: 'openai', model: 'gpt-5.6-luna' })
  // ...and the oldest name too.
  assert.deepEqual(openai({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'gpt-4o' }), { provider: 'openai', model: 'gpt-4o' })
  // New name wins over both.
  assert.deepEqual(
    openai({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'oldest', OPENAI_DEFAULT_MODEL: 'old', OPENAI_MODEL_DEFAULT: 'gpt-5-nano' }),
    { provider: 'openai', model: 'gpt-5-nano' })
  // A task on a higher tier picks that tier's var.
  assert.deepEqual(
    openai({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL_DEFAULT: 'gpt-5-nano', OPENAI_MODEL_REASONING: 'gpt-5.6' }, { type: 'risk_reassess' }),
    { provider: 'openai', model: 'gpt-5.6' })
  // Anthropic is NOT tiered — those three vars name OpenAI models.
  assert.deepEqual(llmProviderInfo({ CLAUDE_API_KEY: 'k' }), { provider: 'anthropic', model: 'claude-sonnet-4-5' })
  assert.deepEqual(llmProviderInfo({ ANTHROPIC_MODEL: 'claude-haiku-4-5' }), { provider: 'anthropic', model: 'claude-haiku-4-5' })
})

test('toOpenAIBody: system + flattened content, emits max_completion_tokens', () => {
  const body = toOpenAIBody(
    { max_tokens: 200, system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
    'gpt-4o-mini'
  )
  // gpt-5.x rejects max_tokens; the body must carry max_completion_tokens instead.
  assert.deepEqual(body, {
    model: 'gpt-4o-mini', max_completion_tokens: 200,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
  })
  assert.equal(body.max_tokens, undefined)
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
  // The router's cheap built-in, NOT the claude id the caller passed. The
  // built-in changed from 'gpt-5.6-luna' to the doc's cheapest tier when the
  // router landed — principle 3: never default to the expensive model.
  assert.equal(calls[0].body.model, 'gpt-5-nano')
  assert.equal(calls[0].auth, 'Bearer sk-test')
})

test('a task type selects the tier the client is built on', async () => {
  const calls = []
  const fakeFetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body))
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], model: 'x' }) }
  }
  const env = {
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL_DEFAULT: 'gpt-5-nano',
    OPENAI_MODEL_REASONING: 'gpt-5.6',
  }
  const cheap = createLLMClient(env, { fetch: fakeFetch, task: { type: 'position_monitor' } })
  const dear = createLLMClient(env, { fetch: fakeFetch, task: { type: 'risk_reassess' } })
  assert.equal(cheap.tier, 'DEFAULT')
  assert.equal(dear.tier, 'REASONING')
  await cheap.messages.create({ max_tokens: 8, messages: [{ role: 'user', content: 'q' }] })
  await dear.messages.create({ max_tokens: 8, messages: [{ role: 'user', content: 'q' }] })
  assert.equal(calls[0].model, 'gpt-5-nano')
  assert.equal(calls[1].model, 'gpt-5.6')
})

test('OpenAI client surfaces API errors', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' })
  const client = createLLMClient({ OPENAI_API_KEY: 'sk-bad' }, { fetch: fakeFetch })
  await assert.rejects(() => client.messages.create({ max_tokens: 1, messages: [] }), /OpenAI 401/)
})

// Production incident 2026-07-27: a stalled OpenAI response never resolves
// nor rejects on its own (Node's fetch has no built-in timeout), and that
// hung promise sat inside D4's Promise.all monitor batch, freezing the main
// loop for 80+ minutes with 28 positions unmonitored — no error ever logged
// because nothing ever threw. This must fail fast instead of hanging.
test('OpenAI client times out instead of hanging forever on a stalled response', async () => {
  const neverResolvingFetch = (url, opts) => new Promise((resolve, reject) => {
    // A real stalled connection: only settles if the caller aborts it.
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
  const client = createLLMClient({ OPENAI_API_KEY: 'sk-test' }, { fetch: neverResolvingFetch, timeoutMs: 25 })
  await assert.rejects(
    () => client.messages.create({ max_tokens: 1, messages: [] }),
    /OpenAI request timed out after 25ms/
  )
})

test('OpenAI client clears its timeout on a normal response (no dangling timer)', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })
  const client = createLLMClient({ OPENAI_API_KEY: 'sk-test' }, { fetch: fakeFetch, timeoutMs: 25 })
  const resp = await client.messages.create({ max_tokens: 1, messages: [] })
  assert.equal(resp.content[0].text, 'ok')
})

// Codex review (PR #421): fetch() resolves once HEADERS arrive, not once the
// body is fully read. Headers arriving fine but the body stalling is the
// same hang, just one await later — the timeout must still cover it.
test('OpenAI client times out on a response whose BODY stalls (headers arrived, body never does)', async () => {
  const fakeFetch = async (url, opts) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }),
  })
  const client = createLLMClient({ OPENAI_API_KEY: 'sk-test' }, { fetch: fakeFetch, timeoutMs: 25 })
  await assert.rejects(
    () => client.messages.create({ max_tokens: 1, messages: [] }),
    /OpenAI request timed out after 25ms/
  )
})
