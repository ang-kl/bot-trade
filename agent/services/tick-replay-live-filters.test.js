// agent/services/tick-replay-live-filters.test.js — PR-Q3 (V3 P6/P7,
// 25-09-2026): the research doors model the live filters as a stamped sim
// block. The values come from the permits' own config and the regime gate,
// never from the body; the block (and its model) is part of the trial id; the
// counter-trend veto reads the regimes AS OF each signal, through the worker
// as well as in-thread; a door with no regimes table refuses that filter; a
// filtered trial cannot pass the replay rung while the shadow runs no equal
// block; and a window the regime prune has reached says so.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { tempDir } from '../test-support/temp-dir.js'
import { initDB, setState } from '../db.js'
import { encodeHeader, encodeRecord, FLAGS, KIND } from '../lib/tick-segment.js'
import { buildFixture } from '../lib/tick-strategy.test.js'
import { TICK_SHADOW_SIM_FILE, loadRepoSchedule } from '../lib/tick-cost-schedule.js'
import {
  tickResearchAction, startTickResearchJob, startTickResearchJobWithSync, tickResearchJob, _resetTickResearchJobs,
  loadSegments, runTrials, replayFiles, researchPlan, replayFilterContext, replayTrendContext, symbolTrend,
  liveFiltersRefusal, liveFiltersBlock, liveFiltersRequested, simHash, LIVE_FILTERS_CONFIG_SOURCE,
} from './tick-research-run.js'
import { loadThresholds, replayChecks, shadowLiveFilters } from './tick-validation.js'
import { loadTickEntryConfig } from './tick-permits.js'
import { trendReadingAt, permittedSides } from './direction-policy.js'
import { loadRegimeGateConfig } from './regime-gate.js'
import { simComparison } from './tick-replay-parity.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const T0 = 1_757_548_800_000 // the fixture's first second (11-09-2025 00:00 UTC)
const PARAMS = { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }
const SIM = { latencyMs: 60, minTargetToCost: 1 }
const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** The planted fixture as one sealed segment named by its start (seg-<13-digit ms>-…). */
function segmentDir({ symbolId = 7, environment = 'demo' } = {}) {
  const parts = [encodeHeader({ environment, generation: 1, startedMs: T0, feedId: 'q3' })]
  for (const ev of buildFixture()) {
    if (ev.changed === false) { parts.push(encodeRecord({ recvMs: ev.recvMs, seq: ev.seq, symbolId, flags: FLAGS.REPEAT, generation: 1 })); continue }
    let flags = 0
    if (ev.bid != null) flags |= FLAGS.BID_PRESENT | FLAGS.BID_CHANGED
    if (ev.ask != null) flags |= FLAGS.ASK_PRESENT | FLAGS.ASK_CHANGED
    if (ev.snapshot) flags |= FLAGS.SNAPSHOT
    if (ev.crossed) flags |= FLAGS.CROSSED
    parts.push(encodeRecord({ recvMs: ev.recvMs, seq: ev.seq, symbolId, bid: ev.bid ?? undefined, ask: ev.ask ?? undefined, flags, kind: KIND.QUOTE, generation: 1 }))
  }
  const dir = tempDir('q3-seg-')
  const file = join(dir, `seg-${T0}-000001.tks`)
  writeFileSync(file, Buffer.concat(parts))
  return { dir, file }
}

/** A keeper database whose tick universe is EURUSD (id 7) with one regime reading before the data. */
function keeperDb({ trend = 'long', gate = null } = {}) {
  const db = initDB(':memory:')
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD']))
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 7, GBPUSD: 8 }))
  if (gate) setState(db, 'regime_gate_json', JSON.stringify(gate))
  if (trend) db.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)').run('EURUSD', 'trending', trend, fmt(T0 - 10 * 60_000))
  return db
}

async function waitJob(id, maxMs = 30_000) {
  const t0 = Date.now()
  for (;;) { const j = tickResearchJob(id); if (j && j.state !== 'running') return j; if (Date.now() - t0 > maxMs) throw new Error('job did not finish'); await sleep(25) }
}

test('PR-Q3: the filter values are the permits\' own config and the regime gate — a body can switch filters on, never set them; every door refuses a value before reading anything', async () => {
  const db = keeperDb()
  const cfg = loadTickEntryConfig()
  const plan = researchPlan({ sim: { ...SIM, liveFilters: true } }, replayFilterContext(db))
  const lf = plan.sim.liveFilters
  assert.equal(lf.minStopFraction, cfg.minStopFraction); assert.equal(lf.overshootFraction, cfg.overshootFraction); assert.equal(lf.signalTtlMs, cfg.maxFireDelayMs)
  assert.equal(lf.configSource, LIVE_FILTERS_CONFIG_SOURCE)
  assert.equal(lf.model, 'firer', 'the default model is the gateway as it runs today')
  const gate = loadRegimeGateConfig(db)
  assert.deepEqual(lf.counterTrend, { asOf: 'signal_time', gateOn: gate.on, maxRegimeAgeMin: gate.maxRegimeAgeMin })
  // The model is a switch too: the named one is stamped, an unknown one refused.
  assert.equal(researchPlan({ sim: { ...SIM, liveFilters: { model: 'book', stopFloor: true } } }, replayFilterContext(db)).sim.liveFilters.model, 'book')
  const badModel = liveFiltersRefusal({ sim: { liveFilters: { model: 'free', stopFloor: true } } })
  assert.equal(badModel?.status, 400); assert.equal(badModel.body.error, 'live_filters_model')
  // A body that SENDS values is refused, whatever the value.
  for (const bad of [{ minStopFraction: 0.01 }, { stopFloor: 0.002 }, { priceBound: 'yes' }, { model: 'firer', signalTtlMs: 100 }, 'all', [1], 3]) {
    const r = liveFiltersRefusal({ sim: { liveFilters: bad } })
    assert.equal(r?.status, 400, JSON.stringify(bad)); assert.match(r.body.error, /^live_filters_/); assert.match(r.body.where, /tick-entry\.json/)
    assert.throws(() => researchPlan({ sim: { liveFilters: bad } }), /live_filters_/)
  }
  // Nothing asked: no key at all, the plan as before.
  for (const off of [undefined, null, false, {}, { stopFloor: false, counterTrend: false }]) {
    const p = researchPlan({ sim: { ...SIM, ...(off === undefined ? {} : { liveFilters: off }) } }, replayFilterContext(db))
    assert.equal('liveFilters' in p.sim, false, JSON.stringify(off))
    assert.equal(liveFiltersRequested({ sim: { liveFilters: off } }), null)
  }
  // The doors refuse before a segment is read or a job is started.
  const { dir } = segmentDir()
  const body = { stageA: false, params: PARAMS, sim: { ...SIM, liveFilters: { stopFloor: 0.002 } }, dryRun: true }
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n
  assert.equal(tickResearchAction(db, body, { segmentsDir: dir }).status, 400)
  assert.equal(startTickResearchJob(db, body, { segmentsDir: dir }).status, 400)
  assert.equal((await startTickResearchJobWithSync(db, body, { segmentsDir: dir })).status, 400)
  assert.equal(tickResearchJob('x'), null); assert.equal(count(), 0)
})

test('PR-Q3: the block is part of the trial id and the sim hash — each filter set is its own trial, a different config value is a different trial, and "off" keys the trial it always did', () => {
  const { file } = segmentDir()
  const loaded = loadSegments([file])
  const cfg = loadTickEntryConfig()
  const trialFor = (liveFilters) => runTrials(loaded, { params: PARAMS, sim: researchPlan({ sim: { ...SIM, ...(liveFilters === undefined ? {} : { liveFilters }) } }).sim })[0]
  const before = runTrials(loaded, { params: PARAMS, sim: SIM })[0]
  const off = trialFor(undefined), offFalse = trialFor(false), offAll = trialFor({ stopFloor: false })
  assert.equal(off.trialId, before.trialId, 'no block: the same trial id as a sim that never heard of one')
  assert.equal(offFalse.trialId, before.trialId); assert.equal(offAll.trialId, before.trialId)
  const floor = trialFor({ stopFloor: true }), three = trialFor({ stopFloor: true, priceBound: true, signalTtl: true })
  const floorBook = trialFor({ stopFloor: true, model: 'book' })
  const ids = new Set([before.trialId, floor.trialId, three.trialId, floorBook.trialId])
  assert.equal(ids.size, 4, 'each filter set, and each model, is a different trial')
  assert.notEqual(floor.manifest.simHash, before.manifest.simHash)
  // A different VALUE in the permits' config is a different trial too.
  const other = liveFiltersBlock({ stopFloor: true }, { entryCfg: { ...cfg, minStopFraction: cfg.minStopFraction * 2 } })
  const t2 = runTrials(loaded, { params: PARAMS, sim: { ...SIM, liveFilters: other } })[0]
  assert.notEqual(t2.trialId, floor.trialId); assert.notEqual(simHash(t2.sim), simHash(floor.sim))
  // The fixture's long has an 80-wire stop on a 100,062 entry: under the 150 floor, so the filter refuses it.
  assert.equal(floor.summary.diagnostics.vetoes.stopFloor, 1)
  assert.equal(floor.rejected.vetoed.stopFloor, 1, 'withheld, the persisted counts are the scoped ones')
  assert.equal(floor.summary.diagnostics.countsAddUp, true)
})

test('PR-Q3 counter-trend end to end: the regimes AS OF the signal veto the against-trend side — in-thread and through the worker thread, which has no database', async () => {
  _resetTickResearchJobs()
  const { dir, file } = segmentDir()
  // A down reading withholds BUY: the fixture's long (seq 118, in train) is vetoed.
  const db = keeperDb({ trend: 'short' })
  const ctx = replayTrendContext(db, { files: [file] })
  assert.deepEqual(ctx.sides.demo, { 7: 'EURUSD' }); assert.equal(ctx.rows.EURUSD.length, 1); assert.equal(ctx.gateOn, true)
  const body = { stageA: false, params: PARAMS, sim: { ...SIM, liveFilters: { counterTrend: true } }, dryRun: true }
  const inline = tickResearchAction(db, body, { segmentsDir: dir })
  assert.equal(inline.status, 200)
  const d = inline.body.trials[0].summary.diagnostics
  assert.equal(d.vetoes.counterTrend, 1, 'RED if the reading never reaches the replay'); assert.equal(d.counterTrendNoReading, 0)
  const started = startTickResearchJob(db, body, { segmentsDir: dir })
  assert.equal(started.status, 202)
  const job = await waitJob(started.body.jobId)
  assert.equal(job.state, 'done', job.error || '')
  assert.equal(job.result.trials[0].summary.diagnostics.vetoes.counterTrend, 1, 'the worker judged the same veto from the rows it was handed')
  assert.equal(job.plan.sim.liveFilters.counterTrend.gateOn, true)
  assert.equal('trendContext' in job.plan, false, 'the regime rows ride the worker, not the job record')
  // Over every block (the owner's confirmation-run shape), an UP reading vetoes the short instead.
  const up = keeperDb({ trend: 'long' })
  const loaded = loadSegments([file])
  const upSim = researchPlan({ sim: { ...SIM, includeTest: true, liveFilters: { counterTrend: true } } }, replayFilterContext(up)).sim
  const [t] = runTrials(loaded, { params: PARAMS, sim: upSim, trendContext: replayTrendContext(up, { files: [file] }) })
  assert.deepEqual(t.parity.vetoes.map(v => [v.seq, v.side, v.filter]), [[284, 'SELL', 'counterTrend']])
  // 'firer' (the default): the book held the short the firer refused — in the book's record, flagged, not a trade.
  assert.deepEqual(t.parity.trades.map(x => [x.side, x.vetoedBy ?? null]), [['BUY', null], ['SELL', 'counterTrend']])
  assert.equal(t.summary.trades, 1); assert.equal(t.summary.diagnostics.vetoedTrades.byFilter.counterTrend.trades, 1)
  assert.equal(t.manifest.regimeInput.symbol, 'EURUSD'); assert.equal(t.manifest.regimeInput.rows, 1); assert.match(t.manifest.regimeInput.digest, /^[0-9a-f]{16}$/)
  // No regime context at all: refused, never a counter-trend filter that saw nothing.
  assert.throws(() => runTrials(loaded, { params: PARAMS, sim: upSim }), /no regime context/)
  // The regime rows are an input: different rows, a different trial.
  const [tDown] = runTrials(loaded, { params: PARAMS, sim: upSim, trendContext: replayTrendContext(db, { files: [file] }) })
  assert.notEqual(tDown.trialId, t.trialId)
  // Gate off: live grants both sides, so nothing is vetoed and every judged signal says it had no reading.
  const off = keeperDb({ trend: 'short', gate: { on: false } })
  const offSim = researchPlan({ sim: { ...SIM, includeTest: true, liveFilters: { counterTrend: true } } }, replayFilterContext(off)).sim
  const [tOff] = runTrials(loaded, { params: PARAMS, sim: offSim, trendContext: replayTrendContext(off, { files: [file] }) })
  assert.equal(tOff.summary.diagnostics.vetoes.counterTrend, 0); assert.equal(tOff.summary.diagnostics.counterTrendNoReading, 2)
  assert.equal(tOff.sim.liveFilters.counterTrend.gateOn, false); assert.equal(tOff.manifest.regimeInput.gateOn, false)
  // A symbol id outside the tick universe reads no regime, and the trial says why.
  const other = loadSegments([segmentDir({ symbolId: 99 }).file])
  const [tU] = runTrials(other, { params: PARAMS, sim: upSim, trendContext: replayTrendContext(up, { files: [file] }) })
  assert.equal(tU.manifest.regimeInput.symbol, null); assert.match(tU.manifest.regimeInput.note, /not in the tick universe/)
  assert.equal(tU.summary.diagnostics.vetoes.counterTrend, 0); assert.equal(tU.summary.diagnostics.counterTrendNoReading, 2)
  _resetTickResearchJobs()
})

test('PR-Q3: the worker\'s reading is direction-policy\'s trendReadingAt, row for row — gaps past the bound, ties on a stamp, before the first row, every gate shape', () => {
  const db = initDB(':memory:')
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD']))
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 7 }))
  const ins = db.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)')
  const dirs = ['long', 'short', 'flat', null]
  let k = 0
  for (let m = 0; m < 2 * 24 * 60; m += 37) {
    if (m > 20 * 60 && m < 26 * 60) continue // six hours with no row: past the 240-minute bound
    ins.run('EURUSD', 'trending', dirs[k++ % 4], fmt(T0 + m * 60_000))
  }
  ins.run('EURUSD', 'trending', 'long', fmt(T0 + 600 * 60_000))
  ins.run('EURUSD', 'trending', 'short', fmt(T0 + 600 * 60_000)) // a tie on a stamp: the later id wins
  const from = T0 - 3_600_000, to = T0 + 2 * 86_400_000
  const list = []
  for (let ms = from; ms < to; ms += 11 * 60_000 + 7_919) list.push({ seq: list.length + 1, recvMs: ms, bid: 1, ask: 2 })
  list.push({ seq: list.length + 1, recvMs: T0 + 600 * 60_000 + 500, bid: 1, ask: 2 })
  let compared = 0, withReading = 0
  for (const shape of [{ on: true, maxRegimeAgeMin: 240 }, { on: true, maxRegimeAgeMin: 30 }, { on: true, maxRegimeAgeMin: 0 }, { on: true }, { on: false }]) {
    setState(db, 'regime_gate_json', JSON.stringify(shape))
    const ctx = replayTrendContext(db, { files: [`seg-${from}-000001.tks`], gate: loadRegimeGateConfig(db), now: to })
    const st = symbolTrend(ctx, { environments: ['demo'] }, 7, list)
    for (const q of list) {
      const want = trendReadingAt(db, 'EURUSD', q.recvMs)
      assert.deepEqual(st.sidesAt(q.recvMs), want == null ? null : permittedSides(want), `${JSON.stringify(shape)} at ${new Date(q.recvMs).toISOString()}`)
      compared++; if (want != null) withReading++
    }
  }
  assert.ok(compared > 1000 && withReading > 300, `${compared} compared, ${withReading} with a reading — not vacuous`)
})

test('PR-Q3: the parity report names a book-model trial against an unfiltered shadow as a different population (sim_differs); a firer-model trial\'s book IS the shadow\'s, so it compares as an unfiltered one does', () => {
  const shadow = JSON.parse(readFileSync(TICK_SHADOW_SIM_FILE, 'utf8'))
  const plain = researchPlan({ sim: { ...shadow } }).sim
  const book = researchPlan({ sim: { ...shadow, liveFilters: { stopFloor: true, model: 'book' } } }).sim
  const firer = researchPlan({ sim: { ...shadow, liveFilters: { stopFloor: true } } }).sim
  const lfDiff = (cmp) => cmp.diffs.find(d => d.field === 'liveFilters') ?? null
  assert.equal(lfDiff(simComparison(plain, PARAMS, shadow)), null)
  assert.equal(lfDiff(simComparison(firer, PARAMS, shadow)), null, 'RED if the firer model is read as a different book')
  const f = simComparison(book, PARAMS, shadow)
  assert.deepEqual(lfDiff(f), { field: 'liveFilters', replay: book.liveFilters, shadow: null })
  // The same block on both sides, in any key order, is no difference.
  const reordered = Object.fromEntries(Object.entries(book.liveFilters).reverse())
  assert.equal(lfDiff(simComparison(book, PARAMS, { ...shadow, liveFilters: reordered })), null)
  // End to end on the planted fixture: the firer trial's parity record, refusals included,
  // is the unfiltered trial's trade for trade — what the shadow recorded.
  const loaded = loadSegments([segmentDir().file])
  const all = (sim) => runTrials(loaded, { params: PARAMS, sim: researchPlan({ sim: { ...SIM, includeTest: true, ...sim } }).sim })[0]
  const u = all({}), fr = all({ liveFilters: { stopFloor: true } })
  assert.ok(fr.parity.trades.some(x => x.vetoedBy === 'stopFloor'), 'the fixture\'s long is under the floor')
  assert.deepEqual(fr.parity.trades.map(x => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'vetoedBy'))), u.parity.trades)
})

test('PR-Q3: a filtered trial cannot pass the replay rung while the shadow runs no equal block — and an unfiltered trial\'s checks are exactly what they were', () => {
  const { file } = segmentDir()
  const loaded = loadSegments([file])
  const replay = loadThresholds().replay
  const trialOf = (liveFilters) => runTrials(loaded, { params: PARAMS, sim: researchPlan({ sim: { ...SIM, ...(liveFilters ? { liveFilters } : {}) } }).sim })[0]
  const plain = trialOf(null), filtered = trialOf({ stopFloor: true, priceBound: true })
  // Unfiltered: no fifth check at all — the same keys, verdicts and figures as before this PR.
  const p = replayChecks(plain, replay)
  assert.deepEqual(Object.keys(p.checks), ['trades', 'profitFactor', 'maxDrawdownR', 'testTrades', 'expectancyLowerR', 'costModel'])
  assert.deepEqual(replayChecks(plain, replay, { shadowFilters: filtered.sim.liveFilters }), p, 'the shadow\'s block is not even read for an unfiltered trial')
  // Filtered, against the repo's shadow sim (which carries no block): refused, and it says why.
  assert.equal(shadowLiveFilters(), null, 'agent/config/tick-shadow-sim.json runs no filters today')
  const f = replayChecks(filtered, replay)
  assert.equal(f.ok, false); assert.ok(f.failed.includes('liveFilters'), 'RED if a filtered trial can pass the rung')
  assert.deepEqual({ ok: f.checks.liveFilters.ok, shadow: f.checks.liveFilters.shadow }, { ok: false, shadow: null })
  // Even with every other check forced green, the filter check alone refuses.
  const green = { ...filtered, summary: { ...filtered.summary, trades: 999, profitFactor: 9, maxDrawdownR: 0 }, blocks: filtered.blocks.map(b => b.name === 'test' ? { ...b, withheld: false, trades: 99, expectancyLowerR: 5 } : b), sim: { ...filtered.sim, costSource: 'class', costClass: 'fx', ...loadRepoSchedule().classes.fx } }
  assert.deepEqual(replayChecks(green, replay).failed, ['liveFilters'])
  // The shadow running the SAME block (any key order) clears it; a different model does not.
  const same = Object.fromEntries(Object.entries(filtered.sim.liveFilters).reverse())
  assert.deepEqual(replayChecks(green, replay, { shadowFilters: same }).failed, [])
  assert.deepEqual(replayChecks(green, replay, { shadowFilters: { ...same, model: 'book' } }).failed, ['liveFilters'])
  // The research route's verdict carries it too.
  const out = replayFiles([file], { ...researchPlan({ params: PARAMS, sim: { ...SIM, liveFilters: { stopFloor: true } } }), stageA: false }, replay)
  assert.ok(out.trials[0].verdict.failed.includes('liveFilters'))
})

test('PR-Q3: a replay window older than the regimes the table still holds says its readings may be pruned — a filter that could not see is not read as one that found nothing', () => {
  const { file } = segmentDir()
  const loaded = loadSegments([file])
  const sim = researchPlan({ sim: { ...SIM, includeTest: true, liveFilters: { counterTrend: true } } }).sim
  // The regime row is 10 minutes before the data: inside the 240-minute bound, nothing pruned.
  const kept = keeperDb({ trend: 'short' })
  const ctx = replayTrendContext(kept, { files: [file] })
  assert.equal(ctx.retainedFrom, fmt(T0 - 10 * 60_000))
  assert.equal(runTrials(loaded, { params: PARAMS, sim, trendContext: ctx })[0].manifest.regimeInput.rowsMayBePruned, false)
  // The table's oldest row is AFTER the data began (the 30-day prune took the rest): said so.
  const pruned = keeperDb({ trend: null })
  pruned.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)').run('EURUSD', 'trending', 'short', fmt(T0 + 3_600_000))
  const t = runTrials(loaded, { params: PARAMS, sim, trendContext: replayTrendContext(pruned, { files: [file] }) })[0]
  assert.equal(t.manifest.regimeInput.rowsMayBePruned, true, 'RED if a pruned window reads as covered')
  // An empty table: nothing to say about pruning, and every judged signal had no reading.
  const empty = keeperDb({ trend: null })
  const te = runTrials(loaded, { params: PARAMS, sim, trendContext: replayTrendContext(empty, { files: [file] }) })[0]
  assert.equal(te.manifest.regimeInput.rowsMayBePruned, null); assert.equal(te.summary.diagnostics.vetoes.counterTrend, 0)
})

test('PR-Q3: the script beside the spool refuses the counter-trend filter (no regimes table there) and stamps the other three from the same config', () => {
  const { dir } = segmentDir()
  const run = (sim) => spawnSync(process.execPath, [join(ROOT, 'scripts/tick-research.mjs'), dir, '--params', JSON.stringify(PARAMS), '--sim', JSON.stringify(sim)], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 60_000 })
  const refused = run({ ...SIM, liveFilters: true })
  assert.equal(refused.status, 2, refused.stderr); assert.match(refused.stderr, /live_filters_no_regimes/)
  const valued = run({ ...SIM, liveFilters: { stopFloor: 0.002 } })
  assert.equal(valued.status, 2, valued.stderr); assert.match(valued.stderr, /live_filters_from_config/)
  const ok = run({ ...SIM, liveFilters: { stopFloor: true, priceBound: true, signalTtl: true } })
  assert.equal(ok.status, 0, ok.stderr)
  const out = JSON.parse(ok.stdout)
  const cfg = loadTickEntryConfig()
  assert.deepEqual(out.trials[0].sim.liveFilters, { version: 'live-filters-v1', model: 'firer', minStopFraction: cfg.minStopFraction, overshootFraction: cfg.overshootFraction, signalTtlMs: cfg.maxFireDelayMs, counterTrend: null, configSource: LIVE_FILTERS_CONFIG_SOURCE })
})
