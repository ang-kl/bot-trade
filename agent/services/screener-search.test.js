// node --test agent/services/screener-search.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { searchScreenerSymbols } from './screener-search.js'

function fakeClient(replyText) {
  return {
    model: 'test-model',
    messages: { create: async () => ({ content: [{ type: 'text', text: replyText }] }) },
  }
}

const UNIVERSE = ['LMT.US', 'RTX.US', 'NOC.US', 'NVDA.US', 'MSFT.US', 'AVGO.US']

test('filters the LLM response down to the given universe — invented tickers are dropped', async () => {
  const client = fakeClient('{"symbols": ["NVDA.US", "AVGO.US", "MADE.UP.SYM"], "reasoning": "AI/chip names"}')
  const res = await searchScreenerSymbols(client, 'AI stocks', UNIVERSE)
  assert.deepEqual(res.symbols, ['NVDA.US', 'AVGO.US'])
  assert.deepEqual(res.dropped, ['MADE.UP.SYM'])
  assert.equal(res.reasoning, 'AI/chip names')
})

test('case-insensitive match against the universe', async () => {
  const client = fakeClient('{"symbols": ["nvda.us"], "reasoning": "x"}')
  const res = await searchScreenerSymbols(client, 'nvidia', UNIVERSE)
  assert.deepEqual(res.symbols, ['NVDA.US'])
})

test('unparseable response is honest — empty symbols, not a crash', async () => {
  const client = fakeClient('not json at all')
  const res = await searchScreenerSymbols(client, 'defense stocks', UNIVERSE)
  assert.deepEqual(res.symbols, [])
  assert.deepEqual(res.dropped, [])
})

test('empty symbols array from the model (no confident match) passes through honestly', async () => {
  const client = fakeClient('{"symbols": [], "reasoning": "Nothing in the universe matches quantum computing stocks."}')
  const res = await searchScreenerSymbols(client, 'quantum computing stocks', UNIVERSE)
  assert.deepEqual(res.symbols, [])
  assert.match(res.reasoning, /quantum/)
})

test('multi-turn history is threaded into the conversation', async () => {
  let capturedMessages = null
  const client = {
    model: 'test-model',
    messages: {
      create: async (params) => {
        capturedMessages = params.messages
        return { content: [{ type: 'text', text: '{"symbols": ["LMT.US"], "reasoning": "narrowed"}' }] }
      },
    },
  }
  await searchScreenerSymbols(client, 'just the large-caps', UNIVERSE, {
    history: [
      { role: 'user', content: 'defense stocks' },
      { role: 'assistant', content: 'Here are some defense stocks...' },
    ],
  })
  assert.equal(capturedMessages.length, 3)
  assert.equal(capturedMessages[0].content, 'defense stocks')
  assert.equal(capturedMessages[1].role, 'assistant')
  assert.match(capturedMessages[2].content, /just the large-caps/)
})
