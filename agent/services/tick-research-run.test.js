// agent/services/tick-research-run.test.js — PR-H: the stage-A replay
// research as an operator action. A tiny synthetic segment (the planted
// strategy fixture encoded in the recorder's own format) is replayed into
// the trial ledger with each trial's replay verdict; with no reachable
// segment the action refuses 409 no_segments and names where the data is —
// it never writes a trial it did not replay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDB } from '../db.js'
import { encodeHeader, encodeRecord, FLAGS, KIND } from '../lib/tick-segment.js'
import { buildFixture } from '../lib/tick-strategy.test.js'
import { simulate } from '../lib/tick-replay-sim.js'
import { tickResearchAction, listSegments, loadSegments, runTrials, stageAGrid, NO_SEGMENTS_WHERE } from './tick-research-run.js'
import { loadThresholds } from './tick-validation.js'

/** The planted fixture as one sealed segment for symbol `symbolId`. */
export function fixtureSegment({ symbolId = 7, gapAfter = null } = {}) {
  const parts = [encodeHeader({ environment: 'demo', generation: 1, startedMs: 1_757_548_800_000, feedId: 'fixture' })]
  for (const [i, ev] of buildFixture().entries()) {
    if (ev.changed === false) { parts.push(encodeRecord({ recvMs: ev.recvMs, seq: ev.seq, symbolId, flags: FLAGS.REPEAT, generation: 1 })); continue }
    let flags = 0
    if (ev.bid != null) flags |= FLAGS.BID_PRESENT | FLAGS.BID_CHANGED
    if (ev.ask != null) flags |= FLAGS.ASK_PRESENT | FLAGS.ASK_CHANGED
    if (ev.snapshot) flags |= FLAGS.SNAPSHOT
    if (ev.crossed) flags |= FLAGS.CROSSED
    parts.push(encodeRecord({ recvMs: ev.recvMs, seq: ev.seq, symbolId, bid: ev.bid == null ? undefined : ev.bid, ask: ev.ask == null ? undefined : ev.ask, flags, kind: KIND.QUOTE, generation: 1 }))
    if (gapAfter != null && i === gapAfter) parts.push(encodeRecord({ recvMs: ev.recvMs, seq: 0, symbolId: 0, bid: 1, ask: 3, kind: KIND.GAP, generation: 1 }))
  }
  return Buffer.concat(parts)
}
const PARAMS = { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }
const SIM = { latencyMs: 60, minTargetToCost: 1 }

test('a synthetic segment decodes to the same trades the oracle fixture yields, and the script\'s loader/grid are the route\'s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tick-seg-'))
  writeFileSync(join(dir, 'seg-000001.tks'), fixtureSegment())
  writeFileSync(join(dir, 'not-a-segment.txt'), 'x')
  const files = listSegments(dir)
  assert.deepEqual(files.map(f => f.split('/').pop()), ['seg-000001.tks'])
  const loaded = loadSegments(files)
  assert.deepEqual(loaded.manifestBase.symbols, [7]); assert.equal(loaded.manifestBase.torn, 0); assert.equal(loaded.manifestBase.decoderVersion, 1)
  assert.ok(loaded.manifestBase.events > 200, `events ${loaded.manifestBase.events}`)
  const direct = simulate(buildFixture(), PARAMS, SIM)
  const [t] = runTrials(loaded, { params: PARAMS, sim: SIM })
  assert.equal(t.summary.trades, direct.summary.trades, 'the segment path replays the same trades as the in-memory fixture')
  assert.equal(t.summary.trades, 2)
  assert.equal(t.profileHash, direct.profileHash); assert.equal(t.manifest.symbolId, 7); assert.match(t.trialId, /^[0-9a-f]{20}$/)
  assert.equal(t.blocks.find(b => b.name === 'test').withheld, true, 'plan §7: a research run withholds the test block')
  assert.equal(stageAGrid().length, 12)
  assert.deepEqual(stageAGrid()[0], { rangeEvents: 128, momentumEvents: 32, minEfficiency: 0.25 })
  // the script uses this module, not a copy of it
  const script = readFileSync(new URL('../../scripts/tick-research.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.match(script, /from '\.\.\/agent\/services\/tick-research-run\.js'/)
  assert.doesNotMatch(script, /readSegment\(/, 'no second decoder in the script')
})

test('with no reachable segment the action refuses 409 no_segments — unset, missing, empty, or files that decode to nothing — and writes no trial', () => {
  const db = initDB(':memory:')
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n
  for (const dir of [undefined, '', '   ', join(tmpdir(), 'does-not-exist-' + Date.now())]) {
    const r = tickResearchAction(db, { stageA: true }, { segmentsDir: dir })
    assert.equal(r.status, 409, String(dir)); assert.equal(r.body.error, 'no_segments'); assert.equal(r.body.where, NO_SEGMENTS_WHERE); assert.equal(r.body.ok, false)
  }
  const empty = mkdtempSync(join(tmpdir(), 'tick-seg-empty-'))
  writeFileSync(join(empty, 'README'), 'no segments here')
  const e = tickResearchAction(db, {}, { segmentsDir: empty })
  assert.equal(e.status, 409); assert.equal(e.body.error, 'no_segments'); assert.equal(e.body.segments, 0)
  // a file that is not a segment (bad magic) decodes to no event: still no_segments, never an empty trial
  const junk = mkdtempSync(join(tmpdir(), 'tick-seg-junk-'))
  writeFileSync(join(junk, 'seg-000001.tks'), Buffer.alloc(200))
  const j = tickResearchAction(db, {}, { segmentsDir: junk })
  assert.equal(j.status, 409); assert.equal(j.body.error, 'no_segments'); assert.equal(j.body.segments, 1); assert.match(j.body.where, /decoded to no valid quote event/)
  assert.equal(count(), 0, 'no trial written on any refusal')
  // the default reads the env var
  const saved = process.env.TICK_SEGMENTS_DIR
  try {
    delete process.env.TICK_SEGMENTS_DIR
    assert.equal(tickResearchAction(db, {}).status, 409)
  } finally { if (saved != null) process.env.TICK_SEGMENTS_DIR = saved }
})

test('over a segment directory the action replays the stage-A grid, imports each trial once with its replay verdict against the owner\'s thresholds, a dry run writes nothing, and the stage is untouched', () => {
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'tick-seg-run-'))
  writeFileSync(join(dir, 'seg-000001.tks'), fixtureSegment({ symbolId: 7 }))
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n
  // dry run: judged, nothing written
  const dry = tickResearchAction(db, { params: PARAMS, sim: SIM, stageA: false, dryRun: true }, { segmentsDir: dir })
  assert.equal(dry.status, 200); assert.equal(dry.body.dryRun, true); assert.equal(dry.body.trials.length, 1); assert.equal(count(), 0)
  assert.equal(dry.body.trials[0].replay.ok, false); assert.ok(dry.body.trials[0].replay.failed.includes('trades'), 'two trades are under the owner\'s 40')
  assert.deepEqual(dry.body.thresholds, loadThresholds().replay)
  // the real run: one trial per grid point (12) for the one symbol, each imported
  const r = tickResearchAction(db, { stageA: true, sim: SIM }, { segmentsDir: dir })
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300))
  assert.equal(r.body.trials.length, 12); assert.equal(r.body.inserted, 12); assert.equal(count(), 12)
  assert.equal(new Set(r.body.trialIds).size, 12); assert.ok(r.body.trials.every(t => t.imported && t.symbolId === 7 && t.replay && Array.isArray(t.replay.failed)))
  assert.deepEqual(r.body.passing, [], 'nothing on a 2-trade fixture clears 40 trades')
  // PR-L: symbol 7 is in no pushed cost map, so the trial is replayed
  // UNCHARGED and the replay rung refuses it on `costModel` — it is not
  // silently passed, and it is not silently emptied by the fallback's cost
  // screen either (the trades are still there to read).
  assert.ok(r.body.trials.every(t => t.replay.failed.includes('costModel')), 'an unclassified symbol cannot clear the replay rung')
  assert.equal(r.body.trials[0].replay.checks.costModel.observed, 'none')
  assert.deepEqual(r.body.manifest.files, ['seg-000001.tks'])
  const row = db.prepare('SELECT note, manifest_json FROM tick_trials WHERE trial_id = ?').get(r.body.trialIds[0])
  assert.match(row.note, /stage-A grid via POST \/actions\/tick-research/); assert.equal(JSON.parse(row.manifest_json).symbolId, 7)
  // the same segments again: content-keyed, nothing duplicated
  const again = tickResearchAction(db, { stageA: true, sim: SIM }, { segmentsDir: dir })
  assert.equal(again.body.inserted, 0); assert.equal(count(), 12)
  // an explicit single profile over one symbol filter
  const one = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, symbol: 7 }, { segmentsDir: dir })
  assert.equal(one.body.trials.length, 1); assert.equal(one.body.trials[0].summary.trades, 2); assert.equal(count(), 13)
  const none = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, symbol: 8 }, { segmentsDir: dir })
  assert.equal(none.status, 409, 'a symbol filter that matches nothing is no segments, not an empty trial')
  // no engine record was touched: the stage moves only through the validation importer
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE path = '/actions/tick-validation'`).get().n, 0)
})

// ---- checker findings, 11-09-2026 ------------------------------------------
import { performance } from 'node:perf_hooks'
import { startTickResearchJob, tickResearchJob, tickResearchJobsView, _resetTickResearchJobs, NOTE_MAX, MAX_RECORDS, segmentRecordCount } from './tick-research-run.js'

/** A synthetic segment: nQuotes changed quotes on `symbols` symbols, a REPEAT after each when repeatEvery is set. */
export function syntheticSegment(nQuotes, { repeatEvery = 0, symbols = 1 } = {}) {
  const parts = [encodeHeader({ environment: 'demo', generation: 1, startedMs: 1_757_548_800_000, feedId: 'perf' })]
  let seq = 1
  for (let i = 0; i < nQuotes; i++) {
    const sym = 1 + (i % symbols)
    const bid = 100000 + Math.round(Math.sin(i / 50) * 300 + (i % 7)), ask = bid + 10
    parts.push(encodeRecord({ recvMs: 1_757_548_800_000 + i * 100, seq: seq++, symbolId: sym, bid, ask, flags: FLAGS.BID_PRESENT | FLAGS.BID_CHANGED | FLAGS.ASK_PRESENT | FLAGS.ASK_CHANGED, kind: KIND.QUOTE, generation: 1 }))
    if (repeatEvery && i % repeatEvery === 0) parts.push(encodeRecord({ recvMs: 1_757_548_800_000 + i * 100 + 50, seq: seq++, symbolId: sym, flags: FLAGS.REPEAT, generation: 1 }))
  }
  return Buffer.concat(parts)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitDone(id, { maxMs = 60_000 } = {}) {
  const t0 = Date.now()
  for (;;) { const j = tickResearchJob(id); if (j && j.state !== 'running') return j; if (Date.now() - t0 > maxMs) throw new Error('job did not finish'); await sleep(25) }
}

test('M-2: repeats are O(1) — 50k quotes + 50k repeats load well under a second, and every repeat carries the sides of the nearest earlier two-sided quote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tick-seg-perf-'))
  const f = join(dir, 'seg-000001.tks')
  writeFileSync(f, syntheticSegment(50_000, { repeatEvery: 1, symbols: 2 }))
  const t0 = performance.now()
  const loaded = loadSegments([f])
  const ms = performance.now() - t0
  assert.ok(ms < 1500, `loadSegments took ${ms.toFixed(0)} ms (quadratic before: 9.3 s on 40k + 40k)`)
  assert.equal(loaded.manifestBase.events, 50_000)
  let repeats = 0
  for (const list of loaded.bySymbol.values()) {
    let prev = null
    for (const q of list) {
      if (q.changed === false) { repeats++; assert.ok(prev, 'a repeat before any quote is dropped, never pushed'); assert.equal(q.bid, prev.bid); assert.equal(q.ask, prev.ask) }
      else if (q.bid != null && q.ask != null) prev = q
    }
  }
  assert.equal(repeats, 50_000)
})

test('m-3: body.note is stored capped at NOTE_MAX characters and the reply says it was truncated', () => {
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'tick-seg-note-'))
  writeFileSync(join(dir, 'seg-000001.tks'), fixtureSegment())
  const r = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, note: 'n'.repeat(5000) }, { segmentsDir: dir })
  assert.equal(r.status, 200); assert.equal(r.body.noteTruncated, true); assert.equal(r.body.noteStored.length, NOTE_MAX)
  assert.equal(db.prepare('SELECT length(note) AS n FROM tick_trials').get().n, NOTE_MAX)
  const ok = tickResearchAction(db, { stageA: false, params: { ...PARAMS, rangeEvents: 65 }, sim: SIM, note: 'short' }, { segmentsDir: dir })
  assert.equal(ok.body.noteTruncated, false); assert.equal('noteStored' in ok.body, false)
})

test('M-1: the record cap refuses 413 too_many_records from file sizes alone, before any decode, on the action and on the job', () => {
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'tick-seg-cap-'))
  writeFileSync(join(dir, 'seg-000001.tks'), fixtureSegment())
  const n = segmentRecordCount(listSegments(dir))
  assert.ok(n > 100 && n < 1000, `fixture records ${n}`)
  assert.equal(MAX_RECORDS, 5_000_000)
  const r = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM }, { segmentsDir: dir, maxRecords: n - 1 })
  assert.equal(r.status, 413); assert.equal(r.body.error, 'too_many_records'); assert.equal(r.body.records, n); assert.equal(r.body.maxRecords, n - 1); assert.match(r.body.where, /exceed the keeper's cap/)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tick_trials').get().c, 0)
  _resetTickResearchJobs()
  const j = startTickResearchJob(db, { stageA: false, params: PARAMS, sim: SIM }, { segmentsDir: dir, maxRecords: n - 1 })
  assert.equal(j.status, 413); assert.equal(tickResearchJobsView().running, null)
  assert.equal(tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM }, { segmentsDir: dir, maxRecords: n }).status, 200, 'at the cap: admitted')
})

test('M-1: the job runs in a worker — 202 with a job id, the event loop stays free while it runs, a second POST is 409 research_running, the result and the imported trials land when it is done; an unknown id is null; no_segments refuses before any worker starts', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'tick-seg-job-'))
  writeFileSync(join(dir, 'seg-000001.tks'), syntheticSegment(300_000))
  assert.equal(startTickResearchJob(db, {}, { segmentsDir: '' }).status, 409)
  assert.equal(tickResearchJobsView().running, null, 'a refusal starts no worker')
  const started = startTickResearchJob(db, { stageA: false, params: PARAMS, sim: SIM, note: 'job' }, { segmentsDir: dir })
  assert.equal(started.status, 202, JSON.stringify(started.body)); assert.equal(started.body.state, 'running'); assert.match(started.body.poll, new RegExp(started.body.jobId))
  const second = startTickResearchJob(db, { stageA: false, params: PARAMS, sim: SIM }, { segmentsDir: dir })
  assert.equal(second.status, 409); assert.equal(second.body.error, 'research_running'); assert.equal(second.body.jobId, started.body.jobId)
  // the event loop: a timer set for 5 ms fires within 100 ms while the worker replays 300k quotes
  const t0 = performance.now(); await sleep(5); const lag = performance.now() - t0
  assert.ok(lag < 100, `event loop lag ${lag.toFixed(0)} ms while the job runs`)
  assert.equal(tickResearchJob(started.body.jobId).state, 'running')
  assert.equal(tickResearchJob('nope'), null)
  const done = await waitDone(started.body.jobId)
  assert.equal(done.state, 'done', JSON.stringify(done).slice(0, 300)); assert.ok(done.finishedAt)
  assert.equal(done.result.ok, true); assert.equal(done.result.trials.length, 1); assert.equal(done.result.inserted, 1)
  assert.equal(done.result.manifest.events, 300_000)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tick_trials').get().c, 1)
  assert.equal(db.prepare('SELECT note FROM tick_trials').get().note, 'job')
  assert.equal(tickResearchJobsView().running, null); assert.equal(tickResearchJobsView().jobs[0].jobId, started.body.jobId)
  assert.equal('worker' in done, false, 'the worker handle never leaves the module')
  // a job over files that decode to nothing fails with no_segments, writing nothing
  const junk = mkdtempSync(join(tmpdir(), 'tick-seg-jobjunk-'))
  writeFileSync(join(junk, 'seg-000001.tks'), Buffer.alloc(4000))
  const jj = startTickResearchJob(db, {}, { segmentsDir: junk })
  assert.equal(jj.status, 202)
  const jd = await waitDone(jj.body.jobId)
  assert.equal(jd.state, 'failed'); assert.equal(jd.error, 'no_segments'); assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tick_trials').get().c, 1)
  // a worker that cannot start (bad file) is a 500, and the lock is not held
  const bad = startTickResearchJob(db, {}, { segmentsDir: dir, workerFile: new URL('./does-not-exist-worker.js', import.meta.url) })
  if (bad.status === 202) { const bj = await waitDone(bad.body.jobId); assert.equal(bj.state, 'failed') } else assert.equal(bad.status, 500)
  assert.equal(tickResearchJobsView().running, null)
})

// CHECKER, on §16.7: `researchPlan` defaulted `sim` to {} — zero cost — so
// REPLAY_PASSED could be cleared free while SHADOW_PASSED is charged. Both
// rungs of the evidence ladder were free. The schedule now rides the plan and
// the class is resolved per symbol id from the map the keeper pushed.
test('PR-L: a replay trial is charged the repo schedule by the keeper\'s symbol map, and records what it was charged', async () => {
  const { researchPlan, replayCostContext } = await import('./tick-research-run.js')
  const { TICK_COST_MAP_KEY, loadRepoSchedule, scheduleHash } = await import('../lib/tick-cost-schedule.js')
  const { setState: put } = await import('../db.js')
  const mk = initDB
  const db = mk(':memory:')
  // no map pushed yet: the schedule is there, the symbol map is empty
  const bare = researchPlan({}, replayCostContext(db))
  assert.equal(scheduleHash(bare.sim.costs), scheduleHash(loadRepoSchedule()), 'the repo schedule defaults in')
  assert.deepEqual(bare.symbolClass, {}, 'and no symbol is classified until the keeper pushes a map')

  // the keeper's map, across both sides, unioned
  put(db, TICK_COST_MAP_KEY, JSON.stringify({
    cpp_exec_demo: { symbolClass: { 7: 'fx', 9: 'stock_us' } },
    cpp_exec: { symbolClass: { 11: 'crypto' } },
  }))
  const plan = researchPlan({}, replayCostContext(db))
  assert.deepEqual(plan.symbolClass, { 7: 'fx', 9: 'stock_us', 11: 'crypto' })

  // and a trial over a classified symbol is CHARGED and says so
  const dir = mkdtempSync(join(tmpdir(), 'tick-cost-'))
  writeFileSync(join(dir, 'seg-000001.tks'), fixtureSegment())
  const r = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, symbol: 7 }, { segmentsDir: dir })
  const t = r.body.trials[0]
  assert.equal(t.symbolId, 7)
  assert.equal(r.body.trials.length, 1)
  const stored = db.prepare('SELECT sim_json FROM tick_trials WHERE trial_id = ?').get(t.trialId)
  const sim = JSON.parse(stored.sim_json)
  assert.equal(sim.costClass, 'fx', 'the trial records the class it was charged')
  assert.equal(sim.costSource, 'class')
  assert.equal(sim.commissionBpsPerSide, 0.35)
  assert.equal(t.replay.checks.costModel.ok, true, 'a charged, classified trial clears the cost rung')
  assert.ok(!t.replay.failed.includes('costModel'))
})

// ---- PR-EX, 20-09-2026: the operator's `maxSegments` bound ------------------
// Measured on production that morning: POST /actions/tick-research answered
// 413 too_many_records — 4 sealed segments, 6,710,880 records against the
// 5,000,000 cap — and told the operator to "copy a subset to
// TICK_SEGMENTS_DIR", which is not reachable: the segments are on a volume
// the keeper only reads through GET /tick-segment. The replay rung was
// therefore unreachable on this deployment. These tests pin the bound that
// opens it: the OLDEST n, the cap applied after the slice, and a refusal that
// names the remedy and the number that actually fits.
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { startTickResearchJobWithSync, maxSegmentsFrom, segmentsThatFit, researchPlan as researchPlanImpl } from './tick-research-run.js'

/** Four sealed segments, chronological by name, `records` records each. */
function fourSegments(records = 400) {
  const dir = mkdtempSync(join(tmpdir(), 'tick-seg-four-'))
  const names = []
  for (let i = 0; i < 4; i++) {
    const name = `seg-175754880${i}000-00000${i + 1}.tks`
    writeFileSync(join(dir, name), syntheticSegment(records))
    names.push(name)
  }
  return { dir, names }
}

test('PR-EX: maxSegments replays the OLDEST n and says how many it left — the cap is applied to the slice, so a directory over the cap runs when the slice fits', () => {
  const db = initDB(':memory:')
  const { dir, names } = fourSegments(400)
  assert.equal(segmentRecordCount(listSegments(dir)), 1600)
  // the production shape: everything is over the cap, two of them are not
  const all = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, dryRun: true }, { segmentsDir: dir, maxRecords: 1000 })
  assert.equal(all.status, 413, 'unbounded, the whole spool is over the cap')
  const r = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, dryRun: true, maxSegments: 2 }, { segmentsDir: dir, maxRecords: 1000 })
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300))
  assert.deepEqual(r.body.manifest.files, names.slice(0, 2), 'the two OLDEST, which is the end the sync pulls')
  assert.equal(r.body.maxSegments, 2)
  assert.equal(r.body.segments, 2)
  assert.equal(r.body.segmentsAvailable, 4)
  assert.equal(r.body.segmentsDropped, 2)
})

test('PR-EX: still over the cap after slicing is 413, and the where names maxSegments and the number that fits — computed from the sizes, never assumed', () => {
  const db = initDB(':memory:')
  const { dir } = fourSegments(400)
  const r = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, maxSegments: 3 }, { segmentsDir: dir, maxRecords: 1000 })
  assert.equal(r.status, 413); assert.equal(r.body.error, 'too_many_records')
  assert.equal(r.body.records, 1200); assert.equal(r.body.segments, 3); assert.equal(r.body.segmentsAvailable, 4); assert.equal(r.body.segmentsDropped, 1)
  assert.equal(r.body.segmentsThatFit, 2, '2 × 400 fits under 1000, 3 × 400 does not')
  assert.match(r.body.where, /maxSegments/); assert.match(r.body.where, /"maxSegments": 2/)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tick_trials').get().c, 0)
  // and the number is measured: a cap that admits three says three
  const three = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, maxSegments: 4 }, { segmentsDir: dir, maxRecords: 1400 })
  assert.equal(three.body.segmentsThatFit, 3)
  assert.equal(segmentsThatFit([400, 400, 400, 400], 1000), 2)
  assert.equal(segmentsThatFit([2000], 1000), 0, 'nothing fits is 0, not 1')
  // Checker, 20-09-2026: mutation `>` → `>=` SURVIVED — neither case above
  // discriminates the boundary. `admit` admits at the cap (`records >
  // maxRecords` refuses), so a slice that lands exactly ON the cap must be
  // offered, or the number the operator is told to type replays one segment
  // less than it could and, worse, the two halves of the same rule disagree.
  assert.equal(segmentsThatFit([500, 500], 1000), 2, 'EXACTLY at the cap fits — RED if the boundary is >=')
  assert.equal(segmentsThatFit([500, 501], 1000), 1)
  assert.equal(segmentsThatFit([1000], 1000), 1, 'one segment exactly at the cap fits')
})

test('PR-EX: an invalid maxSegments is REFUSED 400 bad_max_segments naming the value — never coerced to "replay everything"', () => {
  const db = initDB(':memory:')
  const { dir } = fourSegments(100)
  for (const bad of [0, -1, 1.5, 'two', true, {}]) {
    for (const call of [
      () => tickResearchAction(db, { maxSegments: bad }, { segmentsDir: dir }),
      () => startTickResearchJob(db, { maxSegments: bad }, { segmentsDir: dir }),
    ]) {
      const r = call()
      assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.status}`)
      assert.equal(r.body.error, 'bad_max_segments')
      assert.equal(r.body.ok, false)
      assert.deepEqual(r.body.maxSegments, bad)
      assert.match(r.body.where, /whole number >= 1/)
    }
  }
  assert.equal(tickResearchJobsView().running, null, 'a refusal starts no worker')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tick_trials').get().c, 0)
  // the plan carries the bound only when it is valid, and null when absent
  assert.equal(researchPlanImpl({}, {}).maxSegments, null)
  assert.equal(researchPlanImpl({ maxSegments: 3 }, {}).maxSegments, 3)
  assert.deepEqual(maxSegmentsFrom({}), { value: null })
})

test('PR-EX: maxSegments ABSENT is the unbounded path unchanged — same listing, same replay set, same refusal', () => {
  const db = initDB(':memory:')
  const { dir, names } = fourSegments(400)
  const r = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, dryRun: true }, { segmentsDir: dir, maxRecords: 5000 })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.manifest.files, names, 'every segment replayed')
  assert.equal(r.body.maxSegments, null); assert.equal(r.body.segmentsDropped, 0); assert.equal(r.body.segmentsAvailable, 4)
  const over = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM }, { segmentsDir: dir, maxRecords: 1000 })
  assert.equal(over.status, 413); assert.equal(over.body.records, 1600); assert.equal(over.body.segments, 4); assert.equal(over.body.maxSegments, null)
  assert.match(over.body.where, /exceed the keeper's cap/)
})

test('PR-EX: with maxSegments set the sidecar pre-flight does NOT refuse from the aggregate — the bound is passed to the sync and the cap is applied to what arrived', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const { dir: source, names } = fourSegments(400)
  const empty = mkdtempSync(join(tmpdir(), 'tick-seg-none-'))
  const listed = { segments: 4, bytes: 0, records: 1600, truncated: false, reachable: 1, names, recordsPerSegment: [400, 400, 400, 400], sides: [] }
  const run = async (body, dest) => {
    const calls = []
    const r = await startTickResearchJobWithSync(db, body, {
      segmentsDir: empty, cacheDir: dest, maxRecords: 1000,
      listAll: async () => listed,
      sync: async (d, o) => {
        calls.push(o)
        mkdirSync(d, { recursive: true })
        for (const n of names.slice(0, o.maxSegments ?? names.length)) copyFileSync(join(source, n), join(d, n))
        return { destDir: d, pulled: Math.min(o.maxSegments ?? names.length, names.length), skipped: 0, bytes: 0, truncated: true, sides: [] }
      },
    })
    return { r, calls }
  }
  // unbounded: the aggregate refuses before a byte moves — unchanged
  const un = await run({ stageA: false, params: PARAMS, sim: SIM, dryRun: true }, mkdtempSync(join(tmpdir(), 'tick-cache-a-')))
  assert.equal(un.r.status, 413); assert.equal(un.calls.length, 0, 'nothing pulled on the unbounded refusal')
  assert.equal(un.r.body.segmentsThatFit, 2)
  assert.match(un.r.body.where, /"maxSegments": 2/)
  // bounded: no aggregate refusal, the bound reaches the sync, the job starts
  const dest = mkdtempSync(join(tmpdir(), 'tick-cache-b-'))
  const b = await run({ stageA: false, params: PARAMS, sim: SIM, dryRun: true, maxSegments: 2 }, dest)
  assert.equal(b.calls.length, 1, 'the sync ran')
  assert.equal(b.calls[0].maxSegments, 2, 'RED if the bound is not passed to the sync: the whole spool is pulled')
  assert.equal(b.r.status, 202, JSON.stringify(b.r.body).slice(0, 300))
  assert.equal(b.r.body.maxSegments, 2); assert.equal(b.r.body.segments, 2); assert.equal(b.r.body.records, 800)
  const done = await waitDone(b.r.body.jobId)
  assert.equal(done.state, 'done', JSON.stringify(done).slice(0, 300))
  assert.deepEqual(done.result.manifest.files, names.slice(0, 2), 'the trial manifest names the segments that were replayed')
  assert.equal(done.maxSegments, 2)
  // Checker, 20-09-2026: these two used to read 2 and 0 — "I saw everything
  // there was" — because `admit` counts the CACHE and on this path the cache
  // holds exactly what the bound pulled. Seconds after a 413 that said
  // `segments: 4`. The listing is the authority on how much there is.
  assert.equal(done.segmentsAvailable, 4, 'from the sidecar LISTING, not the cache the bound filled')
  assert.equal(done.segmentsDropped, 2)
  assert.equal(b.r.body.segmentsAvailable, 4, 'the 202 says the same as the finished job')
  assert.equal(b.r.body.segmentsDropped, 2)
  assert.equal(done.plan.maxSegments, 2)
  // ... and the cold cache and the warm cache tell the SAME story: the same
  // POST answered `4 / 2` locally and `2 / 0` through the sync before this.
  const warm = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, dryRun: true, maxSegments: 2 }, { segmentsDir: source, maxRecords: 1000 })
  assert.equal(warm.body.segmentsAvailable, 4); assert.equal(warm.body.segmentsDropped, 2)
  assert.equal(warm.body.segmentsAvailable, done.segmentsAvailable, 'cold cache and warm cache agree')
  _resetTickResearchJobs()
})

test('PR-EX: a BOUNDED request whose slice is still over the cap is refused from the LISTING too — not 192 MiB pulled and then 413', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const { dir: source, names } = fourSegments(400)
  const empty = mkdtempSync(join(tmpdir(), 'tick-seg-none2-'))
  const dest = mkdtempSync(join(tmpdir(), 'tick-cache-c-'))
  const listed = { segments: 4, bytes: 0, records: 1600, truncated: false, reachable: 1, names, recordsPerSegment: [400, 400, 400, 400], sides: [] }
  const calls = []
  // the production shape: the refusal named 2, the operator typed 3.
  // 3 × 400 = 1200 is over the 1000 cap, so nothing may move.
  const r = await startTickResearchJobWithSync(db, { stageA: false, params: PARAMS, sim: SIM, maxSegments: 3 }, {
    segmentsDir: empty, cacheDir: dest, maxRecords: 1000,
    listAll: async () => listed,
    sync: async (d, o) => { calls.push(o); for (const n of names) copyFileSync(join(source, n), join(d, n)); return { destDir: d, pulled: names.length, skipped: 0, bytes: 0, truncated: false, sides: [] } },
  })
  assert.equal(r.status, 413); assert.equal(r.body.error, 'too_many_records')
  assert.equal(calls.length, 0, 'RED if a bounded request skips the pre-flight: the bytes move and THEN it 413s')
  assert.deepEqual(readdirSync(dest), [], 'not one byte on disk')
  assert.equal(r.body.records, 1200, 'the records the BOUND asked for, not the whole listing')
  assert.equal(r.body.maxSegments, 3); assert.equal(r.body.segmentsThatFit, 2)
  assert.match(r.body.where, /maxSegments 3/); assert.match(r.body.where, /"maxSegments": 2/)
  assert.equal(r.body.sync.pulled, 0)
  _resetTickResearchJobs()
})

test('PR-EX: the persisted trial records that it was BOUNDED — the row, not just the transient job, says 2 of 4', () => {
  const db = initDB(':memory:')
  const { dir, names } = fourSegments(400)
  const r = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, maxSegments: 2 }, { segmentsDir: dir, maxRecords: 1000, segmentsAvailable: 4 })
  assert.equal(r.status, 200)
  const row = db.prepare('SELECT manifest_json, note FROM tick_trials WHERE trial_id = ?').get(r.body.trialIds[0])
  const m = JSON.parse(row.manifest_json)
  assert.deepEqual(m.files, names.slice(0, 2))
  assert.equal(m.maxSegments, 2, 'RED if the bound dies at the persistence boundary')
  assert.equal(m.segmentsAvailable, 4); assert.equal(m.segmentsDropped, 2)
  assert.match(row.note, /maxSegments 2: 2 of 4 segment\(s\), oldest first/)
  // an UNBOUNDED run persists the manifest it always did — no null fields,
  // so no existing trial is re-keyed by this change
  const all = tickResearchAction(db, { stageA: false, params: { ...PARAMS, rangeEvents: 65 }, sim: SIM }, { segmentsDir: dir, maxRecords: 5000 })
  const um = JSON.parse(db.prepare('SELECT manifest_json FROM tick_trials WHERE trial_id = ?').get(all.body.trialIds[0]).manifest_json)
  assert.equal('maxSegments' in um, false); assert.equal('segmentsDropped' in um, false)
  // two different subsets of the same spool are different trials
  const four = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, maxSegments: 4 }, { segmentsDir: dir, maxRecords: 5000 })
  assert.notEqual(four.body.trialIds[0], r.body.trialIds[0], 'the bound rides into trialIdFor')
})

test('PR-EX: the script takes --max-segments through the same validator, and a flag with NO VALUE is refused rather than read as "replay everything"', () => {
  const { dir, names } = fourSegments(400)
  const script = new URL('../../scripts/tick-research.mjs', import.meta.url).pathname
  const run = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [script, dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, stdout }
    } catch (err) { return { code: err.status, stderr: String(err.stderr) } }
  }
  // Checker, 20-09-2026: `opt()` returns args[i+1], so a TRAILING flag gave
  // undefined and the script replayed the whole directory with no stderr line
  // and exit 0 — the operator who mistypes gets exactly the full run they
  // were trying to avoid.
  const trailing = run(['--max-segments'])
  assert.equal(trailing.code, 2, 'RED if a valueless flag is read as absent')
  assert.match(trailing.stderr, /--max-segments needs a value/)
  const swallowed = run(['--max-segments', '--stage-a'])
  assert.equal(swallowed.code, 2, 'the next flag is not the value')
  for (const bad of ['0', '-1', '1.5', 'two']) {
    const r = run(['--max-segments', bad])
    assert.equal(r.code, 2, `--max-segments ${bad}`)
    assert.match(r.stderr, /bad_max_segments/)
  }
  const ok = run(['--max-segments', '2', '--params', '{"rangeEvents":64,"momentumEvents":16,"maxSpread":200}'])
  assert.equal(ok.code, 0)
  const out = JSON.parse(ok.stdout)
  assert.deepEqual(out.trials[0].manifest.files, names.slice(0, 2), 'the two OLDEST, the same slice the route takes')
  const unbounded = run(['--params', '{"rangeEvents":64,"momentumEvents":16,"maxSpread":200}'])
  assert.deepEqual(JSON.parse(unbounded.stdout).trials[0].manifest.files, names)
})

// Checker, 20-09-2026 (second round): the fix that put the bound on the
// manifest reached the ROUTE only. The script called loadSegments +
// runTrials directly, so a trial made by `--max-segments 2` was
// indistinguishable from an unbounded run, and the same evidence
// content-keyed differently depending on which door produced it — measured
// 932c7a86ea1c82effd67 (route) against 088c4dff91b8292437fa (script) over
// the same slice and settings. Both 413 texts recommend the script, so this
// is the door the operator is sent to. One path now: the script calls
// `replayFiles`, the same function the route and the worker call.
test('PR-EX: the script and the route are ONE path — same slice, same settings, same manifest and the SAME trial id', () => {
  const db = initDB(':memory:')
  const { dir, names } = fourSegments(400)
  const script = new URL('../../scripts/tick-research.mjs', import.meta.url).pathname
  const sim = JSON.stringify(SIM), params = JSON.stringify(PARAMS)
  const runScript = (args) => JSON.parse(execFileSync(process.execPath, [script, dir, '--params', params, '--sim', sim, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))

  const s2 = runScript(['--max-segments', '2']).trials[0]
  assert.deepEqual(s2.manifest.files, names.slice(0, 2))
  assert.equal(s2.manifest.maxSegments, 2, 'RED if the script does not go through replayFiles: the bound is not on the manifest')
  assert.equal(s2.manifest.segmentsAvailable, 4)
  assert.equal(s2.manifest.segmentsDropped, 2)

  const r2 = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, maxSegments: 2, dryRun: true }, { segmentsDir: dir, maxRecords: 5000, segmentsAvailable: 4 })
  assert.equal(r2.status, 200)
  assert.equal(s2.trialId, r2.body.trialIds[0], 'the two doors content-key the same evidence the same way')

  // and unbounded, on both doors, is still the manifest it always was
  const sAll = runScript([]).trials[0]
  const rAll = tickResearchAction(db, { stageA: false, params: PARAMS, sim: SIM, dryRun: true }, { segmentsDir: dir, maxRecords: 5000 })
  assert.equal('maxSegments' in sAll.manifest, false)
  assert.equal(sAll.trialId, rAll.body.trialIds[0])
  assert.notEqual(sAll.trialId, s2.trialId, 'a bounded run is not the same trial as an unbounded one')
})

// Checker, 20-09-2026 (second round): `segmentsFailed` was on the 202 only,
// so an operator who posts and then polls never learns that a segment could
// not be pulled — and a failed OLDEST segment otherwise looks exactly like a
// clean bounded run.
test('PR-EX: a segment that FAILED to pull is named on the polled job, not only on the 202', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const { dir: source, names } = fourSegments(400)
  const empty = mkdtempSync(join(tmpdir(), 'tick-seg-none3-'))
  const dest = mkdtempSync(join(tmpdir(), 'tick-cache-fail-'))
  const listed = { segments: 4, bytes: 0, records: 1600, truncated: false, reachable: 1, names, recordsPerSegment: [400, 400, 400, 400], sides: [] }
  const r = await startTickResearchJobWithSync(db, { stageA: false, params: PARAMS, sim: SIM, dryRun: true, maxSegments: 2 }, {
    segmentsDir: empty, cacheDir: dest, maxRecords: 1000,
    listAll: async () => listed,
    // the OLDEST fails; the second arrives
    sync: async (d) => {
      mkdirSync(d, { recursive: true })
      copyFileSync(join(source, names[1]), join(d, names[1]))
      return { destDir: d, pulled: 1, skipped: 0, bytes: 0, truncated: false, failed: [{ name: names[0], error: 'chunk_checksum' }], sides: [{ side: 'one', failed: [{ name: names[0], error: 'chunk_checksum' }] }] }
    },
  })
  assert.equal(r.status, 202, JSON.stringify(r.body).slice(0, 300))
  assert.deepEqual(r.body.segmentsFailed, [names[0]], 'named once, though the sync reports it per side and in the whole')
  const job = tickResearchJob(r.body.jobId)
  assert.ok(job.segmentsFailed?.includes(names[0]), 'RED if the failed names live only on the transient 202')
  assert.match(job.segmentsFailedNote, /could not be pulled and are NOT in this replay/)
  // and the replay really did run on the one that arrived
  const done = await waitDone(r.body.jobId)
  assert.equal(done.state, 'done', JSON.stringify(done).slice(0, 300))
  assert.deepEqual(done.result.manifest.files, [names[1]])
  assert.ok(done.segmentsFailed.includes(names[0]), 'the finished job still says it')
  _resetTickResearchJobs()
})
