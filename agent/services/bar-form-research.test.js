// node --test agent/services/bar-form-research.test.js
// Claude · № 13,096 11-Oct (ordered № 13,093; claude-builder), plan step 8.
// The job door: the plan's refusals and recorded values, the one-slot rule
// shared with the tick research, the dry run, the worker lifecycle with a
// fake worker, the one-transaction persist and the persisted view, abort.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initDB } from '../db.js'
import { barFormPlan, startBarFormResearch, abortBarFormResearch, barFormJobsView, barFormJob, barFormResearchView, persistRun, regimeRowsFor, fastMonitorReading, _resetBarFormJobs, MAX_SEGMENT_NAMES, FAST_MONITOR_PASS_KEY, LIMIT_KEYS } from './bar-form-research.js'
import { PASS_RECORD_KEY } from './fast-monitor.js'
import { setState } from '../db.js'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireResearchSlot, releaseResearchSlot, researchSlot } from './research-slot.js'
import { loadResearchConfig } from '../lib/research-config.js'

class FakeWorker extends EventEmitter {
  constructor(file, { workerData }) { super(); this.file = file; this.workerData = workerData; FakeWorker.last = this }
  terminate() { this.emit('exit', 1) }
}
const listAll = async () => ({ names: ['seg-0000000000001-000000.tks', 'seg-0000000000002-000000.tks', 'seg-0000000000003-000000.tks'], recordsPerSegment: [10, 10, 10], segments: 3, reachable: 1, sides: [{ side: 'cpp_exec_demo', reachable: true }] })
const sides = [{ name: 'cpp_exec_demo', base: 'http://demo.test' }, { name: 'cpp_exec', base: 'http://live.test' }]
const deps = (over = {}) => ({ listAll, sides, workerCtor: FakeWorker, cacheDir: '/tmp/bfr-test-cache', secret: 's', resolveNames: () => ({ accountId: '43097342', nameOf: id => ({ 1: 'AAA', 2: 'BBB' })[id] || null }), ...over })
const settle = () => new Promise(r => setTimeout(r, 5)) // the completion crosses a promise (the broker cross-check) before finish
const fresh = () => { _resetBarFormJobs(); if (researchSlot()) releaseResearchSlot(researchSlot().id); return initDB(':memory:') }

test('barFormPlan: values from the config, overrides recorded, the baseline required, bad inputs refused by name', () => {
  const cfg = loadResearchConfig().barForm
  const p = barFormPlan({}).plan
  assert.deepEqual(p.cfg.timeBarsMs, cfg.timeBarsMs); assert.deepEqual(p.overridden, []); assert.equal(p.minSample, 30); assert.match(p.minSampleSource, /tick-validation/)
  assert.ok(p.forms.includes('time_60000ms')); assert.ok(!p.strategies.includes('tsmom_long'))
  const o = barFormPlan({ timeBarsMs: [60000, 15000], maxSilenceMs: 1000, minSample: 5, symbolIds: ['1', 2, 'x', 2], strategies: ['rsi_meanrev'], side: 'cpp_exec_demo', maxSegments: 2, note: 'n' }, { knownSides: ['cpp_exec', 'cpp_exec_demo'] }).plan
  assert.deepEqual(o.cfg.timeBarsMs, [60000, 15000]); assert.deepEqual(o.overridden, ['timeBarsMs', 'maxSilenceMs']); assert.equal(o.minSample, 5); assert.equal(o.minSampleSource, 'request')
  assert.deepEqual(o.symbolIds, [1, 2]); assert.deepEqual(o.strategies, ['rsi_meanrev']); assert.equal(o.side, 'cpp_exec_demo'); assert.equal(o.maxSegments, 2)
  for (const [body, code] of [[{ timeBarsMs: [15000] }, 'baseline_missing'], [{ symbolIds: ['x'] }, 'bad_symbol_ids'], [{ strategies: ['tsmom_long'] }, 'bad_strategies'], [{ segments: ['nope'] }, 'bad_segments'], [{ maxSegments: MAX_SEGMENT_NAMES + 1 }, 'bad_max_segments'], [{ minSample: 0 }, 'bad_min_sample'], [{ side: 'paper' }, 'bad_side'], [{ side: 'demo' }, 'bad_side']]) {
    const r = barFormPlan(body); assert.equal(r.refuse?.body.error, code, JSON.stringify(body))
  }
  assert.equal(barFormPlan({}, { research: { source: 'unavailable', file: 'x', barForm: {} } }).refuse.body.error, 'research_config_unavailable')
  assert.equal(barFormPlan({}, { research: { source: 'file', file: 'x', barForm: { timeBarsMs: [], tickBarsNominalMs: [] } } }).refuse.body.error, 'no_forms', 'an empty request list is "not overridden"; only a config with no forms refuses no_forms')
})

test('a dry run plans, lists and writes nothing; names resolve through the caller; the slot is free afterwards', async () => {
  const db = fresh()
  const r = await startBarFormResearch(db, { dryRun: true, symbolIds: [1, 2, 3], side: 'cpp_exec_demo', maxSegments: 2 }, deps())
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
  FakeWorker.last.emit('message', { ok: true, manifest: { processed: 0 }, cells: [], summary: { cells: 0, byVerdict: {} } }); await settle()
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
  w.emit('message', { ok: true, manifest: { processed: 3, aborted: false }, cells: [cell], summary: { cells: 1, byVerdict: { OK: 1 }, leaderboard: [] } }); await settle()
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
  FakeWorker.last.emit('message', { ok: true, manifest: { processed: 1, aborted: true }, cells: [], summary: { cells: 0, byVerdict: {} } }); await settle()
  assert.equal(barFormJob(r.body.runId).state, 'aborted'); assert.equal(barFormResearchView(db).run.state, 'aborted')
  const f = await startBarFormResearch(db, { symbolIds: [1] }, deps())
  FakeWorker.last.emit('message', { ok: false, error: 'boom' }); await settle()
  assert.equal(barFormJob(f.body.runId).state, 'failed'); assert.equal(barFormJob(f.body.runId).error, 'boom'); assert.equal(researchSlot(), null)
  const e = await startBarFormResearch(db, { symbolIds: [1] }, deps())
  FakeWorker.last.emit('exit', 2); await settle()
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

test('the broker cross-check: the run names up to three of its symbols; at the end their one-minute bars are set beside the broker\'s M1 bars through the route\'s fetch; a failed fetch is recorded, never fatal', async () => {
  const db = fresh()
  assert.equal(barFormPlan({ crossCheck: [1, 2, 3, 4] }).refuse, undefined, 'four names are bounded to three, not refused'); assert.deepEqual(barFormPlan({ crossCheck: [1, 2, 3, 4] }).plan.crossCheck, [1, 2, 3])
  assert.equal(barFormPlan({ crossCheck: ['x'] }).refuse.body.error, 'bad_cross_check'); assert.equal(barFormPlan({ symbolIds: [1], crossCheck: [2] }).refuse.body.error, 'bad_cross_check')
  const M = 60_000, T = 1_760_000_040_000 - (1_760_000_040_000 % M)
  const ours = [0, 1, 2].map(i => ({ t: T + i * M, o: 100, h: 101, l: 99, c: 100.5, v: 30 }))
  const calls = []
  const fetchBrokerBars = async (accountId, symbolId, count, endMs) => { calls.push({ accountId, symbolId, count, endMs }); if (symbolId === 2) throw new Error('broker 503'); return ours.map(b => ({ ...b, c: 100.52, v: 31 })) }
  const r = await startBarFormResearch(db, { symbolIds: [1, 2], crossCheck: [1, 2], minSample: 1 }, deps({ fetchBrokerBars }))
  assert.equal(r.status, 202); assert.deepEqual(FakeWorker.last.workerData.stream.crossCheckSymbolIds, [1, 2])
  FakeWorker.last.emit('message', { ok: true, manifest: { processed: 1, aborted: false }, cells: [], summary: { cells: 0, byVerdict: {} }, crossCheckBars: { 1: ours, 2: ours } }); await settle()
  const v = barFormResearchView(db)
  assert.equal(v.run.state, 'done')
  const cc = v.run.manifest.crossCheck
  assert.equal(cc.accountId, '43097342'); assert.deepEqual(calls.map(c => [c.accountId, c.symbolId, c.count, c.endMs]), [['43097342', 1, 8, T + 3 * M], ['43097342', 2, 8, T + 3 * M]])
  assert.equal(cc.symbols[1].aligned, 3); assert.equal(cc.symbols[1].absDiff.c.max, 0.02); assert.equal(cc.symbols[1].symbol, 'AAA')
  assert.equal(cc.symbols[2].error, 'broker 503'); assert.equal(cc.symbols[2].ours, 3)
  // Without a fetch function the gap is named, and the run still completes.
  const r2 = await startBarFormResearch(db, { symbolIds: [1], crossCheck: [1], minSample: 1 }, deps())
  FakeWorker.last.emit('message', { ok: true, manifest: { processed: 1 }, cells: [], summary: { cells: 0, byVerdict: {} }, crossCheckBars: { 1: ours } }); await settle()
  assert.match(barFormResearchView(db, { runId: r2.body.runId }).run.manifest.crossCheck.symbols[1].error, /no broker fetch available/)
})

const LIMITS = { workerMemoryMb: 2048, maxRuntimeMs: 3_600_000, maxTempBytes: 201_326_592, maxCells: 864, maxTransactionRows: 1000, maxPullsPerMinute: 30, maxSkippedTicksDelta: 0, maxBusyShare10m: 0.5, pollMs: 10 }
const cfgWith = (over = {}) => { const r = loadResearchConfig(); return { ...r, barForm: { ...r.barForm, limits: { ...r.barForm.limits, ...over } } } }

test('amendment area 1: no declared limit, no run; the cell matrix is bounded before anything is pulled; the pass-record key is the fast monitor\'s', () => {
  assert.equal(FAST_MONITOR_PASS_KEY, PASS_RECORD_KEY)
  const r = barFormPlan({}, { research: cfgWith({ maxRuntimeMs: null, maxBusyShare10m: null }) })
  assert.equal(r.refuse.body.error, 'limits_missing'); assert.deepEqual(r.refuse.body.missing, ['maxRuntimeMs', 'maxBusyShare10m'])
  assert.ok(barFormPlan({}).plan, 'the checked-in config declares every limit'); assert.deepEqual(Object.keys(barFormPlan({}).plan.limits).sort(), [...LIMIT_KEYS].sort())
  const big = barFormPlan({}, { research: cfgWith({ maxCells: 10 }) })
  assert.equal(big.refuse.body.error, 'too_many_cells'); assert.ok(big.refuse.body.cellBound > 10)
  assert.ok(barFormPlan({ symbolIds: [1] }, { research: cfgWith({ maxCells: 100 }) }).plan.cellBound <= 100)
})

test('the run carries the fast-monitor receipt before and after, polls it during the run, aborts on a skipped tick, and sweeps leftover pulled segments', async () => {
  const db = fresh()
  const dir = mkdtempSync(join(tmpdir(), 'bfr-cache-'))
  setState(db, FAST_MONITOR_PASS_KEY, JSON.stringify({ at: 'a', tick: { skippedTicks: 3, busyShare10m: 0.06, skipped10m: 0 } }))
  assert.deepEqual(fastMonitorReading(db), { at: 'a', skippedTicks: 3, busyShare10m: 0.06, skipped10m: 0 })
  const r = await startBarFormResearch(db, { symbolIds: [1] }, deps({ cacheDir: dir, research: cfgWith({ pollMs: 10 }) }))
  assert.equal(r.status, 202)
  assert.deepEqual(FakeWorker.last.workerData.stream.limits.maxSkippedTicksDelta, 0)
  assert.equal(barFormJob(r.body.runId).receipt.before.skippedTicks, 3)
  // A skipped tick during the run: the poll sets the abort flag and names the breach.
  setState(db, FAST_MONITOR_PASS_KEY, JSON.stringify({ at: 'b', tick: { skippedTicks: 4, busyShare10m: 0.07 } }))
  await new Promise(res => setTimeout(res, 40))
  assert.equal(Atomics.load(new Int32Array(FakeWorker.last.workerData.abortFlag), 0), 1)
  assert.equal(barFormJob(r.body.runId).receipt.breach.limit, 'maxSkippedTicksDelta')
  // A leftover of THIS run's pulled segments in the cache is swept at the end; a stranger's file is not.
  writeFileSync(join(dir, 'seg-0000000000002-000000.tks'), 'x'); writeFileSync(join(dir, 'other.bin'), 'y'); writeFileSync(join(dir, 'seg-0000000000009-000000.tks.123.abcd.part'), 'z')
  FakeWorker.last.emit('message', { ok: true, manifest: { processed: 1, aborted: true, observed: { maxRssBytes: 1 } }, cells: [], summary: { cells: 0, byVerdict: {} } }); await settle()
  const j = barFormJob(r.body.runId)
  assert.equal(j.state, 'aborted'); assert.equal(j.receipt.after.skippedTicks, 4); assert.equal(j.receipt.sweptLeftovers, 2); assert.deepEqual(j.receipt.observed, { maxRssBytes: 1 })
  assert.ok(!existsSync(join(dir, 'seg-0000000000002-000000.tks'))); assert.ok(existsSync(join(dir, 'other.bin')))
  assert.equal(barFormResearchView(db).run.manifest.receipt.breach.limit, 'maxSkippedTicksDelta')
  rmSync(dir, { recursive: true, force: true })
})

test('more cells than maxTransactionRows: the persisted set is cut to the limit and the receipt says so', async () => {
  const db = fresh()
  const r = await startBarFormResearch(db, { symbolIds: [1] }, deps({ research: cfgWith({ maxTransactionRows: 1 }) }))
  const cell = { symbolId: 1, symbol: 'AAA', strategy: 's', form: 'f', verdict: 'OK', trades: 1 }
  FakeWorker.last.emit('message', { ok: true, manifest: { processed: 1 }, cells: [cell, { ...cell, strategy: 't' }], summary: { cells: 2, byVerdict: {} } }); await settle()
  const v = barFormResearchView(db, { runId: r.body.runId })
  assert.equal(v.cellsTotal, 1); assert.equal(v.run.manifest.receipt.breach.limit, 'maxTransactionRows'); assert.equal(barFormJob(r.body.runId).receipt.cellsTruncatedToLimit, true)
})
