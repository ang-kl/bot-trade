// node --test agent/services/latest-prices-cache.test.js
//
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// GET /state/prices: median 1.2 s, worst 13.4 s, one 45 s client abort
// (measured 10-10) — a fresh worker scan for nearly every Desk poll, because
// the route's 10 s response cache was emptied by every POST. One read is now
// kept 30 s and shared; concurrent callers share one build; a failure is never
// kept; the reply says when it was read (`asOf`).
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from '../routes/state.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import { createLatestPricesReader, LATEST_PRICES_TTL_MS } from './latest-prices-cache.js'

test('within the TTL a second call is served from the kept read; after it, the next call reads again', async () => {
  let clock = 1_000_000, reads = 0
  const read = async () => { reads++; return { EURUSD: { price: 1 + reads / 100 } } }
  const prices = createLatestPricesReader({}, { read, ttlMs: 30_000, now: () => clock })
  const a = await prices()
  clock += 29_999
  const b = await prices()
  assert.equal(reads, 1, 'one read inside the TTL')
  assert.equal(b, a, 'the same kept answer')
  assert.equal(a.asOf, new Date(1_000_000).toISOString(), 'asOf is when the kept read was taken')
  clock += 1
  const c = await prices()
  assert.equal(reads, 2, 'the TTL elapsed: read again')
  assert.notEqual(c.asOf, a.asOf)
  assert.equal(LATEST_PRICES_TTL_MS, 30_000)
})

test('single-flight: callers that arrive while a read runs share that one read', async () => {
  let reads = 0, release
  const read = () => { reads++; return new Promise(resolve => { release = () => resolve({ GBPUSD: { price: 1.3 } }) }) }
  const prices = createLatestPricesReader({}, { read })
  const all = Promise.all([prices(), prices(), prices()])
  await Promise.resolve()
  release()
  const [x, y, z] = await all
  assert.equal(reads, 1)
  assert.ok(x === y && y === z)
})

test('a failed read is not kept: the next caller reads again', async () => {
  let reads = 0
  const read = async () => { reads++; if (reads === 1) throw new Error('performance_report_worker_capacity'); return {} }
  const prices = createLatestPricesReader({}, { read })
  await assert.rejects(prices(), /worker_capacity/)
  await prices()
  assert.equal(reads, 2)
})

test('GET /state/prices keeps its shape, adds asOf, and serves the kept read even after the response cache is emptied', async t => {
  const db = initDB(':memory:')
  const insert = db.prepare("INSERT INTO scans (symbol, price, bias, confidence, scanned_at) VALUES (?, ?, 'skip', 0, datetime('now'))")
  insert.run('EURUSD', 1.1)
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(() => { db.close(); resolve() })))
  const get = async () => { const r = await fetch(`http://127.0.0.1:${server.address().port}/state/prices`); return { status: r.status, cache: r.headers.get('x-cache'), body: await r.json() } }

  const first = await get()
  assert.equal(first.status, 200)
  assert.deepEqual(Object.keys(first.body).sort(), ['asOf', 'prices'])
  assert.equal(first.body.prices.EURUSD.price, 1.1)
  // A new scan row lands, and a write empties the 10 s response cache — the
  // exact sequence a Desk poll met every five seconds.
  insert.run('USDJPY', 150)
  invalidateStateCache()
  const second = await get()
  assert.equal(second.cache, 'miss', 'the response cache really was emptied')
  assert.equal(second.body.asOf, first.body.asOf, 'served from the kept read, not a new worker scan')
  assert.equal(second.body.prices.USDJPY, undefined, 'a kept read says what it read, and when (asOf)')
})
