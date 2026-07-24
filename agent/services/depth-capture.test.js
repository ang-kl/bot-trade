// node --test agent/services/depth-capture.test.js
//
// L2 depth at entry (collect-forward slice 2): the imbalance math is exact,
// and captureDepthAtEntry returns honest nulls on every path where a real
// book isn't available — wrong exec mode, inactive subscription, empty
// book, sidecar error, sidecar unreachable.

import test from 'node:test'
import assert from 'node:assert/strict'
import { depthImbalance, captureDepthAtEntry } from './depth-capture.js'

const BOOK = {
  at: 1000,
  bids: [{ price: 1.085, sizeCents: 300 }, { price: 1.0849, sizeCents: 100 }],
  asks: [{ price: 1.0851, sizeCents: 100 }, { price: 1.0852, sizeCents: 100 }],
}

test('depthImbalance: exact size-weighted imbalance in [-1, 1]', () => {
  // (400 - 200) / 600
  assert.equal(depthImbalance(BOOK), 0.3333)
  assert.equal(depthImbalance({ bids: [{ sizeCents: 5 }], asks: [{ sizeCents: 5 }] }), 0)
  assert.equal(depthImbalance({ bids: [{ sizeCents: 7 }], asks: [] }), 1)
  assert.equal(depthImbalance({ bids: [], asks: [{ sizeCents: 7 }] }), -1)
})

test('depthImbalance: honest null on missing/empty/zero-size books', () => {
  assert.equal(depthImbalance(null), null)
  assert.equal(depthImbalance('not a book'), null)
  assert.equal(depthImbalance({}), null)
  assert.equal(depthImbalance({ bids: [], asks: [] }), null)
  assert.equal(depthImbalance({ bids: [{ sizeCents: 0 }], asks: [{ sizeCents: 0 }] }), null)
  assert.equal(depthImbalance({ bids: [{ sizeCents: 'x' }], asks: [] }), null)
})

test('depthImbalance: levels caps each side before summing', () => {
  const book = {
    bids: [{ sizeCents: 100 }, { sizeCents: 900 }],
    asks: [{ sizeCents: 100 }],
  }
  // levels=1 → 100 vs 100 → 0 (the 900 second-level bid must not leak in)
  assert.equal(depthImbalance(book, 1), 0)
})

function withEnv(vars, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })
}

function withFetch(impl, fn) {
  const saved = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = saved })
}

test('captureDepthAtEntry: js exec mode never calls the sidecar', async () => {
  await withEnv({ EXEC_ENGINE: undefined }, () =>
    withFetch(() => { throw new Error('must not be called') }, async () => {
      assert.deepEqual(await captureDepthAtEntry(41), { depthJson: null, depthImbalance: null })
    }))
})

test('captureDepthAtEntry: active book comes back as json + imbalance', async () => {
  let seen = null
  await withEnv({ EXEC_ENGINE: 'cpp', EXEC_URL: 'http://x', EXEC_SECRET: 's' }, () =>
    withFetch(async (url, opts) => {
      seen = { url, body: JSON.parse(opts.body), auth: opts.headers.authorization }
      return { ok: true, json: async () => ({ enabled: true, active: true, book: BOOK }) }
    }, async () => {
      const out = await captureDepthAtEntry(41, { levels: 10 })
      assert.equal(seen.url, 'http://x/depth')
      assert.deepEqual(seen.body, { symbolId: 41, levels: 10 })
      assert.equal(seen.auth, 'Bearer s')
      assert.equal(out.depthJson, JSON.stringify(BOOK))
      assert.equal(out.depthImbalance, 0.3333)
    }))
})

test('captureDepthAtEntry: nulls on inactive, null book, error status, throw, bad symbolId', async () => {
  const none = { depthJson: null, depthImbalance: null }
  await withEnv({ EXEC_ENGINE: 'cpp', EXEC_URL: 'http://x' }, async () => {
    await withFetch(async () => ({ ok: true, json: async () => ({ enabled: false, active: false, book: null }) }),
      async () => assert.deepEqual(await captureDepthAtEntry(41), none))
    await withFetch(async () => ({ ok: true, json: async () => ({ enabled: true, active: true, book: null }) }),
      async () => assert.deepEqual(await captureDepthAtEntry(41), none))
    await withFetch(async () => ({ ok: false, json: async () => ({}) }),
      async () => assert.deepEqual(await captureDepthAtEntry(41), none))
    await withFetch(async () => { throw new Error('conn refused') },
      async () => assert.deepEqual(await captureDepthAtEntry(41), none))
    await withFetch(() => { throw new Error('must not be called') },
      async () => assert.deepEqual(await captureDepthAtEntry(0), none))
  })
})

test('captureDepthAtEntry: empty-but-active book stores json with null imbalance', async () => {
  const empty = { at: 5, bids: [], asks: [] }
  await withEnv({ EXEC_ENGINE: 'cpp', EXEC_URL: 'http://x' }, () =>
    withFetch(async () => ({ ok: true, json: async () => ({ enabled: true, active: true, book: empty }) }), async () => {
      const out = await captureDepthAtEntry(41)
      assert.equal(out.depthJson, JSON.stringify(empty))
      assert.equal(out.depthImbalance, null)
    }))
})
