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

// ---------------------------------------------------------------------------
// AN EMPTY COMPLETION MUST DIAGNOSE ITSELF.
//
// Staging, 2026-07-30: the LLM position monitor failed 21 checks in a row and
// the only thing the badge could say was "Unexpected end of JSON input" — the
// message JSON.parse('') produces. It names neither the model nor the cause, so
// it read as corrupt output when the real cause was a reasoning model spending
// its entire completion budget on reasoning and returning no text.
// ---------------------------------------------------------------------------
function emptyClient({ finishReason = 'length', reasoning = 768 } = {}) {
  return {
    model: 'gpt-5-nano',
    messages: {
      async create() {
        return {
          content: [{ type: 'text', text: '' }],
          finishReason,
          usage: { input_tokens: 900, output_tokens: 768, reasoning_tokens: reasoning },
          model: 'gpt-5-nano',
        }
      },
    },
  }
}

test('an empty completion names the model, the finish reason and the tokens', async () => {
  await assert.rejects(
    () => runMonitorCheck(emptyClient(), POSITION),
    (err) => {
      assert.doesNotMatch(err.message, /Unexpected end of JSON input/,
        'the bare parse error is exactly what made this undiagnosable')
      assert.match(err.message, /no text/i)
      assert.match(err.message, /gpt-5-nano/)
      assert.match(err.message, /finish_reason=length/)
      assert.match(err.message, /reasoning_tokens=768/)
      assert.match(err.message, /budget exhausted/i, 'finish_reason length names the cause outright')
      return true
    }
  )
})

test('an empty completion for ANOTHER reason still reports, without blaming the budget', async () => {
  await assert.rejects(
    () => runMonitorCheck(emptyClient({ finishReason: 'stop', reasoning: 0 }), POSITION),
    (err) => {
      assert.match(err.message, /finish_reason=stop/)
      assert.doesNotMatch(err.message, /budget exhausted/i)
      return true
    }
  )
})

test('whitespace-only output counts as empty — it parses to nothing either way', async () => {
  const client = {
    model: 'gpt-5-nano',
    messages: { async create() { return { content: [{ type: 'text', text: '   \n' }], finishReason: 'stop', usage: {} } } },
  }
  await assert.rejects(() => runMonitorCheck(client, POSITION), /no text/i)
})
