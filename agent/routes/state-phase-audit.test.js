// node --test agent/routes/state-phase-audit.test.js
//
// N5 (checker nit round, row 2.6 fix round): GET /state/phase-audit's split
// (services/phase-audit.js's phaseAuditSplit — `switches` + `controllerEvents`)
// must not travel the wire (or render on Reasons.jsx, which turns every
// array-of-objects top-level field into its own table — src/lib/reasons-view.js
// shapeBody) a third time over as a duplicate `audit` field alongside them.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import { setPhaseFlag, auditControllerEvent } from '../services/phase-audit.js'

async function withServer(db, fn) {
  const app = express()
  app.use('/state', stateRouter(db))
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try { return await fn(base) } finally { server.close() }
}

test('phase-audit split: switches + controllerEvents cover the same rows a duplicate audit field used to, and audit is gone', async () => {
  const db = initDB(':memory:')
  setPhaseFlag(db, 'autotrade_enabled', 'true', { actor: 'owner-ui', via: '/tune' })
  setPhaseFlag(db, 'autotrade_enabled', 'false', { actor: 'equity_stop', reason: 'daily loss cap' })
  auditControllerEvent(db, { controller: 'loop', event: 'stalled', detail: 'no heartbeat 90s' })
  auditControllerEvent(db, { controller: 'loop', event: 'recovered', detail: 'heartbeat resumed' })

  await withServer(db, async (base) => {
    const res = await fetch(`${base}/state/phase-audit`)
    assert.equal(res.status, 200)
    const body = await res.json()

    // N5: the old duplicate field is gone entirely — never sent as [], never
    // sent as undefined-but-present, just absent.
    assert.ok(!Object.hasOwn(body, 'audit'), 'audit field must not be present — this is the whole point of N5')

    assert.ok(Array.isArray(body.switches), 'switches is an array')
    assert.ok(Array.isArray(body.controllerEvents), 'controllerEvents is an array')
    assert.ok(body.switches.length >= 2, `expected the two setPhaseFlag flips in switches, got ${body.switches.length}`)
    assert.ok(body.controllerEvents.length >= 2, `expected the two auditControllerEvent rows in controllerEvents, got ${body.controllerEvents.length}`)

    // Bounded payload (N5's other half): switches must carry only /phase/
    // and /arm/ rows, controllerEvents only /controller/ rows — no overlap,
    // no row appearing in both (which duplication inside the split itself
    // would also triple the effective payload).
    for (const row of body.switches) assert.match(row.path, /^\/(phase|arm)\//)
    for (const row of body.controllerEvents) assert.match(row.path, /^\/controller\//)

    assert.equal(typeof body.scope, 'string')
  })
})

test('phase-audit split respects ?limit the same way the old audit field did', async () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 5; i++) {
    setPhaseFlag(db, 'scan_enabled', i % 2 === 0 ? 'true' : 'false', { actor: 'owner-ui' })
  }
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/state/phase-audit?limit=2`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.switches.length <= 2, `limit=2 must bound switches, got ${body.switches.length}`)
  })
})
