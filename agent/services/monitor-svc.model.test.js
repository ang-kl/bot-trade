// Owner (2026-07-30): "why 'claude-sonnet-4-5' to position_monitor, i have
// openai as priority." Routing was fine; the REPORTED model was hardcoded, so
// the spend ledger attributed OpenAI calls to an Anthropic model and priced
// them at Anthropic's rates. These tests pin the reporting.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runMonitorCheck } from './monitor-svc.js'

const POSITION = {
  symbol: 'EURUSD', side: 'BUY', entry: 1.1, currentPrice: 1.105, sl: 1.09, tp1: 1.12,
}
const ANSWER = JSON.stringify({
  action: 'HOLD', new_sl: null, scale_pct: null, add_price: null,
  reasoning: 'working', thesis_status: 'intact', urgency: 'low',
})

function fakeClient({ model, respModel }) {
  const seen = {}
  return {
    seen,
    model,
    messages: {
      async create(params) {
        seen.model = params.model
        return {
          content: [{ type: 'text', text: ANSWER }],
          usage: { input_tokens: 10, output_tokens: 5 },
          ...(respModel ? { model: respModel } : {}),
        }
      },
    },
  }
}

test('reports the OpenAI model the response came back with, not an Anthropic default', async () => {
  const client = fakeClient({ model: 'gpt-5.6-luna', respModel: 'gpt-5.6-luna' })
  const out = await runMonitorCheck(client, POSITION)
  assert.equal(out.model, 'gpt-5.6-luna')
  assert.ok(!String(out.model).startsWith('claude'), 'must not label an OpenAI call as Claude')
})

test('sends the client\'s own model id, not the hardcoded constant', async () => {
  const client = fakeClient({ model: 'gpt-5.6-luna', respModel: 'gpt-5.6-luna' })
  await runMonitorCheck(client, POSITION)
  assert.equal(client.seen.model, 'gpt-5.6-luna')
})

test('falls back to the requested id when the provider does not echo a model', async () => {
  const client = fakeClient({ model: 'gpt-5.6-luna', respModel: null })
  const out = await runMonitorCheck(client, POSITION)
  assert.equal(out.model, 'gpt-5.6-luna')
})

test('a client with no declared model still works (Anthropic default path)', async () => {
  const client = fakeClient({ model: undefined, respModel: 'claude-sonnet-4-5' })
  const out = await runMonitorCheck(client, POSITION)
  assert.equal(out.model, 'claude-sonnet-4-5')
  assert.ok(client.seen.model, 'a model id was still sent')
})
