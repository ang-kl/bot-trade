// node --test agent/routes/tick-readiness-routes.test.js — P5's three routes
// over a real express app: the readiness read (all accounts and one), the
// signals read, the validation importer's refusal path (PR-H set the
// thresholds, so an unknown trial answers 400 trial_not_found and writes
// nothing), and PR-H's research action.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'
import { getAccountState } from '../services/account-registry.js'
import { ENGINE_STATUS_KEY } from '../services/entry-mode.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureSegment, syntheticSegment } from '../services/tick-research-run.test.js'
import { _resetTickResearchJobs } from '../services/tick-research-run.js'

function server() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('46130058', 0, 1, 'active', '5203012')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('42993489', 1, 1, 'active', '5268549')
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ db, close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` }))
  })
}

test('GET /state/tick-readiness lists every account with classed blockers; ?account narrows to one; GET /state/tick-signals answers', async () => {
  const s = await server()
  try {
    const all = await fetch(s.url('/state/tick-readiness')).then(r => r.json())
    assert.equal(all.accounts.length, 2); assert.equal(all.readyCount, 0)
    assert.ok(all.accounts.every(a => a.ready === false && a.blockedReasons.length > 0 && Array.isArray(a.readiness)))
    const one = await fetch(s.url('/state/tick-readiness?account=42993489')).then(r => r.json())
    assert.equal(one.accountId, '…3489'); assert.equal(one.environment, 'live'); assert.ok(one.blockedReasons.includes('validation_stage'))
    const sig = await fetch(s.url('/state/tick-signals')).then(r => r.json())
    assert.equal(sig.count, 0); assert.deepEqual(sig.signals, [])
  } finally { s.close() }
})

test('POST /actions/tick-validation is past thresholds_unset (PR-H set them): an unknown trial refuses 400 trial_not_found and writes nothing; a missing stage is 400', async () => {
  const s = await server()
  try {
    const bad = await fetch(s.url('/actions/tick-validation'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: '46130058' }) })
    assert.equal(bad.status, 400)
    const r = await fetch(s.url('/actions/tick-validation'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: '46130058', stage: 'replay_passed', evidence: { trialId: 'x' } }) })
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.equal(body.ok, false); assert.equal(body.reason, 'trial_not_found', 'RED if the checked-in thresholds went back to null (thresholds_unset)')
    assert.equal(getAccountState(s.db, '46130058', ENGINE_STATUS_KEY), null)
  } finally { s.close() }
})

test('PR-H: POST /actions/tick-research answers 409 no_segments with WHERE the data is when TICK_SEGMENTS_DIR is unset, and starts a worker job (202) that imports when it names a segment directory', async () => {
  _resetTickResearchJobs()
  const s = await server()
  const saved = process.env.TICK_SEGMENTS_DIR
  try {
    delete process.env.TICK_SEGMENTS_DIR
    const no = await fetch(s.url('/actions/tick-research'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageA: true }) })
    assert.equal(no.status, 409)
    const nb = await no.json()
    assert.equal(nb.error, 'no_segments'); assert.match(nb.where, /demo sidecar volume/); assert.match(nb.where, /TICK_SEGMENTS_DIR/); assert.match(nb.where, /scripts\/tick-research\.mjs/)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n, 0, 'never a fake trial')
    const dir = mkdtempSync(join(tmpdir(), 'tick-seg-route-'))
    writeFileSync(join(dir, 'seg-000001.tks'), fixtureSegment({ symbolId: 3 }))
    process.env.TICK_SEGMENTS_DIR = dir
    const ok = await fetch(s.url('/actions/tick-research'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageA: false, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, sim: { latencyMs: 60, minTargetToCost: 1 } }) })
    assert.equal(ok.status, 202)
    const started = await ok.json()
    assert.equal(started.ok, true); assert.equal(started.state, 'running'); assert.ok(started.jobId)
    let job = null
    for (let i = 0; i < 400; i++) { job = await fetch(s.url(`/state/tick-research-job?id=${started.jobId}`)).then(r => r.json()); if (job.state !== 'running') break; await new Promise(r => setTimeout(r, 25)) }
    assert.equal(job.state, 'done', JSON.stringify(job).slice(0, 300))
    const body = job.result
    assert.equal(body.ok, true); assert.equal(body.trials.length, 1); assert.equal(body.inserted, 1); assert.equal(body.trials[0].replay.ok, false)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n, 1)
    const view = await fetch(s.url('/state/tick-research')).then(r => r.json())
    assert.equal(view.trials[0].trialId, body.trialIds[0])
    const unknown = await fetch(s.url('/state/tick-research-job?id=nope'))
    assert.equal(unknown.status, 404)
    const all = await fetch(s.url('/state/tick-research-job')).then(r => r.json())
    assert.equal(all.running, null); assert.equal(all.jobs[0].jobId, started.jobId)
  } finally { if (saved != null) process.env.TICK_SEGMENTS_DIR = saved; else delete process.env.TICK_SEGMENTS_DIR; s.close() }
})

test('PR-H checker M-1: while a research job over a large segment runs, GET /health on the same app answers within 100 ms and a second POST is 409 research_running', async () => {
  _resetTickResearchJobs()
  const s = await server()
  const saved = process.env.TICK_SEGMENTS_DIR
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tick-seg-route-big-'))
    writeFileSync(join(dir, 'seg-000001.tks'), syntheticSegment(300_000))
    process.env.TICK_SEGMENTS_DIR = dir
    const post = (b) => fetch(s.url('/actions/tick-research'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    const first = await post({ stageA: false, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, sim: { latencyMs: 60, minTargetToCost: 1 } })
    assert.equal(first.status, 202)
    const { jobId } = await first.json()
    const second = await post({ stageA: false })
    assert.equal(second.status, 409); assert.equal((await second.json()).error, 'research_running')
    const t0 = performance.now()
    const h = await fetch(s.url('/health'))
    const ms = performance.now() - t0
    assert.equal(h.status, 200)
    assert.ok(ms < 100, `GET /health took ${ms.toFixed(0)} ms while the job ran (RED when the replay runs on the event loop: 48.8 s measured)`)
    const running = await fetch(s.url(`/state/tick-research-job?id=${jobId}`)).then(r => r.json())
    assert.equal(running.state, 'running', 'the job was still running when /health answered — the latency was measured against real work')
    let job = null
    for (let i = 0; i < 2400; i++) { job = await fetch(s.url(`/state/tick-research-job?id=${jobId}`)).then(r => r.json()); if (job.state !== 'running') break; await new Promise(r => setTimeout(r, 25)) }
    assert.equal(job.state, 'done', JSON.stringify(job).slice(0, 300)); assert.equal(job.result.manifest.events, 300_000)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n, 1)
  } finally { if (saved != null) process.env.TICK_SEGMENTS_DIR = saved; else delete process.env.TICK_SEGMENTS_DIR; s.close() }
})
