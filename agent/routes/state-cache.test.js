// node --test agent/routes/state-cache.test.js
//
// THE READ CACHE WAS WRITE-BLIND. GET /state/* is served from a 10-second
// response cache, which is right for aggregations six polling tabs would
// otherwise rebuild dozens of times a minute — but nothing invalidated it, so
// for up to ten seconds after a successful config write the agent kept serving
// the PRE-WRITE answer. The UI saved, re-read, and painted the old value back
// over the new one while the agent's own database held the new one.
//
// Found 2026-07-29 while shipping per-symbol strategy arming: a Tune row
// reverted to its previous pick moments after a save the agent had accepted.
// Reproduced with the browser out of the picture — POST, then three GETs, all
// three returning the superseded value. Very likely the mechanism behind the
// owner's earlier "i feel not saved but actually is", which was answered with
// a persistent 'last saved' line — a fix to the symptom.
//
// These tests pin BOTH halves: a write must invalidate, and a rejected write
// must not (otherwise a typo'd request throws away a cache the whole dashboard
// is reading from, which turns a 400 into a load spike).
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

const symbolsOf = async (s) =>
  (await fetch(s.url('/state/config')).then(r => r.json())).symbols

const post = (s, body) => fetch(s.url('/actions/symbols'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('a successful write is visible on the very next read', async () => {
  const s = await server()
  try {
    await post(s, { symbols: [{ symbol: 'EURUSD', strategies: ['cup_handle'] }] })
    assert.deepEqual((await symbolsOf(s))[0].strategies, ['cup_handle'])

    // No delay: this is the exact sequence the UI performs — save, re-read.
    await post(s, { symbols: [{ symbol: 'EURUSD' }] })
    for (let i = 0; i < 3; i++) {
      assert.equal((await symbolsOf(s))[0].strategies, undefined,
        `read ${i + 1} after the write still served the pre-write answer`)
    }
  } finally { s.close() }
})

test('repeat reads are still served from cache — the fix must not disable it', async () => {
  const s = await server()
  try {
    const h = async () => (await fetch(s.url('/state/config'))).headers.get('x-cache')
    assert.equal(await h(), 'miss')
    assert.equal(await h(), 'hit')
    assert.equal(await h(), 'hit')
  } finally { s.close() }
})

test('a REJECTED write does not throw the cache away', async () => {
  // A 400 changed nothing. Busting on it would let a typo'd request evict a
  // cache the whole dashboard is reading from.
  const s = await server()
  try {
    await fetch(s.url('/state/config'))                    // populate
    assert.equal((await fetch(s.url('/state/config'))).headers.get('x-cache'), 'hit')

    const bad = await post(s, { symbols: [{ symbol: 'EURUSD', strategies: ['not_a_strategy'] }] })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /Unknown strategy key/)

    assert.equal((await fetch(s.url('/state/config'))).headers.get('x-cache'), 'hit',
      'a refused request must leave the cache alone')
  } finally { s.close() }
})
