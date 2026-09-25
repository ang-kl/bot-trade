// agent/services/tick-replay-honesty.test.js — PR-Q1 (V3 P6/P7, 25-09-2026):
// replay honesty at the research doors. Provenance (every segment pinned by
// sha256 and bytes, the replayer build, the sim hash), the gap semantics split
// by reason, and the test-block opening ledger: a dry run cannot open it, one
// declared profile only, every opening recorded with the caller, a second
// opening of the same holdout refused — through the in-thread action, the
// keeper job and the route's sync door alike. Client imports are unverified
// and record their openings too.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync as makeTempDir, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

import express from 'express'

import { initDB } from '../db.js'
import actionsRouter from '../routes/actions.js'
import { encodeHeader, encodeRecord, FLAGS, KIND } from '../lib/tick-segment.js'
import { profileHash, normalizeParams, profileHashFull } from '../lib/tick-strategy.js'
import { STATISTICS_VERSION } from '../lib/tick-replay-sim.js'
import { fixtureSegment } from './tick-research-run.test.js'
import {
  tickResearchAction, startTickResearchJob, startTickResearchJobWithSync, tickResearchJob, _resetTickResearchJobs,
  listSegments, loadSegments, runTrials, researchPlan, includeTestRefusal, replayerCommit, RECORDER_ONLY_GAPS,
  blocksRefusal, tickResearchJobsView, SEGMENTS_ENV,
} from './tick-research-run.js'
import { testOpeningsFor, importTickTrial, importClientTrials, tickTrialsView, summaryScopeOf } from './tick-research.js'

const temporaryDirectories = new Set()
const mkdtempSync = (...args) => { const dir = makeTempDir(...args); temporaryDirectories.add(dir); return dir }
after(() => { for (const dir of temporaryDirectories) rmSync(dir, { recursive: true, force: true }) })

const PARAMS = { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }
const SIM = { latencyMs: 60, minTargetToCost: 1 }
const DECLARED = profileHash(normalizeParams(PARAMS))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitDone(id, { maxMs = 60_000 } = {}) {
  const t0 = Date.now()
  for (;;) { const j = tickResearchJob(id); if (j && j.state !== 'running') return j; if (Date.now() - t0 > maxMs) throw new Error('job did not finish'); await sleep(25) }
}
function segDir(buf = fixtureSegment(), prefix = 'tick-q1-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, 'seg-000001.tks'), buf)
  return dir
}

test('provenance: each segment is pinned by sha256 and bytes — one changed byte moves the digest and the trial id; the manifest names the replayer build and the sim hash', () => {
  const buf = fixtureSegment()
  const flipped = Buffer.from(buf); flipped[flipped.length - 1] ^= 0xff // the last record's checksum
  const la = loadSegments(listSegments(segDir(buf))), lb = loadSegments(listSegments(segDir(flipped)))
  const [da] = la.manifestBase.fileDigests, [dbb] = lb.manifestBase.fileDigests
  assert.equal(da.name, 'seg-000001.tks'); assert.equal(da.bytes, buf.length)
  assert.equal(da.sha256, createHash('sha256').update(buf).digest('hex'))
  assert.equal(dbb.bytes, da.bytes, 'same size'); assert.notEqual(dbb.sha256, da.sha256, 'RED if the manifest does not digest the bytes')
  assert.deepEqual(la.manifestBase.environments, ['demo'])
  // the recorder writes whole milliseconds; the replay must compare the same
  // integers the sidecar does (the ns round trip came back as ….9998)
  const times = la.bySymbol.get(7).filter(q => !q.crossed).map(q => q.recvMs)
  assert.ok(times.length > 200 && times.every(Number.isInteger), 'RED on the float round trip: recvMs × 1e6 / 1e6 is not the recorded integer')
  const [ta] = runTrials(la, { params: PARAMS, sim: SIM }), [tb] = runTrials(lb, { params: PARAMS, sim: SIM })
  assert.notEqual(ta.trialId, tb.trialId, 'different bytes are a different trial')
  assert.equal(ta.manifest.replayerCommit, replayerCommit()); assert.match(ta.manifest.simHash, /^[0-9a-f]{16}$/)
  assert.equal(replayerCommit({ RAILWAY_GIT_COMMIT_SHA: 'abc123' }), 'abc123'); assert.equal(replayerCommit({}), null)
})

test('gap semantics: queue_overflow and reserve_pause drop only the recorder\'s queue and reset NO warm-up; restart / reconnect / switched_off still do — counted by reason and listed with their times', () => {
  // A synthetic two-symbol segment: quotes on 1 and 2, an overflow gap, a
  // repeat, more quotes, a restart gap, more quotes.
  const parts = [encodeHeader({ environment: 'live', generation: 1, startedMs: 1_757_548_800_000, feedId: 'gap' })]
  let seq = 1, t = 1_757_548_800_000
  const quote = (sym, bid) => parts.push(encodeRecord({ recvMs: (t += 100), seq: seq++, symbolId: sym, bid, ask: bid + 10, flags: FLAGS.BID_PRESENT | FLAGS.BID_CHANGED | FLAGS.ASK_PRESENT | FLAGS.ASK_CHANGED, kind: KIND.QUOTE, generation: 1 }))
  const gap = (reason) => parts.push(encodeRecord({ recvMs: (t += 100), seq: 0, symbolId: 0, bid: 5, ask: reason, kind: KIND.GAP, generation: 1 }))
  const repeat = (sym) => parts.push(encodeRecord({ recvMs: (t += 100), seq: seq++, symbolId: sym, flags: FLAGS.REPEAT, generation: 1 }))
  quote(1, 100000); quote(2, 200000); quote(1, 100001); quote(2, 200001)
  gap(1)     // queue_overflow
  repeat(1)  // after a dropped span its sides are unknown: dropped, never given stale sides
  quote(1, 100002); quote(2, 200002)
  gap(4)     // restart
  quote(1, 100003); quote(2, 200003)
  const loaded = loadSegments(listSegments(segDir(Buffer.concat(parts), 'tick-q1-gap-')))
  assert.deepEqual(loaded.manifestBase.gapsByReason, { queue_overflow: 1, restart: 1 })
  assert.deepEqual(loaded.manifestBase.gaps.map(g => g.reason), ['queue_overflow', 'restart'])
  assert.ok(loaded.manifestBase.gaps.every(g => g.recvMs > 0 && g.count === 5))
  assert.equal(loaded.manifestBase.warmupResets, 1, 'only the restart resets')
  assert.deepEqual(loaded.manifestBase.environments, ['live'])
  for (const sym of [1, 2]) {
    const list = loaded.bySymbol.get(sym)
    assert.equal(list.filter(q => q.crossed).length, 1, `symbol ${sym}: exactly one warm-up reset (the restart), none for the overflow`)
    assert.equal(list.filter(q => q.changed === false).length, 0, 'the repeat after the overflow gap is dropped')
    assert.equal(list.filter(q => !q.crossed).length, 4)
  }
  assert.ok(RECORDER_ONLY_GAPS.has('queue_overflow') && RECORDER_ONLY_GAPS.has('reserve_pause') && !RECORDER_ONLY_GAPS.has('reconnect'))
  // Behaviour, not only the markers: a gap inside the fixture's warm-up just
  // before its first signal (seq 118). A reconnect re-warms and loses the
  // long; an overflow does not, so the replay keeps both trades — as the live
  // strategy, which never saw a break, did.
  const trades = (gapReason) => runTrials(loadSegments(listSegments(segDir(fixtureSegment({ gapAfter: 100, gapReason }), 'tick-q1-gapfix-'))), { params: PARAMS, sim: { ...SIM, includeTest: true } })[0].summary.trades
  assert.equal(trades(1), 2, 'queue_overflow: no reset, both trades (RED if every gap resets warm-up)')
  assert.equal(trades(2), 2, 'reserve_pause: no reset')
  assert.ok(trades(3) < 2, 'reconnect: the warm-up resets and the first signal is lost')
})

test('includeTest refusals — a dry run, a stage-A grid, no declared profile, a profile the params do not produce — 400 before anything is written; stageA defaults off and maxHoldEvents 0 is 4N in the plan', () => {
  const db = initDB(':memory:')
  const dir = segDir()
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  const cases = [
    [{ includeTest: true, dryRun: true, params: PARAMS, sim: SIM, profileHash: DECLARED }, 'include_test_dry_run'],
    [{ sim: { ...SIM, includeTest: true }, dryRun: true, params: PARAMS, profileHash: DECLARED }, 'include_test_dry_run'],
    [{ includeTest: true, stageA: true, params: PARAMS, sim: SIM, profileHash: DECLARED }, 'include_test_needs_one_profile'],
    [{ includeTest: true, params: PARAMS, sim: SIM }, 'include_test_needs_declared_profile'],
    [{ includeTest: true, params: PARAMS, sim: SIM, profileHash: 'not-hex' }, 'include_test_needs_declared_profile'],
    [{ includeTest: true, params: PARAMS, sim: SIM, profileHash: profileHash(normalizeParams({ ...PARAMS, rangeEvents: 128 })) }, 'include_test_profile_mismatch'],
  ]
  for (const [body, error] of cases) {
    const r = tickResearchAction(db, body, { segmentsDir: dir })
    assert.equal(r.status, 400, error); assert.equal(r.body.error, error)
    assert.equal(includeTestRefusal(body)?.body.error, error, 'the script and the route share the rule')
  }
  assert.equal(count('tick_trials'), 0); assert.equal(count('tick_test_openings'), 0, 'a refused request opens nothing')
  assert.equal(includeTestRefusal({ params: PARAMS, sim: SIM }), null, 'a withheld run is never refused here')
  assert.equal(includeTestRefusal({ includeTest: true, params: PARAMS, profileHash: profileHashFull(normalizeParams(PARAMS)) }), null, 'the full 64-hex hash names the profile too')
  assert.equal(researchPlan({ includeTest: true, profileHash: DECLARED, params: PARAMS }).stageA, false, 'RED if one includeTest POST can open twelve grid points')
  assert.equal(researchPlan({}).stageA, true, 'a withheld request keeps the stage-A default')
  assert.equal(researchPlan({ sim: { includeTest: 'yes' } }).sim.includeTest, undefined, 'only `true` opens the test block, and nothing else is stored as if it had')
  assert.equal('maxHoldEvents' in researchPlan({ sim: { maxHoldEvents: 0 } }).sim, false, '0 is the default 4N: the same stored sim as an absent one')
  assert.equal(researchPlan({ sim: { maxHoldEvents: 40 } }).sim.maxHoldEvents, 40)
})

test('the script beside the spool obeys the same includeTest rule: --include-test needs --profile naming the params\' profile, and never --stage-a', () => {
  const script = new URL('../../scripts/tick-research.mjs', import.meta.url).pathname
  const dir = segDir()
  const run = (args) => {
    try { return { code: 0, stdout: execFileSync(process.execPath, [script, dir, '--params', JSON.stringify(PARAMS), '--sim', JSON.stringify(SIM), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (err) { return { code: err.status, stderr: String(err.stderr) } }
  }
  const bare = run(['--include-test'])
  assert.equal(bare.code, 2); assert.match(bare.stderr, /include_test_needs_declared_profile/)
  const grid = run(['--include-test', '--stage-a', '--profile', DECLARED])
  assert.equal(grid.code, 2); assert.match(grid.stderr, /include_test_needs_one_profile/)
  const ok = run(['--include-test', '--profile', DECLARED])
  assert.equal(ok.code, 0, ok.stderr)
  const [t] = JSON.parse(ok.stdout).trials
  assert.equal(t.sim.includeTest, true); assert.equal(t.summary.scope, 'all_blocks'); assert.equal(t.profileHash, DECLARED)
})

test('opening ledger: a declared includeTest run opens the holdout ONCE — recorded with the caller and its trial ids — and a second opening is refused 409; a profile with a pre-v2 trial is already consulted', () => {
  const db = initDB(':memory:')
  const dir = segDir()
  const body = { includeTest: true, params: PARAMS, sim: SIM, profileHash: DECLARED }
  const actor = 'claude on the owner\'s word via agent_secret'
  const r = tickResearchAction(db, body, { segmentsDir: dir, actor })
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300))
  assert.equal(r.body.includeTest, true); assert.equal(r.body.stageA, false); assert.equal(r.body.trials.length, 1)
  assert.equal(r.body.trials[0].summary.trades, 2, 'the confirmation run reads every block')
  const rows = db.prepare('SELECT * FROM tick_test_openings').all()
  assert.equal(rows.length, 1); assert.equal(rows[0].profile_hash, DECLARED); assert.equal(rows[0].status, 'opened'); assert.equal(rows[0].channel, 'keeper_inline')
  assert.equal(rows[0].actor, actor); assert.deepEqual(JSON.parse(rows[0].trial_ids), r.body.trialIds)
  const origin = JSON.parse(db.prepare('SELECT origin_json FROM tick_trials WHERE trial_id = ?').get(r.body.trialIds[0]).origin_json)
  assert.equal(origin.kind, 'keeper_inline'); assert.equal(origin.verified, true); assert.equal(origin.actor, actor)
  // a second opening of the same holdout: refused, nothing more written
  const again = tickResearchAction(db, body, { segmentsDir: dir })
  assert.equal(again.status, 409); assert.equal(again.body.error, 'second_opening'); assert.equal(again.body.openings.length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_test_openings').get().n, 1)
  // a withheld run of the same profile opens nothing and is not refused
  assert.equal(tickResearchAction(db, { params: PARAMS, sim: SIM, stageA: false }, { segmentsDir: dir }).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_test_openings').get().n, 1)
  // a pre-v2 trial (the stored rows' shape: no statisticsVersion v2) printed
  // the leaking summary — its profile's holdout is ALREADY consulted
  const other = normalizeParams({ ...PARAMS, rangeEvents: 96 })
  const otherHash = profileHash(other)
  importTickTrial(db, { strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: otherHash, params: other, sim: { latencyMs: 250 }, manifest: { files: ['legacy'] }, summary: { trades: 4 }, blocks: [{ name: 'test', withheld: true, trades: null }] })
  const consulted = testOpeningsFor(db, otherHash)
  assert.equal(consulted.consulted, true); assert.equal(consulted.legacyConsultedTrials, 1); assert.equal(consulted.openings.length, 0)
  const legacyOpen = tickResearchAction(db, { includeTest: true, params: other, sim: SIM, profileHash: otherHash }, { segmentsDir: dir })
  assert.equal(legacyOpen.status, 409); assert.equal(legacyOpen.body.error, 'second_opening'); assert.equal(legacyOpen.body.legacyConsultedTrials, 1)
})

test('job path: a keeper job records its opening with the job id and the caller, its trials carry origin keeper_job; the sync door refuses an includeTest dry run and a second opening before listing or pulling', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = segDir()
  const body = { includeTest: true, params: PARAMS, sim: SIM, profileHash: DECLARED }
  const started = startTickResearchJob(db, body, { segmentsDir: dir, actor: 'owner (device session)' })
  assert.equal(started.status, 202, JSON.stringify(started.body).slice(0, 300))
  assert.equal(started.body.includeTest, true); assert.equal(started.body.origin.kind, 'keeper_job'); assert.equal(started.body.origin.jobId, started.body.jobId)
  const row = db.prepare('SELECT * FROM tick_test_openings').get()
  assert.equal(row.job_id, started.body.jobId, 'on the ledger from the moment the worker can read the test block'); assert.equal(row.actor, 'owner (device session)')
  const done = await waitDone(started.body.jobId)
  assert.equal(done.state, 'done', JSON.stringify(done).slice(0, 300))
  assert.equal(done.opening.id, row.id, 'the polled job names its opening')
  assert.equal(db.prepare('SELECT status FROM tick_test_openings WHERE id = ?').get(row.id).status, 'opened')
  const origin = JSON.parse(db.prepare('SELECT origin_json FROM tick_trials').get().origin_json)
  assert.equal(origin.kind, 'keeper_job'); assert.equal(origin.jobId, started.body.jobId); assert.equal(origin.actor, 'owner (device session)')
  const second = startTickResearchJob(db, body, { segmentsDir: dir })
  assert.equal(second.status, 409); assert.equal(second.body.error, 'second_opening')
  let listed = 0, pulled = 0
  const door = (b) => startTickResearchJobWithSync(db, b, {
    segmentsDir: mkdtempSync(join(tmpdir(), 'tick-q1-none-')), cacheDir: mkdtempSync(join(tmpdir(), 'tick-q1-cache-')),
    listAll: async () => { listed++; return { segments: 0, names: [], records: 0, sides: [] } },
    sync: async () => { pulled++; return { pulled: 0, sides: [] } },
  })
  const dry = await door({ ...body, dryRun: true })
  assert.equal(dry.status, 400); assert.equal(dry.body.error, 'include_test_dry_run')
  const twice = await door(body)
  assert.equal(twice.status, 409); assert.equal(twice.body.error, 'second_opening')
  assert.equal(listed, 0, 'nothing listed'); assert.equal(pulled, 0, 'no byte pulled for a request that is refused')
  _resetTickResearchJobs()
})

test('client imports (POST /actions/tick-trials): stored as client_import, UNVERIFIED, with the caller; an includeTest import records its opening once per profile, and a second import of the same holdout is recorded AND refused', () => {
  const db = initDB(':memory:')
  const loaded = loadSegments(listSegments(segDir()))
  const withheld = runTrials(loaded, { params: PARAMS, sim: SIM })
  const opened = runTrials(loaded, { params: PARAMS, sim: { ...SIM, includeTest: true } })
  const plain = importClientTrials(db, withheld, { actor: 'agent-secret holder (undeclared)' })
  assert.equal(plain[0].ok, true); assert.equal(plain[0].origin, 'client_import')
  const o = JSON.parse(db.prepare('SELECT origin_json FROM tick_trials WHERE trial_id = ?').get(plain[0].trialId).origin_json)
  assert.equal(o.kind, 'client_import'); assert.equal(o.verified, false); assert.equal(o.actor, 'agent-secret holder (undeclared)')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_test_openings').get().n, 0, 'a withheld import opens nothing')
  // two trials of one profile in one import are ONE opening (one per symbol is the same run)
  const first = importClientTrials(db, [opened[0], { ...opened[0], manifest: { ...opened[0].manifest, symbolId: 8 }, trialId: undefined }], { actor: 'x via agent_secret' })
  assert.ok(first.every(f => f.ok)); assert.equal(first[0].opening, 'recorded'); assert.equal(first[1].opening, 'same_import')
  const rows = () => db.prepare('SELECT channel, status, actor FROM tick_test_openings ORDER BY id').all()
  assert.deepEqual(rows(), [{ channel: 'client_import', status: 'opened', actor: 'x via agent_secret' }])
  // Q1 follow-up (checker N9): the SAME trial imported again is a retry of an
  // import that already landed, not a second opening — nothing more written
  const retry = importClientTrials(db, [opened[0]], { actor: 'y via agent_secret' })
  assert.equal(retry[0].ok, true); assert.equal(retry[0].inserted, false); assert.equal(retry[0].opening, 'already_stored')
  assert.deepEqual(rows().map(r => r.status), ['opened'], 'RED if a retried import is refused and writes a refused_second_opening row')
  // a DIFFERENT trial of the same profile (another data set) is a second opening
  const other = { ...opened[0], manifest: { ...opened[0].manifest, files: ['seg-other.tks'] }, trialId: undefined }
  const second = importClientTrials(db, [other, other], { actor: 'y via agent_secret' })
  assert.equal(second[0].ok, false); assert.equal(second[0].reason, 'second_opening'); assert.equal(second[1].reason, 'second_opening')
  assert.deepEqual(rows().map(r => r.status), ['opened', 'refused_second_opening'], 'recorded once, refused')
  // Q1 follow-up (checker N11): an opening is recorded against the profile the
  // params produce; a trial naming another profile is refused, not stored
  const named = { ...opened[0], profileHash: 'aaaaaaaaaaaaaaaa', trialId: undefined }
  const mis = importClientTrials(db, [named], { actor: 'z via agent_secret' })
  assert.equal(mis[0].ok, false); assert.equal(mis[0].reason, 'profile_mismatch'); assert.equal(mis[0].paramsProfile, DECLARED)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tick_trials WHERE profile_hash = 'aaaaaaaaaaaaaaaa'`).get().n, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tick_test_openings WHERE profile_hash = 'aaaaaaaaaaaaaaaa'`).get().n, 0, 'RED if the opening is recorded against the named profile')
  // the view says where every row came from and counts the openings over the whole ledger
  const v = tickTrialsView(db, { profile: DECLARED, limit: 'all' })
  assert.ok(v.trials.every(t => t.origin.kind === 'client_import' && t.origin.verified === false && t.parityRecorded === true))
  const led = v.ledger.profiles.find(p => p.profileHash === DECLARED)
  assert.equal(led.openings, 1); assert.equal(led.refusedOpenings, 1); assert.equal(led.includeTestTrials, 2); assert.equal(led.consulted, true)
})

// ---- Q1 follow-up: the checker's blockers and nits ----------------------------
const count = (db, t, where = '') => db.prepare(`SELECT COUNT(*) AS n FROM ${t} ${where}`).get().n

test('Q1 follow-up (checker B2): a pre-v2 row replayed WITH includeTest is consulted at the gate exactly as the view says — the second opening is refused', () => {
  const db = initDB(':memory:')
  // v1, includeTest: scope all_blocks, not all_blocks_legacy_leak — the gate
  // counted only the latter, so the view said testConsulted while the gate let
  // a second opening through
  importTickTrial(db, { strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: DECLARED, params: normalizeParams(PARAMS), sim: { latencyMs: 250, includeTest: true, statisticsVersion: 'mtm-moving-block-v1' }, manifest: { files: ['legacy-open'] }, summary: { trades: 4 }, blocks: [{ name: 'test', trades: 3, netR: 1 }] })
  const view = tickTrialsView(db, { profile: DECLARED })
  assert.equal(view.trials[0].summaryScope, 'all_blocks'); assert.equal(view.trials[0].testConsulted, true)
  const gate = testOpeningsFor(db, DECLARED)
  assert.equal(gate.consulted, true, 'RED if the gate counts only all_blocks_legacy_leak rows')
  assert.equal(gate.consultedTrials, 1); assert.equal(gate.legacyConsultedTrials, 0)
  const led = view.ledger.profiles.find(p => p.profileHash === DECLARED)
  assert.equal(led.consulted, true); assert.equal(led.consultedTrials, 1)
  const r = tickResearchAction(db, { includeTest: true, params: PARAMS, sim: SIM, profileHash: DECLARED }, { segmentsDir: segDir() })
  assert.equal(r.status, 409); assert.equal(r.body.error, 'second_opening'); assert.equal(r.body.consultedTrials, 1)
  assert.equal(count(db, 'tick_test_openings'), 0, 'refused before anything is opened')
})

test('Q1 follow-up (checker B3): sim.blocks other than 3 is refused at every research door before anything is read; a stored v2 trial whose summary covers every block — or that was cut in 4 — is consulted; an unknown statistics version is consulted, not called a leak', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = segDir()
  for (const blocks of [1, 2, 4, '3', null]) {
    const body = { params: PARAMS, sim: { ...SIM, blocks }, stageA: false }
    const inline = tickResearchAction(db, body, { segmentsDir: dir })
    assert.equal(inline.status, 400, `blocks ${JSON.stringify(blocks)}`); assert.equal(inline.body.error, 'blocks_fixed')
    assert.equal(startTickResearchJob(db, body, { segmentsDir: dir }).body.error, 'blocks_fixed')
    assert.equal(blocksRefusal(body)?.body.error, 'blocks_fixed', 'the script shares the rule')
  }
  let listed = 0
  const door = await startTickResearchJobWithSync(db, { params: PARAMS, sim: { ...SIM, blocks: 1 } }, {
    segmentsDir: mkdtempSync(join(tmpdir(), 'tick-q1-none-')), cacheDir: mkdtempSync(join(tmpdir(), 'tick-q1-cache-')),
    listAll: async () => { listed++; return { segments: 0, names: [], records: 0, sides: [] } }, sync: async () => ({ pulled: 0, sides: [] }),
  })
  assert.equal(door.status, 400); assert.equal(door.body.error, 'blocks_fixed'); assert.equal(listed, 0, 'refused before listing')
  assert.equal(count(db, 'tick_trials'), 0); assert.equal(count(db, 'tick_test_openings'), 0)
  assert.equal(tickResearchJobsView().running, null, 'no job started')
  assert.equal(blocksRefusal({ sim: { blocks: 3 } }), null); assert.equal(blocksRefusal({ sim: {} }), null)
  assert.equal(tickResearchAction(db, { params: PARAMS, sim: { ...SIM, blocks: 3 }, stageA: false }, { segmentsDir: dir }).status, 200, 'the default cut stated explicitly is fine')
  // the script refuses the same way
  const script = new URL('../../scripts/tick-research.mjs', import.meta.url).pathname
  let scriptCode = 0, scriptErr = ''
  try { execFileSync(process.execPath, [script, dir, '--params', JSON.stringify(PARAMS), '--sim', JSON.stringify({ ...SIM, blocks: 1 })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { scriptCode = err.status; scriptErr = String(err.stderr) }
  assert.equal(scriptCode, 2); assert.match(scriptErr, /blocks_fixed/)
  // what those doors used to store: v2 rows whose summary read the test block
  const loaded = loadSegments(listSegments(dir))
  const [one] = runTrials(loaded, { params: PARAMS, sim: { ...SIM, blocks: 1 } })
  const [four] = runTrials(loaded, { params: PARAMS, sim: { ...SIM, blocks: 4 } })
  const [three] = runTrials(loaded, { params: PARAMS, sim: SIM })
  assert.equal(one.sim.statisticsVersion, STATISTICS_VERSION); assert.equal(one.summary.scope, 'all_blocks')
  assert.equal(summaryScopeOf(one.sim, one.summary), 'all_blocks', 'RED if the scope is read from sim alone (v2 ⇒ train_validation)')
  assert.equal(four.summary.scope, 'train_validation'); assert.equal(summaryScopeOf(four.sim, four.summary), 'nonstandard_blocks')
  assert.equal(summaryScopeOf(three.sim, three.summary), 'train_validation', 'the default withheld run is still unconsulted')
  // (N8) a future version is not a v1 leak, and not trusted as withheld either
  assert.equal(summaryScopeOf({ statisticsVersion: 'mtm-moving-block-v3' }, { scope: 'train_validation' }), 'unknown_statistics_version')
  assert.equal(summaryScopeOf({ statisticsVersion: 'mtm-moving-block-v1' }), 'all_blocks_legacy_leak'); assert.equal(summaryScopeOf({}), 'all_blocks_legacy_leak')
  for (const [trial, label] of [[one, 'blocks 1'], [four, 'blocks 4']]) {
    const d = initDB(':memory:')
    importTickTrial(d, trial)
    assert.equal(testOpeningsFor(d, DECLARED).consulted, true, `${label}: the gate counts it`)
    assert.equal(tickTrialsView(d, { profile: DECLARED }).trials[0].testConsulted, true, `${label}: the view says so`)
    const again = tickResearchAction(d, { includeTest: true, params: PARAMS, sim: SIM, profileHash: DECLARED }, { segmentsDir: dir })
    assert.equal(again.status, 409, `${label}: a later opening is a second opening`)
  }
  const clean = initDB(':memory:')
  importTickTrial(clean, three)
  assert.equal(testOpeningsFor(clean, DECLARED).consulted, false)
  // the client-import door records the opening such a trial made off-box
  const imp = initDB(':memory:')
  const [res] = importClientTrials(imp, [one], { actor: 'x via agent_secret' })
  assert.equal(res.ok, true); assert.equal(res.opening, 'recorded')
  assert.deepEqual(imp.prepare('SELECT channel, status FROM tick_test_openings').all(), [{ channel: 'client_import', status: 'opened' }])
})

test('Q1 follow-up (checker N3): the job\'s opening is written BEFORE its worker starts — a write that throws starts nothing and leaves the slot free; a worker that cannot start settles its opening failed_unseen', () => {
  _resetTickResearchJobs()
  const dir = segDir()
  const body = { includeTest: true, params: PARAMS, sim: SIM, profileHash: DECLARED }
  let started = 0
  class Idle { constructor() { started++ } on() {} terminate() {} }
  const db = initDB(':memory:')
  db.exec('DROP TABLE tick_test_openings')
  assert.throws(() => startTickResearchJob(db, body, { segmentsDir: dir, workerCtor: Idle }), /tick_test_openings/)
  assert.equal(started, 0, 'RED if the worker starts before the opening is on the ledger')
  assert.equal(tickResearchJobsView().running, null, 'RED if the single-job slot is left taken (every later POST 409 until a restart)')
  class Broken { constructor() { throw new Error('no thread') } }
  const db2 = initDB(':memory:')
  const failed = startTickResearchJob(db2, body, { segmentsDir: dir, workerCtor: Broken })
  assert.equal(failed.status, 500); assert.equal(failed.body.error, 'worker_start_failed')
  assert.deepEqual(db2.prepare('SELECT status FROM tick_test_openings').all(), [{ status: 'failed_unseen' }], 'recorded, and settled as read by no one')
  assert.equal(testOpeningsFor(db2, DECLARED).consulted, false, 'failed_unseen consumes nothing')
  assert.equal(tickResearchJobsView().running, null)
  _resetTickResearchJobs()
})

test('Q1 follow-up (checker N2): a withheld trial carries the SCOPED rejected counters — a signal cost-screened inside the test block is not in them', () => {
  const loaded = loadSegments(listSegments(segDir()))
  const screen = { ...SIM, minTargetToCost: 1e9 } // every signal is cost-screened
  const [open] = runTrials(loaded, { params: PARAMS, sim: { ...screen, includeTest: true } })
  const [w] = runTrials(loaded, { params: PARAMS, sim: screen })
  assert.equal(open.rejected.cost, 2, 'the whole run screens both of the fixture\'s signals')
  assert.equal(w.rejected.cost, 1, 'RED if the withheld trial carries the whole run\'s counters: the second signal is in the test block')
  assert.deepEqual(w.rejected, { cost: w.summary.diagnostics.costRejected, noFill: w.summary.diagnostics.noFill })
})

test('Q1 follow-up (checker N1): POST /actions/tick-research carries the CALLER into the job — its origin, its opening and its trials — through the real route', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = segDir()
  const prev = process.env[SEGMENTS_ENV]
  process.env[SEGMENTS_ENV] = dir
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.authCredential = 'agent_secret'; next() }) // what index.js's authMiddleware stamps
  app.use('/actions', actionsRouter(db))
  const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)) })
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/actions/tick-research`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-actor': 'claude' }, body: JSON.stringify({ includeTest: true, params: PARAMS, sim: SIM, profileHash: DECLARED }) })
    const b = await r.json()
    assert.equal(r.status, 202, JSON.stringify(b).slice(0, 300))
    assert.equal(b.origin.actor, 'claude via agent_secret', 'RED if the route does not hand the caller to the job')
    assert.equal(db.prepare('SELECT actor FROM tick_test_openings').get().actor, 'claude via agent_secret')
    const done = await waitDone(b.jobId)
    assert.equal(done.state, 'done', JSON.stringify(done).slice(0, 300))
    assert.equal(JSON.parse(db.prepare('SELECT origin_json FROM tick_trials').get().origin_json).actor, 'claude via agent_secret')
  } finally {
    s.close()
    if (prev === undefined) delete process.env[SEGMENTS_ENV]; else process.env[SEGMENTS_ENV] = prev
    _resetTickResearchJobs()
  }
})
