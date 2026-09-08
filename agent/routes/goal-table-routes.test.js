// node --test agent/routes/goal-table-routes.test.js
//
// §7,437·B·1: GET /state/goal-table serves the table; GET/POST
// /actions/goal-table read and patch its targets under the start-from-stored
// merge rule (CLAUDE.md failure mode #5 — an endpoint that rebuilds instead
// of merging drops every key it does not name).

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
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
const post = (h, path, body) => fetch(h.url(path), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('GET /state/goal-table returns ten goals with verdicts and a summary', async () => {
  const h = await server()
  try {
    const r = await fetch(h.url('/state/goal-table')).then(x => x.json())
    assert.equal(r.goals.length, 10)
    assert.ok(r.summary.on_track + r.summary.off_track + r.summary.not_measurable === 10)
    assert.ok(r.goals.every(g => ['on_track', 'off_track', 'not_measurable'].includes(g.verdict)))
    assert.equal(r.targets.pipelineConversionMin, 0.5)
  } finally { h.close() }
})

test('POST /actions/goal-table: a stored key the route does not know survives a partial POST', async () => {
  const h = await server()
  try {
    setState(h.db, 'goal_table_json', JSON.stringify({ targets: { pipelineConversionMin: 0.7, futureKnob: 7 }, ownerNote: 'keep' }))
    const r = await post(h, '/actions/goal-table', { trailWinRatePct: 65 })
    assert.equal(r.ok, true)
    const stored = JSON.parse(getState(h.db, 'goal_table_json'))
    assert.equal(stored.targets.futureKnob, 7, 'an unrelated POST must not drop a stored key')
    assert.equal(stored.targets.pipelineConversionMin, 0.7, 'an untouched known key keeps its stored value')
    assert.equal(stored.targets.trailWinRatePct, 65, 'the patched key changes')
    assert.equal(stored.ownerNote, 'keep', 'a top-level stored key survives')
    assert.equal(r.targets.futureKnob, 7, 'the reply is built from what is stored, not from a fixed list')
    const g = await fetch(h.url('/actions/goal-table')).then(x => x.json())
    assert.equal(g.targets.trailWinRatePct, 65)
  } finally { h.close() }
})
