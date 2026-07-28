// node --test agent/routes/state-single-flight.test.js
//
// Incident 2026-07-28 ~03:10 UTC: after a redeploy every open tab
// cold-missed the /state response cache at once and each miss ran its own
// full synchronous aggregation — reads stacked until the site read as dead.
// These tests lock in the single-flight behaviour: concurrent GETs for the
// same URL are answered by ONE compute (leader 'miss', the rest 'coalesced'
// or 'hit'), and nobody is left hanging.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'

async function withServer(fn) {
  const db = initDB(':memory:')
  const app = express()
  app.use('/state', stateRouter(db))
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try { return await fn(base) } finally { server.close() }
}

test('concurrent GETs for one URL share a single compute', async () => {
  await withServer(async (base) => {
    // risk-full is async (dynamic imports) — the event loop yields mid-
    // compute, so concurrent requests genuinely arrive while it runs.
    const N = 5
    const responses = await Promise.all(
      Array.from({ length: N }, () => fetch(`${base}/state/risk-full`))
    )
    const bodies = await Promise.all(responses.map(r => r.text()))
    for (const r of responses) assert.equal(r.status, 200)
    // Everyone got the SAME payload…
    assert.equal(new Set(bodies).size, 1)
    // …and at most one request actually computed it.
    const kinds = responses.map(r => r.headers.get('x-cache'))
    assert.equal(kinds.filter(k => k === 'miss').length, 1, `expected exactly 1 miss, got: ${kinds.join(', ')}`)
    for (const k of kinds) assert.ok(['miss', 'coalesced', 'hit'].includes(k), `unexpected x-cache: ${k}`)
  })
})

test('sequential GET after settle is a cache hit with a matching etag', async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/state/risk-full`)
    assert.equal(first.status, 200)
    const etag = first.headers.get('etag')
    assert.ok(etag)
    const second = await fetch(`${base}/state/risk-full`)
    assert.equal(second.headers.get('x-cache'), 'hit')
    assert.equal(second.headers.get('etag'), etag)
    const notModified = await fetch(`${base}/state/risk-full`, { headers: { 'if-none-match': etag } })
    assert.equal(notModified.status, 304)
  })
})
