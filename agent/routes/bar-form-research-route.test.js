// node --test agent/routes/bar-form-research-route.test.js
// Claude · № 13,096 11-Oct (ordered № 13,093; claude-builder), plan step 8.
// The read routes: the persisted run view and the in-memory job view,
// validated, no-store.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import { persistRun, _resetBarFormJobs } from '../services/bar-form-research.js'

async function fixture(t) {
  const db = initDB(':memory:'); _resetBarFormJobs()
  persistRun(db, { runId: 'abc123', state: 'done', startedAt: '2026-10-11T00:00:00Z', finishedAt: '2026-10-11T00:10:00Z', actor: 'owner', plan: { minSample: 30 }, error: null },
    { manifest: { processed: 2 }, cells: [{ symbolId: 1, symbol: 'AAA', strategy: 'vwap_trend', form: 'time_60000ms', verdict: 'INSUFFICIENT', trades: 2, rStats: { usable: 2 } }], summary: { cells: 1, byVerdict: { INSUFFICIENT: 1 } } })
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close() })
  return { url: p => `http://127.0.0.1:${server.address().port}/state${p}` }
}

test('GET /state/bar-form-research serves the latest persisted run and its cells; a named run; validation', async t => {
  const { url } = await fixture(t)
  const res = await fetch(url('/bar-form-research')); assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store')
  const j = await res.json()
  assert.equal(j.run.runId, 'abc123'); assert.equal(j.run.summary.cells, 1); assert.equal(j.cells[0].verdict, 'INSUFFICIENT'); assert.equal(j.cells[0].rStats.usable, 2); assert.equal(j.runs.length, 1)
  assert.equal((await (await fetch(url('/bar-form-research?runId=abc123&limit=1'))).json()).cellsTotal, 1)
  assert.equal((await (await fetch(url('/bar-form-research?runId=abc999'))).json()).run, null)
  for (const [q, code] of [['?runId=DROP%20TABLE', 'bar_form_invalid_run'], ['?limit=0', 'bar_form_invalid_limit'], ['?limit=5000', 'bar_form_invalid_limit']]) {
    const r = await fetch(url('/bar-form-research' + q)); assert.equal(r.status, 400, q); assert.equal((await r.json()).code, code)
  }
})

test('GET /state/bar-form-research-job: nothing running, no such id', async t => {
  const { url } = await fixture(t)
  const j = await (await fetch(url('/bar-form-research-job'))).json()
  assert.equal(j.running, null); assert.ok(Array.isArray(j.jobs)); assert.equal(j.slot, null)
  const r = await fetch(url('/bar-form-research-job?id=nope')); assert.equal(r.status, 404); assert.equal((await r.json()).code, 'bar_form_no_such_run')
})
