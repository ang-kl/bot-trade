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

// 27-09 follow-up (4), 03-10-2026: when both threw, the book's error is not
// dropped — it reaches onAfterError and rides on the rethrown error.
test('both throw: after\'s error is handed to onAfterError and attached as .afterError; before\'s error is still what is rethrown', async () => {
  const first = new Error('llmBlocked read failed')
  const second = new Error('book gate failed')
  const seen = []
  await assert.rejects(
    thenAlways(async () => { throw first }, async () => { throw second }, { onAfterError: (a, b) => seen.push([a, b]) }),
    (err) => err === first,
    'the SAME before error is rethrown',
  )
  assert.deepEqual(seen, [[second, first]], 'RED if after\'s error is dropped: onAfterError is called once with (afterError, beforeError)')
  assert.equal(first.afterError, second, 'the rethrown error carries the book\'s error')
})

test('both throw, no hook given: the default hook reports to console.error and nothing else changes', async () => {
  const first = new Error('first')
  const lines = []
  const orig = console.error
  console.error = (...a) => lines.push(a.join(' '))
  try {
    await assert.rejects(thenAlways(async () => { throw first }, async () => { throw new Error('second') }), (err) => err === first)
  } finally { console.error = orig }
  assert.equal(lines.length, 1)
  assert.match(lines[0], /after\(\) also threw .*"first".*: second/)
})

test('a hook that throws, and a frozen before error, never replace the rethrown error', async () => {
  const first = Object.freeze(new Error('frozen'))
  await assert.rejects(
    thenAlways(async () => { throw first }, async () => { throw new Error('second') }, { onAfterError: () => { throw new Error('hook broke') } }),
    (err) => err === first,
  )
  assert.equal(first.afterError, undefined, 'frozen: not attached, and no throw for it')
  // A primitive before error: the hook still sees both; nothing is attached.
  const seen = []
  await assert.rejects(thenAlways(async () => { throw 'str' }, async () => { throw new Error('second') }, { onAfterError: (a, b) => seen.push([a.message, b]) }), (err) => err === 'str')
  assert.deepEqual(seen, [['second', 'str']])
})

test('only before throws: the hook is not called; only after throws: it is not called either, after\'s error propagates', async () => {
  let calls = 0
  const hook = () => { calls++ }
  await assert.rejects(thenAlways(async () => { throw new Error('a') }, async () => {}, { onAfterError: hook }), /a/)
  await assert.rejects(thenAlways(async () => {}, async () => { throw new Error('b') }, { onAfterError: hook }), /b/)
  assert.equal(calls, 0)
})
