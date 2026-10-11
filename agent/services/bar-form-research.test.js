// node --test agent/services/bar-form-research.test.js
// Claude · № 13,096 11-Oct (ordered № 13,093; claude-builder), plan step 8.
// The job door: the plan's refusals and recorded values, the one-slot rule
// shared with the tick research, the dry run, the worker lifecycle with a
// fake worker, the one-transaction persist and the persisted view, abort.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initDB } from '../db.js'
import { barFormPlan, startBarFormResearch, abortBarFormResearch, barFormJobsView, barFormJob, barFormResearchView, persistRun, regimeRowsFor, _resetBarFormJobs, MAX_SEGMENT_NAMES } from './bar-form-research.js'
import { acquireResearchSlot, releaseResearchSlot, researchSlot } from './research-slot.js'
import { loadResearchConfig } from '../lib/research-config.js'

class FakeWorker extends EventEmitter {
  constructor(file, { workerData }) { super(); this.file = file; this.workerData = workerData; FakeWorker.last = this }
  terminate() { this.emit('exit', 1) }
}
const listAll = async () => ({ names: ['seg-0000000000001-000000.tks', 'seg-0000000000002-000000.tks', 'seg-0000000000003-000000.tks'], recordsPerSegment: [10, 10, 10], segments: 3, reachable: 1, sides: [{ side: 'cpp_exec_demo', reachable: true }] })
const sides = [{ name: 'cpp_exec_demo', base: 'http://demo.test' }, { name: 'cpp_exec', base: 'http://live.test' }]
const deps = (over = {}) => ({ listAll, sides, workerCtor: FakeWorker, cacheDir: '/tmp/bfr-test-cache', secret: 's', resolveNames: () => ({ accountId: '43097342', nameOf: id => ({ 1: 'AAA', 2: 'BBB' })[id] || null }), ...over })
const fresh = () => { _resetBarFormJobs(); if (researchSlot()) releaseResearchSlot(researchSlot().id); return initDB(':memory:') }

test('barFormPlan: values from the config, overrides recorded, the baseline required, bad inputs refused by name', () => {
  const cfg = loadResearchConfig().barForm
  const p = barFormPlan({}).plan
  assert.deepEqual(p.cfg.timeBarsMs, cfg.timeBarsMs); assert.deepEqual(p.overridden, []); assert.equal(p.minSample, 30); assert.match(p.minSampleSource, /tick-validation/)
  assert.ok(p.forms.includes('time_60000ms')); assert.ok(!p.strategies.includes('tsmom_long'))
  const o = barFormPlan({ timeBarsMs: [60000, 15000], maxSilenceMs: 1000, minSample: 5, symbolIds: ['1', 2, 'x', 2], strategies: ['rsi_meanrev'], side: 'demo', maxSegments: 2, note: 'n' }).plan
  assert.deepEqual(o.cfg.timeBarsMs, [60000, 15000]); assert.deepEqual(o.overridden, ['timeBarsMs', 'maxSilenceMs']); assert.equal(o.minSample, 5); assert.equal(o.minSampleSource, 'request')
  assert.deepEqual(o.symbolIds, [1, 2]); assert.deepEqual(o.strategies, ['rsi_meanrev']); assert.equal(o.side, 'demo'); assert.equal(o.maxSegments, 2)
  for (const [body, code] of [[{ timeBarsMs: [15000] }, 'baseline_missing'], [{ symbolIds: ['x'] }, 'bad_symbol_ids'], [{ strategies: ['tsmom_long'] }, 'bad_strategies'], [{ segments: ['nope'] }, 'bad_segments'], [{ maxSegments: MAX_SEGMENT_NAMES + 1 }, 'bad_max_segments'], [{ minSample: 0 }, 'bad_min_sample'], [{ side: 'paper' }, 'bad_side']]) {
    const r = barFormPlan(body); assert.equal(r.refuse?.body.error, code, JSON.stringify(body))
  }
  assert.equal(barFormPlan({}, { research: { source: 'unavailable', file: 'x', barForm: {} } }).refuse.body.error, 'research_config_unavailable')
  assert.equal(barFormPlan({}, { research: { source: 'file', file: 'x', barForm: { timeBarsMs: [], tickBarsNominalMs: [] } } }).refuse.body.error, 'no_forms', 'an empty request list is "not overridden"; only a config with no forms refuses no_forms')
})

test('a dry run plans, lists and writes nothing; names resolve through the caller; the slot is free afterwards', async () => {
  const db = fresh()
  const r = await startBarFormResearch(db, { dryRun: true, symbolIds: [1, 2, 3], side: 'demo', maxSegments: 2 }, deps())
  assert.equal(r.status, 200); assert.equal(r.body.dryRun, true); assert.equal(r.body.segments, 2); assert.deepEqual(r.body.symbolNames, { 1: 'AAA', 2: 'BBB' }); assert.deepEqual(r.body.sides, ['cpp_exec_demo'])
  assert.equal(researchSlot(), null); assert.equal(barFormJobsView().running, null); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bar_form_runs').get().n, 0)
  assert.equal((await startBarFormResearch(db, { segments: ['seg-0000000000009-000000.tks'] }, deps())).body.error, 'segments_not_listed')
  assert.equal((await startBarFormResearch(db, {}, deps({ listAll: async () => ({ names: [], sides: [] }) }))).body.error, 'no_segments')
})

test('one research job at a time: the tick research\'s slot refuses the bar-form job, and a running bar-form job refuses a second', async () => {
  const db = fresh()
  acquireResearchSlot('tick research replay', 'tick-1')
  const r = await startBarFormResearch(db, {}, deps())
  assert.equal(r.status, 409); assert.equal(r.body.error, 'research_running'); assert.match(r.body.where, /tick research replay/)
  releaseResearchSlot('tick-1')
  const a = await startBarFormResearch(db, { symbolIds: [1] }, deps())
  assert.equal(a.status, 202); assert.equal(researchSlot().what, 'bar-form research'); assert.equal(researchSlot().id, a.body.runId)
  const b = await startBarFormResearch(db, {}, deps())
  assert.equal(b.status, 409); assert.equal(b.body.runId, a.body.runId)
  FakeWorker.last.emit('message', { ok: true, manifest: { processed: 0 }, cells: [], summary: { cells: 0, byVerdict: {} } })
  assert.equal(researchSlot(), null)
})

test('the worker lifecycle: workerData carries the stream and the evaluation inputs; progress is shown; the result is persisted in the two tables and served by the view; the job view hides the worker', async () => {
  const db = fresh()
  db.prepare("INSERT INTO regimes(symbol, regime, computed_at) VALUES ('AAA', 'ranging', datetime('now', '-1 hour'))").run()
  const r = await startBarFormResearch(db, { symbolIds: [1, 2], minSample: 2 }, deps({ actor: 'owner' }))
  assert.equal(r.status, 202); assert.match(r.body.poll, /bar-form-research-job/)
  const w = FakeWorker.last
  assert.deepEqual(w.workerData.stream.names, ['seg-0000000000001-000000.tks', 'seg-0000000000002-000000.tks', 'seg-0000000000003-000000.tks'])
  assert.deepEqual(w.workerData.stream.sides.map(s => s.name), ['cpp_exec_demo', 'cpp_exec']); assert.equal(w.workerData.stream.secret, 's'); assert.deepEqual(w.workerData.stream.symbolIds, [1, 2])
  assert.equal(w.workerData.evaluate.minSample, 2); assert.deepEqual(w.workerData.evaluate.symbolNames, { 1: 'AAA', 2: 'BBB' }); assert.equal(w.workerData.evaluate.regimes.AAA.length, 1)
  assert.ok(w.workerData.abortFlag instanceof SharedArrayBuffer)
  w.emit('message', { progress: { done: 1, total: 3 } })
  assert.deepEqual(barFormJob(r.body.runId).progress, { done: 1, total: 3 }); assert.equal('worker' in barFormJob(r.body.runId), false)
  const cell = { symbolId: 1, symbol: 'AAA', strategy: 'vwap_trend', form: 'time_60000ms', bars: 100, runs: 1, invalidBars: 1, trades: 3, verdict: 'OK', stats: { trades: 3 }, rStats: { usable: 3, expectancyR: 0.2, expectancyLowerR: -0.1 }, byHalf: {}, byRegime: { ranging: { usable: 3 } }, mdeR: 0.5, note: null }
  w.emit('message', { ok: true, manifest: { processed: 3, aborted: false }, cells: [cell], summary: { cells: 1, byVerdict: { OK: 1 }, leaderboard: [] } })
  const j = barFormJob(r.body.runId)
  assert.equal(j.state, 'done'); assert.equal(j.result.cells, 1); assert.equal(barFormJobsView().running, null)
  const v = barFormResearchView(db)
  assert.equal(v.run.runId, r.body.runId); assert.equal(v.run.state, 'done'); assert.equal(v.run.actor, 'owner'); assert.equal(v.run.params.minSample, 2); assert.equal(v.run.manifest.processed, 3)
  assert.equal(v.cells.length, 1); assert.equal(v.cells[0].verdict, 'OK'); assert.deepEqual(v.cells[0].byRegime, { ranging: { usable: 3 } }); assert.equal(v.cellsTotal, 1); assert.equal(v.cellsTruncated, false)
  assert.equal(barFormResearchView(db, { runId: 'nope' }).run, null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bar_form_runs').get().n, 1)
})

test('abort sets the shared flag; an aborted worker result is recorded as aborted; a worker error as failed with the slot released', async () => {
  const db = fresh()
  assert.equal(abortBarFormResearch(null).status, 404)
  const r = await startBarFormResearch(db, { symbolIds: [1] }, deps())
  assert.equal(abortBarFormResearch('other').status, 404)
  const a = abortBarFormResearch(r.body.runId); assert.equal(a.status, 202)
  assert.equal(Atomics.load(new Int32Array(FakeWorker.last.workerData.abortFlag), 0), 1)
  FakeWorker.last.emit('message', { ok: true, manifest: { processed: 1, aborted: true }, cells: [], summary: { cells: 0, byVerdict: {} } })
  assert.equal(barFormJob(r.body.runId).state, 'aborted'); assert.equal(barFormResearchView(db).run.state, 'aborted')
  const f = await startBarFormResearch(db, { symbolIds: [1] }, deps())
  FakeWorker.last.emit('message', { ok: false, error: 'boom' })
  assert.equal(barFormJob(f.body.runId).state, 'failed'); assert.equal(barFormJob(f.body.runId).error, 'boom'); assert.equal(researchSlot(), null)
  const e = await startBarFormResearch(db, { symbolIds: [1] }, deps())
  FakeWorker.last.emit('exit', 2)
  assert.equal(barFormJob(e.body.runId).state, 'failed'); assert.match(barFormJob(e.body.runId).error, /exited 2/)
})

test('persistRun is one transaction; regimeRowsFor reads sorted rows per symbol within the window', () => {
  const db = fresh()
  db.prepare("INSERT INTO regimes(symbol, regime, computed_at) VALUES ('AAA', 'ranging', datetime('now', '-2 hours')), ('AAA', 'trending', datetime('now', '-1 hour')), ('ZZZ', 'quiet', datetime('now'))").run()
  const rows = regimeRowsFor(db, { 1: 'AAA' }, { fromMs: Date.now() - 86_400_000, toMs: Date.now() })
  assert.deepEqual(rows.AAA.map(r => r.regime), ['ranging', 'trending']); assert.equal(rows.ZZZ, undefined)
  const j = { runId: 'r1', state: 'done', startedAt: 'a', finishedAt: 'b', actor: null, plan: { x: 1 }, error: null }
  persistRun(db, j, { manifest: { m: 1 }, cells: [{ symbolId: 1, strategy: 's', form: 'f', verdict: 'OK', trades: 1 }, { symbolId: 2, strategy: 's', form: 'f', verdict: 'NO_BARS', trades: 0 }], summary: { cells: 2 } })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bar_form_results').get().n, 2)
  assert.throws(() => persistRun(db, j, { manifest: {}, cells: [], summary: {} }), /UNIQUE/)
})
