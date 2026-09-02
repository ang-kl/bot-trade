// node --test agent/routes/trades-limit-route.test.js
//
// /state/trades ignored `?limit=` — a hardcoded LIMIT 100 with no offset, so
// a 183-trade week could not be pulled through the API at all (state.js's
// own comment above /strategy-asset records the cost).

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'

function serve(db) {
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  const server = app.listen(0)
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

function seeded(n) {
  const db = initDB(':memory:')
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, opened_at, closed_at) VALUES ('EURUSD', 'BUY', 'closed', 1, ?, ?)`,
  )
  for (let i = 0; i < n; i++) {
    const ts = `2026-08-01 ${String(10 + (i % 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}`
    ins.run(ts, ts)
  }
  return db
}

test('limit is honoured, defaults to 100, and is capped at 1000', async () => {
  const db = seeded(120)
  const { server, base } = serve(db)
  try {
    const get = (q) => fetch(`${base}/state/trades${q}`).then(r => r.json())
    assert.equal((await get('?limit=2')).trades.length, 2)
    assert.equal((await get('')).trades.length, 100, 'default stays 100')
    assert.equal((await get('?limit=5000')).trades.length, 120, 'capped at 1000 — all 120 come back')
    assert.equal((await get('?limit=0')).trades.length, 100, 'a non-positive limit falls back to the default')
  } finally { server.close() }
})

test('offset pages through the journal without overlap', async () => {
  const db = seeded(7)
  const { server, base } = serve(db)
  try {
    const get = (q) => fetch(`${base}/state/trades${q}`).then(r => r.json())
    const p1 = (await get('?limit=3')).trades.map(t => t.id)
    const p2 = (await get('?limit=3&offset=3')).trades.map(t => t.id)
    const p3 = (await get('?limit=3&offset=6')).trades.map(t => t.id)
    assert.equal(p1.length, 3); assert.equal(p2.length, 3); assert.equal(p3.length, 1)
    const all = [...p1, ...p2, ...p3]
    assert.equal(new Set(all).size, 7, 'pages must not overlap and must cover every row')
  } finally { server.close() }
})
