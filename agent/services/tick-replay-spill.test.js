// Claude · № 13,571 12-Oct (W6, owner "Raise the cap (code change)";
// claude-builder). The streamed replay must be the in-memory replay, trial
// for trial, with one symbol's stream in memory at a time; what it leaves on
// disk goes when the job settles; an abort is named; clearCache empties only
// a temporary cache.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync as makeTempDir, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
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
function richSegments(dir, n = 6000) {
  const names = []
  let seq = 1
  for (let s = 0; s < 2; s++) {
    const parts = [encodeHeader({ environment: 'demo', generation: 1, startedMs: T0 + s * 1e7, feedId: 'spill' })]
    for (let i = 0; i < n; i++) {
      const t = T0 + s * 1e7 + i * 100
      const sym = [11, 11, 12, 13][i % 4]
      const drift = sym === 11 ? Math.floor(i / 3) * 3 : 0
      const bid = 100_000 + drift + Math.round(Math.sin(i / (sym === 12 ? 40 : 90)) * 400) + (i % 5)
      const ask = bid + 8 + (i % 3)
      let flags = QUOTE
      let b = bid, a = ask
      if (i % 997 === 5) { flags = FLAGS.BID_PRESENT | FLAGS.BID_CHANGED; a = undefined }
      if (i % 1499 === 7) flags |= FLAGS.SNAPSHOT
      if (i % 1777 === 9) { flags |= FLAGS.CROSSED; b = ask + 2; a = ask }
      parts.push(encodeRecord({ recvMs: t, seq: seq++, symbolId: sym, bid: b, ask: a, flags, kind: KIND.QUOTE, generation: 1 }))
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
  assert.deepEqual(str.trials, mem.trials.filter(t => !big.includes(t.trial.manifest.symbolId)), 'the replayed symbols are the in-memory trials')
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
