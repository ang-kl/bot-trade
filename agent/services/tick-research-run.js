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
import { randomUUID, createHash } from 'node:crypto'
import { readSegment, toQuoteEvents, FORMAT_VERSION, HEADER_BYTES, RECORD_BYTES } from '../lib/tick-segment.js'
import { simulate, normalizeLiveFilters, LIVE_FILTER_NAMES, LIVE_FILTER_MODELS, GATEWAY_LIVE_FILTERS } from '../lib/tick-replay-sim.js'
import { normalizeParams, profileHashFull } from '../lib/tick-strategy.js'
import { trialIdFor, importTickTrial, testOpeningsFor, recordTestOpening, settleTestOpening, HOLDOUT_UNDECLARED, RESEARCH_BLOCKS } from './tick-research.js'
import { loadThresholds, replayChecks, shadowLiveFilters } from './tick-validation.js'
import { loadRepoSchedule, TICK_COST_MAP_KEY } from '../lib/tick-cost-schedule.js'
import { getState } from '../db.js'
import { loadTickEntryConfig } from './tick-permits.js'
import { permittedSides } from './direction-policy.js'
import { loadRegimeGateConfig, DEFAULT_MAX_REGIME_AGE_MIN } from './regime-gate.js'
import { asOfTrendReader, trendReadingFromRows } from './tick-shadow-counterfactual.js'
import { tickSymbolNames } from './exec-guard-sync.js'
import { symbolNameResolver } from './tick-shadow-accounts.js'
import { sideAccounts } from './tick-shadow.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'

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
 * input) and the manifest base. A continuity-breaking gap marker (restart,
 * reconnect, switched_off) invalidates continuity: the sim sees it as a
 * crossed (invalid) quote, which the strategy treats as a warm-up reset. A
 * recorder-only gap (queue_overflow, reserve_pause — PR-Q1) is counted and
 * listed in the manifest but resets nothing. Repeats stay in the stream as unchanged observations
 * carrying the last quote's sides (they count nowhere, they invalidate
 * nothing) — the last valid quote is kept per symbol in a Map, O(1) per
 * repeat (checker M-2: a reverse scan per repeat was quadratic, 9.3 s on
 * 40k + 40k).
 */
export function loadSegments(files, { onlySymbol = null } = {}) {
  const bySymbol = new Map()
  const lastValid = new Map() // symbolId → the last two-sided quote pushed
  let events = 0, torn = 0, firstMs = null, lastMs = null
  // PR-Q1: the dataset is pinned by content, not by name — a trial names the
  // bytes it replayed, so a segment rewritten or rotated under the same name
  // cannot pass as the data the trial saw.
  const fileDigests = []
  const environments = new Set()
  const gapsByReason = {}
  const gaps = []
  let warmupResets = 0
  for (const f of files) {
    const buf = readFileSync(f)
    fileDigests.push({ name: basename(f), bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') })
    const seg = readSegment(buf)
    if (!seg.header) continue
    environments.add(seg.header.environment)
    if (seg.truncated) torn++
    for (const ev of toQuoteEvents(seg)) {
      if (ev.gap) {
        // PR-Q1: split by reason. queue_overflow and reserve_pause drop only
        // the RECORDER's queue — the live strategy kept running on every
        // quote — so they must not reset the replay's warm-up (the sidecar's
        // strategy did not reset). The quotes they dropped are simply absent,
        // which the parity report names per window. restart, reconnect and
        // switched_off are continuity breaks on the live side too: those
        // still reset, as before. The last valid quote is forgotten either
        // way, so a repeat after ANY gap is not given sides the dropped span
        // may have changed.
        gapsByReason[ev.reason] = (gapsByReason[ev.reason] || 0) + 1
        if (gaps.length < GAP_LIST_MAX) gaps.push({ reason: ev.reason, recvMs: ev.recvMs, count: ev.count })
        lastValid.clear()
        if (!RECORDER_ONLY_GAPS.has(ev.reason)) { warmupResets++; for (const list of bySymbol.values()) list.push({ gapMarker: true }) }
        continue
      }
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
      // PR-Q1: the recorder's receive time is a whole millisecond (u64 recvMs),
      // and the decoder carries it as recvMs × 1e6 ns — past 2^53, so the
      // division came back as 1757548800049.9998. The sidecar compares the
      // same integer ms (latency fill, clock hold cap), so an event exactly
      // one latency later could fill on one engine and not the other. Rounded
      // back to the integer the recorder wrote.
      const ms = Math.round(ev.recvMonoNs / 1e6)
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
  const manifestBase = {
    files: files.map(f => basename(f)), events, symbols: [...bySymbol.keys()], torn, fromMs: firstMs, toMs: lastMs, decoderVersion: FORMAT_VERSION,
    fileDigests, environments: [...environments].sort(),
    gapsByReason, gaps, gapsTruncated: Object.values(gapsByReason).reduce((a, b) => a + b, 0) > gaps.length, warmupResets,
  }
  return { bySymbol, manifestBase }
}

/** PR-Q1: gap reasons that drop only the recorder's queue (the live strategy kept every quote). */
export const RECORDER_ONLY_GAPS = new Set(['queue_overflow', 'reserve_pause'])
/** The manifest lists at most this many gaps with their times; `gapsByReason` counts all of them. */
export const GAP_LIST_MAX = 200

/** The replayer build that produced a trial: the deploy's commit, or null where the environment does not say. */
export function replayerCommit(env = process.env) {
  return env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT || null
}

/** A short content hash of the effective sim (sorted keys), so two trials' fill rules compare by value. */
export function simHash(sim) {
  const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v
  return createHash('sha256').update(JSON.stringify(canon(sim || {}))).digest('hex').slice(0, 16)
}

/**
 * One trial per grid point per symbol (copies across accounts are one
 * exposure, never summed). Plan §7: the test block is withheld unless
 * sim.includeTest is set — the owner's one confirmation run.
 */
export function runTrials({ bySymbol, manifestBase }, { stageA = false, params = {}, sim = {}, symbolClass = null, trendContext = null } = {}) {
  const grid = stageA ? stageAGrid() : [params]
  const trials = []
  // PR-Q3: the counter-trend reader per symbol, built once for every grid
  // point (the regime rows are the same input whatever the profile).
  const counterTrendOn = !!normalizeLiveFilters(sim.liveFilters)?.counterTrend
  // A veto that cannot be judged is refused, never stamped as applied (the
  // replayer's own rule): with no regime context every signal would read "no
  // reading" and the trial would carry a counter-trend filter that saw nothing.
  if (counterTrendOn && !trendContext) throw new TypeError('sim.liveFilters.counterTrend is on but no regime context (replayTrendContext) was given: the veto could not be judged')
  const trendBySymbol = new Map()
  if (counterTrendOn) for (const [symbolId, list] of bySymbol) trendBySymbol.set(symbolId, symbolTrend(trendContext, manifestBase, symbolId, list))
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
      const trend = trendBySymbol.get(symbolId) || null
      const r = simulate(list, p, symSim, trend ? { trendSidesAt: trend.sidesAt } : {})
      // PR-Q1: provenance rides the manifest (and so the trial id): which
      // bytes (fileDigests, from loadSegments), which replayer build, which
      // fill rules by hash. A different build over the same bytes is a
      // different trial, so a replayer fix is never masked by an older row.
      const manifest = { ...manifestBase, symbolId, symbolEvents: list.length, replayerCommit: replayerCommit(), simHash: simHash(r.sim) }
      // PR-Q3: the regime rows the counter-trend veto could read are an input
      // like the segments, so they are pinned by content too (and the trial id
      // with them). Only with the filter on: an unfiltered trial is unchanged.
      if (trend) manifest.regimeInput = trend.manifest
      // Withheld, the trial carries the SCOPED counters, never the whole
      // run's (the cost/no-fill counts over the test period are test-period
      // information too).
      const d = r.summary.diagnostics
      const rejected = r.summary.scope === 'all_blocks' ? r.rejected : { cost: d.costRejected, noFill: d.noFill, ...(d.vetoes ? { vetoed: vetoCounts(d.vetoes) } : {}) }
      const trial = { strategyId: r.strategyId, strategyVersion: r.strategyVersion, profileHash: r.profileHash, params: r.params, sim: r.sim, manifest, summary: r.summary, blocks: r.blocks, rejected, parity: { ...r.parity, symbolId } }
      trial.trialId = trialIdFor(trial)
      trials.push(trial)
    }
  }
  return trials
}

const vetoCounts = (v) => Object.fromEntries(LIVE_FILTER_NAMES.map(k => [k, Number(v?.[k]) || 0]))

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {}

// ---- PR-Q3: the live filters -------------------------------------------------

export const LIVE_FILTERS_WHERE = 'sim.liveFilters names WHICH live filters the replay applies — true for the three the gateway runs today (counterTrend, priceBound, stopFloor; the signal TTL only when named), or an object of booleans over counterTrend, signalTtl, priceBound, stopFloor, plus an optional model: "firer" (the default: the gateway today — the shadow book fills, the firer refuses, the refused trade holds the book) or "book" (a ShadowBook applying the filters itself, dual plan P3 / PR-Q4, not built: a refused signal frees the book). It never carries their values: minStopFraction, overshootFraction and maxFireDelayMs (as the signal TTL — a planned pending-signal expiry, not a filter the gateway runs today) are read from agent/config/tick-entry.json, the config the tick permits carry, and the counter-trend reading from the regimes table under the regime gate — so a replay cannot model a filter value the live path does not have. A filtered trial cannot pass the replay rung while agent/config/tick-shadow-sim.json carries no equal block'
export const LIVE_FILTERS_NO_REGIMES_WHERE = 'the counter-trend filter reads the keeper\'s regimes table, which this door does not have (the script runs beside the spool with no keeper database): name the other filters, or replay through POST /actions/tick-research'
/** Where the filter values come from, stamped on the block. */
export const LIVE_FILTERS_CONFIG_SOURCE = 'agent/config/tick-entry.json (minStopFraction, overshootFraction; maxFireDelayMs as the signal TTL)'

/**
 * Which filters a research body asks for: null when none, else a boolean per
 * filter and the model, or { error } when the body is not the switch-only
 * shape.
 */
export function liveFiltersRequested(body = {}) {
  const raw = plain((body || {}).sim).liveFilters
  if (raw == null || raw === false) return null
  // Fix round (checker N1): `true` is the gateway as it runs today — the
  // three filters it applies, under the default 'firer' model. The signal TTL
  // is a planned expiry the gateway does not run (maxFireDelayMs is a queue
  // delay after the fill), so `true` never switches it on; it is named.
  if (raw === true) return { ...Object.fromEntries(LIVE_FILTER_NAMES.map(k => [k, GATEWAY_LIVE_FILTERS.includes(k)])), model: LIVE_FILTER_MODELS[0] }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'live_filters_shape', got: raw }
  const out = { ...Object.fromEntries(LIVE_FILTER_NAMES.map(k => [k, false])), model: LIVE_FILTER_MODELS[0] }
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'model') {
      if (!LIVE_FILTER_MODELS.includes(v)) return { error: 'live_filters_model', field: k, got: v }
      out.model = v
      continue
    }
    if (!LIVE_FILTER_NAMES.includes(k)) return { error: 'live_filters_from_config', field: k, got: v }
    if (typeof v !== 'boolean') return { error: 'live_filters_from_config', field: k, got: v }
    out[k] = v
  }
  return LIVE_FILTER_NAMES.some(k => out[k]) ? out : null
}

/**
 * The refusal every research door applies before anything is read: a body
 * that sends filter VALUES (or any other shape) is refused 400, and a door
 * with no regimes table refuses the counter-trend filter rather than stamp a
 * veto it could never judge.
 */
export function liveFiltersRefusal(body = {}, { counterTrendAvailable = true } = {}) {
  const asked = liveFiltersRequested(body)
  if (!asked) return null
  if (asked.error) return { status: 400, body: { ok: false, error: asked.error, ...(asked.field ? { field: asked.field } : {}), got: asked.got ?? null, where: LIVE_FILTERS_WHERE } }
  if (asked.counterTrend && !counterTrendAvailable) return { status: 400, body: { ok: false, error: 'live_filters_no_regimes', where: LIVE_FILTERS_NO_REGIMES_WHERE } }
  return null
}

/**
 * The stamped block for what was asked, with every value from the permits'
 * own config (`entryCfg` is loadTickEntryConfig()) and the regime gate — the
 * research body switches filters on, it never sets them.
 */
export function liveFiltersBlock(asked, { entryCfg = loadTickEntryConfig(), gate = null } = {}) {
  if (!asked || asked.error) return null
  return normalizeLiveFilters({
    model: asked.model ?? null,
    minStopFraction: asked.stopFloor ? entryCfg.minStopFraction : null,
    overshootFraction: asked.priceBound ? entryCfg.overshootFraction : null,
    signalTtlMs: asked.signalTtl ? entryCfg.maxFireDelayMs : null,
    counterTrend: asked.counterTrend ? { gateOn: gate ? gate.on !== false : null, maxRegimeAgeMin: gate ? gateAgeBound(gate) : null } : null,
    configSource: LIVE_FILTERS_CONFIG_SOURCE,
  })
}

/** The age bound asOfTrendReader applies for this gate (undefined → the default). */
function gateAgeBound(gate) {
  const v = gate?.maxRegimeAgeMin === undefined ? DEFAULT_MAX_REGIME_AGE_MIN : gate.maxRegimeAgeMin
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v)
}

/** The permits' config and the regime gate, read once per request (main thread). */
export function replayFilterContext(db) {
  return { entryCfg: loadTickEntryConfig(), gate: loadRegimeGateConfig(db) }
}

/** The segment's start from its name (seg-<13-digit ms>-…), or null. */
function segmentStartMs(file) {
  const m = /^seg-(\d{13})-/.exec(basename(String(file)))
  return m ? Number(m[1]) : null
}

/**
 * PR-Q3: what the replay worker needs to judge the counter-trend veto with no
 * database — built on the main thread and handed over as plain data:
 *   - `sides.demo` / `sides.live`: symbol id → name for the tick universe,
 *     through symbolNameResolver on the side's first account (the shadow
 *     counterfactual's rule: a segment carries ids, the regimes carry names);
 *   - `rows[name]`: that name's regime rows as asOfTrendReader loads them,
 *     from the oldest segment's start less the age bound up to `now`;
 *   - the gate's on flag and age bound, which the block stamps;
 *   - `retainedFrom`: the oldest regime row the table still holds. Housekeeping
 *     deletes regimes older than 30 days (loop.js prune-regimes), so a window
 *     older than that reads NO regime and the filter silently grants both
 *     sides; each trial says so (regimeInput.rowsMayBePruned) instead.
 * The universe is tick_symbols_json at the time of the replay; a segment
 * symbol outside it reads no regime, and its trial says so.
 *
 * PR-Q3 fix round (checker B2, measured on a production-shaped database of
 * 565k regime rows, 53 tick symbols): the rows were built as one object per
 * row on the keeper's event loop and structured-cloned into the worker —
 * 404 ms + 60 ms of blocked loop at 14 days, 1,873 ms + 159 ms at 29. Now:
 *   - `rows[name]` is PACKED (packRegimeRows: one string and two typed
 *     arrays per symbol), so the clone into the worker is a copy of a few
 *     flat buffers, and the worker unpacks (unpackRegimeRows) off the loop;
 *   - the route's door builds the context with replayTrendContextAsync,
 *     which reads each symbol a page at a time and yields to the event loop
 *     between pages. This synchronous form stays for the in-thread action
 *     (tests and small runs: its replay blocks the thread anyway) and as the
 *     job's fallback when it was handed no context that covers its segments.
 * The two forms return the same context, value for value (pinned).
 */
export function replayTrendContext(db, opts = {}) {
  const { reader, head } = trendContextFrame(db, opts)
  const rows = {}
  for (const name of head.names) rows[name] = packRegimeRows(reader.rowsFor(name))
  return { ...head, rows }
}

/**
 * Regime rows read per page by replayTrendContextAsync. Measured on the
 * production-shaped table (565k rows, four runs at 7, 14 and 29 days): the
 * longest loop turn 7–20 ms, p99 under 8 ms, where one pass held the loop
 * 0.2–1.9 s. 2000 rows a page measured a p99 up to 16 ms; the smaller page
 * costs only more yields (the wall time is within run-to-run noise).
 */
export const REGIME_PAGE_ROWS = 500
const yieldLoop = () => new Promise(resolve => setImmediate(resolve))

/**
 * replayTrendContext's answer without holding the keeper's event loop: each
 * symbol's rows are read `pageRows` at a time (asOfTrendReader.pages — the
 * same window, the same order) and the loop is yielded to after every page.
 * `yieldTo` is the yield (a test counts it).
 */
export async function replayTrendContextAsync(db, { pageRows = REGIME_PAGE_ROWS, yieldTo = yieldLoop, ...opts } = {}) {
  const { reader, head } = trendContextFrame(db, opts)
  const rows = {}
  for (const name of head.names) {
    const acc = []
    for (const page of reader.pages(name, { pageRows })) {
      for (const r of page) acc.push(r)
      await yieldTo()
    }
    rows[name] = packRegimeRows(acc)
  }
  return { ...head, rows }
}

/**
 * Whether a context built before the job (the async door) is the one the
 * job would build: every segment the job admitted was in the set it was
 * built over (so its window reaches back far enough and its `toMs` is after
 * every sealed event), and the gate it read is the gate the block stamps.
 */
export function trendContextCovers(ctx, files, gate) {
  if (!ctx || !Array.isArray(ctx.files) || !ctx.rows) return false
  if (ctx.gateOn !== (gate?.on !== false) || ctx.maxRegimeAgeMin !== gateAgeBound(gate)) return false
  const built = new Set(ctx.files)
  return files.every(f => built.has(basename(String(f))))
}

/**
 * One symbol's rows [{ at, dir }] packed for the worker: `at` is every
 * stamp concatenated, `atEnd[i]` the end of row i's stamp in it, `dir[i]` 0
 * for no direction or k for `dirValues[k − 1]`. Exact for any stamp and any
 * direction value (no separator is assumed); unpackRegimeRows inverts it.
 */
export function packRegimeRows(rows) {
  const n = rows.length
  const parts = new Array(n)
  const atEnd = new Uint32Array(n)
  const dir = new Uint16Array(n)
  const dirValues = []
  const codeOf = new Map()
  let end = 0
  for (let i = 0; i < n; i++) {
    const at = String(rows[i].at)
    parts[i] = at
    end += at.length
    atEnd[i] = end
    const d = rows[i].dir ?? null
    if (d == null) continue
    let code = codeOf.get(d)
    if (code == null) {
      if (dirValues.length >= 0xffff) throw new RangeError('more distinct regime directions than a packed row can name')
      dirValues.push(d); code = dirValues.length; codeOf.set(d, code)
    }
    dir[i] = code
  }
  return { n, at: parts.join(''), atEnd, dir, dirValues }
}

/** packRegimeRows inverted: the rows [{ at, dir }], in order. */
export function unpackRegimeRows(p) {
  if (!p || !Number.isInteger(p.n) || typeof p.at !== 'string' || p.atEnd?.length !== p.n || p.dir?.length !== p.n || !Array.isArray(p.dirValues)) {
    throw new TypeError('a regime context\'s rows are not packRegimeRows\' shape')
  }
  const out = new Array(p.n)
  let start = 0
  for (let i = 0; i < p.n; i++) {
    const end = p.atEnd[i]
    out[i] = { at: p.at.slice(start, end), dir: p.dir[i] === 0 ? null : p.dirValues[p.dir[i] - 1] }
    start = end
  }
  return out
}

/** The context's frame — everything but the rows — and the reader the rows come from. */
function trendContextFrame(db, { files = [], gate = loadRegimeGateConfig(db), now = Date.now() } = {}) {
  const starts = files.map(segmentStartMs).filter(Number.isFinite)
  const minAsOfMs = starts.length ? Math.min(...starts) : undefined
  const reader = asOfTrendReader(db, { gate, minAsOfMs, maxAsOfMs: now })
  const names = tickSymbolNames(db)
  const nameSet = new Set(names)
  const sides = {}
  for (const [env, side] of [['demo', 'cpp_exec_demo'], ['live', 'cpp_exec']]) {
    const accountId = sideAccounts(db, side)[0] ?? null
    const nameOf = symbolNameResolver(db, accountId)
    const ids = new Set()
    const collect = (obj) => { if (obj && typeof obj === 'object') for (const id of Object.values(obj)) if (id != null) ids.add(String(id)) }
    try { collect(JSON.parse(getState(db, 'symbol_id_map') || '{}')) } catch { /* unreadable: the account map alone */ }
    if (accountId != null) {
      try { const own = JSON.parse(getState(db, accountSymbolMapKey(accountId)) || 'null'); collect(own && typeof own === 'object' ? (own.map ?? own) : null) } catch { /* unreadable */ }
    }
    const map = {}
    for (const id of ids) { const n = nameOf(id); const up = n ? String(n).toUpperCase() : null; if (up && nameSet.has(up)) map[id] = up }
    sides[env] = map
  }
  let retainedFrom = null
  try { retainedFrom = db.prepare('SELECT MIN(computed_at) AS at FROM regimes').get()?.at ?? null } catch { retainedFrom = null }
  const head = { gateOn: gate?.on !== false, maxRegimeAgeMin: gateAgeBound(gate), names, sides, fromMs: minAsOfMs ?? null, toMs: now, retainedFrom: retainedFrom == null ? null : String(retainedFrom), files: files.map(f => basename(String(f))) }
  return { reader, head }
}

const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

/**
 * One symbol's counter-trend reader in the worker: its name for the
 * segments' environment, the rows it could read over its own event window
 * (pinned by digest on the manifest), and `sidesAt(ms)` — permittedSides over
 * the reading as of that moment, null when there is none.
 */
export function symbolTrend(ctx, manifestBase, symbolId, list) {
  const envs = manifestBase?.environments || []
  const id = String(symbolId)
  let name = null
  if (ctx?.sides) {
    if (envs.length === 1) name = ctx.sides[envs[0]]?.[id] ?? null
    else {
      // Mixed or unknown environments: a name both sides agree on, or the one
      // side that carries the id (the recorder admits only its own universe).
      const d = ctx.sides.demo?.[id] ?? null, l = ctx.sides.live?.[id] ?? null
      name = d && l ? (d === l ? d : null) : (d || l)
    }
  }
  let fromMs = null, toMs = null
  for (const q of list) { const ms = q.recvMs; if (ms > 0) { if (fromMs == null || ms < fromMs) fromMs = ms; if (toMs == null || ms > toMs) toMs = ms } }
  const bound = ctx ? ctx.maxRegimeAgeMin : null
  const all = name && ctx?.rows?.[name] ? unpackRegimeRows(ctx.rows[name]) : []
  // The rows a signal inside [fromMs, toMs] could read: none newer than
  // toMs (the future), and — under an age bound — none older than
  // fromMs − bound, which is stale for every signal (asOfTrendReader's cut).
  let rows = all
  // A window whose first signals have no row to read, where a row the 30-day
  // prune deleted (older than the table's oldest, `retainedFrom`) would still
  // have been inside the age bound, may have lost readings to the prune: those
  // signals read "no reading" (both sides granted), which is the prune, not
  // the market. Stated, so a filter that could not see is never read as one
  // that found nothing. A row at or before the window's start makes every
  // pruned row older than a row the window can read, so nothing is lost.
  let rowsMayBePruned = null
  if (fromMs != null && toMs != null) {
    const hi = sqlStamp(toMs)
    const lo = Number(bound) > 0 ? sqlStamp(fromMs - Number(bound) * 60_000 - 1000) : null
    rows = all.filter(r => r.at <= hi && (lo == null || r.at >= lo))
    // (Not asked with the gate off or the symbol unnamed: nothing is read then, and the manifest says why.)
    if (ctx?.retainedFrom != null && ctx.gateOn !== false && name) {
      const covered = rows.length > 0 && rows[0].at <= sqlStamp(fromMs)
      rowsMayBePruned = covered ? false : lo == null ? true : String(ctx.retainedFrom) > lo
    }
  }
  const digest = createHash('sha256').update(JSON.stringify(rows.map(r => [r.at, r.dir ?? null]))).digest('hex').slice(0, 16)
  const sidesAt = (ms) => {
    if (!ctx || ctx.gateOn === false || !name) return null
    const reading = trendReadingFromRows(rows, ms, bound)
    return reading == null ? null : permittedSides(reading)
  }
  return {
    sidesAt,
    manifest: {
      symbol: name, gateOn: ctx ? ctx.gateOn !== false : null, maxRegimeAgeMin: bound ?? null, rows: rows.length, digest, rowsMayBePruned,
      ...(name ? {} : { note: ctx ? 'the symbol id is not in the tick universe map for the segments\' environment: no regime is read, so no signal is vetoed as counter-trend (the live feeder grants both sides with no reading)' : 'no regime context was given' }),
    },
  }
}

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
export function researchPlan(body = {}, { costSchedule = null, symbolClass = null, entryCfg = null, gate = null } = {}) {
  const sim = { ...plain(body.sim) }
  // PR-Q3: the body's switches become the stamped block, every value from the
  // permits' config and the regime gate (the doors refuse any other shape
  // before this is reached). No filter asked → no key, the sim as before.
  const askedFilters = liveFiltersRequested(body)
  if (askedFilters?.error) throw new TypeError(`${askedFilters.error}: ${LIVE_FILTERS_WHERE}`)
  const block = liveFiltersBlock(askedFilters, { entryCfg: entryCfg || loadTickEntryConfig(), gate })
  if (block) sim.liveFilters = block
  else delete sim.liveFilters
  // PR-Q1: ONE reading of "the test block is open" for every door —
  // body.includeTest or body.sim.includeTest, true and nothing else — so the
  // refusal below and the replay cannot disagree about whether it was opened.
  const includeTest = includeTestAsked(body)
  if (includeTest) sim.includeTest = true
  else delete sim.includeTest
  // PR-Q1: maxHoldEvents 0 (what tick-shadow-sim.json ships) is the default
  // 4N, as the sidecar reads it — normalised here as well as in simulate, so
  // a 0 and an absent value are the same stored sim and the same trial id.
  if (!(Number(sim.maxHoldEvents) > 0)) delete sim.maxHoldEvents
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
    // PR-Q1: the stage-A grid is the DEFAULT only for a withheld run. One
    // POST with includeTest used to open the holdout for 12 grid points × every
    // symbol at once; with the test block asked for, the default is the one
    // declared profile (and an explicit stageA:true is refused before this).
    stageA: includeTest ? body.stageA === true : body.stageA !== false,
    dryRun: body.dryRun === true,
    includeTest,
    declaredProfile: includeTest ? String(body.profileHash).trim().toLowerCase().slice(0, 16) : null,
    params: plain(body.params),
    sim,
    onlySymbol: body.symbol != null && Number.isFinite(Number(body.symbol)) ? Number(body.symbol) : null,
    symbolClass: symbolClassMap,
    note: rawNote == null ? null : rawNote.slice(0, NOTE_MAX),
    noteTruncated,
  }
}

/** PR-Q1: whether a research body asks for the test block — body.includeTest or body.sim.includeTest, `true` only. */
export function includeTestAsked(body = {}) {
  const b = body || {}
  return b.includeTest === true || plain(b.sim).includeTest === true
}

export const INCLUDE_TEST_WHERE = 'the test block is the owner\'s ONE confirmation run (plan §7): ask for it with includeTest:true, stageA absent or false, not a dry run, params for exactly one profile and profileHash naming that profile (16 or 64 hex, from GET /state/tick-research); every opening is recorded on the ledger and a second opening of the same holdout is refused'

/**
 * PR-Q1 (the ledger blocker, review 25-09-2026): the refusals that need no
 * database, shared by the route, the in-thread action and the script. A dry
 * run wrote nothing, so an opening through it was invisible to the ledger
 * (the result lived only in the job's memory); a stage-A POST opened the
 * holdout for twelve profiles at once; neither can happen now. `includeTest`
 * must name exactly ONE declared profile: `profileHash` agrees with `params`.
 */
export function includeTestRefusal(body = {}) {
  const b = body || {}
  if (!includeTestAsked(b)) return null
  const refuse = (error, extra = {}) => ({ status: 400, body: { ok: false, error, ...extra, where: INCLUDE_TEST_WHERE } })
  if (b.dryRun === true) return refuse('include_test_dry_run', { note: 'a dry run writes nothing, so a test-block opening through it would never reach the ledger' })
  if (b.stageA === true) return refuse('include_test_needs_one_profile', { note: 'a stage-A grid is twelve profiles; the test block is opened for one declared profile' })
  const named = typeof b.profileHash === 'string' ? b.profileHash.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{16}([0-9a-f]{48})?$/.test(named)) return refuse('include_test_needs_declared_profile', { profileHash: b.profileHash ?? null })
  const full = profileHashFull(normalizeParams(plain(b.params)))
  if (!full.startsWith(named)) return refuse('include_test_profile_mismatch', { profileHash: named, paramsProfile: full.slice(0, 16), note: 'the named profile is not the one these params produce' })
  return null
}

export const BLOCKS_WHERE = `the keeper cuts every research replay in ${RESEARCH_BLOCKS} chronological blocks (train / validation / test): the withheld summary stops at the test block only at that cut, and the opening ledger recognises a test-block read only at that cut. Omit sim.blocks, or send ${RESEARCH_BLOCKS}`

/**
 * Q1 FOLLOW-UP (checker B3): `sim.blocks` is not the caller's to set. The
 * replayer withholds the test block only when blocks > 1, and cuts it at
 * (n-1)/n: with `blocks: 1` nothing was withheld, the summary covered every
 * event and the trial was stored as a v2 withheld trial with no opening on
 * the ledger (the checker's probe: a summary identical to the includeTest
 * run's, 2 trades, netR 0.3153); with `blocks: 4` the cut fell inside the
 * default test third. So
 * every research door — the in-thread action, the job, the sync door and the
 * script — refuses any value but RESEARCH_BLOCKS, before anything is read.
 */
export function blocksRefusal(body = {}) {
  const sim = plain((body || {}).sim)
  if (!('blocks' in sim) || sim.blocks === RESEARCH_BLOCKS) return null
  return { status: 400, body: { ok: false, error: 'blocks_fixed', blocks: sim.blocks ?? null, where: BLOCKS_WHERE } }
}

/**
 * PR-Q1: the refusal that needs the ledger — a second opening of the same
 * holdout. Until PR-Q2 declares a future-only holdout window, the holdout is
 * the profile's own (HOLDOUT_UNDECLARED), and a profile whose pre-v2 trials
 * printed the leaking summary has ALREADY been consulted.
 */
export function openingRefusal(db, plan) {
  if (!plan?.includeTest) return null
  const prior = testOpeningsFor(db, plan.declaredProfile, HOLDOUT_UNDECLARED)
  if (!prior.consulted) return null
  return { status: 409, body: { ok: false, error: 'second_opening', profileHash: plan.declaredProfile, holdout: HOLDOUT_UNDECLARED, openings: prior.openings, consultedTrials: prior.consultedTrials, legacyConsultedTrials: prior.legacyConsultedTrials, where: `the test block of profile ${plan.declaredProfile} has already been consulted (${prior.openings.length} recorded opening(s), ${prior.consultedTrials} stored trial(s) whose summary covered the test block, ${prior.legacyConsultedTrials} of them pre-v2); a second opening of the same holdout is refused — a fresh, future-only holdout is PR-Q2's declared window` } }
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
  const trials = runTrials(loaded, { stageA: plan.stageA, params: plan.params, sim: plan.sim, symbolClass: plan.symbolClass, trendContext: plan.trendContext ?? null })
  // Fix round (checker N3): agent/config/tick-shadow-sim.json is read ONCE
  // per replay, not once per trial — its liveFilters block (only when a trial
  // carries one; undefined otherwise, so replayChecks never looks) and the
  // cost schedule replayChecks read per trial from the same file. Both are
  // what replayChecks would have read itself, so every verdict is unchanged.
  const schedule = loadRepoSchedule()
  const shadowFilters = trials.some(t => t.sim?.liveFilters != null) ? shadowLiveFilters() : undefined
  return { manifest: loaded.manifestBase, trials: trials.map(t => ({ trial: t, verdict: replayChecks(t, replayThresholds, { schedule, shadowFilters }) })) }
}

/** The main-thread half: import (unless dry) and shape the reply. */
function finish(db, plan, replayed, replayThresholds, dir, importTrial, admitted = {}, origin = null) {
  const bound = plan.maxSegments == null ? '' : ` (maxSegments ${plan.maxSegments}: ${replayed.manifest.files.length} of ${plan.segmentsAvailable ?? replayed.manifest.files.length} segment(s), oldest first)`
  const noteText = plan.note ?? ((plan.stageA ? 'stage-A grid via POST /actions/tick-research' : 'POST /actions/tick-research') + bound)
  const out = replayed.trials.map(({ trial: t, verdict }) => {
    const imported = plan.dryRun ? { ok: true, trialId: t.trialId, inserted: false } : importTrial(db, t, { note: noteText, origin })
    return { trialId: imported.trialId ?? t.trialId, inserted: !plan.dryRun && imported.inserted === true, imported: !plan.dryRun && imported.ok === true, ...(imported.existingOrigin ? { existingOrigin: imported.existingOrigin } : {}), symbolId: t.manifest.symbolId, profileHash: t.profileHash, params: t.params, summary: t.summary, blocks: t.blocks, replay: verdict }
  })
  return {
    ok: true, dryRun: plan.dryRun, stageA: plan.stageA, includeTest: plan.includeTest === true, segmentsDir: dir, manifest: replayed.manifest, thresholds: replayThresholds,
    origin,
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
export function tickResearchAction(db, body = {}, { segmentsDir = process.env[SEGMENTS_ENV], thresholds = null, importTrial = importTickTrial, maxRecords = MAX_RECORDS, segmentsAvailable = null, actor = null } = {}) {
  const bounded = maxSegmentsFrom(body)
  if (bounded.refuse) return bounded.refuse
  const itRefused = includeTestRefusal(body) || blocksRefusal(body) || liveFiltersRefusal(body)
  if (itRefused) return itRefused
  const a = withAvailable(admit(segmentsDir, { maxRecords, maxSegments: bounded.value }), segmentsAvailable)
  if (a.refuse) return a.refuse
  const filterCtx = replayFilterContext(db)
  const plan = researchPlan(body, { ...replayCostContext(db), ...filterCtx })
  const second = openingRefusal(db, plan)
  if (second) return second
  plan.segmentsAvailable = a.segmentsAvailable
  plan.segmentsDropped = a.segmentsDropped
  if (plan.sim.liveFilters?.counterTrend) plan.trendContext = replayTrendContext(db, { files: a.files, gate: filterCtx.gate })
  const th = thresholds || loadThresholds()
  const origin = keeperOrigin('keeper_inline', null, actor)
  // PR-Q1: the opening is written BEFORE the replay reads the test block, so
  // a replay that throws half-way is still on the ledger as an opening.
  const opening = plan.includeTest ? recordTestOpening(db, { profileHash: plan.declaredProfile, channel: 'keeper_inline', actor, detail: { files: a.files.map(f => basename(f)), onlySymbol: plan.onlySymbol } }) : null
  const replayed = replayFiles(a.files, plan, th.replay)
  if (!replayed) {
    if (opening) settleTestOpening(db, opening.id, { status: 'no_data' })
    return { status: 409, body: { ok: false, error: 'no_segments', where: `${a.files.length} segment file(s) at ${a.dir} decoded to no valid quote event`, segmentsDir: a.dir, segments: a.files.length } }
  }
  const out = finish(db, plan, replayed, th.replay, a.dir, importTrial, a, origin)
  if (opening) {
    settleTestOpening(db, opening.id, { status: 'opened', trialIds: out.trialIds })
    out.opening = { id: opening.id, profileHash: plan.declaredProfile, holdout: HOLDOUT_UNDECLARED }
  }
  return { status: 200, body: out }
}

/** PR-Q1: the origin every keeper-replayed trial carries — who asked, which build, which job. */
export function keeperOrigin(kind, jobId, actor) {
  return { kind, verified: true, jobId: jobId ?? null, actor: actor ?? null, replayerCommit: replayerCommit(), note: 'replayed by this keeper over the segments its manifest names (fileDigests)' }
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
export function startTickResearchJob(db, body = {}, { segmentsDir = process.env[SEGMENTS_ENV], thresholds = null, importTrial = importTickTrial, maxRecords = MAX_RECORDS, workerFile = WORKER_FILE, now = new Date(), segmentsAvailable = null, segmentsFailed = [], actor = null, workerCtor = null, filterCtx: givenFilterCtx = null, trendContext: givenTrendContext = null } = {}) {
  if (jobs.current) {
    return { status: 409, body: { ok: false, error: 'research_running', jobId: jobs.current.jobId, startedAt: jobs.current.startedAt, where: 'one research job runs at a time; poll GET /state/tick-research-job?id=<jobId> and post again when it is done' } }
  }
  const bounded = maxSegmentsFrom(body)
  if (bounded.refuse) return bounded.refuse
  const itRefused = includeTestRefusal(body) || blocksRefusal(body) || liveFiltersRefusal(body)
  if (itRefused) return itRefused
  const a = withAvailable(admit(segmentsDir, { maxRecords, maxSegments: bounded.value }), segmentsAvailable)
  if (a.refuse) return a.refuse
  const filterCtx = givenFilterCtx || replayFilterContext(db)
  const plan = researchPlan(body, { ...replayCostContext(db), ...filterCtx })
  const second = openingRefusal(db, plan)
  if (second) return second
  plan.segmentsAvailable = a.segmentsAvailable
  plan.segmentsDropped = a.segmentsDropped
  // PR-Q3: the worker has no database, so the regime rows it may read ride
  // the plan (packed); the job record's copy of the plan leaves them out.
  // Fix round (checker B2): the route's door hands in the context it built
  // off the loop (replayTrendContextAsync) with the gate it read; it is used
  // when it covers the segments admitted here, else read here as before.
  let regimeRead = null
  if (plan.sim.liveFilters?.counterTrend) {
    const prebuilt = trendContextCovers(givenTrendContext, a.files, filterCtx.gate)
    plan.trendContext = prebuilt ? givenTrendContext : replayTrendContext(db, { files: a.files, gate: filterCtx.gate })
    regimeRead = prebuilt ? 'handed in by the caller (the route\'s door reads it a page at a time, yielding to the event loop between pages)' : 'read in one pass on the calling thread'
  }
  const th = thresholds || loadThresholds()
  // Checker, 20-09-2026: `segmentsFailed` was on the 202 alone, so an
  // operator who posts and then polls never learns that a segment could not
  // be pulled — the same shape as the figures that used to live only on the
  // transient response. It rides the job record too.
  const failedNote = segmentsFailed.length ? { segmentsFailed, segmentsFailedNote: `${segmentsFailed.length} listed segment(s) could not be pulled and are NOT in this replay; the replayed set is the oldest that did arrive` } : {}
  const j = { jobId: randomUUID().slice(0, 12), state: 'running', startedAt: now.toISOString(), finishedAt: null, segmentsDir: a.dir, segments: a.files.length, records: a.records, maxSegments: plan.maxSegments, segmentsAvailable: a.segmentsAvailable, segmentsDropped: a.segmentsDropped, ...failedNote, plan: { stageA: plan.stageA, dryRun: plan.dryRun, params: plan.params, sim: plan.sim, onlySymbol: plan.onlySymbol, maxSegments: plan.maxSegments, noteTruncated: plan.noteTruncated }, ...(regimeRead ? { regimeRead } : {}), result: null, error: null, worker: null, db, importTrial }
  // PR-Q1: the job's opening is on the ledger from the moment the worker can
  // read the test block, with the job id and the caller; the job record says
  // so too. A worker that dies before reporting showed its result to no one
  // and is settled `failed_unseen` (not counted as a consultation); one that
  // reported is `opened` with its trial ids, whatever the import then does.
  //
  // Q1 FOLLOW-UP (checker N3): written BEFORE the worker starts. It was
  // written after `new Worker` and after the single-job slot was taken, so a
  // throwing write left a worker reading the test block with no ledger row and
  // a slot that never cleared (every later POST 409 until a restart). Now a
  // failed write refuses the request with nothing started, and a worker that
  // cannot start settles the row `failed_unseen` (it read nothing).
  const origin = keeperOrigin('keeper_job', j.jobId, actor)
  let opening = null
  if (plan.includeTest) {
    opening = recordTestOpening(db, { profileHash: plan.declaredProfile, channel: 'keeper_job', jobId: j.jobId, actor, detail: { files: a.files.map(f => basename(f)), onlySymbol: plan.onlySymbol } })
    j.opening = { id: opening.id, profileHash: plan.declaredProfile, holdout: HOLDOUT_UNDECLARED }
  }
  const settleOpening = (patch) => { if (opening) { try { settleTestOpening(db, opening.id, patch) } catch { /* the row stays 'opened' — the conservative reading */ } } }
  let worker
  try {
    worker = new (workerCtor || Worker)(workerFile, { workerData: { files: a.files, plan, replay: th.replay } })
  } catch (err) {
    settleOpening({ status: 'failed_unseen' })
    return { status: 500, body: { ok: false, error: 'worker_start_failed', detail: err.message } }
  }
  j.worker = worker
  jobs.current = j
  j.plan.includeTest = plan.includeTest
  j.origin = origin
  let settled = false
  worker.on('message', (msg) => {
    if (settled) return
    settled = true
    try {
      if (!msg || !msg.ok) { settleOpening({ status: 'failed_unseen' }); settle(j, { state: 'failed', error: msg?.error || 'worker returned no result' }); return }
      if (!msg.replayed) { settleOpening({ status: 'no_data' }); settle(j, { state: 'failed', error: 'no_segments', result: { ok: false, error: 'no_segments', where: `${a.files.length} segment file(s) at ${a.dir} decoded to no valid quote event`, segmentsDir: a.dir, segments: a.files.length } }); return }
      settleOpening({ status: 'opened', trialIds: msg.replayed.trials.map(t => t.trial.trialId) })
      const result = finish(db, plan, msg.replayed, th.replay, a.dir, importTrial, a, origin)
      settle(j, { state: 'done', result })
    } catch (err) {
      settle(j, { state: 'failed', error: `import failed: ${err.message}` })
    }
  })
  worker.on('error', (err) => { if (settled) return; settled = true; settleOpening({ status: 'failed_unseen' }); settle(j, { state: 'failed', error: err.message }) })
  worker.on('exit', (code) => { if (settled) return; settled = true; settleOpening({ status: 'failed_unseen' }); settle(j, { state: 'failed', error: `worker exited with code ${code} before reporting` }) })
  return { status: 202, body: { ok: true, jobId: j.jobId, state: 'running', startedAt: j.startedAt, segmentsDir: a.dir, segments: a.files.length, records: a.records, maxSegments: plan.maxSegments, segmentsAvailable: a.segmentsAvailable, segmentsDropped: a.segmentsDropped, ...failedNote, dryRun: plan.dryRun, stageA: plan.stageA, includeTest: plan.includeTest, ...(j.opening ? { opening: j.opening } : {}), origin, noteTruncated: plan.noteTruncated, poll: `/state/tick-research-job?id=${j.jobId}`, note: 'the replay runs in a worker thread; the result and the imported trial ids are on the poll URL once state is done' } }
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
  const { cacheDir = null, sync = null, listAll = null, maxRecords = MAX_RECORDS, regimePageRows = REGIME_PAGE_ROWS, regimeYield = undefined, ...rest } = opts
  // PR-Q3 fix round (checker B2): a counter-trend replay's regime rows are
  // read HERE, a page at a time with the loop yielded between pages, and
  // handed to the job with the gate they were read under — the job would
  // otherwise read them in one synchronous pass (0.4 s at 14 days of a
  // production-sized table, 1.9 s at 29). Only for a body that asks.
  const counterTrendAsked = liveFiltersRequested(body)?.counterTrend === true
  const offLoopContext = async (files) => {
    const filterCtx = replayFilterContext(db)
    const trendContext = await replayTrendContextAsync(db, { files, gate: filterCtx.gate, pageRows: regimePageRows, ...(regimeYield ? { yieldTo: regimeYield } : {}) })
    return { filterCtx, trendContext }
  }
  const segmentsDir = opts.segmentsDir ?? process.env[SEGMENTS_ENV]
  const bounded = maxSegmentsFrom(body)
  if (bounded.refuse) return bounded.refuse
  // PR-Q1: an includeTest request that will be refused is refused before a
  // byte is listed or pulled — the same two rules the job itself applies.
  const itRefused = includeTestRefusal(body) || blocksRefusal(body) || liveFiltersRefusal(body)
  if (itRefused) return itRefused
  const second = openingRefusal(db, researchPlan(body))
  if (second) return second
  const maxSegments = bounded.value
  // A job already running — or a SYNC already running (checker m-3: the job
  // slot was only claimed after the sync, so two concurrent POSTs both
  // pulled) — is refused before anything is listed or moved.
  if (jobs.current) return startTickResearchJob(db, body, { ...rest, maxRecords, segmentsDir })
  if (syncLock) {
    return { status: 409, body: { ok: false, error: 'research_running', jobId: syncLock.jobId, startedAt: syncLock.startedAt, where: `a ${syncLock.what || 'segment sync'} for an earlier request is still running; poll GET /state/tick-research-job and post again when it is done` } }
  }
  const local = admit(segmentsDir, { maxRecords, maxSegments })
  if (!local.refuse) {
    if (!counterTrendAsked) return startTickResearchJob(db, body, { ...rest, maxRecords, segmentsDir })
    // The regime read yields, so the slot is claimed first (as the sync
    // claims it): a second POST meanwhile is refused, never doubled.
    syncLock = { jobId: `regimes-${randomUUID().slice(0, 8)}`, startedAt: new Date().toISOString(), what: 'regime-row read (the counter-trend filter\'s context)' }
    try {
      return startTickResearchJob(db, body, { ...rest, maxRecords, segmentsDir, ...(await offLoopContext(local.files)) })
    } finally {
      syncLock = null
    }
  }
  if (local.refuse.body.error !== 'no_segments') return local.refuse
  // CLAIMED BEFORE THE FIRST await. A check-then-act across an await is not
  // a lock: with the claim below the `await import(...)`, both callers ran
  // their synchronous prefix, both saw a null lock and both pulled the same
  // segment (measured: 48 chunk requests where one pull is 24). `admit`
  // above is synchronous, so nothing has yielded yet at this point.
  syncLock = { jobId: `sync-${randomUUID().slice(0, 8)}`, startedAt: new Date().toISOString(), what: 'segment sync' }
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
    const pre = counterTrendAsked ? await offLoopContext(after.files) : {}
    const started = startTickResearchJob(db, body, { ...rest, maxRecords, segmentsDir: dest, segmentsAvailable: listedCount, segmentsFailed: failedNames, ...pre })
    return { status: started.status, body: { ...started.body, sync: pull } }
  } finally {
    syncLock = null
  }
}
