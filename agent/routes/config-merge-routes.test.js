// node --test agent/routes/config-merge-routes.test.js
//
// CLAUDE.md failure mode #5 — an endpoint that rebuilds instead of merging.
// POST /actions/session-open-guard and /actions/performance-breaker built
// `next` from a fixed field list, so any key the list did not name was
// silently DROPPED from the stored config on the next unrelated POST.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from './actions.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}
const post = (h, path, body) => fetch(h.url(path), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('session-open-guard: a stored key the route does not know survives a partial POST', async () => {
  const h = await server()
  try {
    setState(h.db, 'session_open_guard_json', JSON.stringify({ on: true, windowMin: 30, minR: 0.2, futureKnob: 7 }))
    const r = await post(h, '/actions/session-open-guard', { minR: 0.3 })
    assert.equal(r.ok, true)
    const stored = JSON.parse(getState(h.db, 'session_open_guard_json'))
    assert.equal(stored.futureKnob, 7, 'an unrelated POST must not drop a stored key')
    assert.equal(stored.windowMin, 30, 'an untouched known key keeps its stored value')
    assert.equal(stored.minR, 0.3, 'the patched key changes')
    assert.equal(r.futureKnob, 7, 'the reply is built from what is stored, not from a fixed list')
  } finally { h.close() }
})

test('performance-breaker: a stored key the route does not know survives a partial POST', async () => {
  const h = await server()
  try {
    setState(h.db, 'performance_breaker_json', JSON.stringify({ on: true, window: 40, minTrades: 20, pfThreshold: 0.8, autoDisarm: true, futureKnob: 'x' }))
    const r = await post(h, '/actions/performance-breaker', { window: 50 })
    assert.equal(r.ok, true)
    const stored = JSON.parse(getState(h.db, 'performance_breaker_json'))
    assert.equal(stored.futureKnob, 'x')
    assert.equal(stored.autoDisarm, true, 'the armed auto-disarm must not be reset by an unrelated POST')
    assert.equal(stored.minTrades, 20)
    assert.equal(stored.window, 50)
    assert.equal(r.futureKnob, 'x')
  } finally { h.close() }
})
