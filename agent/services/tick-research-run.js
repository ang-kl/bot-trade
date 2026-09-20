// ---------------------------------------------------------------------------
// agent/services/tick-research-run.js — PR-H (owner principle 3: a
// codebase-built blockage is addressed, not carried). The stage-A replay
// research as an OPERATOR ACTION, not only a shell script.
//
// The blockage: the sealed spool segments live on the DEMO sidecar's volume
// (cpp-exec, TICK_SPOOL_PATH=/data/tick), and scripts/tick-research.mjs
// runs only where it can read them — which the Node keeper cannot, and the
// sidecar exposes no segment download (GET /tick-status lists counts and
// the mount, not files; there is no GET /tick-segments). So the route built
// here is HONEST about locality: it replays the segments reachable at
// TICK_SEGMENTS_DIR (env, optional — a mounted or copied directory of
// seg-*.tks files) and imports every trial into tick_trials through the
// same importTickTrial the script's JSON goes through; when that directory
// is unset, missing or holds no segment it answers 409 `no_segments` and
// says where the data is. It never fabricates a trial: a trial in the
// ledger was replayed over segments that were there.
//
// Checker M-1 (11-09-2026): the replay is CPU-bound for seconds to minutes
// (a 200k-quote / 4-symbol grid measured 48.8 s) and must not run on the
// keeper's event loop — the heartbeat, the guard sync and /health share it.
// So the route starts ONE job at a time in a worker thread
// (tick-research-worker.js; 202 + jobId; GET /state/tick-research-job), a
// second POST while one runs is 409 research_running, and a directory over
// MAX_RECORDS (counted from file sizes, no decode) is refused 413
// too_many_records. The trial import and the verdict shaping stay on the
// main thread (SQLite is not shared across threads); the decode + sims run
// in the worker. `tickResearchAction` is the same pipeline in-thread for
// the script and for tests.
//
// The script keeps working (it calls listSegments / loadSegments /
// runTrials below), so the "beside the spool" path — copy the segments off
// the volume, run the script, POST /actions/tick-trials — is the same code
// as the route.
//
// PR-EX (20-09-2026): `maxSegments` — the operator's bound on how many
// sealed segments one job replays. Measured that morning on production, the
// demo sidecar had sealed 4 × 64 MiB segments = 6,710,880 records and every
// POST answered 413 too_many_records against MAX_RECORDS (5,000,000),
// telling the operator to "copy a subset to TICK_SEGMENTS_DIR" — through a
// door that does not exist: the segments are on a Railway volume the keeper
// reaches only through GET /tick-segment. So the whole replay rung was
// unreachable on this deployment. `maxSegments` is that subset, asked for
// explicitly: the OLDEST n segments are pulled (the sync already bounds the
// same way) and replayed, the record cap is applied to what remains, and
// every report — the 202, the polled job, the trial manifest — says which
// segments were replayed and how many were left. Absent, nothing changes.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { readSegment, toQuoteEvents, FORMAT_VERSION, HEADER_BYTES, RECORD_BYTES } from '../lib/tick-segment.js'
import { simulate } from '../lib/tick-replay-sim.js'
import { normalizeParams } from '../lib/tick-strategy.js'
import { trialIdFor, importTickTrial } from './tick-research.js'
import { loadThresholds, replayChecks } from './tick-validation.js'
import { loadRepoSchedule, TICK_COST_MAP_KEY } from '../lib/tick-cost-schedule.js'
import { getState } from '../db.js'

export const SEGMENTS_ENV = 'TICK_SEGMENTS_DIR'
export const NO_SEGMENTS_WHERE = 'the sealed segments are on the demo sidecar volume (cpp-exec, TICK_SPOOL_PATH); set TICK_SEGMENTS_DIR on the keeper to a directory holding seg-*.tks files, or run scripts/tick-research.mjs beside the spool and POST /actions/tick-trials'
/** PR-I: the same refusal once the sidecar itself has been asked and had nothing. */
export const NO_SEGMENTS_ANYWHERE = 'no sealed segment is reachable: TICK_SEGMENTS_DIR names none, and no sidecar side with a tick recorder served one on GET /tick-segments (see GET /state/tick-segments for what each side reports)'
/** Records the keeper will replay in one job; above it the request is refused, never queued. */
export const MAX_RECORDS = 5_000_000
/** The stored note's cap (checker m-3: an unbounded body.note was stored whole). */
export const NOTE_MAX = 500
/**
 * PR-EX (20-09-2026, owner principle 3). Measured on production that
 * morning: the demo sidecar had sealed 4 × 64 MiB segments = 6,710,880
 * records and POST /actions/tick-research answered 413 too_many_records
 * against MAX_RECORDS (5,000,000) on every call. The refusal told the
 * operator to "copy a subset to TICK_SEGMENTS_DIR" — but the segments live
 * on a Railway volume the keeper reaches ONLY through GET /tick-segment,
 * so there was no way to copy anything: a remedy naming a door that does
 * not open. REPLAY_PASSED was therefore unreachable on this deployment
 * (/state/tick-research: `trials: []`; every account failing
 * replay_evidence / profile_pinned / profile_matches_sidecar /
 * validation_stage).
 *
 * `maxSegments` is the door: an OPERATOR-SET bound on how many sealed
 * segments one job replays, defaulting to "all of them" so nothing about
 * the unbounded path changes. It is deliberately explicit — the keeper
 * never silently replays a subset and calls it the whole spool, because a
 * trial that claims more evidence than it saw is the failure this repo
 * keeps paying for.
 */
export const BAD_MAX_SEGMENTS_WHERE = 'maxSegments bounds how many sealed segments one job replays; it must be a whole number >= 1. Omit it to replay every reachable segment.'
export const WORKER_FILE = new URL('./tick-research-worker.js', import.meta.url)
/**
 * Slack above `MAX_RECORDS × RECORD_BYTES` when bounding a sync: each
 * segment carries a 64-byte header, and a segment that straddles the cap is
 * pulled whole or not at all. 500 headers plus one 64 MiB segment.
 */
export const SYNC_HEADROOM_BYTES = (500 * HEADER_BYTES) + (64 * 1024 * 1024)

/** The plan's stage-A grid: twelve N × efficiency combinations, the rest frozen. */
export function stageAGrid() {
  return [128, 256, 512, 1024].flatMap(N => [0.25, 0.4, 0.55].map(E => ({ rangeEvents: N, momentumEvents: N / 4, minEfficiency: E })))
}

/** The segment files under a directory (or the one file named), sorted. */
export function listSegments(target) {
  if (!target || !existsSync(target)) return []
  return statSync(target).isDirectory()
    ? readdirSync(target).filter(f => f.startsWith('seg-') && f.endsWith('.tks')).sort().map(f => join(target, f))
    : [target]
}

/** Records across the files, from their sizes alone (no decode). */
export function segmentRecordCount(files) {
  let n = 0
  for (const f of files) { try { n += Math.max(0, Math.floor((statSync(f).size - HEADER_BYTES) / RECORD_BYTES)) } catch { /* unreadable: counts nothing */ } }
  return n
}

/**
 * The operator's `maxSegments`, validated ONCE for every entry point
 * (`tickResearchAction`, `startTickResearchJob`, `startTickResearchJobWithSync`
 * and `researchPlan` all read this function, never `body.maxSegments`).
 * Absent is `{ value: null }` — replay everything, the behaviour before
 * PR-EX. Anything present and not a whole number >= 1 is REFUSED 400
 * naming the value: coercing 0, -1, 1.5 or "two" to null would silently
 * replay the whole spool for an operator who asked for a bounded subset,
 * and the 413 they then get says nothing about why.
 */
export function maxSegmentsFrom(body = {}) {
  const raw = body == null ? undefined : body.maxSegments
  if (raw == null) return { value: null }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return { refuse: { status: 400, body: { ok: false, error: 'bad_max_segments', maxSegments: raw === undefined ? null : raw, where: `${BAD_MAX_SEGMENTS_WHERE} Got ${JSON.stringify(raw)}.` } } }
  }
  return { value: raw }
}

/**
 * How many segments, taken OLDEST FIRST in the given order, fit under
 * `maxRecords`. Computed from the per-segment record counts the caller
 * measured (file sizes locally, listed bytes for the sidecar pre-flight) —
 * never a hardcoded number, because segment sizes are a runtime fact and a
 * refusal that names the wrong number is worse than one that names none.
 */
export function segmentsThatFit(recordsPerSegment, maxRecords) {
  let total = 0, n = 0
  for (const r of recordsPerSegment) { if (total + r > maxRecords) break; total += r; n++ }
  return n
}

/**
 * The per-segment record counts a sidecar LISTING carries, or null when it
 * does not carry them. Checker, 20-09-2026: the first version spread the
 * aggregate evenly across the listed segments when the field was missing —
 * a guess dressed as a measurement, and one that names a `maxSegments` the
 * next request would 413 on again whenever the last sealed segment is short.
 * A refusal that cannot measure the remedy now says so instead.
 */
export function listedRecordsPerSegment(listed) {
  return Array.isArray(listed?.recordsPerSegment) && listed.recordsPerSegment.length === (listed.names?.length ?? listed.recordsPerSegment.length)
    ? listed.recordsPerSegment
    : null
}

/**
 * Decode segments into per-symbol oracle quote streams (the replayer's
 * input) and the manifest base. A gap marker invalidates continuity: the
 * sim sees it as a crossed (invalid) quote, which the strategy treats as a
 * warm-up reset. Repeats stay in the stream as unchanged observations
 * carrying the last quote's sides (they count nowhere, they invalidate
 * nothing) — the last valid quote is kept per symbol in a Map, O(1) per
 * repeat (checker M-2: a reverse scan per repeat was quadratic, 9.3 s on
 * 40k + 40k).
 */
export function loadSegments(files, { onlySymbol = null } = {}) {
  const bySymbol = new Map()
  const lastValid = new Map() // symbolId → the last two-sided quote pushed
  let events = 0, torn = 0, firstMs = null, lastMs = null
  for (const f of files) {
    const seg = readSegment(readFileSync(f))
    if (!seg.header) continue
    if (seg.truncated) torn++
    for (const ev of toQuoteEvents(seg)) {
      if (ev.gap) { for (const list of bySymbol.values()) list.push({ gapMarker: true }); lastValid.clear(); continue }
      if (ev.repeat) {
        // An identical repeat carries the SAME prices as the last quote
        // (that is what makes it a repeat); it counts nowhere (plan §4) but
        // must not invalidate continuity. The script used to push it with
        // null sides, which the oracle reads as a missing side and re-warms
        // on (tick-strategy.js: the null check precedes the repeat check) —
        // measured PR-H on the planted fixture: 1 trade over the segment
        // path against 2 in memory. Now it carries the last quote's sides.
        const prev = lastValid.get(ev.symbolId)
        const list = bySymbol.get(ev.symbolId)
        if (list && prev) list.push({ seq: ev.seq, recvMs: ev.recvMs, bid: prev.bid, ask: prev.ask, snapshot: false, crossed: false, changed: false })
        continue
      }
      if (ev.invalid) continue
      if (onlySymbol != null && ev.symbolId !== onlySymbol) continue
      const list = bySymbol.get(ev.symbolId) || []
      const ms = ev.recvMonoNs / 1e6
      const q = { seq: ev.seq, recvMs: ms, bid: ev.bid, ask: ev.ask, snapshot: ev.quality.snapshot, crossed: ev.quality.crossed, changed: true }
      list.push(q)
      bySymbol.set(ev.symbolId, list)
      if (q.bid != null && q.ask != null) lastValid.set(ev.symbolId, q)
      events++
      if (firstMs == null || ms < firstMs) firstMs = ms
      if (lastMs == null || ms > lastMs) lastMs = ms
    }
  }
  for (const list of bySymbol.values()) for (const q of list) if (q.gapMarker) Object.assign(q, { seq: 0, recvMs: 0, bid: 1, ask: 0, crossed: true, snapshot: false, changed: true })
  const manifestBase = { files: files.map(f => basename(f)), events, symbols: [...bySymbol.keys()], torn, fromMs: firstMs, toMs: lastMs, decoderVersion: FORMAT_VERSION }
  return { bySymbol, manifestBase }
}

/**
 * One trial per grid point per symbol (copies across accounts are one
 * exposure, never summed). Plan §7: the test block is withheld unless
 * sim.includeTest is set — the owner's one confirmation run.
 */
export function runTrials({ bySymbol, manifestBase }, { stageA = false, params = {}, sim = {}, symbolClass = null } = {}) {
  const grid = stageA ? stageAGrid() : [params]
  const trials = []
  for (const g of grid) {
    const p = normalizeParams({ ...params, ...g })
    for (const [symbolId, list] of bySymbol) {
      // PR-L: the cost class for THIS symbol id, from the keeper's pushed map.
      // When the id is NOT in the map the schedule is left off entirely rather
      // than charging the dearest fallback: a research run must still produce
      // a readable trial, and the trial then records costSource 'none', which
      // replayChecks REFUSES. Charging the fallback instead made the cost
      // screen reject every signal, so the run produced no trades at all and
      // said nothing about why.
      const cls = symbolClass && symbolClass[String(symbolId)]
      const symSim = cls ? { ...sim, costClass: cls } : { ...sim, costs: null, costClass: null }
      const r = simulate(list, p, symSim)
      const trial = { strategyId: r.strategyId, strategyVersion: r.strategyVersion, profileHash: r.profileHash, params: r.params, sim: r.sim, manifest: { ...manifestBase, symbolId, symbolEvents: list.length }, summary: r.summary, blocks: r.blocks, rejected: r.rejected }
      trial.trialId = trialIdFor(trial)
      trials.push(trial)
    }
  }
  return trials
}

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {}

/**
 * PR-L: the cost schedule a replay trial should be charged, and the symbol
 * id → class map to charge it by. The schedule is the repo's; the map is the
 * union of what the keeper last pushed per side (a segment's symbol ids are
 * that side's ids, and the two sides do not collide in practice — where they
 * would, the first side's class wins and the trial records which class it
 * used, so the choice is auditable rather than hidden).
 */
export function replayCostContext(db) {
  const costSchedule = loadRepoSchedule()
  const symbolClass = {}
  try {
    const stored = JSON.parse(getState(db, TICK_COST_MAP_KEY) || '{}') || {}
    for (const side of Object.values(stored)) {
      for (const [id, cls] of Object.entries(side?.symbolClass || {})) if (!symbolClass[id]) symbolClass[id] = cls
    }
  } catch { /* no map pushed yet — every trial then reads costSource 'fallback' and cannot pass */ }
  return { costSchedule, symbolClass }
}

/** The request body, normalised once (shared by the in-thread action and the job). */
export function researchPlan(body = {}, { costSchedule = null, symbolClass = null } = {}) {
  const sim = { ...plain(body.sim) }
  if (body.includeTest === true) sim.includeTest = true
  // PR-L (checker, on §16.7): a replay trial used to default `sim` to {} —
  // zero cost — so REPLAY_PASSED could be cleared at no cost while
  // SHADOW_PASSED is now charged. Both rungs of the ladder were free. The
  // schedule now rides the plan, and runTrials resolves the CLASS per symbol
  // id from the map the keeper pushed to the sidecar (a trial knows only the
  // symbol ID, never the name). A body that names its own `costs` wins, so a
  // deliberate zero-cost research run is still possible — it just cannot pass
  // the stage, because replayChecks refuses an uncharged trial.
  if (!sim.costs && costSchedule && Object.keys(costSchedule.classes || {}).length) sim.costs = costSchedule
  const symbolClassMap = symbolClass && typeof symbolClass === 'object' ? symbolClass : null
  const rawNote = body.note == null ? null : String(body.note)
  const noteTruncated = rawNote != null && rawNote.length > NOTE_MAX
  // PR-EX: the operator's segment bound rides the plan so every report of
  // the run says the subset was DELIBERATE. An invalid value is refused 400
  // by `maxSegmentsFrom` at the entry points before this is reached; the
  // null here is the absent case, not a coercion.
  const bounded = maxSegmentsFrom(body)
  return {
    maxSegments: bounded.refuse ? null : bounded.value,
    stageA: body.stageA !== false,
    dryRun: body.dryRun === true,
    params: plain(body.params),
    sim,
    onlySymbol: body.symbol != null && Number.isFinite(Number(body.symbol)) ? Number(body.symbol) : null,
    symbolClass: symbolClassMap,
    note: rawNote == null ? null : rawNote.slice(0, NOTE_MAX),
    noteTruncated,
  }
}

/**
 * The CPU-bound half, pure: decode the files, run the sims, judge each
 * trial against the replay thresholds. Returns null when the files decode
 * to no valid quote event. Runs in the worker for the route, in-thread for
 * the script and `tickResearchAction`.
 */
export function replayFiles(files, plan, replayThresholds) {
  const loaded = loadSegments(files, { onlySymbol: plan.onlySymbol })
  if (!loaded.manifestBase.events) return null
  // Checker, 20-09-2026: the manifest named the files replayed and nothing
  // else, so a bounded run and an unbounded run over a two-segment spool
  // persisted identically — `maxSegments`, `segmentsAvailable` and
  // `segmentsDropped` died at the persistence boundary with the job object.
  // These rows are the evidence that clears REPLAY_PASSED; a row that cannot
  // say it saw 2 of 4 is a half-truth the moment the process restarts. The
  // fields ride into `trialIdFor` with the rest of the manifest, so two
  // different subsets cannot collide on a trial id. Only written when a
  // bound was SET: an unbounded run saw everything, and adding null fields
  // would re-key every existing trial.
  if (plan.maxSegments != null) {
    Object.assign(loaded.manifestBase, {
      maxSegments: plan.maxSegments,
      segmentsAvailable: plan.segmentsAvailable ?? files.length,
      segmentsDropped: plan.segmentsDropped ?? 0,
    })
  }
  const trials = runTrials(loaded, { stageA: plan.stageA, params: plan.params, sim: plan.sim, symbolClass: plan.symbolClass })
  return { manifest: loaded.manifestBase, trials: trials.map(t => ({ trial: t, verdict: replayChecks(t, replayThresholds) })) }
}

/** The main-thread half: import (unless dry) and shape the reply. */
function finish(db, plan, replayed, replayThresholds, dir, importTrial, admitted = {}) {
  const bound = plan.maxSegments == null ? '' : ` (maxSegments ${plan.maxSegments}: ${replayed.manifest.files.length} of ${plan.segmentsAvailable ?? replayed.manifest.files.length} segment(s), oldest first)`
  const noteText = plan.note ?? ((plan.stageA ? 'stage-A grid via POST /actions/tick-research' : 'POST /actions/tick-research') + bound)
  const out = replayed.trials.map(({ trial: t, verdict }) => {
    const imported = plan.dryRun ? { ok: true, trialId: t.trialId, inserted: false } : importTrial(db, t, { note: noteText })
    return { trialId: imported.trialId ?? t.trialId, inserted: !plan.dryRun && imported.inserted === true, imported: !plan.dryRun && imported.ok === true, symbolId: t.manifest.symbolId, profileHash: t.profileHash, params: t.params, summary: t.summary, blocks: t.blocks, replay: verdict }
  })
  return {
    ok: true, dryRun: plan.dryRun, stageA: plan.stageA, segmentsDir: dir, manifest: replayed.manifest, thresholds: replayThresholds,
    // PR-EX: every report of the run says how much of the spool it saw. The
    // manifest already names the FILES replayed (loadSegments, `files`); these
    // three say what was left out and that leaving it out was asked for.
    maxSegments: plan.maxSegments, segments: replayed.manifest.files.length, segmentsAvailable: admitted.segmentsAvailable, segmentsDropped: admitted.segmentsDropped,
    trials: out, trialIds: out.map(o => o.trialId), inserted: out.filter(o => o.inserted).length, passing: out.filter(o => o.replay.ok).map(o => o.trialId),
    noteTruncated: plan.noteTruncated, ...(plan.noteTruncated ? { noteStored: plan.note } : {}),
    note: plan.dryRun ? 'dry run: replayed and judged, nothing written to tick_trials' : 'trials written to tick_trials (content-keyed; a re-run of the same segments and profile is not duplicated); the stage moves only through POST /actions/tick-validation { stage: REPLAY_PASSED, evidence: { trialId } }',
  }
}

/**
 * The refusals shared by the in-thread action and the job start.
 *
 * PR-EX: when the operator set `maxSegments`, the OLDEST that many are kept
 * — `listSegments` sorts lexicographically and `seg-<13-digit-ms>-<6-digit
 * index>.tks` makes that chronological ascending, so "first" is "oldest".
 * That is the same end of the list `syncSegments` pulls (it walks the
 * sidecar's list in order and breaks at `pulled >= maxSegments`), so the
 * pulled set and the replayed set are the same segments rather than two
 * different subsets that happen to be the same size. The record cap is
 * applied to the SLICE, which is the whole point: 4 × 1,677,720 records is
 * over the 5,000,000 cap and 2 of them are not.
 */
/**
 * What the operator's spool actually HOLDS, when the caller knows better than
 * the directory does. Checker, 20-09-2026: `admit` counts the cache, and on
 * the sync path the cache is exactly what the bound pulled — so a run that
 * replayed 2 of the sidecar's 4 segments reported `segmentsAvailable: 2,
 * segmentsDropped: 0` ("I saw everything there was") seconds after a 413 that
 * said `segments: 4`, and the SAME request answered `4 / 2` once the cache was
 * warm. The listing is the authority on how much there is; the cache is only
 * the authority on what is replayable right now.
 */
function withAvailable(a, segmentsAvailable) {
  if (a.refuse || segmentsAvailable == null) return a
  const available = Math.max(segmentsAvailable, a.files.length)
  return { ...a, segmentsAvailable: available, segmentsDropped: Math.max(0, available - a.files.length) }
}

function admit(segmentsDir, { maxRecords = MAX_RECORDS, maxSegments = null } = {}) {
  const dir = typeof segmentsDir === 'string' ? segmentsDir.trim() : ''
  const available = listSegments(dir)
  if (!dir || !available.length) {
    return { refuse: { status: 409, body: { ok: false, error: 'no_segments', where: NO_SEGMENTS_WHERE, segmentsDir: dir || null, segments: 0 } } }
  }
  const files = maxSegments == null ? available : available.slice(0, maxSegments)
  const segmentsAvailable = available.length
  const segmentsDropped = segmentsAvailable - files.length
  const records = segmentRecordCount(files)
  if (records > maxRecords) {
    const fits = segmentsThatFit(available.map(f => segmentRecordCount([f])), maxRecords)
    const remedy = fits > 0
      ? `; replay a bounded subset with { "maxSegments": ${fits} } (${fits} of the ${segmentsAvailable} segment(s) here, oldest first, fit under the cap) or run scripts/tick-research.mjs beside the spool`
      : `; not even the oldest single segment fits under the cap — run scripts/tick-research.mjs beside the spool`
    return { refuse: { status: 413, body: { ok: false, error: 'too_many_records', records, maxRecords, segments: files.length, segmentsAvailable, segmentsDropped, maxSegments, segmentsDir: dir, where: `${records.toLocaleString('en-US')} records across ${files.length} segment(s) exceed the keeper's cap of ${maxRecords.toLocaleString('en-US')} per job${remedy}`, segmentsThatFit: fits } } }
  }
  return { dir, files, records, segmentsAvailable, segmentsDropped, maxSegments }
}

/**
 * The route's body IN-THREAD: { status, body }. Refuses with 409
 * no_segments when nothing is reachable, 413 over the record cap;
 * otherwise replays, judges each trial against the owner's replay
 * thresholds (a verdict, not a stage move — the stage moves only through
 * POST /actions/tick-validation), and imports unless dryRun. Used by tests
 * and small runs; the route uses startTickResearchJob.
 */
export function tickResearchAction(db, body = {}, { segmentsDir = process.env[SEGMENTS_ENV], thresholds = null, importTrial = importTickTrial, maxRecords = MAX_RECORDS, segmentsAvailable = null } = {}) {
  const bounded = maxSegmentsFrom(body)
  if (bounded.refuse) return bounded.refuse
  const a = withAvailable(admit(segmentsDir, { maxRecords, maxSegments: bounded.value }), segmentsAvailable)
  if (a.refuse) return a.refuse
  const plan = researchPlan(body, replayCostContext(db))
  plan.segmentsAvailable = a.segmentsAvailable
  plan.segmentsDropped = a.segmentsDropped
  const th = thresholds || loadThresholds()
  const replayed = replayFiles(a.files, plan, th.replay)
  if (!replayed) return { status: 409, body: { ok: false, error: 'no_segments', where: `${a.files.length} segment file(s) at ${a.dir} decoded to no valid quote event`, segmentsDir: a.dir, segments: a.files.length } }
  return { status: 200, body: finish(db, plan, replayed, th.replay, a.dir, importTrial, a) }
}

// ---- the job: one at a time, off the event loop ----------------------------
const JOB_HISTORY = 10
const jobs = { current: null, history: [] }
// Checker m-3: the single-job slot was only claimed AFTER the sync, so two
// concurrent POSTs both listed and both pulled. This is claimed first.
let syncLock = null

function publicJob(j) {
  if (!j) return null
  const { worker, db, importTrial, ...rest } = j // eslint-disable-line no-unused-vars
  return rest
}

/** Every job this process has run (newest first), the running one first. */
export function tickResearchJobsView() {
  return { at: new Date().toISOString(), running: publicJob(jobs.current), jobs: jobs.history.map(publicJob), maxRecords: MAX_RECORDS }
}
export function tickResearchJob(id) {
  if (jobs.current && jobs.current.jobId === id) return publicJob(jobs.current)
  return publicJob(jobs.history.find(j => j.jobId === id)) || null
}
/** Tests only: forget every job. */
export function _resetTickResearchJobs() { if (jobs.current?.worker) { try { jobs.current.worker.terminate() } catch { /* best effort */ } } jobs.current = null; jobs.history = []; syncLock = null }

function settle(j, patch) {
  Object.assign(j, patch, { finishedAt: new Date().toISOString() })
  if (jobs.current === j) jobs.current = null
  jobs.history.unshift(j)
  if (jobs.history.length > JOB_HISTORY) jobs.history.length = JOB_HISTORY
}

/**
 * Start the research in a worker thread. { status, body }: 202 with the
 * job id, 409 research_running while one runs, 409 no_segments / 413
 * too_many_records as the in-thread action. The result (the same body the
 * in-thread action returns) is on GET /state/tick-research-job?id=… once
 * `state` is `done`; the trials are in tick_trials by then.
 */
export function startTickResearchJob(db, body = {}, { segmentsDir = process.env[SEGMENTS_ENV], thresholds = null, importTrial = importTickTrial, maxRecords = MAX_RECORDS, workerFile = WORKER_FILE, now = new Date(), segmentsAvailable = null, segmentsFailed = [] } = {}) {
  if (jobs.current) {
    return { status: 409, body: { ok: false, error: 'research_running', jobId: jobs.current.jobId, startedAt: jobs.current.startedAt, where: 'one research job runs at a time; poll GET /state/tick-research-job?id=<jobId> and post again when it is done' } }
  }
  const bounded = maxSegmentsFrom(body)
  if (bounded.refuse) return bounded.refuse
  const a = withAvailable(admit(segmentsDir, { maxRecords, maxSegments: bounded.value }), segmentsAvailable)
  if (a.refuse) return a.refuse
  const plan = researchPlan(body, replayCostContext(db))
  plan.segmentsAvailable = a.segmentsAvailable
  plan.segmentsDropped = a.segmentsDropped
  const th = thresholds || loadThresholds()
  // Checker, 20-09-2026: `segmentsFailed` was on the 202 alone, so an
  // operator who posts and then polls never learns that a segment could not
  // be pulled — the same shape as the figures that used to live only on the
  // transient response. It rides the job record too.
  const failedNote = segmentsFailed.length ? { segmentsFailed, segmentsFailedNote: `${segmentsFailed.length} listed segment(s) could not be pulled and are NOT in this replay; the replayed set is the oldest that did arrive` } : {}
  const j = { jobId: randomUUID().slice(0, 12), state: 'running', startedAt: now.toISOString(), finishedAt: null, segmentsDir: a.dir, segments: a.files.length, records: a.records, maxSegments: plan.maxSegments, segmentsAvailable: a.segmentsAvailable, segmentsDropped: a.segmentsDropped, ...failedNote, plan: { stageA: plan.stageA, dryRun: plan.dryRun, params: plan.params, sim: plan.sim, onlySymbol: plan.onlySymbol, maxSegments: plan.maxSegments, noteTruncated: plan.noteTruncated }, result: null, error: null, worker: null, db, importTrial }
  let worker
  try {
    worker = new Worker(workerFile, { workerData: { files: a.files, plan, replay: th.replay } })
  } catch (err) {
    return { status: 500, body: { ok: false, error: 'worker_start_failed', detail: err.message } }
  }
  j.worker = worker
  jobs.current = j
  let settled = false
  worker.on('message', (msg) => {
    if (settled) return
    settled = true
    try {
      if (!msg || !msg.ok) { settle(j, { state: 'failed', error: msg?.error || 'worker returned no result' }); return }
      if (!msg.replayed) { settle(j, { state: 'failed', error: 'no_segments', result: { ok: false, error: 'no_segments', where: `${a.files.length} segment file(s) at ${a.dir} decoded to no valid quote event`, segmentsDir: a.dir, segments: a.files.length } }); return }
      const result = finish(db, plan, msg.replayed, th.replay, a.dir, importTrial, a)
      settle(j, { state: 'done', result })
    } catch (err) {
      settle(j, { state: 'failed', error: `import failed: ${err.message}` })
    }
  })
  worker.on('error', (err) => { if (settled) return; settled = true; settle(j, { state: 'failed', error: err.message }) })
  worker.on('exit', (code) => { if (settled) return; settled = true; settle(j, { state: 'failed', error: `worker exited with code ${code} before reporting` }) })
  return { status: 202, body: { ok: true, jobId: j.jobId, state: 'running', startedAt: j.startedAt, segmentsDir: a.dir, segments: a.files.length, records: a.records, maxSegments: plan.maxSegments, segmentsAvailable: a.segmentsAvailable, segmentsDropped: a.segmentsDropped, ...failedNote, dryRun: plan.dryRun, stageA: plan.stageA, noteTruncated: plan.noteTruncated, poll: `/state/tick-research-job?id=${j.jobId}`, note: 'the replay runs in a worker thread; the result and the imported trial ids are on the poll URL once state is done' } }
}

/**
 * PR-I: the route's entry point. Same contract as `startTickResearchJob`,
 * with one step in front of it — when NOTHING is reachable locally, the
 * sidecar is ASKED for its sealed segments and what is missing is pulled
 * into the cache directory (`segmentCacheDir()`: `TICK_SEGMENTS_CACHE_DIR`,
 * else `TICK_SEGMENTS_DIR`, else `<os.tmpdir()>/tick-segments`) before the
 * job starts. This closes the blockage named in
 * docs/plan-execution-audit-2026-09-11.md §12.3: the segments existed, the
 * keeper had no path to them, and REPLAY_PASSED was unreachable.
 *
 * WHERE THE WORK HAPPENS. The pull is awaited BEFORE the job is started —
 * never inside it and never on the event loop as blocking work: it is
 * network I/O in ≤ 1 MiB chunks (PR-H's checker M-1 caught a CPU-bound
 * replay on the loop; the replay itself still runs in the worker thread).
 *
 * The 409 stays honest. If the sidecar has no recorder, is unreachable, or
 * has sealed nothing, the answer is still `no_segments` — with `where` and
 * the per-side detail of what was asked. A trial is never fabricated.
 */
export async function startTickResearchJobWithSync(db, body = {}, opts = {}) {
  const { cacheDir = null, sync = null, listAll = null, maxRecords = MAX_RECORDS, ...rest } = opts
  const segmentsDir = opts.segmentsDir ?? process.env[SEGMENTS_ENV]
  const bounded = maxSegmentsFrom(body)
  if (bounded.refuse) return bounded.refuse
  const maxSegments = bounded.value
  // A job already running — or a SYNC already running (checker m-3: the job
  // slot was only claimed after the sync, so two concurrent POSTs both
  // pulled) — is refused before anything is listed or moved.
  if (jobs.current) return startTickResearchJob(db, body, { ...rest, maxRecords, segmentsDir })
  if (syncLock) {
    return { status: 409, body: { ok: false, error: 'research_running', jobId: syncLock.jobId, startedAt: syncLock.startedAt, where: 'a segment sync for an earlier request is still running; poll GET /state/tick-research-job and post again when it is done' } }
  }
  const local = admit(segmentsDir, { maxRecords, maxSegments })
  if (!local.refuse) return startTickResearchJob(db, body, { ...rest, maxRecords, segmentsDir })
  if (local.refuse.body.error !== 'no_segments') return local.refuse
  // CLAIMED BEFORE THE FIRST await. A check-then-act across an await is not
  // a lock: with the claim below the `await import(...)`, both callers ran
  // their synchronous prefix, both saw a null lock and both pulled the same
  // segment (measured: 48 chunk requests where one pull is 24). `admit`
  // above is synchronous, so nothing has yielded yet at this point.
  syncLock = { jobId: `sync-${randomUUID().slice(0, 8)}`, startedAt: new Date().toISOString() }
  try {
    const { segmentCacheDir, syncInWorker, listAllSides } = await import('./tick-segments.js')
    const dest = cacheDir || segmentCacheDir()
    // PRE-FLIGHT (checker M-1). The record cap is checked against what the
    // sides LIST, before a byte moves. Pulling first and refusing afterwards
    // moved up to 2 GiB to disk for a request that was always going to be
    // 413 — measured: 413 too_many_records with 2,400,064 bytes already
    // written to the cache. A listing is one small GET per side.
    const listed = await (listAll || listAllSides)({})
    // The cache and the listing OVERLAP after a successful sync — the cache
    // holds exactly what was pulled. Summing them would double-count every
    // segment a previous run fetched and refuse 413 on a request that is
    // well inside the cap, so only cached segments the sides do NOT list are
    // added to the listed total.
    const listedNames = new Set(listed.names || [])
    const cachedOnly = listSegments(dest).filter(f => !listedNames.has(basename(f)))
    const cachedRecords = segmentRecordCount(cachedOnly)
    // PR-EX. The aggregate refusal is the RIGHT answer only when the operator
    // asked for the whole spool. Measured on production 20-09-2026: the demo
    // sidecar listed 4 sealed segments / 6,710,880 records against the
    // 5,000,000 cap, so this fired on every call and the remedy it named
    // ("copy a subset to TICK_SEGMENTS_DIR") was not reachable — the volume
    // is only readable through GET /tick-segment. With `maxSegments` set the
    // aggregate is NOT the question: only that many segments are pulled, and
    // `admit` below applies the real cap to the cached files that arrived.
    const per = listedRecordsPerSegment(listed)
    const fits = per ? segmentsThatFit(per, maxRecords) : null
    // What the operator actually asked to have pulled: the whole listing, or
    // the oldest `maxSegments` of it.
    const askedRecords = maxSegments == null
      ? listed.records + cachedRecords
      : (per ? per.slice(0, maxSegments).reduce((a, b) => a + b, 0) : null)
    // BOTH bounds are refused from the LISTING, before a byte moves. The
    // aggregate half is checker M-1's rule, unchanged. The bounded half is
    // this checker's (20-09-2026): skipping the pre-flight whenever a bound
    // was set re-opened exactly the waste M-1 closed — `{"maxSegments": 3}`
    // on the production shape pulls 3 × 67,108,864 = 201,326,592 bytes to the
    // volume and then 413s, because 3 × 1,677,720 = 5,033,160 is over the
    // 5,000,000 cap. Typing 3 when the refusal named 2 is an ordinary
    // mistake, and `maxSegments` has no upper bound of its own, so without
    // this a large value was the pre-flight's off switch.
    //
    // WHAT THIS MEASURES, AND WHAT IT DOES NOT (checker, 20-09-2026). It
    // measures the LISTED slice. The cache can also hold segments the sides
    // no longer list — the recorder's `retire()` unlinks old sealed segments
    // the keeper already pulled — and those are invisible here while still
    // counting in `admit`'s cap check on the merged cache afterwards. So in
    // that one shape bytes do move before a 413 (measured 8,128 bytes on a
    // scaled fixture; the worst case stays bounded by `maxBytes`), and
    // `segmentsAvailable` UNDERSTATES what was reachable — 4 where 6 were.
    // The cap itself is never exceeded: `admit` is the enforcement, this is
    // only the early refusal that keeps the bytes still.
    if (per && askedRecords > maxRecords) {
      const records = askedRecords
      const scope = maxSegments == null
        ? `${listed.segments} sidecar segment(s) and the cache`
        : `the ${Math.min(maxSegments, listed.segments)} oldest of ${listed.segments} sidecar segment(s) (maxSegments ${maxSegments})`
      const remedy = fits > 0
        ? `Re-post with { "maxSegments": ${fits} } to replay the ${fits} oldest of the ${listed.segments} listed segment(s), which fit under the cap`
        : `Not even the oldest single listed segment fits under the cap`
      return { status: 413, body: { ok: false, error: 'too_many_records', records, maxRecords, segments: listed.segments, maxSegments, segmentsThatFit: fits, segmentsDir: dest, where: `${records.toLocaleString('en-US')} record(s) are reachable across ${scope}, over the keeper's cap of ${maxRecords.toLocaleString('en-US')} per job — nothing was pulled. ${remedy}, or run scripts/tick-research.mjs beside the spool`, sync: { destDir: dest, pulled: 0, skipped: 0, bytes: 0, truncated: false, sides: listed.sides, note: 'refused from the listing; no bytes were moved' } } }
    }
    // A listing that carries no per-segment counts cannot answer "how many
    // fit", and a request bounded against it cannot be pre-flighted: the cap
    // is still enforced by `admit` after the pull, and the reply says the
    // remedy could not be measured rather than naming a guessed number.
    if (maxSegments == null && listed.records + cachedRecords > maxRecords) {
      const records = listed.records + cachedRecords
      return { status: 413, body: { ok: false, error: 'too_many_records', records, maxRecords, segments: listed.segments, maxSegments, segmentsThatFit: null, segmentsDir: dest, where: `${records.toLocaleString('en-US')} record(s) are reachable across ${listed.segments} sidecar segment(s) and the cache, over the keeper's cap of ${maxRecords.toLocaleString('en-US')} per job — nothing was pulled. The sides did not list per-segment sizes, so how many segments fit under the cap is NOT known here; post { "maxSegments": n } to replay the n oldest, or run scripts/tick-research.mjs beside the spool`, sync: { destDir: dest, pulled: 0, skipped: 0, bytes: 0, truncated: false, sides: listed.sides, note: 'refused from the listing; no bytes were moved' } } }
    }
    let pull
    try {
      // The sync — list, pull, decode, VERIFY — runs in a worker thread
      // (checker B-1): the verification is ~1 s per 64 MiB of CPU and must
      // not touch the keeper's event loop.
      // PR-EX: the operator's bound goes to the SYNC too, so the pulled set
      // and the replayed set are the same oldest-first prefix rather than two
      // subsets of the same size. `syncSegments` walks the sidecar's list in
      // order and breaks at `pulled >= maxSegments`; `admit` slices the same
      // way. Absent, `maxSegments` stays undefined and the sync keeps its own
      // default — the unbounded path is untouched.
      pull = await (sync || syncInWorker)(dest, { maxBytes: maxRecords * RECORD_BYTES + SYNC_HEADROOM_BYTES, ...(maxSegments == null ? {} : { maxSegments }) })
    } catch (err) {
      pull = { destDir: dest, pulled: 0, skipped: 0, bytes: 0, truncated: false, sides: [], error: err?.message || String(err) }
    }
    const after = admit(dest, { maxRecords, maxSegments })
    if (after.refuse) {
      const b = after.refuse.body
      return { status: after.refuse.status, body: { ...b, ...(b.error === 'no_segments' ? { where: NO_SEGMENTS_ANYWHERE, localWhere: NO_SEGMENTS_WHERE } : {}), sync: pull } }
    }
    // The listing is the authority on how much there IS (the cache holds only
    // what the bound pulled), and its `names` are deduplicated where the two
    // sides list the same segment, which `listed.segments` is not.
    const listedCount = Array.isArray(listed.names) ? listed.names.length : listed.segments
    // A segment that FAILED to pull is not a segment the operator chose to
    // leave out. Without this the oldest segment failing looks identical to a
    // clean bounded run — the replay quietly moves on to the oldest N present
    // and only `sync.failed`, nested per side, says otherwise. It is handed
    // to the job so the POLL carries it as well as the 202.
    // De-duplicated: a side's failure is reported both on the side and on the
    // pull as a whole, and the operator wants the SEGMENTS, not the reports.
    const failedNames = [...new Set([...(pull.failed || []), ...(pull.sides || []).flatMap(x => x.failed || [])].map(f => f?.name).filter(Boolean))]
    const started = startTickResearchJob(db, body, { ...rest, maxRecords, segmentsDir: dest, segmentsAvailable: listedCount, segmentsFailed: failedNames })
    return { status: started.status, body: { ...started.body, sync: pull } }
  } finally {
    syncLock = null
  }
}
