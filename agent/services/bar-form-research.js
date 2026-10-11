// ---------------------------------------------------------------------------
// agent/services/bar-form-research.js — the bar-form research job: its plan,
// refusals, the worker lifecycle, the abort, the persisted run and the views.
//
// Claude · № 13,095 11-Oct (ordered № 13,093; claude-builder), plan step 8.
// RESEARCH ONLY. Starts only on an authenticated POST (the owner's word; a
// small run first). One research job at a time across the research doors
// (research-slot.js, and the tick research's own slot is checked too). The
// CPU work runs in a worker thread; this thread holds the job record, the
// abort flag, and writes the run's two tables in ONE short transaction at
// the end — nothing else touches the database while the job runs, so no
// lock time is added beside the trading loop. Segments are pulled one at a
// time into the temporary cache and deleted after processing.
//
// Every parameter comes from agent/config/research.json or the request and
// is recorded in params_json with the run; nothing here is a constant a
// gate reads. The sample minimum is tick-validation's traded.minTrades.
// ---------------------------------------------------------------------------
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getState } from '../db.js'
import { loadResearchConfig, withOverrides, numberList } from '../lib/research-config.js'
import { acquireResearchSlot, releaseResearchSlot, researchSlot } from './research-slot.js'
import { listAllSides, segmentCacheDir, segmentSides, SEGMENT_NAME_RE } from './tick-segments.js'
import { formsFrom, strategiesFor, EXCLUDED_STRATEGIES } from './bar-form-research-core.js'
import { crossCheckBars, donchianVolumeAgreement } from '../lib/bar-crosscheck.js'

export const CROSS_CHECK_MAX_SYMBOLS = 3

/** The owner's existing sample bar: agent/config/tick-validation.json traded.minTrades, read as a file (the validation module's graph is the live one). */
export const THRESHOLDS_FILE = new URL('../config/tick-validation.json', import.meta.url)
export function loadThresholds({ file = THRESHOLDS_FILE } = {}) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

export const WORKER_FILE = new URL('./bar-form-research-worker.js', import.meta.url)
export const MAX_SEGMENT_NAMES = 400
export const JOB_WHAT = 'bar-form research'
/** The fast monitor's pass record (services/fast-monitor.js PASS_RECORD_KEY; the test pins the two equal): skipped ticks and busy share, read before, during and after a run. */
export const FAST_MONITOR_PASS_KEY = 'fast_monitor_pass_json'
export const LIMIT_KEYS = Object.freeze(['workerMemoryMb', 'maxRuntimeMs', 'maxTempBytes', 'maxCells', 'maxTransactionRows', 'maxPullsPerMinute', 'maxSkippedTicksDelta', 'maxBusyShare10m', 'pollMs'])

/** The fast monitor's current figures, or null when the record is absent/unreadable. */
export function fastMonitorReading(db) {
  try {
    const r = JSON.parse(getState(db, FAST_MONITOR_PASS_KEY) || 'null')
    const t = r?.tick
    if (!t) return null
    return { at: r.at ?? null, skippedTicks: Number.isFinite(Number(t.skippedTicks)) ? Number(t.skippedTicks) : null, busyShare10m: Number.isFinite(Number(t.busyShare10m)) ? Number(t.busyShare10m) : null, skipped10m: Number.isFinite(Number(t.skipped10m)) ? Number(t.skipped10m) : null }
  } catch { return null }
}

const jobs = { current: null, history: [] }
const posInt = v => Number.isInteger(v) && v > 0
const refuse = (status, error, where, extra = {}) => ({ status, body: { ok: false, error, where, ...extra } })

/** The plan from a request body over the config: every value validated, overrides recorded, refusals named. */
export function barFormPlan(body = {}, { research = loadResearchConfig(), thresholds = loadThresholds(), knownSides = null } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const ov = withOverrides(research.barForm, b, {
    timeBarsMs: { list: true, max: 86_400_000, limit: 12, min: 999 }, tickBarsNominalMs: { list: true, max: 86_400_000, limit: 12, min: 999 },
    maxSilenceMs: { int: true }, pauseBetweenSegmentsMs: { int: true }, maxSegmentsPerRun: { int: true }, calibrationSegments: { int: true }, computeWindowBars: { int: true }, maxSymbolsPerRun: { int: true },
  })
  const cfg = ov.value
  if (research.source !== 'file') return { refuse: refuse(409, 'research_config_unavailable', `agent/config/research.json could not be read (${research.file}); a run must say what it used, so none starts without it`) }
  if (!cfg.timeBarsMs?.length && !cfg.tickBarsNominalMs?.length) return { refuse: refuse(400, 'no_forms', 'timeBarsMs and tickBarsNominalMs are both empty: nothing to build') }
  if (!cfg.timeBarsMs?.includes(60_000)) return { refuse: refuse(400, 'baseline_missing', 'timeBarsMs must include 60000: the one-minute time bar is the baseline every other form is compared against') }
  // Amendment area 1: no declared limit, no run.
  const limits = cfg.limits || {}
  const missingLimits = LIMIT_KEYS.filter(k => limits[k] == null)
  if (missingLimits.length) return { refuse: refuse(409, 'limits_missing', `agent/config/research.json barForm.limits must declare: ${missingLimits.join(', ')} (a missing limit leaves the run's readiness unresolved; none is invented)`, { missing: missingLimits }) }
  const symbolIds = b.symbolIds == null ? null : numberList(b.symbolIds, { max: 1e9, limit: cfg.maxSymbolsPerRun ?? 12, min: 0 }).map(Number)
  if (b.symbolIds != null && !symbolIds.length) return { refuse: refuse(400, 'bad_symbol_ids', 'symbolIds must be a non-empty list of positive integers (broker symbol ids of the recorded feed)') }
  const strategies = b.strategies == null ? null : (Array.isArray(b.strategies) ? b.strategies.map(String) : null)
  if (b.strategies != null && (!strategies || !strategies.length || !strategiesFor(strategies).length)) return { refuse: refuse(400, 'bad_strategies', `strategies must name registry keys (tsmom_long is excluded: ${EXCLUDED_STRATEGIES.join(', ')})`) }
  const segments = b.segments == null ? null : (Array.isArray(b.segments) ? b.segments.map(String) : null)
  if (b.segments != null && (!segments || !segments.length || segments.length > MAX_SEGMENT_NAMES || segments.some(n => !SEGMENT_NAME_RE.test(n)) || new Set(segments).size !== segments.length)) return { refuse: refuse(400, 'bad_segments', `segments must be a non-empty list of distinct seg-<start>-<index>.tks names, at most ${MAX_SEGMENT_NAMES}`) }
  const maxSegments = b.maxSegments == null ? (cfg.maxSegmentsPerRun ?? MAX_SEGMENT_NAMES) : Number(b.maxSegments)
  if (!posInt(maxSegments) || maxSegments > MAX_SEGMENT_NAMES) return { refuse: refuse(400, 'bad_max_segments', `maxSegments must be a whole number from 1 to ${MAX_SEGMENT_NAMES}`) }
  const minSample = b.minSample == null ? (thresholds?.traded?.minTrades ?? 30) : Number(b.minSample)
  if (!posInt(minSample)) return { refuse: refuse(400, 'bad_min_sample', 'minSample must be a positive whole number') }
  // Which gateway's segments: named by the sidecar SIDE the segment lister
  // already uses (segmentSides().name), never by a demo/live word (owner
  // principle 1: only routing reads the side, and this is routing by name).
  const sideNames = Array.isArray(knownSides) ? knownSides.map(String) : segmentSides().map(s => s.name)
  const side = b.side == null ? null : String(b.side)
  if (side != null && !sideNames.includes(side)) return { refuse: refuse(400, 'bad_side', `side must be one of the sidecar sides listed: ${sideNames.join(', ')}`) }
  const note = b.note == null ? null : String(b.note).slice(0, 500)
  // The result matrix is bounded before anything is pulled.
  const symbolBound = symbolIds ? symbolIds.length : (cfg.maxSymbolsPerRun ?? 12)
  const cellBound = symbolBound * formsFrom(cfg).length * strategiesFor(strategies).length
  if (cellBound > limits.maxCells) return { refuse: refuse(400, 'too_many_cells', `${symbolBound} symbol(s) × ${formsFrom(cfg).length} form(s) × ${strategiesFor(strategies).length} strateg(ies) = ${cellBound} cells over the declared maxCells ${limits.maxCells}`, { cellBound, maxCells: limits.maxCells }) }
  // Plan step 9: the broker cross-check for up to three of the run's symbols
  // (their one-minute bars against the broker's M1 trendbars for the same
  // minutes). Only symbols the run builds; the fetch happens once, at the end.
  const crossCheck = b.crossCheck == null ? null : numberList(Array.isArray(b.crossCheck) ? b.crossCheck : b.crossCheck?.symbolIds, { max: 1e9, limit: CROSS_CHECK_MAX_SYMBOLS, min: 0 }).map(Number)
  if (b.crossCheck != null && !crossCheck?.length) return { refuse: refuse(400, 'bad_cross_check', `crossCheck must name 1 to ${CROSS_CHECK_MAX_SYMBOLS} symbol ids the run builds`) }
  if (crossCheck && symbolIds && crossCheck.some(id => !symbolIds.includes(id))) return { refuse: refuse(400, 'bad_cross_check', 'crossCheck symbols must be among symbolIds') }
  return {
    plan: {
      cfg, overridden: ov.overridden, configFile: research.file, forms: formsFrom(cfg).map(f => f.form), symbolIds, strategies: strategiesFor(strategies).map(s => s.key),
      segments, maxSegments, minSample, minSampleSource: b.minSample == null ? 'agent/config/tick-validation.json traded.minTrades' : 'request', side, keepCache: b.keepCache === true, dryRun: b.dryRun === true, note, crossCheck, limits, cellBound,
      backtestOpts: { minConviction: b.minConviction == null ? undefined : Number(b.minConviction), minRr: b.minRr == null ? undefined : Number(b.minRr) },
    },
  }
}

function publicJob(j) {
  if (!j) return null
  const { worker, db, abortFlag, ...rest } = j
  void worker; void db; void abortFlag
  return rest
}

export function barFormJobsView() { return { at: new Date().toISOString(), running: publicJob(jobs.current), jobs: jobs.history.map(publicJob), slot: researchSlot() } }
export function barFormJob(id) { const j = jobs.current?.runId === id ? jobs.current : jobs.history.find(x => x.runId === id); return publicJob(j) }

/** Regime readings for the symbols over the window, as sorted {ms, regime} rows per symbol name. */
export function regimeRowsFor(db, symbolNames, { fromMs, toMs }) {
  const names = [...new Set(Object.values(symbolNames).filter(Boolean))]
  const out = {}
  if (!names.length) return out
  const rows = db.prepare(`SELECT symbol, regime, computed_at FROM regimes WHERE symbol IN (${names.map(() => '?').join(',')}) AND computed_at >= datetime(?, 'unixepoch') AND computed_at <= datetime(?, 'unixepoch') ORDER BY computed_at`).all(...names, Math.floor((fromMs ?? 0) / 1000) - 6 * 3600, Math.ceil((toMs ?? Date.now()) / 1000))
  for (const r of rows) { const ms = Date.parse(r.computed_at.replace(' ', 'T') + 'Z'); if (Number.isFinite(ms)) (out[r.symbol] ||= []).push({ ms, regime: r.regime }) }
  return out
}

/** Persist one finished run: the run row and every cell, one transaction. */
export function persistRun(db, j, { manifest, cells, summary }) {
  const ins = db.prepare(`INSERT INTO bar_form_results(run_id, symbol_id, symbol, strategy, form, bars, runs, invalid_bars, trades, verdict, stats_json, r_stats_json, by_half_json, by_regime_json, mde_r, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  db.transaction(() => {
    db.prepare(`INSERT INTO bar_form_runs(run_id, state, started_at, finished_at, actor, params_json, manifest_json, summary_json, error) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(j.runId, j.state, j.startedAt, j.finishedAt, j.actor, JSON.stringify(j.plan), JSON.stringify(manifest), JSON.stringify(summary), j.error)
    for (const c of cells) ins.run(j.runId, c.symbolId, c.symbol, c.strategy, c.form, c.bars, c.runs, c.invalidBars, c.trades, c.verdict, JSON.stringify(c.stats ?? null), JSON.stringify(c.rStats ?? null), JSON.stringify(c.byHalf ?? null), JSON.stringify(c.byRegime ?? null), c.mdeR ?? null, c.note)
  })()
}

/**
 * Start a run. Refuses 409 while any research job runs (this door's or the
 * tick replay's), 409 when no segment is reachable. Returns { status, body }
 * like the tick research door. `deps` lets tests inject the segment lister,
 * the worker constructor and the sides.
 */
export async function startBarFormResearch(db, body = {}, { actor = null, now = new Date(), listAll = listAllSides, sides = null, cacheDir = null, workerCtor = Worker, workerFile = WORKER_FILE, secret = process.env.EXEC_SECRET ?? '', research = undefined, thresholds = undefined, localFiles = null, resolveNames = null, fetchBrokerBars = null } = {}) {
  const allSides = sides ?? segmentSides()
  const planned = barFormPlan(body, { ...(research ? { research } : {}), ...(thresholds ? { thresholds } : {}), knownSides: allSides.map(s => s.name) })
  if (planned.refuse) return planned.refuse
  const plan = planned.plan
  if (jobs.current) return refuse(409, 'research_running', 'one research job runs at a time; poll GET /state/bar-form-research-job and post again when it is done', { runId: jobs.current.runId, startedAt: jobs.current.startedAt })
  // The tick research replay takes the same slot (research-slot.js), so one
  // research job runs at a time across both doors.
  const held = researchSlot()
  if (held) return refuse(409, 'research_running', `a ${held.what} holds the research slot; post again when it is done`, { id: held.id, startedAt: held.startedAt })

  // The segments: named, or the listed ones (oldest first) up to maxSegments; local files for tests.
  let names, sidesUsed, listed = null
  if (localFiles) { names = localFiles.slice(0, plan.maxSegments); sidesUsed = [] } else {
    // Codex P1 on #1311: ONE side per run. Two gateways are two feeds (their
    // ids, quotes and segment clocks are not one stream), so their segments
    // never share a builder state. With no `side` named, the run takes the
    // single side that lists segments and refuses when more than one does.
    const candidates = plan.side == null ? allSides : allSides.filter(s => s.name === plan.side)
    listed = await listAll({ sides: candidates, secret })
    const serving = (listed.sides || []).filter(x => x.reachable && x.segments > 0).map(x => x.side)
    if (!serving.length) return refuse(409, 'no_segments', 'no sealed segment is listed by the sidecar(s) asked (see GET /state/tick-segments)', { sides: listed.sides })
    if (serving.length > 1) return refuse(409, 'side_required', `more than one sidecar side lists segments (${serving.join(', ')}); name one with "side" — one run reads one feed`, { sides: serving })
    sidesUsed = candidates.filter(s => s.name === serving[0])
    listed = await listAll({ sides: sidesUsed, secret })
    const available = listed.names || []
    if (!available.length) return refuse(409, 'no_segments', 'no sealed segment is listed by the sidecar asked (see GET /state/tick-segments)', { sides: listed.sides })
    if (plan.segments) {
      const missing = plan.segments.filter(n => !available.includes(n))
      if (missing.length) return refuse(409, 'segments_not_listed', `${missing.length} named segment(s) are not listed: ${missing.join(', ')}`, { missing })
      names = plan.segments
    } else names = [...available].sort().slice(0, plan.maxSegments)
  }
  // Symbol names for the cells and the regime rows: the route resolves them
  // from the side's first account's map (`resolveNames(sideName) → { accountId,
  // nameOf }`); without a resolver the cells carry ids only.
  const resolved = resolveNames && sidesUsed[0] ? resolveNames(sidesUsed[0].name) : null
  const accountId = resolved?.accountId ?? null
  const symbolNames = {}
  for (const id of plan.symbolIds || []) { const n = resolved?.nameOf?.(String(id)); if (n) symbolNames[id] = String(n).toUpperCase() }
  const runId = randomUUID().slice(0, 12)
  const take = acquireResearchSlot(JOB_WHAT, runId, now)
  if (!take.ok) return refuse(409, 'research_running', `a ${take.held.what} holds the research slot`, take.held)
  const j = { runId, state: plan.dryRun ? 'dry_run' : 'running', startedAt: now.toISOString(), finishedAt: null, actor, plan, segments: names.length, segmentNames: names.slice(0, 50), segmentNamesTruncated: names.length > 50, sides: sidesUsed.map(s => s.name), accountIdForNames: accountId, symbolNames, listed: listed ? { segments: listed.segments, reachable: listed.reachable, sides: listed.sides } : null, progress: null, result: null, error: null, worker: null, db, abortFlag: null }
  if (plan.dryRun) { releaseResearchSlot(runId); jobs.history.unshift(publicJob(j)); return { status: 200, body: { ok: true, dryRun: true, runId, plan, segments: names.length, segmentNames: names, symbolNames, sides: j.sides, note: 'nothing pulled, replayed or written' } } }
  const regimes = regimeRowsFor(db, symbolNames, { fromMs: now.getTime() - 60 * 86_400_000, toMs: now.getTime() })
  const abortFlag = new SharedArrayBuffer(4)
  j.abortFlag = abortFlag
  // Amendment area 1: the operational receipt — the fast monitor's figures
  // before the run, polled during it (a breach sets the abort flag), and
  // read again after; the leftover sweep on every end path.
  j.receipt = { before: fastMonitorReading(db), during: [], after: null, breach: null, limits: plan.limits }
  const destDir = cacheDir || segmentCacheDir()
  const requestAbort = (why) => { Atomics.store(new Int32Array(abortFlag), 0, 1); j.abortRequestedAt = j.abortRequestedAt || new Date().toISOString(); j.receipt.breach = j.receipt.breach || why }
  const poll = setInterval(() => {
    const r = fastMonitorReading(db); if (!r) return
    j.receipt.during.push({ at: new Date().toISOString(), skippedTicks: r.skippedTicks, busyShare10m: r.busyShare10m }); if (j.receipt.during.length > 240) j.receipt.during.shift()
    const before = j.receipt.before
    if (before?.skippedTicks != null && r.skippedTicks != null && r.skippedTicks - before.skippedTicks > plan.limits.maxSkippedTicksDelta) requestAbort({ limit: 'maxSkippedTicksDelta', declared: plan.limits.maxSkippedTicksDelta, observed: r.skippedTicks - before.skippedTicks, at: new Date().toISOString() })
    if (r.busyShare10m != null && r.busyShare10m > plan.limits.maxBusyShare10m) requestAbort({ limit: 'maxBusyShare10m', declared: plan.limits.maxBusyShare10m, observed: r.busyShare10m, at: new Date().toISOString() })
  }, plan.limits.pollMs)
  poll.unref?.()
  const sweep = () => {
    // Pulled segments of THIS run left in the cache (a crash mid-segment): removed; local files are never touched.
    const mine = new Set(localFiles ? [] : names)
    let removed = 0
    try { for (const f of readdirSync(destDir)) if (mine.has(f) || (f.startsWith('seg-') && f.includes('.part'))) { try { unlinkSync(join(destDir, f)); removed++ } catch { /* gone */ } } } catch { /* no dir */ }
    return removed
  }
  jobs.current = j
  // Plan step 9: broker M1 bars for the cross-check symbols, fetched once at
  // the end through the route's `fetchBrokerBars(accountId, symbolId, count,
  // endMs)`; a fetch that fails is recorded, never retried, never fatal.
  const crossCheckAgainstBroker = async (payload) => {
    const want = plan.crossCheck || []
    if (!want.length) return null
    const out = { accountId, symbols: {}, note: 'our 1m bars (bid, receive-time buckets, v = changed quotes) against the broker\'s M1 trendbars for the same minutes; a difference is measured, not attributed' }
    for (const id of want) {
      const ours = payload?.crossCheckBars?.[id] || []
      if (!ours.length) { out.symbols[id] = { error: 'no one-minute bar built for this symbol' }; continue }
      if (!fetchBrokerBars || accountId == null) { out.symbols[id] = { error: 'no broker fetch available (no resolver account or no fetch function)', ours: ours.length }; continue }
      try {
        const endMs = ours[ours.length - 1].t + 60_000
        const theirs = await fetchBrokerBars(accountId, Number(id), ours.length + 5, endMs)
        const tol = plan.cfg.crossCheck || {}
        const tolerance = tol.closeTolerancePoints != null ? tol.closeTolerancePoints / 100_000 : null
        out.symbols[id] = { symbol: symbolNames[id] ?? null, tolerances: tol, ...crossCheckBars(ours, theirs || [], { tolerance }), donchian: donchianVolumeAgreement(ours, theirs || [], { ratioTolerance: tol.ratioTolerance ?? null }) }
      } catch (err) { out.symbols[id] = { error: err?.message || String(err), ours: ours.length } }
    }
    return out
  }
  const finish = (state, { payload = null, partial = false, error = null } = {}) => {
    clearInterval(poll)
    j.state = state; j.finishedAt = new Date().toISOString(); if (error) j.error = error
    j.receipt.after = fastMonitorReading(db)
    if (!j.receipt.breach && payload?.manifest?.breach) j.receipt.breach = payload.manifest.breach
    j.receipt.observed = payload?.manifest?.observed ?? null
    if (!plan.keepCache) j.receipt.sweptLeftovers = sweep()
    if (payload?.cells && plan.limits.maxTransactionRows != null && payload.cells.length > plan.limits.maxTransactionRows) { j.receipt.breach = j.receipt.breach || { limit: 'maxTransactionRows', declared: plan.limits.maxTransactionRows, observed: payload.cells.length }; payload.cells = payload.cells.slice(0, plan.limits.maxTransactionRows); j.receipt.cellsTruncatedToLimit = true }
    if (payload?.manifest) payload.manifest.receipt = j.receipt
    // The job record keeps a SUMMARY (the cells go to the table, not into memory).
    if (payload) j.result = { manifest: payload.manifest ?? null, summary: payload.summary ?? null, cells: Array.isArray(payload.cells) ? payload.cells.length : 0 }
    try { if (state !== 'failed' || partial) persistRun(db, j, payload ?? { manifest: null, cells: [], summary: null }) } catch (err) { j.persistError = err.message }
    releaseResearchSlot(runId)
    jobs.history.unshift(publicJob(j)); if (jobs.history.length > 20) jobs.history.length = 20
    jobs.current = null
  }
  try {
    const w = new workerCtor(workerFile, { workerData: {
      abortFlag,
      stream: { names, sides: sidesUsed, secret, destDir, keepCache: plan.keepCache, symbolIds: plan.symbolIds, cfg: plan.cfg, crossCheckSymbolIds: plan.crossCheck, limits: plan.limits },
      evaluate: { symbolNames, strategies: plan.strategies, cfg: plan.cfg, minSample: plan.minSample, regimes, backtestOpts: Object.fromEntries(Object.entries(plan.backtestOpts).filter(([, v]) => v !== undefined)) },
    } })
    j.worker = w
    w.on('message', m => {
      if (m?.progress) { j.progress = m.progress; return }
      if (!m?.ok) return finish('failed', { error: m?.error || 'worker error' })
      j.state = 'cross_checking'
      crossCheckAgainstBroker(m).then(cc => { if (cc && m.manifest) m.manifest.crossCheck = cc }).catch(err => { if (m.manifest) m.manifest.crossCheck = { error: err?.message || String(err) } })
        .finally(() => finish(m.manifest?.aborted ? 'aborted' : 'done', { payload: m, partial: !!m.manifest?.aborted }))
    })
    w.on('error', err => finish('failed', { error: err?.message || String(err) }))
    w.on('exit', code => { if (jobs.current === j && j.state === 'running') finish('failed', { error: `worker exited ${code} before reporting` }) })
  } catch (err) {
    finish('failed', { error: err?.message || String(err) })
    return refuse(500, 'worker_failed', err?.message || String(err))
  }
  return { status: 202, body: { ok: true, runId, state: 'running', startedAt: j.startedAt, segments: names.length, sides: j.sides, symbolIds: plan.symbolIds, symbolNames, forms: plan.forms, strategies: plan.strategies, minSample: plan.minSample, overridden: plan.overridden, poll: `/state/bar-form-research-job?id=${runId}`, abort: `POST /actions/bar-form-research/abort { "runId": "${runId}" }`, note: 'segments are pulled one at a time into the temporary cache and deleted after processing; the result is written to bar_form_runs/bar_form_results in one transaction at the end' } }
}

/** Abort the running job: the flag is set, the worker stops between segments and reports a partial, aborted run. */
export function abortBarFormResearch(runId) {
  const j = jobs.current
  if (!j || (runId && j.runId !== runId)) return refuse(404, 'no_such_run', runId ? `no running bar-form research with runId ${runId}` : 'no bar-form research is running')
  if (j.abortFlag) Atomics.store(new Int32Array(j.abortFlag), 0, 1)
  j.abortRequestedAt = new Date().toISOString()
  return { status: 202, body: { ok: true, runId: j.runId, note: 'abort requested; the worker stops after the segment in hand and the partial run is recorded as aborted' } }
}

/** GET /state/bar-form-research: a persisted run (the latest by default) with its cells. */
export function barFormResearchView(db, { runId = null, limit = 500 } = {}) {
  const run = runId ? db.prepare('SELECT * FROM bar_form_runs WHERE run_id = ?').get(runId) : db.prepare('SELECT * FROM bar_form_runs ORDER BY id DESC LIMIT 1').get()
  const runs = db.prepare('SELECT run_id, at, state, started_at, finished_at, actor, error FROM bar_form_runs ORDER BY id DESC LIMIT 20').all()
  if (!run) return { at: new Date().toISOString(), run: null, cells: [], runs, note: 'no bar-form research run recorded' }
  const parse = s => { try { return JSON.parse(s) } catch { return null } }
  const cells = db.prepare('SELECT * FROM bar_form_results WHERE run_id = ? ORDER BY id LIMIT ?').all(run.run_id, Math.max(1, Math.min(2000, limit)))
    .map(c => ({ symbolId: c.symbol_id, symbol: c.symbol, strategy: c.strategy, form: c.form, bars: c.bars, runs: c.runs, invalidBars: c.invalid_bars, trades: c.trades, verdict: c.verdict, stats: parse(c.stats_json), rStats: parse(c.r_stats_json), byHalf: parse(c.by_half_json), byRegime: parse(c.by_regime_json), mdeR: c.mde_r, note: c.note }))
  const total = db.prepare('SELECT COUNT(*) AS n FROM bar_form_results WHERE run_id = ?').get(run.run_id).n
  return { at: new Date().toISOString(), run: { runId: run.run_id, at: run.at, state: run.state, startedAt: run.started_at, finishedAt: run.finished_at, actor: run.actor, params: parse(run.params_json), manifest: parse(run.manifest_json), summary: parse(run.summary_json), error: run.error }, cells, cellsTotal: total, cellsTruncated: total > cells.length, runs }
}

/** Test seam: forget in-memory jobs. */
export function _resetBarFormJobs() { jobs.current = null; jobs.history.length = 0 }
