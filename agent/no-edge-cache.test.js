// node --test agent/no-edge-cache.test.js
//
// The owner enabled Railway CDN caching (2026-07-28) with a 30-minute
// default TTL that applies "when the origin doesn't send Cache-Control
// headers" — and this API sent none. Every response here is live trading
// state or a money-moving action, so a cached copy is a wrong copy. These
// tests lock the opt-out in at the middleware level so no future route can
// quietly become edge-cacheable.
//
// The middleware under test is a pure express concern, so it is exercised
// directly rather than by booting the whole agent (which needs a DB, creds
// and a loop).

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

/** The exact middleware installed in agent/index.js — kept in sync by the
 *  assertion at the bottom of this file, which reads the real source. */
function noEdgeCache(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('Vary', 'Authorization, Accept-Encoding')
  next()
}

async function withServer(install, fn) {
  const app = express()
  install(app)
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  try { return await fn(`http://127.0.0.1:${server.address().port}`) } finally { server.close() }
}

test('every response carries a no-store Cache-Control', async () => {
  await withServer(
    (app) => {
      app.use(noEdgeCache)
      app.get('/health', (_q, s) => s.json({ ok: true }))
      app.get('/state/positions', (_q, s) => s.json({ positions: [] }))
      app.post('/actions/close-all', (_q, s) => s.json({ closed: 0 }))
      app.get('/boom', (_q, s) => s.status(500).json({ error: 'x' }))
    },
    async (base) => {
      const checks = [
        ['GET', '/health'],
        ['GET', '/state/positions'],
        ['POST', '/actions/close-all'],
        ['GET', '/boom'], // error responses must not be cacheable either
      ]
      for (const [method, path] of checks) {
        const r = await fetch(`${base}${path}`, { method })
        const cc = r.headers.get('cache-control') || ''
        assert.ok(cc.includes('no-store'), `${method} ${path} must send no-store, got "${cc}"`)
        assert.ok(cc.includes('private'), `${method} ${path} must send private, got "${cc}"`)
      }
    }
  )
})

test('responses vary on Authorization so an authed body is never reused for an anonymous request', async () => {
  await withServer(
    (app) => {
      app.use(noEdgeCache)
      app.get('/state/config', (_q, s) => s.json({ secretish: true }))
    },
    async (base) => {
      const r = await fetch(`${base}/state/config`)
      const vary = (r.headers.get('vary') || '').toLowerCase()
      assert.ok(vary.includes('authorization'), `Vary must include Authorization, got "${vary}"`)
      // Accept-Encoding must survive too — dropping it would break compression
      // negotiation for any cache that does store.
      assert.ok(vary.includes('accept-encoding'), `Vary must still include Accept-Encoding, got "${vary}"`)
    }
  )
})

test('the real agent installs this middleware before its routes', async () => {
  const fs = await import('node:fs')
  const url = await import('node:url')
  const path = await import('node:path')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, 'index.js'), 'utf8')

  const ccIdx = src.indexOf("res.setHeader('Cache-Control', 'no-store")
  assert.ok(ccIdx > 0, 'agent/index.js must set a no-store Cache-Control')
  assert.ok(
    src.includes("res.setHeader('Vary', 'Authorization, Accept-Encoding')"),
    'agent/index.js must vary on Authorization',
  )
  // It has to run BEFORE the routers, or routes mounted earlier escape it.
  const routerIdx = src.indexOf("app.use('/state'")
  if (routerIdx > 0) {
    assert.ok(ccIdx < routerIdx, 'the no-store middleware must be installed before the /state router')
  }
})
