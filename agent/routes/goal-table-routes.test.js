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

test('GET /state/goal-table returns twenty-eight goals with verdicts and a summary', async () => {
  const h = await server()
  try {
    const r = await fetch(h.url('/state/goal-table')).then(x => x.json())
    assert.equal(r.goals.length, 28) // V3 M3 four P1/P4 rows + V3 L1 four lifecycle rows + PR-C veto_rate + PR-E trade_reasons + Wave 3 four family rows and the momentum checkpoint + Wave 5 monitor_cadence
    assert.ok(r.summary.on_track + r.summary.off_track + r.summary.not_measurable + r.summary.proposed === 28)
    assert.ok(r.goals.every(g => ['on_track', 'off_track', 'not_measurable', 'proposed'].includes(g.verdict)))
    assert.equal(r.targets.pipelineConversionMin, 0.5)
  } finally { h.close() }
})

test('V3 M3: the P1/P4 rows read "proposed" until the owner stamps the confirmation through POST /actions/goal-table; a null limit survives the POST', async () => {
  const h = await server()
  try {
    const now = Date.now()
    // A clean boot record for a boot whose startup window has closed.
    setState(h.db, 'boot_record_json', JSON.stringify({
      version: 1, bootId: 'b1', bootAt: new Date(now - 20 * 60_000).toISOString(), commit: 'abc1234',
      listening: { sinceBootMs: 7_000 }, startupLag: { ms: 900, at: new Date(now - 19 * 60_000).toISOString(), loopPhase: 'scan' },
      startupHttp: { complete: true, routes: [{ route: '/state/heartbeats', '4xx': 0, '5xx': 1, aborted: 0 }] },
      first: { band: { sinceBootMs: 20_000, ok: true, overran: false }, cleanProtectionAudit: { sinceBootMs: 30_000 } },
      persistedAt: new Date(now - 60_000).toISOString(),
    }))
    const before = await fetch(h.url('/state/goal-table')).then(x => x.json())
    const row = before.goals.find(g => g.id === 'startup_window')
    assert.equal(row.verdict, 'proposed', 'a critical-route 5xx against unconfirmed limits is reported, not counted off track')
    assert.equal(row.proposedVerdict, 'off_track')
    assert.equal(before.summary.proposed, 1)
    // An unrelated POST stores the full merged targets; the owner-set limits
    // with no proposal (null) must come back null, not 0.
    await post(h, '/actions/goal-table', { pipelineConversionMin: 0.6 })
    const stored = JSON.parse(getState(h.db, 'goal_table_json'))
    assert.equal(stored.targets.p1p4Report5xxMax, null)
    assert.equal(stored.targets.p1p4FirstLoopMaxSec, null)
    const conf = await post(h, '/actions/goal-table', { p1p4LimitsConfirmedAt: '2026-09-28T12:00:00Z' })
    assert.equal(conf.targets.p1p4LimitsConfirmedAt, '2026-09-28T12:00:00Z')
    assert.equal(conf.targets.pipelineConversionMin, 0.6, 'the earlier patch is kept')
    const after = await fetch(h.url('/state/goal-table')).then(x => x.json())
    const row2 = after.goals.find(g => g.id === 'startup_window')
    assert.equal(row2.verdict, 'off_track', 'confirmed limits: the same reading counts')
    assert.equal(row2.limits, 'confirmed')
    assert.equal(after.summary.off_track, before.summary.off_track + 1)
    assert.equal(after.summary.proposed, 0)
  } finally { h.close() }
})

test('POST /actions/goal-table: a stored key the route does not know survives a partial POST', async () => {
  const h = await server()
  try {
    setState(h.db, 'goal_table_json', JSON.stringify({ targets: { pipelineConversionMin: 0.7, futureKnob: 7 }, ownerNote: 'keep' }))
    const r = await post(h, '/actions/goal-table', { someFutureTargetKey: 65 })
    assert.equal(r.ok, true)
    const stored = JSON.parse(getState(h.db, 'goal_table_json'))
    assert.equal(stored.targets.futureKnob, 7, 'an unrelated POST must not drop a stored key')
    assert.equal(stored.targets.pipelineConversionMin, 0.7, 'an untouched known key keeps its stored value')
    assert.equal(stored.targets.someFutureTargetKey, 65, 'the patched key changes')
    assert.equal(stored.ownerNote, 'keep', 'a top-level stored key survives')
    assert.equal(r.targets.futureKnob, 7, 'the reply is built from what is stored, not from a fixed list')
    const g = await fetch(h.url('/actions/goal-table')).then(x => x.json())
    assert.equal(g.targets.someFutureTargetKey, 65)
  } finally { h.close() }
})

test('GET /state/equity-curve and /state/family-edge answer on an empty db (Wave 3)', async () => {
  const h = await server()
  try {
    const c = await fetch(h.url('/state/equity-curve?days=30')).then(x => x.json())
    assert.deepEqual(c.accounts, [])
    assert.equal(c.lastPassAt, null)
    const f = await fetch(h.url('/state/family-edge?days=0')).then(x => x.json())
    assert.deepEqual(Object.keys(f.families).sort(), ['breakout', 'mean_reversion', 'momentum', 'trend'])
    assert.equal(f.families.momentum.closes, 0)
  } finally { h.close() }
})
