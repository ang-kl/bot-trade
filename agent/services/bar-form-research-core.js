// ---------------------------------------------------------------------------
// agent/services/bar-form-research-core.js — the bar-form research job's
// CPU half: stream sealed tick segments one at a time, build every bar form
// per symbol (lib/tick-bars.js), then replay every registry strategy on each
// form (scripts/backtest-fib.js runBacktest with its research options).
//
// Claude · № 13,095 11-Oct (ordered № 13,093; claude-builder), plan step 8.
// RESEARCH ONLY: runs in a worker thread (bar-form-research-worker.js), reads
// no database, writes nothing but the segment cache it streams through
// (pull → process → delete; at most one segment on disk at a time), and
// nothing live imports it (agent/research-isolation.test.js).
//
// Where the values come from: the forms, silence bound, pause, calibration
// prefix, compute window and design floors are agent/config/research.json
// (or the request), passed in `cfg` and recorded with the run. The sample
// minimum is the owner's existing bar (tick-validation traded.minTrades).
//
// What a result is NOT: a production trade, a profit claim, or a gate
// input. Two to four weeks of ticks detect only large differences; mdeR
// says how large on each cell.
// ---------------------------------------------------------------------------
import { unlinkSync, existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { readSegment, toQuoteEvents } from '../lib/tick-segment.js'
import { timeBars, tickBars, nominalTickCount, refusedByDesignFloor } from '../lib/tick-bars.js'
import { runBacktest, computeRStats, computeStats } from '../scripts/backtest-fib.js'
import { STRATEGY_REGISTRY } from './strategies.js'

export const VERDICTS = Object.freeze(['OK', 'INSUFFICIENT', 'REFUSED_DESIGN_FLOOR', 'NO_BARS'])
/** The backtest's own warm-up (backtest-fib.js WARMUP_BARS) plus one: a run shorter than minBars + this cannot decide once. */
export const BACKTEST_WARMUP_BARS = 30
export const REGIME_MAX_AGE_MS = 6 * 3_600_000
export const EXCLUDED_STRATEGIES = Object.freeze(['tsmom_long']) // not a per-symbol scan strategy (its compute is a no-op)
/** Gaps that dropped only the RECORDER's queue (the live strategy kept running): no warm-up reset. Mirrors tick-research-run.js RECORDER_ONLY_GAPS; the test pins the two equal. */
export const RECORDER_ONLY_GAPS = new Set(['queue_overflow', 'reserve_pause'])

/**
 * One segment file → the normalised quote list per symbol, the SAME shape
 * as tick-research-run.js loadSegments (a repeat carries the last quote's
 * sides and changed:false) with ONE difference: every gap, recorder-only
 * included, is a marker the builders treat as a hole (bars are about data,
 * not about whether the live strategy kept running); only continuity
 * breaks count as warm-up resets. Kept here so the core reaches no live door.
 */
export function quotesFromSegment(file, { symbolIds = null } = {}) {
  const buf = readFileSync(file)
  const seg = readSegment(buf)
  const bySymbol = new Map(), lastValid = new Map(), gapsByReason = {}
  let events = 0, warmupResets = 0, fromMs = null, toMs = null
  if (!seg.header) return { bySymbol, events, gapsByReason, warmupResets, fromMs, toMs, torn: true, bytes: buf.length }
  for (const ev of toQuoteEvents(seg)) {
    if (ev.gap) {
      gapsByReason[ev.reason] = (gapsByReason[ev.reason] || 0) + 1
      lastValid.clear()
      // Every gap is a hole in the BAR data (Codex P1 on #1310: the tick
      // research loader marks only continuity breaks because its strategy
      // kept running through a recorder-only drop; a bar built over dropped
      // quotes is still a bar over missing data). Warm-up resets keep the
      // loader's rule: continuity breaks only.
      if (!RECORDER_ONLY_GAPS.has(ev.reason)) warmupResets++
      for (const list of bySymbol.values()) list.push({ gapMarker: true, reason: ev.reason, recorderOnly: RECORDER_ONLY_GAPS.has(ev.reason) })
      continue
    }
    if (ev.repeat) {
      const prev = lastValid.get(ev.symbolId), list = bySymbol.get(ev.symbolId)
      if (list && prev) list.push({ seq: ev.seq, recvMs: ev.recvMs, bid: prev.bid, ask: prev.ask, snapshot: false, crossed: false, changed: false })
      continue
    }
    if (ev.invalid) continue
    if (symbolIds && !symbolIds.has(Number(ev.symbolId))) continue
    const ms = Math.round(ev.recvMonoNs / 1e6)
    const q = { seq: ev.seq, recvMs: ms, bid: ev.bid, ask: ev.ask, snapshot: ev.quality.snapshot, crossed: ev.quality.crossed, changed: true }
    const list = bySymbol.get(ev.symbolId) || []
    list.push(q); bySymbol.set(ev.symbolId, list)
    if (q.bid != null && q.ask != null) lastValid.set(ev.symbolId, q)
    events++
    if (fromMs == null || ms < fromMs) fromMs = ms
    if (toMs == null || ms > toMs) toMs = ms
  }
  return { bySymbol, events, gapsByReason, warmupResets, fromMs, toMs, torn: seg.truncated, bytes: buf.length }
}

const round3 = n => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null)

/** The timeframe label a strategy's compute receives for a bar duration. Sub-minute forms have no canonical label; the label says so. */
export function timeframeLabel(ms) {
  if (ms % 60_000 === 0) { const m = ms / 60_000; return m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${m}m` }
  return `${ms / 1000}s`
}

/** The forms a run builds, from the config section. */
export function formsFrom(cfg) {
  const out = []
  for (const ms of cfg.timeBarsMs || []) out.push({ kind: 'time', ms, form: `time_${ms}ms`, timeframe: timeframeLabel(ms) })
  for (const ms of cfg.tickBarsNominalMs || []) out.push({ kind: 'tick', ms, form: `tick_approx_${ms}ms`, timeframe: timeframeLabel(ms) })
  return out
}

/** The strategies a run replays: the registry minus the excluded, or the caller's subset of it. */
export function strategiesFor(keys = null) {
  const all = STRATEGY_REGISTRY.filter(s => !EXCLUDED_STRATEGIES.includes(s.key))
  if (!Array.isArray(keys) || !keys.length) return all
  const want = new Set(keys.map(String))
  return all.filter(s => want.has(s.key))
}

/** Split a bar list carrying invalid markers into valid runs. */
export function splitRuns(all) {
  const runs = []; let run = []
  for (const b of all) { if (b.invalid) { if (run.length) { runs.push(run); run = [] } } else run.push(b) }
  if (run.length) runs.push(run)
  return runs
}

function seriesState() { return { all: [], state: null } }

/**
 * Stream the segments. `names` are segment names (pulled from `sides` into
 * `destDir`, each deleted after processing unless keepCache) or absolute
 * paths of local files (read in place, never deleted). Returns per-symbol
 * series per form plus the manifest. `abort()` is polled between segments.
 */
export const CROSS_CHECK_MAX_BARS = 1440 // one day of minutes per symbol
/** The limits the loop checks itself (the rest are the service's): memory, runtime, temp bytes, pull rate. */
export const WORKER_LIMIT_KEYS = Object.freeze(['workerMemoryMb', 'maxRuntimeMs', 'maxTempBytes', 'maxPullsPerMinute'])

export async function processSegments({ names, pull = null, destDir, keepCache = false, symbolIds = null, cfg, abort = () => false, onProgress = null, crossCheckSymbolIds = null, limits = null, now = () => Date.now(), memoryRssBytes = () => process.memoryUsage().rss }) {
  const forms = formsFrom(cfg)
  const timeMs = forms.filter(f => f.kind === 'time').map(f => f.ms)
  const nominal = forms.filter(f => f.kind === 'tick').map(f => f.ms)
  const calibrationSegments = cfg.calibrationSegments ?? 2
  const want = symbolIds ? new Set([...symbolIds].map(Number)) : null
  const states = new Map() // symbolId → { time: Map, tick: Map, calib: [], calibrated }
  const startedMs = now()
  const observed = { maxRssBytes: 0, runtimeMs: 0, maxTempBytes: 0, maxPullsPerMinute: 0 }
  const pullTimes = []
  const manifest = { segments: names.length, processed: 0, pulled: 0, local: 0, failed: [], bytes: 0, records: 0, gapsByReason: {}, warmupResets: 0, fromMs: null, toMs: null, symbols: [], calibration: {}, aborted: false, breach: null, observed, limits: limits ?? null, forms: forms.map(f => f.form), cfg }
  // Amendment area 1: the loop measures itself and stops on the first breach.
  const breached = () => {
    if (!limits) return null
    const rss = memoryRssBytes(); if (rss > observed.maxRssBytes) observed.maxRssBytes = rss
    observed.runtimeMs = now() - startedMs
    if (limits.workerMemoryMb != null && rss > limits.workerMemoryMb * 1024 * 1024) return { limit: 'workerMemoryMb', declared: limits.workerMemoryMb, observed: Math.round(rss / 1024 / 1024) }
    if (limits.maxRuntimeMs != null && observed.runtimeMs > limits.maxRuntimeMs) return { limit: 'maxRuntimeMs', declared: limits.maxRuntimeMs, observed: observed.runtimeMs }
    return null
  }
  const stateFor = id => {
    let st = states.get(id)
    if (!st) { st = { time: new Map(timeMs.map(ms => [ms, seriesState()])), tick: new Map(nominal.map(ms => [ms, { ...seriesState(), n: null }])), calib: [], calibrated: false }; states.set(id, st) }
    return st
  }
  const feedTick = (id, st, quotes) => {
    for (const [ms, ts] of st.tick) {
      if (!ts.n) continue
      const r = tickBars(quotes, { n: ts.n, nominalMs: ms, maxSilenceMs: cfg.maxSilenceMs ?? null, resume: ts.state })
      ts.all.push(...r.bars.map(b => ({ ...b })), ...r.invalid.map(i => ({ t: i.t, invalid: i.reason, n: i.n })))
      ts.all.sort((a, b) => a.t - b.t)
      ts.state = r.state
    }
  }
  // Amendment area 2: N is calibrated on the leading segments ONLY, and those
  // segments are excluded from every form's evaluated series (training data
  // never evaluated; every form shares the same window). The cut is the end
  // of the calibration prefix, recorded in the manifest.
  let calibrationCutMs = null
  const calibrate = () => {
    calibrationCutMs = manifest.toMs
    manifest.calibrationCutMs = calibrationCutMs
    manifest.calibrationSegmentsExcluded = manifest.processed
    for (const [id, st] of states) {
      if (st.calibrated) continue
      manifest.calibration[id] = {}
      for (const [ms, ts] of st.tick) {
        const nc = nominalTickCount(st.calib, { nominalMs: ms })
        ts.n = nc.n
        manifest.calibration[id][ms] = { ...nc, basis: `median changed quotes per ${ms}ms bucket over the first ${manifest.processed} segment(s); those segments are excluded from the evaluated series` }
      }
      st.calib = []; st.calibrated = true
    }
  }
  let calibrated = false
  for (let i = 0; i < names.length; i++) {
    if (abort()) { manifest.aborted = true; break }
    const b = breached()
    if (b) { manifest.breach = { ...b, at: new Date(now()).toISOString(), segment: i }; manifest.aborted = true; break }
    const name = names[i]
    let file = null, pulled = false
    if (isAbsolute(name) && existsSync(name)) { file = name; manifest.local++ } else {
      // `pull(name, destDir)` → { ok, path, error } is the service's (it owns
      // the sidecar sides and the secret); the core never talks to a gateway.
      const r = pull ? await pull(name, destDir) : { ok: false, error: 'no pull function and not a local file' }
      if (!r?.ok) { manifest.failed.push({ name, error: r?.error || 'pull failed' }); continue }
      file = r.path ?? `${destDir}/${name}`; pulled = true; manifest.pulled++
      const t = now(); pullTimes.push(t); while (pullTimes.length && t - pullTimes[0] > 60_000) pullTimes.shift()
      if (pullTimes.length > observed.maxPullsPerMinute) observed.maxPullsPerMinute = pullTimes.length
      if (limits?.maxPullsPerMinute != null && pullTimes.length > limits.maxPullsPerMinute) { manifest.breach = { limit: 'maxPullsPerMinute', declared: limits.maxPullsPerMinute, observed: pullTimes.length, at: new Date(t).toISOString(), segment: i }; manifest.aborted = true; if (!keepCache) { try { unlinkSync(file) } catch { /* gone */ } } break }
    }
    try {
      const size = statSync(file).size
      manifest.bytes += size
      if (pulled && size > observed.maxTempBytes) observed.maxTempBytes = size
      if (pulled && limits?.maxTempBytes != null && size > limits.maxTempBytes) { manifest.breach = { limit: 'maxTempBytes', declared: limits.maxTempBytes, observed: size, at: new Date(now()).toISOString(), segment: i }; manifest.aborted = true; break }
      const seg = quotesFromSegment(file, { symbolIds: want })
      if (seg.torn) manifest.torn = (manifest.torn || 0) + 1
      manifest.records += seg.events
      manifest.warmupResets += seg.warmupResets
      for (const [k, v] of Object.entries(seg.gapsByReason)) manifest.gapsByReason[k] = (manifest.gapsByReason[k] || 0) + v
      if (seg.fromMs != null && (manifest.fromMs == null || seg.fromMs < manifest.fromMs)) manifest.fromMs = seg.fromMs
      if (seg.toMs != null && (manifest.toMs == null || seg.toMs > manifest.toMs)) manifest.toMs = seg.toMs
      for (const [id, quotes] of seg.bySymbol) {
        const st = stateFor(id)
        for (const [ms, ts] of st.time) {
          const r = timeBars(quotes, { barMs: ms, maxSilenceMs: cfg.maxSilenceMs ?? null, resume: ts.state })
          ts.all.push(...r.bars.map(b => ({ ...b })), ...r.invalid.map(x => ({ t: x.t, invalid: x.reason, n: x.n })))
          ts.state = r.state
        }
        if (st.calibrated) feedTick(id, st, quotes)
        else st.calib.push(...quotes)
      }
      manifest.processed++
    } finally {
      if (pulled && !keepCache) { try { unlinkSync(file) } catch { /* already gone */ } }
    }
    if (!calibrated && manifest.processed >= calibrationSegments) { calibrate(); calibrated = true }
    onProgress?.({ done: i + 1, total: names.length, processed: manifest.processed })
    const pause = cfg.pauseBetweenSegmentsMs ?? 0
    if (pause > 0 && i < names.length - 1) await sleep(pause)
  }
  if (!calibrated) calibrate()
  breached(); observed.runtimeMs = now() - startedMs
  // Series per symbol: the time series sorted (invalid markers in place), runs split.
  const series = new Map()
  const evaluated = all => (calibrationCutMs == null ? all : all.filter(b => b.t > calibrationCutMs))
  for (const [id, st] of states) {
    const list = []
    for (const [ms, ts] of st.time) { ts.all.sort((a, b) => a.t - b.t); const ev = evaluated(ts.all); list.push({ kind: 'time', ms, form: `time_${ms}ms`, timeframe: timeframeLabel(ms), all: ev, runs: splitRuns(ev), n: null, excludedForCalibration: ts.all.length - ev.length }) }
    // Fixed-N bars carry NO nominal time label: a strategy that parses the
    // label would read nominal time as elapsed time. `tick` is unparseable;
    // elapsed-time rules in the backtest (time caps) read the bars' own
    // timestamps and stay correct; label-parsing floors are handled by
    // designFloorMs (the form's nominal duration against the floor).
    for (const [ms, ts] of st.tick) { const ev = evaluated(ts.all); list.push({ kind: 'tick', ms, form: `tick_approx_${ms}ms`, timeframe: 'tick', nominalTimeframe: timeframeLabel(ms), all: ev, runs: splitRuns(ev), n: ts.n, excludedForCalibration: ts.all.length - ev.length }) }
    series.set(id, list)
    manifest.symbols.push(Number(id))
  }
  manifest.symbols.sort((a, b) => a - b)
  // Plan step 9: the last day of OUR one-minute bars for the symbols the
  // cross-check names, so the main thread can set them beside the broker's.
  const crossCheckBars = {}
  for (const id of crossCheckSymbolIds || []) {
    const one = series.get(Number(id))?.find(f => f.kind === 'time' && f.ms === 60_000)
    if (one) crossCheckBars[id] = one.all.filter(b => !b.invalid).slice(-CROSS_CHECK_MAX_BARS).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
  }
  return { series, manifest, crossCheckBars }
}

/** The regime recorded for a symbol at an entry time: the latest reading at or before it, within REGIME_MAX_AGE_MS. */
export function regimeAt(rows, ms) {
  if (!Array.isArray(rows) || !rows.length) return 'unknown'
  let lo = 0, hi = rows.length - 1, best = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].ms <= ms) { best = mid; lo = mid + 1 } else hi = mid - 1 }
  if (best < 0 || ms - rows[best].ms > REGIME_MAX_AGE_MS) return 'unknown'
  return rows[best].regime || 'unknown'
}

/**
 * Replay every strategy on every form of every symbol. One cell per
 * (symbol, form, strategy); each run of valid bars is replayed apart and
 * the trades are pooled. Returns the cells and a summary.
 */
export function evaluateSeries({ series, symbolNames = {}, strategies = null, cfg, minSample, regimes = {}, backtestOpts = {} }) {
  const strats = strategiesFor(strategies)
  const cells = []
  for (const [id, forms] of series) {
    const symbol = symbolNames[id] || symbolNames[String(id)] || null
    const regimeRows = symbol ? (regimes[symbol] || []) : []
    for (const f of forms) {
      const bars = f.all.filter(b => !b.invalid).length, invalidBars = f.all.length - bars
      for (const s of strats) {
        const base = { symbolId: Number(id), symbol, strategy: s.key, family: s.family ?? null, form: f.form, kind: f.kind, ms: f.ms, timeframe: f.timeframe, nominalTimeframe: f.nominalTimeframe ?? null, nTicks: f.n ?? null, bars, runs: f.runs.length, invalidBars, excludedForCalibration: f.excludedForCalibration ?? 0 }
        const floor = refusedByDesignFloor(f.ms, cfg.designFloorMs?.[s.key])
        if (floor?.refused) { cells.push({ ...base, verdict: 'REFUSED_DESIGN_FLOOR', trades: 0, note: floor.reason }); continue }
        if (bars === 0) { cells.push({ ...base, verdict: 'NO_BARS', trades: 0, note: 'no valid closed bar of this form for this symbol' }); continue }
        const need = (s.minBars || 0) + BACKTEST_WARMUP_BARS + 1
        let trades = [], runsReplayed = 0, runsTooShort = 0
        for (const run of f.runs) {
          if (run.length < need) { runsTooShort++; continue }
          const r = runBacktest(run, { timeframe: f.timeframe, strategy: s.key, rStats: true, computeWindow: cfg.computeWindowBars ?? null, ...backtestOpts })
          trades.push(...r.trades); runsReplayed++
        }
        trades.sort((a, b) => a.entryT - b.entryT)
        const rStats = computeRStats(trades)
        const mid = Math.floor(trades.length / 2)
        const byRegime = {}
        for (const t of trades) { const k = regimeAt(regimeRows, t.entryT); (byRegime[k] ||= []).push(t) }
        const rs = trades.map(t => t.r).filter(Number.isFinite)
        const mean = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null
        const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / rs.length) : null
        cells.push({
          ...base, verdict: trades.length >= minSample ? 'OK' : 'INSUFFICIENT', trades: trades.length, runsReplayed, runsTooShort,
          stats: computeStats(trades), rStats,
          byHalf: { first: computeRStats(trades.slice(0, mid)), second: computeRStats(trades.slice(mid)) },
          byRegime: Object.fromEntries(Object.entries(byRegime).map(([k, v]) => [k, computeRStats(v)])),
          mdeR: sd != null && rs.length >= 2 ? round3(2 * sd / Math.sqrt(rs.length)) : null,
          note: [f.kind === 'time' && f.ms % 60_000 ? `timeframe label '${f.timeframe}' is sub-minute: a strategy that parses it reads no time cap` : null, f.kind === 'tick' ? `label 'tick' (no nominal time handed to the strategy; nominal ${f.nominalTimeframe}); v is bar speed (ticks/s), not a quote count` : null, trades.length < minSample ? `${trades.length} trade(s) under the ${minSample} floor` : null].filter(Boolean).join('; ') || null,
        })
      }
    }
  }
  const byVerdict = {}
  for (const c of cells) byVerdict[c.verdict] = (byVerdict[c.verdict] || 0) + 1
  const leaderboard = cells.filter(c => c.verdict === 'OK' && Number.isFinite(c.rStats?.expectancyLowerR)).sort((a, b) => b.rStats.expectancyLowerR - a.rStats.expectancyLowerR).slice(0, 20)
    .map(c => ({ symbol: c.symbol ?? c.symbolId, strategy: c.strategy, form: c.form, trades: c.trades, expectancyR: c.rStats.expectancyR, expectancyLowerR: c.rStats.expectancyLowerR, profitFactorR: c.rStats.profitFactorR, mdeR: c.mdeR }))
  return { cells, summary: { cells: cells.length, byVerdict, leaderboard, minSample, strategies: strats.map(s => s.key) } }
}
