// Claude · № 13,571 12-Oct (W6, owner "Raise the cap (code change)";
// claude-builder). The streamed replay must be the in-memory replay, trial
// for trial, with one symbol's stream in memory at a time; what it leaves on
// disk goes when the job settles; an abort is named; clearCache empties only
// a temporary cache.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync as makeTempDir, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { encodeHeader, encodeRecord, FLAGS, KIND } from '../lib/tick-segment.js'
import { loadSegments, walkSegments, replayFiles, runTrials, stageAGrid, startTickResearchJob, startTickResearchJobWithSync, abortTickResearchJob, tickResearchJob, _resetTickResearchJobs, clearCacheFrom, MAX_RECORDS, IN_MEMORY_MAX_RECORDS, MAX_SYMBOL_EVENTS, WORKER_HEAP_MB } from './tick-research-run.js'
import { createSpill, SPILL_ENTRY_BYTES } from './tick-replay-spill.js'
import { isTemporaryCache, clearSegmentCache } from './tick-segments.js'
import { loadThresholds } from './tick-validation.js'

const temporaryDirectories = new Set()
const mkdtempSync = (...args) => { const d = makeTempDir(...args); temporaryDirectories.add(d); return d }
after(() => { for (const d of temporaryDirectories) rmSync(d, { recursive: true, force: true }) })

const T0 = 1_757_548_800_000
const QUOTE = FLAGS.BID_PRESENT | FLAGS.BID_CHANGED | FLAGS.ASK_PRESENT | FLAGS.ASK_CHANGED
const GAP = (reason, recvMs) => encodeRecord({ recvMs, seq: 0, symbolId: 0, bid: 1, ask: reason, kind: KIND.GAP, generation: 1 })

/**
 * Two segments over three symbols with every kind of entry the walker
 * handles: two-sided quotes, repeats, one-sided quotes, snapshots, crossed
 * quotes, a continuity gap (reconnect, 3) and a recorder-only gap
 * (queue_overflow, 1) — a trend on symbol 11 so the oracle trades.
 */
function richSegments(dir, n = 6000, base = 100_000, encoded = null) {
  const names = []
  let seq = 1
  for (let s = 0; s < 2; s++) {
    const parts = [encodeHeader({ environment: 'demo', generation: 1, startedMs: T0 + s * 1e7, feedId: 'spill' })]
    for (let i = 0; i < n; i++) {
      const t = T0 + s * 1e7 + i * 100
      const sym = [11, 11, 12, 13][i % 4]
      const drift = sym === 11 ? Math.floor(i / 3) * 3 : 0
      const bid = base + drift + Math.round(Math.sin(i / (sym === 12 ? 40 : 90)) * 400) + (i % 5)
      const ask = bid + 8 + (i % 3)
      let flags = QUOTE
      let b = bid, a = ask
      if (i % 997 === 5) { flags = FLAGS.BID_PRESENT | FLAGS.BID_CHANGED; a = undefined }
      if (i % 1499 === 7) flags |= FLAGS.SNAPSHOT
      if (i % 1777 === 9) { flags |= FLAGS.CROSSED; b = ask + 2; a = ask }
      parts.push(encodeRecord({ recvMs: t, seq: seq++, symbolId: sym, bid: b, ask: a, flags, kind: KIND.QUOTE, generation: 1 }))
      if (encoded) encoded.push({ sym, bid: b, ask: a ?? null })
      if (i % 11 === 0) parts.push(encodeRecord({ recvMs: t + 50, seq: seq++, symbolId: sym, flags: FLAGS.REPEAT, generation: 1 }))
      if (i === 1500 + s) parts.push(GAP(3, t + 60))
      if (i === 3000) parts.push(GAP(1, t + 60))
    }
    const name = `seg-${T0 + s * 1e7}-00000${s + 1}.tks`
    writeFileSync(join(dir, name), Buffer.concat(parts))
    names.push(name)
  }
  return names.map(nm => join(dir, nm))
}

const PLAN = { stageA: false, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, sim: { latencyMs: 60, minTargetToCost: 1, includeTest: true }, onlySymbol: null, maxSegments: null }

test('the spill hands back each symbol\'s stream exactly as loadSegments builds it — same entries, same values, same key order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-eq-'))
  const files = richSegments(dir)
  const mem = loadSegments(files)
  const spillDir = mkdtempSync(join(tmpdir(), 'spill-store-'))
  const spill = createSpill(spillDir)
  const base = walkSegments(files, spill)
  spill.close()
  assert.deepEqual(base, mem.manifestBase, 'the same manifest, digests and gaps included')
  assert.deepEqual(spill.symbols(), [...mem.bySymbol.keys()], 'first-seen order')
  assert.ok(mem.manifestBase.warmupResets >= 2, 'the fixture carries continuity gaps')
  assert.ok(mem.manifestBase.gapsByReason.queue_overflow >= 1, 'and a recorder-only gap')
  let markers = 0, repeats = 0, oneSided = 0
  for (const id of spill.symbols()) {
    const want = mem.bySymbol.get(id)
    assert.equal(spill.counts().get(id), want.length)
    const got = spill.read(id)
    // JSON keeps key order, so this also pins the order loadSegments writes.
    assert.equal(JSON.stringify(got), JSON.stringify(want), `symbol ${id}`)
    markers += got.filter(q => q.gapMarker).length
    repeats += got.filter(q => q.changed === false).length
    oneSided += got.filter(q => !q.gapMarker && (q.bid == null || q.ask == null)).length
  }
  assert.ok(markers > 0 && repeats > 0 && oneSided > 0, `markers ${markers}, repeats ${repeats}, one-sided ${oneSided}`)
  assert.deepEqual(readdirSync(spillDir), [], 'each symbol file is deleted as it is read')
  assert.equal(SPILL_ENTRY_BYTES, 32)
})

test('a streamed replay gives the in-memory replay\'s trials — ids, summaries, verdicts — and says how it held them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-replay-'))
  const files = richSegments(dir)
  const th = loadThresholds().replay
  const mem = replayFiles(files, PLAN, th, { inMemoryMaxRecords: Infinity })
  const spillDir = mkdtempSync(join(tmpdir(), 'spill-run-'))
  const str = replayFiles(files, PLAN, th, { inMemoryMaxRecords: 0, spillDir })
  assert.equal(mem.replay.mode, 'in_memory'); assert.equal(str.replay.mode, 'streamed')
  assert.ok(mem.trials.some(t => t.trial.summary.trades > 0), 'the fixture trades, so the comparison compares something')
  assert.deepEqual(str.trials.map(t => t.trial.trialId), mem.trials.map(t => t.trial.trialId))
  assert.deepEqual(str.trials, mem.trials, 'trial for trial, verdicts included')
  assert.deepEqual(str.manifest, mem.manifest)
  assert.deepEqual(str.replay.symbolsNotReplayed, [])
  assert.equal(str.replay.largestSymbolEvents, Math.max(...str.trials.map(t => t.trial.manifest.symbolEvents)))
  assert.deepEqual(readdirSync(spillDir), [], 'nothing is left in the spill directory')
  // the stage-A grid too: same trials in the same grid-major order
  const gridMem = replayFiles(files, { ...PLAN, stageA: true }, th, { inMemoryMaxRecords: Infinity })
  const gridStr = replayFiles(files, { ...PLAN, stageA: true }, th, { inMemoryMaxRecords: 0 })
  assert.equal(gridStr.trials.length, 36)
  assert.deepEqual(gridStr.trials.map(t => t.trial.trialId), gridMem.trials.map(t => t.trial.trialId))
  assert.deepEqual(gridMem.trials.map(t => t.trial.trialId), runTrials(loadSegments(files), { stageA: true, params: PLAN.params, sim: PLAN.sim }).map(t => t.trialId), 'and runTrials still returns that order')
  // The order itself, written out: grid point by grid point, symbols in first-seen order (what runTrials always returned).
  const symbols = loadSegments(files).manifestBase.symbols
  const want = stageAGrid().flatMap(g => symbols.map(id => `${g.rangeEvents}/${g.minEfficiency}/${id}`))
  assert.deepEqual(gridStr.trials.map(t => `${t.trial.params.rangeEvents}/${t.trial.params.minEfficiency}/${t.trial.manifest.symbolId}`), want)
})

test('a symbol whose stream is over the bound is named and not replayed; the others are replayed in full', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-bound-'))
  const files = richSegments(dir)
  const th = loadThresholds().replay
  const counts = new Map([...loadSegments(files).bySymbol].map(([id, l]) => [id, l.length]))
  const bound = Math.max(...counts.values()) - 1
  const big = [...counts].filter(([, n]) => n > bound).map(([id]) => id)
  assert.ok(big.length >= 1 && big.length < counts.size)
  const mem = replayFiles(files, PLAN, th, { inMemoryMaxRecords: Infinity })
  const str = replayFiles(files, PLAN, th, { inMemoryMaxRecords: 0, maxSymbolEvents: bound })
  assert.deepEqual(str.replay.symbolsNotReplayed, big.map(id => ({ symbolId: id, streamEvents: counts.get(id) })))
  assert.equal(str.replay.maxSymbolEvents, bound)
  assert.deepEqual(str.trials.map(t => t.trial.manifest.symbolId), mem.trials.map(t => t.trial.manifest.symbolId).filter(id => !big.includes(id)))
  // Codex P1 on #1330 (review of 0049e8a8; owner: "Record it on the trials"):
  // every trial of a run that skipped a symbol says so on its own manifest, so
  // the stored row says it, not only the transient job. Otherwise each replayed
  // symbol's trial is the in-memory one: same summary, blocks and parity.
  const want = mem.trials.filter(t => !big.includes(t.trial.manifest.symbolId))
  for (const [i, t] of str.trials.entries()) {
    assert.deepEqual(t.trial.manifest.symbolsNotReplayed, big.map(id => ({ symbolId: id, streamEvents: counts.get(id) })), 'RED before the fix: the skip lived only on the job')
    assert.equal(t.trial.manifest.maxSymbolEvents, bound)
    const { symbolsNotReplayed, maxSymbolEvents, ...rest } = t.trial.manifest // eslint-disable-line no-unused-vars
    assert.deepEqual(rest, want[i].trial.manifest)
    for (const k of ['summary', 'blocks', 'parity', 'params', 'sim', 'profileHash']) assert.deepEqual(t.trial[k], want[i].trial[k], k)
    assert.notEqual(t.trial.trialId, want[i].trial.trialId, 'a run that left a symbol out is not the same evidence as one that did not')
  }
  // and stored: the row in tick_trials carries it after an import
  const db = initDB(':memory:')
  const r = tickResearchAction(db, { stageA: false, params: PLAN.params, sim: { latencyMs: 60, minTargetToCost: 1 } }, { segmentsDir: dir, replayOptions: { inMemoryMaxRecords: 0, maxSymbolEvents: bound } })
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300))
  const rows = db.prepare('SELECT manifest_json FROM tick_trials').all().map(x => JSON.parse(x.manifest_json))
  assert.ok(rows.length > 0)
  for (const m of rows) assert.deepEqual(m.symbolsNotReplayed?.map(o => o.symbolId), big)
  assert.equal(MAX_SYMBOL_EVENTS, 20_000_000)
})

test('the cap is raised for the 92,274,616 records both sidecars held on 12-10; the in-memory bound is the old cap; the worker heap is capped', () => {
  assert.equal(IN_MEMORY_MAX_RECORDS, 5_000_000)
  assert.ok(MAX_RECORDS >= 92_274_616, `MAX_RECORDS ${MAX_RECORDS}`)
  assert.equal(MAX_RECORDS, 150_000_000)
  assert.equal(WORKER_HEAP_MB, 4096)
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitSettled(id, maxMs = 60_000) {
  const t0 = Date.now()
  for (;;) { const j = tickResearchJob(id); if (j && j.state !== 'running') return j; if (Date.now() - t0 > maxMs) throw new Error('job did not settle'); await sleep(20) }
}

test('a job over the in-memory bound runs streamed in the real worker, matches the in-memory job, and leaves no spill behind', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'spill-job-'))
  richSegments(dir)
  const root = mkdtempSync(join(tmpdir(), 'spill-root-'))
  const body = { stageA: false, params: PLAN.params, sim: { latencyMs: 60, minTargetToCost: 1 }, dryRun: true }
  const a = startTickResearchJob(db, body, { segmentsDir: dir, spillRoot: root, inMemoryMaxRecords: 0 })
  assert.equal(a.status, 202, JSON.stringify(a.body))
  assert.equal(readdirSync(root).length, 1, 'the main thread made the spill directory')
  const da = await waitSettled(a.body.jobId)
  assert.equal(da.state, 'done', JSON.stringify(da).slice(0, 400))
  assert.equal(da.result.replay.mode, 'streamed')
  assert.deepEqual(readdirSync(root), [], 'the spill directory is removed when the job settles')
  const b = startTickResearchJob(db, body, { segmentsDir: dir, spillRoot: root })
  const dbb = await waitSettled(b.body.jobId)
  assert.equal(dbb.result.replay.mode, 'in_memory')
  assert.deepEqual(da.result.trialIds, dbb.result.trialIds)
  assert.deepEqual(da.result.trials.map(t => t.summary), dbb.result.trials.map(t => t.summary))
  assert.deepEqual(readdirSync(root), [], 'an in-memory job makes no spill directory')
  _resetTickResearchJobs()
})

/** A worker stand-in: records its options; terminate() ends it with code 1. */
function fakeWorkerCtor(seen) {
  return class extends EventEmitter {
    constructor(file, opts) { super(); seen.push(opts) }
    terminate() { setImmediate(() => this.emit('exit', 1)); return Promise.resolve(1) }
  }
}

test('the worker is started with the heap cap; an abort settles the job aborted with the reason and caller, imports nothing and removes the spill', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'spill-abort-'))
  richSegments(dir, 600)
  const root = mkdtempSync(join(tmpdir(), 'spill-abort-root-'))
  assert.equal(abortTickResearchJob({ reason: 'x' }).status, 409, 'nothing running')
  const seen = []
  const s = startTickResearchJob(db, { stageA: false, params: PLAN.params }, { segmentsDir: dir, spillRoot: root, inMemoryMaxRecords: 0, workerCtor: fakeWorkerCtor(seen) })
  assert.equal(s.status, 202)
  assert.equal(seen[0].resourceLimits.maxOldGenerationSizeMb, WORKER_HEAP_MB)
  assert.ok(seen[0].workerData.spillDir && existsSync(seen[0].workerData.spillDir))
  const wrong = abortTickResearchJob({ jobId: 'other', reason: 'x' })
  assert.equal(wrong.status, 409); assert.equal(wrong.body.error, 'job_id_mismatch')
  const r = abortTickResearchJob({ jobId: s.body.jobId, reason: 'gateway CPU over 80% during the run', actor: 'owner' })
  assert.equal(r.status, 202); assert.equal(r.body.state, 'aborting')
  const j = await waitSettled(s.body.jobId)
  assert.equal(j.state, 'aborted')
  assert.equal(j.error, 'aborted: gateway CPU over 80% during the run')
  assert.equal(j.abort.actor, 'owner')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tick_trials').get().c, 0)
  assert.deepEqual(readdirSync(root), [], 'the spill directory goes with the aborted job')
  assert.equal(abortTickResearchJob({ reason: 'again' }).status, 409)
  _resetTickResearchJobs()
})

test('clearCache: true empties the temporary cache once the job settles; false keeps it; anything else is 400; an operator directory is refused', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const source = mkdtempSync(join(tmpdir(), 'spill-src-'))
  const files = richSegments(source, 600)
  const names = files.map(f => f.split('/').pop())
  const empty = mkdtempSync(join(tmpdir(), 'spill-none-'))
  const listed = { segments: 2, bytes: 0, records: 0, truncated: false, reachable: 1, names, recordsPerSegment: [10, 10], sides: [] }
  const opts = (dest) => ({
    segmentsDir: empty, cacheDir: dest,
    listAll: async () => listed,
    sync: async (d) => { mkdirSync(d, { recursive: true }); for (const n of names) copyFileSync(join(source, n), join(d, n)); return { destDir: d, pulled: names.length, skipped: 0, bytes: 0, truncated: false, sides: [] } },
  })
  const body = { stageA: false, params: PLAN.params, dryRun: true }
  // kept by default
  const keep = mkdtempSync(join(tmpdir(), 'spill-cache-keep-'))
  const k = await startTickResearchJobWithSync(db, body, opts(keep))
  assert.equal(k.status, 202, JSON.stringify(k.body).slice(0, 300))
  const kd = await waitSettled(k.body.jobId)
  assert.equal(kd.state, 'done'); assert.equal('cacheCleared' in kd, false)
  assert.deepEqual(readdirSync(keep).sort(), names.slice().sort())
  // emptied on request
  const dest = mkdtempSync(join(tmpdir(), 'spill-cache-clear-'))
  writeFileSync(join(dest, 'operator-note.txt'), 'not a segment')
  const c = await startTickResearchJobWithSync(db, { ...body, clearCache: true }, opts(dest))
  assert.equal(c.status, 202)
  const cd = await waitSettled(c.body.jobId)
  assert.equal(cd.state, 'done')
  assert.equal(cd.cacheCleared.ok, true); assert.equal(cd.cacheCleared.removed, 2); assert.equal(cd.cacheCleared.remaining, 0)
  assert.deepEqual(readdirSync(dest), ['operator-note.txt'], 'only sealed segments are removed')
  // refused shapes, before anything is pulled
  for (const bad of ['yes', 1, 'true', 0]) {
    const r = await startTickResearchJobWithSync(db, { ...body, clearCache: bad }, opts(mkdtempSync(join(tmpdir(), 'spill-cache-bad-'))))
    assert.equal(r.status, 400, `clearCache ${JSON.stringify(bad)}`); assert.equal(r.body.error, 'bad_clear_cache')
  }
  assert.deepEqual(clearCacheFrom({}), { value: false }); assert.deepEqual(clearCacheFrom({ clearCache: false }), { value: false }); assert.deepEqual(clearCacheFrom({ clearCache: true }), { value: true })
  const pulled = []
  const notTmp = await startTickResearchJobWithSync(db, { ...body, clearCache: true }, { ...opts('/srv/operator-segments'), sync: async () => { pulled.push(1); return {} } })
  assert.equal(notTmp.status, 400); assert.equal(notTmp.body.error, 'clear_cache_not_temporary'); assert.equal(pulled.length, 0)
  // read from an operator directory (the local path): no cache to clear
  const local = await startTickResearchJobWithSync(db, { ...body, clearCache: true }, { segmentsDir: source })
  assert.equal(local.status, 400); assert.equal(local.body.error, 'clear_cache_not_a_cache')
  _resetTickResearchJobs()
})

test('clearSegmentCache touches only a temporary directory and only sealed-segment names', () => {
  assert.equal(isTemporaryCache(join(tmpdir(), 'tick-segments')), true)
  assert.equal(isTemporaryCache(tmpdir()), false, 'the temp root itself is not a cache')
  assert.equal(isTemporaryCache('/data/tick'), false)
  assert.equal(isTemporaryCache(join(tmpdir(), '..', 'data')), false)
  const r = clearSegmentCache('/data/tick')
  assert.equal(r.ok, false); assert.equal(r.error, 'not_temporary'); assert.equal(r.removed, 0)
  const d = mkdtempSync(join(tmpdir(), 'spill-clear-'))
  writeFileSync(join(d, 'seg-1757548800000-000001.tks'), Buffer.alloc(100))
  writeFileSync(join(d, 'seg-x.tks'), 'x')
  const c = clearSegmentCache(d)
  assert.deepEqual({ ok: c.ok, removed: c.removed, bytes: c.bytes, remaining: c.remaining }, { ok: true, removed: 1, bytes: 100, remaining: 0 })
  assert.deepEqual(readdirSync(d), ['seg-x.tks'])
})

// Codex P1 on #1330: a confirmation run (includeTest) opens the profile's
// one-time test block. A streamed run that skipped a symbol over the bound
// spent that opening on a partial result, and every retry was refused as a
// second opening.
import { tickResearchAction, SYMBOL_OVER_BOUND } from './tick-research-run.js'
import { testOpeningsFor } from './tick-research.js'
import { profileHash, normalizeParams } from '../lib/tick-strategy.js'

const CONFIRM_PARAMS = { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }
const CONFIRM = { includeTest: true, params: CONFIRM_PARAMS, sim: { latencyMs: 60, minTargetToCost: 1 }, profileHash: profileHash(normalizeParams(CONFIRM_PARAMS)) }

test('Codex P1 on #1330: a streamed confirmation run with a symbol over the bound is refused before any sim — nothing simulated, the spill removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-confirm-'))
  const files = richSegments(dir, 600)
  const spillDir = mkdtempSync(join(tmpdir(), 'spill-confirm-run-'))
  assert.throws(
    () => replayFiles(files, { ...PLAN, includeTest: true }, loadThresholds().replay, { inMemoryMaxRecords: 0, maxSymbolEvents: 10, spillDir }),
    (err) => err.code === SYMBOL_OVER_BOUND && err.symbolsOverBound.length === 3 && /test block was not read/.test(err.message),
  )
  assert.deepEqual(readdirSync(spillDir), [])
  // a research run (no includeTest) still names and skips
  const r = replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: 0, maxSymbolEvents: 10 })
  assert.equal(r.trials.length, 0); assert.equal(r.replay.symbolsNotReplayed.length, 3)
})

test('Codex P1 on #1330: the job settles failed with the code, its opening failed_unseen, and the confirmation can be run again', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'spill-confirm-job-'))
  richSegments(dir, 600)
  const s = startTickResearchJob(db, CONFIRM, { segmentsDir: dir, inMemoryMaxRecords: 0, maxSymbolEvents: 10 })
  assert.equal(s.status, 202, JSON.stringify(s.body).slice(0, 300))
  const j = await waitSettled(s.body.jobId)
  assert.equal(j.state, 'failed'); assert.equal(j.errorCode, SYMBOL_OVER_BOUND); assert.equal(j.symbolsOverBound.length, 3)
  assert.deepEqual(db.prepare('SELECT status FROM tick_test_openings').all(), [{ status: 'failed_unseen' }], 'RED before the fix: settled opened with no trials')
  assert.equal(testOpeningsFor(db, CONFIRM.profileHash).consulted, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tick_trials').get().c, 0)
  const again = startTickResearchJob(db, CONFIRM, { segmentsDir: dir, inMemoryMaxRecords: 0 })
  assert.equal(again.status, 202, 'not refused as a second opening')
  const j2 = await waitSettled(again.body.jobId)
  assert.equal(j2.state, 'done', JSON.stringify(j2).slice(0, 300))
  _resetTickResearchJobs()
})

test('Codex P1 on #1330: the in-thread action answers 413 symbol_over_bound and leaves the opening unconsumed', () => {
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'spill-confirm-inline-'))
  richSegments(dir, 600)
  const r = tickResearchAction(db, CONFIRM, { segmentsDir: dir, replayOptions: { inMemoryMaxRecords: 0, maxSymbolEvents: 10 } })
  assert.equal(r.status, 413); assert.equal(r.body.error, SYMBOL_OVER_BOUND); assert.equal(r.body.symbolsOverBound.length, 3)
  assert.deepEqual(db.prepare('SELECT status FROM tick_test_openings').all(), [{ status: 'failed_unseen' }])
  assert.equal(tickResearchAction(db, CONFIRM, { segmentsDir: dir }).status, 200, 'the confirmation can still be run')
})

// Codex P2 on #1330 (1 of 2): a result already queued when the abort lands.
test('Codex P2 on #1330: a result the worker posted just before the abort is discarded — the job is aborted and imports nothing', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'spill-abort-race-'))
  const files = richSegments(dir, 600)
  const body = { stageA: false, params: PLAN.params, sim: { latencyMs: 60, minTargetToCost: 1 } }
  const replayed = replayFiles(files, { ...PLAN, includeTest: false, sim: body.sim }, loadThresholds().replay)
  assert.ok(replayed.trials.length > 0)
  // terminate() delivers the queued result first, then the exit — the order Node may use.
  const Racing = class extends EventEmitter {
    terminate() { setImmediate(() => { this.emit('message', { ok: true, replayed }); this.emit('exit', 1) }); return Promise.resolve(1) }
  }
  const s = startTickResearchJob(db, body, { segmentsDir: dir, workerCtor: Racing })
  assert.equal(s.status, 202)
  assert.equal(abortTickResearchJob({ jobId: s.body.jobId, reason: 'owner stop' }).status, 202)
  const j = await waitSettled(s.body.jobId)
  assert.equal(j.state, 'aborted', 'RED before the fix: the queued result was imported and the job read done')
  assert.equal(j.error, 'aborted: owner stop')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tick_trials').get().c, 0)
  _resetTickResearchJobs()
})

// Codex P2 on #1330 (2 of 2): a symlink inside the temp directory to a kept directory.
test('Codex P2 on #1330: a cache path that is a symlink out of the temporary directory is not temporary, and nothing behind it is removed', async () => {
  const { symlinkSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'spill-tmproot-'))   // stands in for os.tmpdir()
  const kept = mkdtempSync(join(tmpdir(), 'spill-kept-'))      // a directory outside that root
  writeFileSync(join(kept, 'seg-1757548800000-000001.tks'), Buffer.alloc(64))
  const link = join(root, 'cache-link')
  symlinkSync(kept, link)
  assert.equal(isTemporaryCache(link, { tmpRoot: root }), false, 'RED before the fix: the lexical check read the link as temporary')
  assert.equal(isTemporaryCache(join(link, 'sub'), { tmpRoot: root }), false, 'a not-yet-created child of the link is judged by its real parent')
  const r = clearSegmentCache(link, { tmpRoot: root })
  assert.equal(r.ok, false); assert.equal(r.error, 'not_temporary')
  assert.deepEqual(readdirSync(kept), ['seg-1757548800000-000001.tks'], 'the kept directory is untouched')
  // a real directory inside the root, and one not created yet, are temporary
  const real = mkdtempSync(join(root, 'cache-'))
  assert.equal(isTemporaryCache(real, { tmpRoot: root }), true)
  assert.equal(isTemporaryCache(join(root, 'not-yet', 'tick-segments'), { tmpRoot: root }), true)
})

// Codex P1 on #1330 (review of 4e26751d): the spill directory was created
// after the job's test opening was recorded and outside the guarded start, so
// a temp directory that could not be created left the opening `opened` with
// no worker ever started, and every retry was refused as a second opening.
test('Codex P1 on #1330: a spill directory that cannot be created refuses the job with nothing started and the opening failed_unseen; a retry is accepted', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'spill-mkdtemp-'))
  richSegments(dir, 600)
  const notADir = join(mkdtempSync(join(tmpdir(), 'spill-file-root-')), 'a-file')
  writeFileSync(notADir, 'x') // mkdtemp under a file fails (ENOTDIR), as a full or unwritable temp disk would
  let r
  assert.doesNotThrow(() => { r = startTickResearchJob(db, CONFIRM, { segmentsDir: dir, inMemoryMaxRecords: 0, spillRoot: notADir }) }, 'RED before the fix: the mkdtemp error escaped the guarded start')
  assert.equal(r.status, 500); assert.equal(r.body.error, 'worker_start_failed')
  assert.deepEqual(db.prepare('SELECT status FROM tick_test_openings').all(), [{ status: 'failed_unseen' }])
  assert.equal(testOpeningsFor(db, CONFIRM.profileHash).consulted, false)
  assert.equal(tickResearchJob(r.body.jobId ?? 'none'), null)
  const again = startTickResearchJob(db, CONFIRM, { segmentsDir: dir, inMemoryMaxRecords: 0 })
  assert.equal(again.status, 202, 'not refused as a second opening, and the job slot is free')
  assert.equal((await waitSettled(again.body.jobId)).state, 'done')
  _resetTickResearchJobs()
})

// Codex P1 on #1330 (review of 743c2d80): the beside-the-spool script wrote
// only `trials`, so a streamed run that skipped a symbol over the stream bound
// produced a file that read as complete. Owner: "Fix in #1330 now".
import { replayNotice } from './tick-research-run.js'
import { execFileSync } from 'node:child_process'

test('Codex P1 on #1330: the script\'s JSON carries the replay record, and a skipped symbol is named on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-cli-'))
  richSegments(dir, 600)
  const script = new URL('../../scripts/tick-research.mjs', import.meta.url).pathname
  const out = JSON.parse(execFileSync(process.execPath, [script, dir, '--params', JSON.stringify(PLAN.params), '--sim', JSON.stringify({ latencyMs: 60, minTargetToCost: 1 })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(out.replay?.mode, 'in_memory', 'RED before the fix: the output had trials only')
  assert.ok(out.replay.records > 0)
  // the notice the script prints, from a streamed replay that skipped symbols
  const r = replayFiles(listSegmentsOf(dir), PLAN, loadThresholds().replay, { inMemoryMaxRecords: 0, maxSymbolEvents: 10 })
  const line = replayNotice(r.replay)
  assert.match(line, /^NOT REPLAYED: 3 symbol\(s\) over the 10-event stream bound: 11 \(\d[\d,]*\), 12 \(\d[\d,]*\), 13 \(\d[\d,]*\); their trials are absent from this output$/)
  assert.equal(replayNotice(out.replay), null); assert.equal(replayNotice(null), null)
  const script2 = readFileSync(new URL('../../scripts/tick-research.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.match(script2, /replayNotice\(replayed\.replay\)/, 'the script prints the notice it is given')
})
const listSegmentsOf = (dir) => readdirSync(dir).filter(f => f.endsWith('.tks')).sort().map(f => join(dir, f))

// Codex P2 on #1330 (review of 743c2d80): each continuity gap writes one
// spill entry per symbol seen so far, so a gap-heavy spool can need more spill
// than its record count. Owner: "Add a spill-byte cap".
import { SPILL_OVER_BOUND, MAX_SPILL_ENTRIES } from './tick-research-run.js'

test('Codex P2 on #1330: the spill refuses past its entry cap — nothing simulated, the spill removed, the opening left to retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-cap-'))
  const files = richSegments(dir) // full size: its continuity gaps sit at quotes 1,500 and 3,000
  const total = [...loadSegments(files).bySymbol.values()].reduce((n, l) => n + l.length, 0)
  const markers = [...loadSegments(files).bySymbol.values()].reduce((n, l) => n + l.filter(q => q.gapMarker).length, 0)
  assert.ok(markers > 0, 'the fixture carries broadcast gap entries')
  const spillDir = mkdtempSync(join(tmpdir(), 'spill-cap-run-'))
  assert.throws(
    () => replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: 0, maxSpillEntries: total - 1, spillDir }),
    (err) => err.code === SPILL_OVER_BOUND && /bound of [\d,]+ entries/.test(err.message),
    'RED before the cap: the spill grew past it',
  )
  assert.deepEqual(readdirSync(spillDir), [], 'what was spilled before the refusal is removed')
  assert.ok(replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: 0, maxSpillEntries: total }).trials.length > 0, 'at the cap: replayed')
  // the in-thread door answers 413 and a confirmation's opening stays retryable
  const db = initDB(':memory:')
  const r = tickResearchAction(db, CONFIRM, { segmentsDir: dir, replayOptions: { inMemoryMaxRecords: 0, maxSpillEntries: total - 1 } })
  assert.equal(r.status, 413); assert.equal(r.body.error, SPILL_OVER_BOUND)
  assert.deepEqual(db.prepare('SELECT status FROM tick_test_openings').all(), [{ status: 'failed_unseen' }])
  assert.equal(MAX_SPILL_ENTRIES, MAX_RECORDS, 'the cap is the spill budget MAX_RECORDS states: 32 bytes an entry')
})

// ── Claude · № 15,001 15-Oct (owner: "#36 research isolation — CI step only when research files change" after № 14,989; claude-builder) ──
// The spill writes prices as float64 and reads them bit-exact; the lossy
// step would be a price above 2^53. Expected outcome: at a BTC-class level
// (8 × 10^9 in 10^-5 points) every quote the spill hands back carries the
// integer that was encoded, and the stream equals the in-memory build.
test('at 8e9 (BTC-class prices) the spill hands back the encoded integers and equals the in-memory build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-high-'))
  const encoded = []
  const files = richSegments(dir, 3000, 8_000_000_000, encoded)
  const mem = loadSegments(files)
  const spillDir = mkdtempSync(join(tmpdir(), 'spill-high-store-'))
  const spill = createSpill(spillDir)
  const base = walkSegments(files, spill)
  spill.close()
  assert.deepEqual(base, mem.manifestBase)
  let maxBid = 0
  for (const id of spill.symbols()) {
    const got = spill.read(id)
    assert.equal(JSON.stringify(got), JSON.stringify(mem.bySymbol.get(id)), `symbol ${id}`)
    const quotes = got.filter(q => !q.gapMarker && q.changed !== false)
    const want = encoded.filter(e => e.sym === id)
    assert.equal(quotes.length, want.length, `symbol ${id}: one entry per encoded quote`)
    quotes.forEach((q, i) => {
      assert.equal(q.bid, want[i].bid, `symbol ${id} quote ${i} bid`)
      assert.equal(q.ask, want[i].ask, `symbol ${id} quote ${i} ask`)
      assert.ok(Number.isSafeInteger(q.bid) && (q.ask == null || Number.isSafeInteger(q.ask)))
      maxBid = Math.max(maxBid, q.bid)
    })
  }
  assert.ok(maxBid >= 8_000_000_000, `the fixture reached the BTC-class level (max bid ${maxBid})`)
  assert.deepEqual(readdirSync(spillDir), [])
})
