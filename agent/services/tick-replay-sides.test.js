// Claude · № 13,672 12-Oct (W6 sides, owner "Key streams by side" and "One
// PR, 3 items"; claude-builder). Measured on 12-10 (/state/tick-recorder): 27
// symbol ids are recorded on BOTH sidecars, and an id names a different
// instrument per side. A replay over both sides keyed its streams by symbol id
// alone, so the two feeds of one id were interleaved out of time order, a gap
// on one side re-warmed the other, and the cost class was whichever side the
// stored map listed first. Each stream is now keyed by side in a run over both
// sides; a run over one side is unchanged, trial ids included. And the two
// Codex P2s on #1330: a short write to the spill is retried, and a write that
// fails at close leaves no file open and nothing on disk.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync as makeTempDir, rmSync, writeFileSync, readdirSync, writeSync as fsWriteSync, openSync as fsOpenSync, closeSync as fsCloseSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import { encodeHeader, encodeRecord, FLAGS, KIND } from '../lib/tick-segment.js'
import { TICK_COST_MAP_KEY } from '../lib/tick-cost-schedule.js'
import { loadSegments, replayFiles, replayNotice, researchPlan, replayCostContext, symbolTrend, stageAGrid, tickResearchAction } from './tick-research-run.js'
import { createSpill, SPILL_ENTRY_BYTES } from './tick-replay-spill.js'
import { trialParity, trialGaps, gapListCutAt, replayRecordOf, compareParity } from './tick-replay-parity.js'
import { loadThresholds } from './tick-validation.js'

const temporaryDirectories = new Set()
const mkdtempSync = (...args) => { const d = makeTempDir(...args); temporaryDirectories.add(d); return d }
after(() => { for (const d of temporaryDirectories) rmSync(d, { recursive: true, force: true }) })

const T0 = 1_757_548_800_000
const QUOTE = FLAGS.BID_PRESENT | FLAGS.BID_CHANGED | FLAGS.ASK_PRESENT | FLAGS.ASK_CHANGED
const GAP = (reason, recvMs) => encodeRecord({ recvMs, seq: 0, symbolId: 0, bid: 1, ask: reason, kind: KIND.GAP, generation: 1 })
// Each stream's price band: the same id 7 is a different instrument per side.
const BAND = { 'demo:7': [99_000, 104_000], 'demo:8': [49_000, 51_000], 'live:7': [199_000, 204_000] }

/**
 * Two segments per side, interleaved by start time as the cache lists them.
 * Demo records ids 7 and 8, live records id 7 at a different price over the
 * same minutes. Demo has a reconnect in each segment; live has one reconnect
 * and a recorder-only gap (queue_overflow) per segment. Demo's second segment
 * opens with a repeat of id 7, which follows live's gaps in file order.
 */
function sidesSegments(dir, { envs = ['demo', 'live'], n = 4000 } = {}) {
  const names = []
  let seq = 1
  for (let s = 0; s < 2; s++) {
    for (const env of envs) {
      const start = T0 + s * 1e7 + (env === 'live' ? 5 : 0)
      const parts = [encodeHeader({ environment: env, generation: 1, startedMs: start, feedId: env })]
      if (s === 1 && env === 'demo') parts.push(encodeRecord({ recvMs: start, seq: seq++, symbolId: 7, flags: FLAGS.REPEAT, generation: 1 }))
      for (let i = 0; i < n; i++) {
        const t = start + 10 + i * 100
        const sym = env === 'demo' ? [7, 7, 8][i % 3] : 7
        const base = sym === 8 ? 50_000 : env === 'live' ? 200_000 : 100_000
        const drift = sym === 7 ? Math.floor(i / 3) * 2 : 0
        const bid = base + drift + Math.round(Math.sin(i / 50) * 300) + (i % 5)
        parts.push(encodeRecord({ recvMs: t, seq: seq++, symbolId: sym, bid, ask: bid + 8 + (i % 3), flags: QUOTE, kind: KIND.QUOTE, generation: 1 }))
        if (i % 13 === 0) parts.push(encodeRecord({ recvMs: t + 50, seq: seq++, symbolId: sym, flags: FLAGS.REPEAT, generation: 1 }))
        if (env === 'demo' && i === 1500) parts.push(GAP(3, t + 60))
        if (env === 'live' && s === 0 && i === 2000) parts.push(GAP(3, t + 60))
        if (env === 'live' && i === 3000) parts.push(GAP(1, t + 60))
      }
      const name = `seg-${start}-00000${s + 1}.tks`
      writeFileSync(join(dir, name), Buffer.concat(parts))
      names.push(name)
    }
  }
  return names.sort().map(nm => join(dir, nm))
}

const PLAN = { stageA: false, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, sim: { latencyMs: 60, minTargetToCost: 1 }, onlySymbol: null, maxSegments: null }
const keyOf = (t) => `${t.trial.manifest.environment}:${t.trial.manifest.symbolId}`

test('a replay over both sides keeps one stream per side and id: each holds its own side\'s quotes, in time order', () => {
  const files = sidesSegments(mkdtempSync(join(tmpdir(), 'sides-load-')))
  const { bySymbol, manifestBase } = loadSegments(files)
  assert.deepEqual(manifestBase.environments, ['demo', 'live'])
  assert.deepEqual([...bySymbol.keys()], ['demo:7', 'demo:8', 'live:7'], 'id 7 is two streams, in first-seen order')
  assert.deepEqual(manifestBase.symbols, ['demo:7', 'demo:8', 'live:7'])
  for (const [key, list] of bySymbol) {
    const [lo, hi] = BAND[key]
    let prev = -Infinity, quotes = 0
    for (const q of list) {
      if (q.gapMarker) continue
      assert.ok(q.bid >= lo && q.bid <= hi, `${key}: bid ${q.bid} is its own side's price`)
      assert.ok(q.recvMs >= prev, `${key}: ${q.recvMs} after ${prev} — never the other side's minutes`)
      prev = q.recvMs
      quotes++
    }
    assert.ok(quotes > 2000, `${key}: ${quotes} quotes`)
  }
})

test('each trial names its side: a numeric symbol id and its environment, one trial per side and id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sides-trials-'))
  const files = sidesSegments(dir)
  const r = replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: Infinity })
  assert.deepEqual(r.trials.map(keyOf), ['demo:7', 'demo:8', 'live:7'])
  const lists = loadSegments(files).bySymbol
  for (const { trial } of r.trials) {
    assert.equal(typeof trial.manifest.symbolId, 'number')
    assert.equal(trial.parity.symbolId, trial.manifest.symbolId)
    assert.equal(trial.manifest.symbolEvents, lists.get(`${trial.manifest.environment}:${trial.manifest.symbolId}`).length)
  }
  assert.ok(r.trials.some(t => t.trial.summary.trades > 0), 'the fixture trades, so what follows compares something')
  assert.notEqual(r.trials[0].trial.trialId, r.trials[2].trial.trialId, 'id 7 on each side is its own trial')
  // and the action's reply names the side beside the id
  const reply = tickResearchAction(initDB(':memory:'), { dryRun: true, stageA: false, params: PLAN.params, sim: PLAN.sim }, { segmentsDir: dir })
  assert.equal(reply.status, 200)
  assert.deepEqual(reply.body.trials.map(t => [t.environment, t.symbolId]), [['demo', 7], ['demo', 8], ['live', 7]])
})

test('a streamed replay over both sides is the in-memory replay, trial for trial, grid order included, and leaves nothing on disk', () => {
  const files = sidesSegments(mkdtempSync(join(tmpdir(), 'sides-stream-')))
  const th = loadThresholds().replay
  const mem = replayFiles(files, PLAN, th, { inMemoryMaxRecords: Infinity })
  const spillDir = mkdtempSync(join(tmpdir(), 'sides-spill-'))
  const str = replayFiles(files, PLAN, th, { inMemoryMaxRecords: 0, spillDir })
  assert.equal(str.replay.mode, 'streamed')
  assert.deepEqual(str.trials, mem.trials)
  assert.deepEqual(str.manifest, mem.manifest)
  assert.deepEqual(readdirSync(spillDir), [])
  const grid = replayFiles(files, { ...PLAN, stageA: true }, th, { inMemoryMaxRecords: 0 })
  const want = stageAGrid().flatMap(g => ['demo:7', 'demo:8', 'live:7'].map(k => `${g.rangeEvents}/${g.minEfficiency}/${k}`))
  assert.deepEqual(grid.trials.map(t => `${t.trial.params.rangeEvents}/${t.trial.params.minEfficiency}/${keyOf(t)}`), want)
  assert.deepEqual(grid.trials.map(t => t.trial.trialId), replayFiles(files, { ...PLAN, stageA: true }, th, { inMemoryMaxRecords: Infinity }).trials.map(t => t.trial.trialId))
})

test('a continuity gap re-warms only its own side\'s streams; a repeat after the other side\'s gap keeps its own side\'s last quote', () => {
  const files = sidesSegments(mkdtempSync(join(tmpdir(), 'sides-gaps-')))
  const { bySymbol, manifestBase } = loadSegments(files)
  const markers = (k) => bySymbol.get(k).filter(q => q.gapMarker).length
  assert.equal(markers('demo:7'), 2, 'the two demo reconnects')
  assert.equal(markers('demo:8'), 2)
  assert.equal(markers('live:7'), 1, 'the one live reconnect; the recorder-only gaps re-warm nothing')
  assert.equal(manifestBase.warmupResets, 3)
  assert.deepEqual(manifestBase.gaps.map(g => `${g.environment}:${g.reason}`).sort(), ['demo:reconnect', 'demo:reconnect', 'live:queue_overflow', 'live:queue_overflow', 'live:reconnect'])
  // Demo's second segment opens with a repeat of id 7, after live's gaps in file order.
  const rep = bySymbol.get('demo:7').find(q => q.recvMs === T0 + 1e7 && q.changed === false)
  assert.ok(rep, 'the repeat is kept: live\'s gaps did not forget demo\'s last quote')
  assert.ok(rep.bid >= BAND['demo:7'][0] && rep.bid <= BAND['demo:7'][1], `with demo's price, ${rep.bid}`)
})

// Pinned on 7feb4e49, before streams were keyed by side: a run over one side
// keys the same trials as before. They move only with the decoder, the sim or
// the strategy version, which re-key every trial by design.
const PINNED = {
  demo: ['46bf7b957d67eeaaa0b1', '3d31d0b56c0f98573664'],
  live: ['863b2b19d18870ef4743'],
}
test('a run over one side is unchanged: numeric streams, no environment on the manifest or its gaps, the trial ids pinned before this change', () => {
  const saved = { RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA, GIT_COMMIT: process.env.GIT_COMMIT }
  delete process.env.RAILWAY_GIT_COMMIT_SHA; delete process.env.GIT_COMMIT
  try {
    for (const env of ['demo', 'live']) {
      const files = sidesSegments(mkdtempSync(join(tmpdir(), `sides-one-${env}-`)), { envs: [env] })
      const { bySymbol, manifestBase } = loadSegments(files)
      assert.deepEqual([...bySymbol.keys()], env === 'demo' ? [7, 8] : [7])
      assert.ok(manifestBase.gaps.every(g => !('environment' in g)), 'gaps as before')
      const r = replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: Infinity })
      for (const { trial } of r.trials) assert.ok(!('environment' in trial.manifest), 'no environment key: the manifest, and so the trial id, as before')
      assert.deepEqual(r.trials.map(t => t.trial.trialId), PINNED[env], env)
      assert.deepEqual(replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: 0 }).trials.map(t => t.trial.trialId), PINNED[env], `${env}, streamed`)
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
  }
})

test('the cost class is read from the trial\'s own side: the same id is charged per side, never the side the map lists first', () => {
  const db = initDB(':memory:')
  // Demo listed first, with a different class for id 7: the first-come union charged live 7 as an index.
  setState(db, TICK_COST_MAP_KEY, JSON.stringify({ cpp_exec_demo: { symbolClass: { 7: 'index_cfd', 8: 'fx' } }, cpp_exec: { symbolClass: { 7: 'crypto' } } }))
  const plan = { ...PLAN, ...researchPlan({ stageA: false, params: PLAN.params, sim: PLAN.sim }, replayCostContext(db)) }
  const classOf = (files) => Object.fromEntries(replayFiles(files, plan, loadThresholds().replay, { inMemoryMaxRecords: Infinity }).trials.map(t => [keyOf(t).replace(/^undefined:/, ''), t.trial.sim.costClass]))
  assert.deepEqual(classOf(sidesSegments(mkdtempSync(join(tmpdir(), 'sides-cost-')))), { 'demo:7': 'index_cfd', 'demo:8': 'fx', 'live:7': 'crypto' })
  assert.deepEqual(classOf(sidesSegments(mkdtempSync(join(tmpdir(), 'sides-cost-live-')), { envs: ['live'] })), { 7: 'crypto' }, 'a live run alone: the live class')
  assert.deepEqual(classOf(sidesSegments(mkdtempSync(join(tmpdir(), 'sides-cost-demo-')), { envs: ['demo'] })), { 7: 'index_cfd', 8: 'fx' })
  // An id its own side does not classify is not charged the other side's class (its trial reads costSource none, which the replay rung refuses).
  setState(db, TICK_COST_MAP_KEY, JSON.stringify({ cpp_exec_demo: { symbolClass: { 7: 'index_cfd' } }, cpp_exec: { symbolClass: { 7: 'crypto', 8: 'fx' } } }))
  const strict = { ...PLAN, ...researchPlan({ stageA: false, params: PLAN.params, sim: PLAN.sim }, replayCostContext(db)) }
  const t8 = replayFiles(sidesSegments(mkdtempSync(join(tmpdir(), 'sides-cost-strict-')), { envs: ['demo'] }), strict, loadThresholds().replay, { inMemoryMaxRecords: Infinity }).trials.find(t => t.trial.manifest.symbolId === 8)
  assert.equal(t8.trial.sim.costClass, null)
  // A map stored under no side name (a single-route deployment) is still read as one union.
  setState(db, TICK_COST_MAP_KEY, JSON.stringify({ exec: { symbolClass: { 7: 'fx' } } }))
  const legacy = { ...PLAN, ...researchPlan({ stageA: false, params: PLAN.params, sim: PLAN.sim }, replayCostContext(db)) }
  assert.equal(replayFiles(sidesSegments(mkdtempSync(join(tmpdir(), 'sides-cost-legacy-')), { envs: ['live'] }), legacy, loadThresholds().replay, { inMemoryMaxRecords: Infinity }).trials[0].trial.sim.costClass, 'fx')
})

test('the regime name is read from the stream\'s own side', () => {
  const ctx = { sides: { demo: { 7: 'EURUSD' }, live: { 7: 'US500' } }, rows: {}, gateOn: true, maxRegimeAgeMin: 240, retainedFrom: null }
  const base = { environments: ['demo', 'live'] }
  const list = [{ seq: 1, recvMs: T0, bid: 1, ask: 2 }]
  assert.equal(symbolTrend(ctx, base, 7, list, 'live').manifest.symbol, 'US500')
  assert.equal(symbolTrend(ctx, base, 7, list, 'demo').manifest.symbol, 'EURUSD')
  assert.equal(symbolTrend(ctx, base, 7, list).manifest.symbol, null, 'with no side named, two names that disagree are no name (unchanged)')
  // Through the replay: each side's trial pins the rows of its own side's name.
  const files = sidesSegments(mkdtempSync(join(tmpdir(), 'sides-trend-')))
  const filtered = researchPlan({ stageA: false, params: PLAN.params, sim: { ...PLAN.sim, liveFilters: { counterTrend: true } } }, { gate: { on: true, maxRegimeAgeMin: 240 } })
  const r = replayFiles(files, { ...PLAN, ...filtered, trendContext: ctx }, loadThresholds().replay, { inMemoryMaxRecords: Infinity })
  assert.deepEqual(Object.fromEntries(r.trials.map(t => [keyOf(t), t.trial.manifest.regimeInput.symbol])), { 'demo:7': 'EURUSD', 'demo:8': null, 'live:7': 'US500' })
})

test('the parity report reads a both-sides trial\'s side from its environment, and only its own side\'s gaps', () => {
  const db = initDB(':memory:')
  const files = sidesSegments(mkdtempSync(join(tmpdir(), 'sides-parity-')))
  const r = replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: Infinity })
  for (const { trial } of r.trials) {
    const row = { trial_id: trial.trialId, profile_hash: trial.profileHash, manifest_json: JSON.stringify(trial.manifest), sim_json: JSON.stringify(trial.sim), params_json: JSON.stringify(trial.params), parity_json: JSON.stringify(trial.parity) }
    const p = trialParity(db, row)
    assert.equal(p.side, trial.manifest.environment === 'live' ? 'cpp_exec' : 'cpp_exec_demo', keyOf({ trial }))
    assert.ok(!(p.reasons || []).includes('mixed_environments'))
    const gaps = trialGaps(trial.manifest)
    assert.ok(gaps.length > 0 && gaps.every(g => g.environment === trial.manifest.environment), 'its own side\'s gaps only')
  }
  // A one-side manifest's gaps carry no environment and are all its own.
  assert.deepEqual(trialGaps({ gaps: [{ reason: 'reconnect', recvMs: 1, count: 1 }] }), [{ reason: 'reconnect', recvMs: 1, count: 1 }])
})

test('a stream skipped over the bound is named with its side', () => {
  const files = sidesSegments(mkdtempSync(join(tmpdir(), 'sides-bound-')))
  const counts = [...loadSegments(files).bySymbol].map(([k, l]) => [k, l.length])
  const bound = Math.min(...counts.map(c => c[1])) // the smallest stream fits, the others do not
  const r = replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: 0, maxSymbolEvents: bound })
  const over = counts.filter(c => c[1] > bound).map(([k, n]) => { const [environment, id] = k.split(':'); return { symbolId: Number(id), environment, streamEvents: n } })
  assert.ok(over.length >= 1)
  assert.deepEqual(r.replay.symbolsNotReplayed, over)
  assert.deepEqual(r.trials.map(keyOf), counts.filter(c => c[1] <= bound).map(c => c[0]))
  assert.match(replayNotice(r.replay), new RegExp(`${over[0].environment}:${over[0].symbolId} \\(`))
})

// ---- Codex P2 on #1332 (owner "Per side + parity") --------------------------

/** Demo with 250 gaps (recorder-only unless `demoReason` says otherwise), then live with 3 recorder-only, both on id 7. */
function gapHeavySegments(dir, envs = ['demo', 'live'], demoReason = 1) {
  let seq = 1
  const files = []
  for (const env of envs) {
    const start = T0 + (env === 'live' ? 5 : 0)
    const parts = [encodeHeader({ environment: env, generation: 1, startedMs: start, feedId: env })]
    const gapsHere = env === 'demo' ? 250 : 3
    for (let i = 0; i < 600; i++) {
      const t = start + 10 + i * 100
      const bid = (env === 'live' ? 200_000 : 100_000) + (i % 7)
      parts.push(encodeRecord({ recvMs: t, seq: seq++, symbolId: 7, bid, ask: bid + 8, flags: QUOTE, kind: KIND.QUOTE, generation: 1 }))
      if (i % 2 === 0 && i / 2 < gapsHere) parts.push(GAP(env === 'demo' ? demoReason : 1, t + 60))
    }
    const name = `seg-${start}-000001.tks`
    writeFileSync(join(dir, name), Buffer.concat(parts))
    files.push(join(dir, name))
  }
  return files.sort()
}

test('Codex P2 on #1332: the gap list is capped per side, so one side cannot crowd the other out, and each side says whether its list was cut', () => {
  const both = loadSegments(gapHeavySegments(mkdtempSync(join(tmpdir(), 'gapcap-both-')))).manifestBase
  const listed = (env) => both.gaps.filter(g => g.environment === env).length
  assert.equal(both.gapsByReason.queue_overflow, 253, 'every gap is counted')
  assert.equal(listed('demo'), 200, 'demo listed up to its cap')
  assert.equal(listed('live'), 3, 'and live\'s three are listed after it')
  assert.deepEqual(both.gapsTruncatedBySide, { demo: true, live: false })
  assert.deepEqual(both.recorderGapsUnlistedBySide, { demo: 50, live: 0 }, 'how many recorder drops each side\'s list leaves out')
  assert.equal(both.gapsTruncated, true)
  // One side: the list and the manifest as before.
  const one = loadSegments(gapHeavySegments(mkdtempSync(join(tmpdir(), 'gapcap-one-')), ['demo'])).manifestBase
  assert.equal(one.gaps.length, 200)
  assert.equal(one.gapsTruncated, true)
  assert.ok(!('gapsTruncatedBySide' in one))
})

test('Codex P2 on #1332: past the last gap a cut list names, a mismatch reads not comparable (gap_list_truncated), on one side or both', () => {
  // where each kind of manifest's list stops
  const gaps = [{ reason: 'queue_overflow', recvMs: 3_000, count: 1, environment: 'demo' }, { reason: 'queue_overflow', recvMs: 4_000, count: 1, environment: 'demo' }, { reason: 'reconnect', recvMs: 7_000, count: 1, environment: 'live' }]
  const oneSide = (reason) => ({ gapsTruncated: true, gapsByReason: { [reason]: 3 }, gaps: [{ reason, recvMs: 3_000 }, { reason, recvMs: 4_000 }] })
  assert.equal(gapListCutAt(oneSide('queue_overflow')), 4_000, 'one side, cut, a recorder drop left out')
  assert.equal(gapListCutAt({ gapsTruncated: false, gapsByReason: { queue_overflow: 1 }, gaps: [{ reason: 'queue_overflow', recvMs: 3_000 }] }), null, 'one side, whole')
  const bySide = (env, unlisted) => ({ environment: env, gapsTruncated: true, gapsTruncatedBySide: { demo: true, live: false }, recorderGapsUnlistedBySide: { demo: unlisted, live: 0 }, gaps })
  assert.equal(gapListCutAt(bySide('demo', 5)), 4_000, 'both sides: the demo trial\'s own list is cut and leaves recorder drops out')
  assert.equal(gapListCutAt(bySide('live', 5)), null, 'the live trial\'s list is whole, whatever demo\'s was')
  assert.equal(replayRecordOf({ fromMs: 1 }, bySide('demo', 5)).gapsUnlistedAfterMs, 4_000, 'the parity report is handed the cut')
  // Codex P2 on 87257bf6 (owner "Narrow it"): a cut that leaves out only
  // continuity gaps (reconnect, restart, switched_off) excuses nothing — those
  // never excuse a mismatch — so the mismatch past it is still one.
  assert.equal(gapListCutAt(oneSide('reconnect')), null, 'one side: only reconnects left out')
  assert.equal(gapListCutAt({ gapsTruncated: true, gapsByReason: { queue_overflow: 2, reconnect: 250 }, gaps: [{ reason: 'queue_overflow', recvMs: 1_000 }, { reason: 'queue_overflow', recvMs: 2_000 }, { reason: 'reconnect', recvMs: 3_000 }] }), null, 'one side: every recorder drop is listed; the cut left out reconnects')
  assert.equal(gapListCutAt(bySide('demo', 0)), null, 'both sides: no recorder drop left out of demo\'s list')
  const reconnectsOnly = loadSegments(gapHeavySegments(mkdtempSync(join(tmpdir(), 'gapcap-reconnect-')), ['demo', 'live'], 3)).manifestBase
  assert.deepEqual(reconnectsOnly.gapsTruncatedBySide, { demo: true, live: false })
  assert.deepEqual(reconnectsOnly.recorderGapsUnlistedBySide, { demo: 0, live: 0 })
  assert.equal(gapListCutAt({ ...reconnectsOnly, environment: 'demo' }), null, 'from a real manifest: demo\'s cut left out reconnects only')
  assert.equal(gapListCutAt(loadSegments(gapHeavySegments(mkdtempSync(join(tmpdir(), 'gapcap-reconnect-one-')), ['demo'], 3)).manifestBase), null, 'and on one side, from the manifest\'s own reason counts')
  assert.equal(typeof gapListCutAt(loadSegments(gapHeavySegments(mkdtempSync(join(tmpdir(), 'gapcap-overflow-one-')), ['demo'])).manifestBase), 'number', 'while a one-side cut that leaves recorder drops out is a cut')
  // the verdict: a signal the sidecar does not have, in a window past the cut
  const replay = (cut) => ({ fromMs: 1_000, toMs: 100_000, settledFromMs: 2_000, latencyMs: 250, truncated: false, signals: [{ seq: 10, recvMs: 5_000, side: 'BUY' }, { seq: 20, recvMs: 9_000, side: 'SELL' }], trades: [], gaps: [], gapsUnlistedAfterMs: cut })
  const sidecar = { signals: [{ seq: 10, recvMs: 5_000, side: 'BUY' }], trades: [], health: { boots: [{ bootId: 'b1', lo: 1, hi: 50, n: 50 }], lostRestart: 0 } }
  assert.equal(compareParity(replay(null), sidecar).parity, 'mismatch', 'a whole list: a real mismatch')
  const cut = compareParity(replay(4_000), sidecar)
  assert.equal(cut.parity, 'not_comparable')
  assert.ok(cut.reasons.includes('gap_list_truncated'))
  assert.equal(compareParity(replay(4_000), { ...sidecar, signals: replay(null).signals }).parity, 'ok', 'a match past the cut is still a match')
})

// ---- the two Codex P2s on #1330 ---------------------------------------------

/** Writes through node:fs, but at most `max` bytes per call — what a full pipe or a busy disk may do. */
function shortWriter(max) {
  const io = { calls: 0, opened: [], closed: [] }
  io.openSync = (f, m) => { const fd = fsOpenSync(f, m); io.opened.push(fd); return fd }
  io.closeSync = (fd) => { io.closed.push(fd); fsCloseSync(fd) }
  io.writeSync = (fd, buf, off, len) => { io.calls++; return fsWriteSync(fd, buf, off, Math.min(len, max)) }
  return io
}

test('Codex P2 on #1330: a short write to the spill is retried until the whole chunk is on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-short-'))
  const io = shortWriter(1000)
  const spill = createSpill(dir, { io })
  const want = new Map([[7, []], [8, []]])
  for (let i = 0; i < 5000; i++) {
    const id = i % 3 ? 7 : 8
    const q = { seq: i + 1, recvMs: T0 + i, bid: 100_000 + i, ask: 100_010 + i, snapshot: false, crossed: false, changed: true }
    spill.push(id, q); want.get(id).push(q)
    if (i === 2500) { spill.gapAll(); for (const l of want.values()) l.push('gap') }
  }
  spill.close()
  assert.ok(io.calls > (5002 * SPILL_ENTRY_BYTES) / 1000, `${io.calls} writes: the short writer was used and each chunk took several`)
  for (const [id, list] of want) {
    const got = spill.read(id)
    assert.equal(got.length, list.length, `symbol ${id}: every entry came back`)
    got.forEach((q, i) => list[i] === 'gap' ? assert.equal(q.gapMarker, true) : assert.deepEqual(q, list[i]))
  }
})

/** Fails the last, partial flush of each stream with ENOSPC — the write `close()` makes. */
function fullDiskAtClose() {
  const io = shortWriter(Infinity)
  const write = io.writeSync
  io.writeSync = (fd, buf, off, len) => {
    if (len < 2048 * SPILL_ENTRY_BYTES) { const err = new Error('ENOSPC: no space left on device, write'); err.code = 'ENOSPC'; throw err }
    return write(fd, buf, off, len)
  }
  return io
}

test('Codex P2 on #1330: a flush that fails at close still closes every file, and the store removes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spill-enospc-'))
  const io = fullDiskAtClose()
  const spill = createSpill(dir, { io })
  for (let i = 0; i < 300; i++) spill.push(i % 3, { seq: i + 1, recvMs: T0 + i, bid: 1, ask: 2, snapshot: false, crossed: false, changed: true })
  assert.throws(() => spill.close(), { code: 'ENOSPC' })
  assert.equal(io.opened.length, 3)
  assert.deepEqual([...io.closed].sort(), [...io.opened].sort(), 'every file closed, not only the first')
  spill.remove()
  assert.deepEqual(readdirSync(dir), [])
  // remove() without a close first (a refusal mid-decode) closes every file, removes every one, and does not throw.
  const dir2 = mkdtempSync(join(tmpdir(), 'spill-enospc-remove-'))
  const io2 = fullDiskAtClose()
  const spill2 = createSpill(dir2, { io: io2 })
  for (let i = 0; i < 300; i++) spill2.push(i % 3, { seq: i + 1, recvMs: T0 + i, bid: 1, ask: 2, snapshot: false, crossed: false, changed: true })
  spill2.remove()
  assert.deepEqual([...io2.closed].sort(), [...io2.opened].sort())
  assert.deepEqual(readdirSync(dir2), [])
})

test('Codex P2 on #1330: a replay whose spill fails at close throws that error and leaves no spill behind, in its own directory or the job\'s', () => {
  const files = sidesSegments(mkdtempSync(join(tmpdir(), 'spill-enospc-run-')))
  const spillDir = mkdtempSync(join(tmpdir(), 'spill-enospc-dir-'))
  const io = fullDiskAtClose()
  assert.throws(() => replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: 0, spillDir, spillIo: io }), { code: 'ENOSPC' })
  assert.deepEqual(readdirSync(spillDir), [])
  assert.deepEqual([...io.closed].sort(), [...io.opened].sort())
  // With no directory given, replayFiles makes its own under the system temp directory and removes it.
  const ownTmp = mkdtempSync(join(tmpdir(), 'spill-enospc-tmp-'))
  const savedTmp = process.env.TMPDIR
  process.env.TMPDIR = ownTmp
  try {
    assert.throws(() => replayFiles(files, PLAN, loadThresholds().replay, { inMemoryMaxRecords: 0, spillIo: fullDiskAtClose() }), { code: 'ENOSPC' })
  } finally { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp }
  assert.deepEqual(readdirSync(ownTmp), [], 'its own directory removed')
})
