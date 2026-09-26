// node --test agent/lib/then-always.test.js
//
// S-2 small round (26-09-2026): the momentum book runs even when a phase
// before it throws. loop.js hands the pre-book region to `before` and the
// book to `after`; the wiring is pinned in
// agent/services/momentum-book-out-of-scan.test.js.

import test from 'node:test'
import assert from 'node:assert/strict'
import { thenAlways } from './then-always.js'

test('a preceding phase throws: the book (after) still runs once, is handed the error, and the error reaches the caller unchanged', async () => {
  const ran = []
  const boom = new Error('rankHotSymbols: cannot read properties of undefined')
  let handed
  await assert.rejects(
    thenAlways(
      async () => { ran.push('scan persist'); ran.push('rankHotSymbols'); throw boom },
      async (err) => { ran.push('book'); handed = err },
    ),
    (err) => err === boom,
    'the SAME error object is rethrown — the cycle catch accounts for it as before',
  )
  assert.deepEqual(ran, ['scan persist', 'rankHotSymbols', 'book'], 'the book ran after the throw')
  assert.equal(handed, boom, 'the book is told the cycle errored')
})

test('a clean cycle: the book runs once, handed null, and nothing is thrown', async () => {
  const calls = []
  await thenAlways(async () => { calls.push('before') }, async (err) => { calls.push(['after', err]) })
  assert.deepEqual(calls, ['before', ['after', null]])
})

test('the book waits for the pre-book region to settle (an async throw after an await)', async () => {
  const order = []
  await assert.rejects(thenAlways(
    async () => { await new Promise(r => setTimeout(r, 5)); order.push('monitor phase'); throw new Error('runMonitorPhase failed') },
    async () => { order.push('book') },
  ), /runMonitorPhase failed/)
  assert.deepEqual(order, ['monitor phase', 'book'])
})

test('the book\'s own throw never masks the pre-book error; alone, it propagates', async () => {
  const first = new Error('llmBlocked read failed')
  await assert.rejects(thenAlways(async () => { throw first }, async () => { throw new Error('book gate failed') }), (err) => err === first)
  await assert.rejects(thenAlways(async () => {}, async () => { throw new Error('book gate failed') }), /book gate failed/)
})

test('a nullish throw is still seen by the book as an error, and rethrown as thrown', async () => {
  let handed = null
  await assert.rejects(thenAlways(async () => { throw undefined }, async (err) => { handed = err }), (err) => err === undefined)
  assert.ok(handed instanceof Error, 'the book can tell the cycle errored')
})
