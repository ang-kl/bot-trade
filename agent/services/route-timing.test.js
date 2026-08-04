// node --test agent/services/route-timing.test.js
//
// #125. The recorder itself must not become the leak it exists to catch, so
// most of these are about its ceilings rather than its arithmetic.

import test from 'node:test'
import assert from 'node:assert/strict'
import { recordRequest, routeTimings, resetRouteTimings, routeKey, MAX_ROUTES, SAMPLES_PER_ROUTE } from './route-timing.js'

test('the key drops the query string — otherwise this is a map keyed by user input', () => {
  // ?account=<id>&limit=<n> would mint a fresh key per distinct query, which
  // is exactly the unbounded-growth bug #123 is about, introduced here.
  assert.equal(routeKey('/state/trades?account=all&limit=100'), '/state/trades')
  assert.equal(routeKey('/state/trades?account=46130058'), '/state/trades')
})

test('long numeric ids in the path collapse to :id', () => {
  assert.equal(routeKey('/positions/234848341'), '/positions/:id')
  assert.equal(routeKey('/positions/234848341/events'), '/positions/:id/events')
  // Short numbers are not ids — a version or page number should stay legible.
  assert.equal(routeKey('/v1/state'), '/v1/state')
})

test('percentiles come out of the samples', () => {
  resetRouteTimings()
  for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) recordRequest('/state/x', ms, 100)
  const r = routeTimings().routes.find(x => x.route === '/state/x')
  assert.equal(r.requests, 10)
  assert.equal(r.p50, 50)
  assert.equal(r.p90, 90)
  assert.equal(r.max, 100)
  assert.equal(r.avgBytes, 100)
})

test('the worst request is kept with its timestamp — the shape a stall leaves behind', () => {
  resetRouteTimings()
  recordRequest('/state/x', 12, 10)
  recordRequest('/state/x', 29_000, 500_000)
  recordRequest('/state/x', 15, 10)
  const r = routeTimings().routes[0]
  assert.equal(r.worst.ms, 29_000)
  assert.equal(r.worst.bytes, 500_000)
  assert.match(r.worst.at, /^\d{4}-\d{2}-\d{2}T/)
})

test('samples per route are a fixed ring, so a busy route cannot grow forever', () => {
  resetRouteTimings()
  for (let i = 0; i < SAMPLES_PER_ROUTE * 3; i++) recordRequest('/state/x', 1, 1)
  const r = routeTimings().routes[0]
  assert.equal(r.sampled, SAMPLES_PER_ROUTE)
  assert.equal(r.requests, SAMPLES_PER_ROUTE * 3, 'the COUNT still tells the truth')
})

test('routes beyond the cap are counted, not silently dropped', () => {
  resetRouteTimings()
  for (let i = 0; i < MAX_ROUTES + 25; i++) recordRequest(`/state/r${i}`, 5, 1)
  const t = routeTimings()
  assert.equal(t.tracked, MAX_ROUTES)
  assert.equal(t.overflowRequests, 25)
  assert.match(t.note, /beyond the 120-route cap/)
})

test('with nothing over the cap there is no note to read', () => {
  resetRouteTimings()
  recordRequest('/state/x', 5, 1)
  assert.equal(routeTimings().note, null)
})

test('worst-p90 sorts first, because that is the question being asked', () => {
  resetRouteTimings()
  for (let i = 0; i < 10; i++) { recordRequest('/fast', 5, 1); recordRequest('/slow', 900, 1) }
  assert.equal(routeTimings().routes[0].route, '/slow')
})

test('a broken counter never throws into a response path', () => {
  resetRouteTimings()
  assert.doesNotThrow(() => recordRequest(null, null, null))
  assert.doesNotThrow(() => recordRequest(undefined, NaN, 'abc'))
  assert.doesNotThrow(() => recordRequest({}, {}, {}))
})

test('avgBytes is here beside the timings on purpose', () => {
  // The 2026-08-04 sweep found nothing slow but did find /state/veto-breakdown
  // returning 507 KB per call. Half a megabyte over a fast link still looks
  // fast from the server's side, so a latency-only view would have missed it.
  resetRouteTimings()
  recordRequest('/state/veto-breakdown', 500, 506_936)
  assert.equal(routeTimings().routes[0].avgBytes, 506_936)
})
