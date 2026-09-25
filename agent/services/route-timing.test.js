// node --test agent/services/route-timing.test.js
//
// #125. The recorder itself must not become the leak it exists to catch, so
// most of these are about its ceilings rather than its arithmetic.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import {
  recordRequest, routeTimings, resetRouteTimings, routeKey, MAX_ROUTES, SAMPLES_PER_ROUTE,
  statusClass, requestRouteKey, unmatchedKey, routeTimingMiddleware,
} from './route-timing.js'

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
  assert.match(t.note, new RegExp(`beyond the ${MAX_ROUTES}-route cap`))
  // V3 M1: raised from 120 only after naming what filled it (route-timing.js
  // header); still a hard bound.
  assert.equal(MAX_ROUTES, 256)
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

// ---------------------------------------------------------------------------
// V3 M1 (P1/P4-1): status classes, mount-prefixed pattern keys, and the
// middleware itself exercised through a real Express app — not a source grep.
// ---------------------------------------------------------------------------

test('statusClass: every response lands in exactly one class; aborted and junk are named, not dropped', () => {
  assert.equal(statusClass(200), '2xx')
  assert.equal(statusClass(204), '2xx')
  assert.equal(statusClass(304), '3xx')
  assert.equal(statusClass(401), '4xx')
  assert.equal(statusClass(499), '4xx')
  assert.equal(statusClass(500), '5xx')
  assert.equal(statusClass(503), '5xx')
  assert.equal(statusClass('aborted'), 'aborted')
  assert.equal(statusClass(undefined), 'other')
  assert.equal(statusClass(700), 'other')
  assert.equal(statusClass(101), 'other')
})

test('recordRequest counts status classes per route and keeps the last 5xx with its time', () => {
  resetRouteTimings()
  recordRequest('/state/decisions-daily', 30_002, 90, 503)
  recordRequest('/state/decisions-daily', 800, 9_000, 200)
  recordRequest('/state/decisions-daily', 12, 40, 'aborted')
  recordRequest('/state/decisions-daily', 5, 40) // an older caller: timed, not classed
  const r = routeTimings().routes.find(x => x.route === '/state/decisions-daily')
  assert.deepEqual(r.status, { '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 1, aborted: 1, other: 0 })
  assert.equal(r.requests, 4)
  assert.equal(r.last5xx.status, 503)
  assert.equal(r.last5xx.ms, 30_002)
  assert.match(r.last5xx.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(routeTimings().statusTotals['5xx'], 1)
})

test('requestRouteKey: a matched route keys by MOUNT + PATTERN, so /state/X and /actions/X no longer collide and ids cannot mint keys', () => {
  assert.equal(requestRouteKey({ baseUrl: '/state', path: '/scans/EURUSD', route: { path: '/scans/:symbol' } }), '/state/scans/:symbol')
  assert.equal(requestRouteKey({ baseUrl: '/state', path: '/scans/XAUUSD', route: { path: '/scans/:symbol' } }), '/state/scans/:symbol')
  assert.equal(requestRouteKey({ baseUrl: '/state', path: '/x', route: { path: '/x' } }), '/state/x')
  assert.equal(requestRouteKey({ baseUrl: '/actions', path: '/x', route: { path: '/x' } }), '/actions/x')
  assert.equal(requestRouteKey({ baseUrl: '', path: '/health', route: { path: '/health' } }), '/health')
  // The SPA fallback is a RegExp route that calls next() for API paths — never a key of its own.
  assert.equal(requestRouteKey({ baseUrl: '', path: '/desk', route: { path: /.*/ } }), '/*')
  assert.equal(requestRouteKey({ baseUrl: '', path: '/state/nope', route: { path: /.*/ } }), '/state/*')
  // No route at all: static files, a 401 before routing, a 404.
  assert.equal(requestRouteKey({ baseUrl: '', path: '/assets/index-ZK96yTc6.js' }), '/assets/*')
  assert.equal(requestRouteKey({ baseUrl: '', path: '/fonts/inter-400.woff2' }), '/fonts/*')
  assert.equal(requestRouteKey({ baseUrl: '', path: '/wp-login.php' }), '/*')
  assert.equal(unmatchedKey('/'), '/')
  assert.equal(unmatchedKey('/actions/anything/at/all?x=1'), '/actions/*')
})

test('the unmatched buckets are bounded: a thousand distinct junk and asset paths make a handful of keys', () => {
  resetRouteTimings()
  for (let i = 0; i < 1000; i++) {
    recordRequest(requestRouteKey({ baseUrl: '', path: `/assets/chunk-${i}.js` }), 1, 1, 200)
    recordRequest(requestRouteKey({ baseUrl: '', path: `/probe-${i}.php` }), 1, 1, 404)
    recordRequest(requestRouteKey({ baseUrl: '/state', path: `/scans/SYM${i}`, route: { path: '/scans/:symbol' } }), 1, 1, 200)
  }
  const t = routeTimings()
  assert.equal(t.tracked, 3, t.routes.map(r => r.route).join(', '))
  assert.equal(t.overflowRequests, 0)
})

function miniApp(onStatus) {
  // The same ORDER as agent/index.js: timing first, then an auth-shaped
  // middleware, then the mounted routers, /health, and a 404.
  const app = express()
  app.use(routeTimingMiddleware({ onStatus }))
  app.use((req, res, next) => (req.path === '/state/locked' ? res.status(401).json({ error: 'Unauthorized' }) : next()))
  const state = express.Router()
  state.get('/scans/:symbol', (_req, res) => res.json({ ok: 1 }))
  state.get('/x', (_req, res) => res.json({ ok: 1 }))
  state.get('/decisions-daily', (_req, res) => res.status(503).json({ error: 'performance_report_worker_capacity', retryAfter: 5 }))
  const actions = express.Router()
  actions.post('/x', (_req, res) => res.status(500).json({ error: 'boom' }))
  actions.get('/hang', () => { /* never answers — the client gives up */ })
  app.use('/state', state)
  app.use('/actions', actions)
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.use((_req, res) => res.status(404).json({ error: 'not found' }))
  return app
}

test('THE MIDDLEWARE, end to end: every route is classed — /health and /actions/* included — under its mount-prefixed pattern, and onStatus sees each one', async () => {
  resetRouteTimings()
  const seen = []
  const server = createServer(miniApp((key, status) => seen.push([key, status])))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    for (const p of ['/state/scans/EURUSD', '/state/scans/XAUUSD', '/state/x', '/state/decisions-daily', '/health', '/state/locked', '/wp-login.php']) {
      await fetch(base + p).then(r => r.text())
    }
    await fetch(base + '/actions/x', { method: 'POST' }).then(r => r.text())
    const ac = new AbortController()
    const hung = fetch(base + '/actions/hang', { signal: ac.signal }).catch(() => null)
    await new Promise(r => setTimeout(r, 50))
    ac.abort()
    await hung
    await new Promise(r => setTimeout(r, 50))
  } finally {
    server.closeAllConnections?.()
    await new Promise(r => server.close(r))
  }
  const by = Object.fromEntries(routeTimings().routes.map(r => [r.route, r]))
  assert.deepEqual(Object.keys(by).sort(), ['/*', '/actions/hang', '/actions/x', '/health', '/state/*', '/state/decisions-daily', '/state/scans/:symbol', '/state/x'])
  assert.equal(by['/state/scans/:symbol'].status['2xx'], 2, 'two symbols, ONE key')
  assert.equal(by['/state/x'].status['2xx'], 1)
  assert.equal(by['/actions/x'].status['5xx'], 1, '/actions/x is its own key, not /state/x')
  assert.equal(by['/state/decisions-daily'].status['5xx'], 1)
  assert.equal(by['/state/decisions-daily'].last5xx.status, 503)
  assert.equal(by['/health'].status['2xx'], 1, '/health is timed and classed now')
  assert.equal(by['/state/*'].status['4xx'], 1, 'a 401 before routing is counted, in the bounded bucket')
  assert.equal(by['/*'].status['4xx'], 1, 'a scanner probe is a 404 in the bounded bucket')
  assert.equal(by['/actions/hang'].status.aborted, 1, 'a request the client gave up on is counted as aborted, not lost')
  assert.ok(seen.some(([k, s]) => k === '/state/decisions-daily' && s === 503), JSON.stringify(seen))
  assert.ok(seen.some(([k, s]) => k === '/health' && s === 200))
  assert.ok(seen.some(([k, s]) => k === '/actions/hang' && s === 'aborted'))
  assert.equal(seen.length, 9, 'exactly one onStatus per request — finish and close never double-count')
})

test('the middleware never throws into the response path, even when onStatus does', async () => {
  resetRouteTimings()
  const server = createServer(miniApp(() => { throw new Error('observer broke') }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/state/x`)
    assert.equal(res.status, 200)
    await res.text()
  } finally {
    server.closeAllConnections?.()
    await new Promise(r => server.close(r))
  }
})
