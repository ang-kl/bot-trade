// Codex · №12,411 · 2026-10-09; codex-footprint: bounded-node-diagnostic.
// Owner-authorised one-shot observation. Disabled without an explicit run ID
// AND unexpired UTC deadline. The durable claim prevents restart replays.
import { performance } from 'node:perf_hooks'
import { startDiagnosticProfile, diagnosticProfileTimeline } from './cpu-profile.js'
import { currentLagPhase } from './event-loop-lag.js'
import { captureSql } from './diagnostic-sql.js'
import { readHybridVerdicts, readDiagnosticPopulation, readTradingAssessment } from './diagnostic-readout.js'
import { inflightSummary } from '../lib/inflight.js'

const WINDOW_MS = 120_000, OUTPUT_BYTES = 512 * 1024, DETAIL_CAP = 200
let httpTap = null

export function diagnosticHttpMiddleware(req, res, next) {
  const tap = httpTap
  if (tap) {
    const start = performance.now(), at = Date.now()
    // Never log arbitrary URLs, query strings, headers or request bodies.
    const route = ['/health', '/api/health'].includes(req.path) ? req.path : 'other'
    const supplied = req.headers?.['x-railway-request-id']
    const requestId = typeof supplied === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(supplied) ? supplied : null
    let done = false
    const detach = () => { res.removeListener('finish', finish); res.removeListener('close', finish) }
    const finish = () => {
      if (done) return
      done = true; detach(); tap.pending.delete(detach)
      tap.record({ at, start, end: performance.now(), route, requestId, status: res.statusCode, finished: res.writableFinished })
    }
    if (tap.pending.size < DETAIL_CAP) { tap.pending.set(detach, { at, start, route, requestId }); res.once('finish', finish); res.once('close', finish) }
    else tap.overflow()
  }
  next()
}

function emitter(log, identity) {
  let bytes = 0, lines = 0, dropped = 0
  const emit = (kind, value) => {
    try {
      const line = JSON.stringify({ diagnostic: 'bounded-node-v1', ...identity, kind, value })
      const n = Buffer.byteLength(line)
      if (n > 16000 || bytes + n > OUTPUT_BYTES - 2048) { dropped++; return }
      bytes += n; lines++; log(line)
    } catch { dropped++ }
  }
  const finish = value => {
    try { log(JSON.stringify({ diagnostic: 'bounded-node-v1', ...identity, kind: 'exit',
      value: { ...value, bytes, lines, dropped, outputCapBytes: OUTPUT_BYTES } })) } catch { /* output sink */ }
  }
  return { emit, finish }
}

export function startBoundedNodeDiagnostic(db, { env = process.env, log = console.log,
  now = Date.now, monotonic = () => performance.now(), durationMs = WINDOW_MS,
  profileStart = startDiagnosticProfile, sqlStart = captureSql,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const id = env.NODE_DIAGNOSTIC_RUN_ID, expires = Date.parse(env.NODE_DIAGNOSTIC_EXPIRES_AT || '')
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(id) || !Number.isFinite(expires)
    || expires <= now() || expires - now() > 3_600_000) return null
  const identity = { runId: id, bootAt: new Date(performance.timeOrigin).toISOString(),
    commit: /^[a-f0-9]{40}$/.test(env.RAILWAY_GIT_COMMIT_SHA || '') ? env.RAILWAY_GIT_COMMIT_SHA : null,
    deployment: /^[a-f0-9-]{36}$/.test(env.RAILWAY_DEPLOYMENT_ID || '') ? env.RAILWAY_DEPLOYMENT_ID : null }
  const output = emitter(log, identity)
  try {
    const result = db.prepare('INSERT OR IGNORE INTO agent_state(key,value) VALUES (?,?)')
      .run(`bounded_node_diagnostic:${id}`, JSON.stringify({ at: now(), ...identity }))
    if (result.changes !== 1) { output.emit('not-started', { reason: 'run_already_claimed' }); return null }
  } catch { output.emit('not-started', { reason: 'durable_claim_failed' }); return null }
  let start = monotonic(), at = now(), ms = 0, deadline = start
  let timer, probe, stopSql = null, stopProfile = null, stopped = false, cpu = null
  let cpuReady = false, sql = null, httpDropped = 0, lagDropped = 0, probes = 0, finished = false, hooksRestored = true, httpUnfinished = 0
  const pendingHttp = new Map(), censoredHttp = []
  const http = [], lag = []
  const snapshot = tag => {
    try {
      const verdicts = readHybridVerdicts(db)
      for (const [key, value] of Object.entries(verdicts)) output.emit('stored-verdict', { tag, key, readAt: now(), ...value })
      const population = readDiagnosticPopulation(db)
      for (const [table, value] of Object.entries(population)) {
        const { rows, ...metadata } = value
        output.emit('population', { tag, table, readAt: now(), ...metadata, count: rows?.length ?? null })
        for (const row of rows || []) output.emit('row', { tag, table, row })
      }
    } catch { output.emit('readout-error', { tag, reason: 'stored_read_failed' }) }
  }
  const finish = () => {
    if (!stopped || !cpuReady || finished) return
    finished = true
    try {
      output.emit('sql-summary', sql && { ...sql, details: undefined })
      for (const detail of sql?.details || []) output.emit('sql', detail)
      output.emit('cpu-summary', cpu && { ...cpu, windows: undefined })
      for (const window of cpu?.windows || []) output.emit('cpu-window', window)
      for (const detail of lag) output.emit('lag', detail)
      for (const detail of http) output.emit('http', detail)
      for (const detail of censoredHttp) output.emit('http-incomplete', detail)
      snapshot('after')
      try {
        const assessment = readTradingAssessment(db, now())
        const { accounts: protectionAccounts, ...protection } = assessment.protection
        output.emit('independent-protection', protection)
        for (const account of protectionAccounts || []) output.emit('independent-account', account)
        const { accounts: targetAccounts, ...targets } = assessment.targets
        output.emit('performance-targets', targets)
        for (const account of targetAccounts || []) output.emit('performance-account', account)
      } catch { output.emit('assessment-error', { reason: 'stored_read_failed' }) }
    } finally {
      output.finish({ at: now(), startAt: at, durationMs: monotonic() - start, targetMs: ms,
        stopped: true, hooksRestored, probes, httpDropped, httpUnfinished, lagDropped,
        limits: 'main-connection SQL; bounded CPU samples; phase labels are not causes; no broker requests' })
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true; clearTimer(timer); clearTimer(probe); httpTap = null
    httpUnfinished += pendingHttp.size
    for (const [detach, event] of pendingHttp) { detach(); censoredHttp.push({ ...event, end: monotonic(), reason: 'window_ended_before_response' }) }
    pendingHttp.clear()
    try { sql = stopSql?.() || null } catch { hooksRestored = false }
    try { stopProfile?.() } catch { cpuReady = true }
    finish()
  }
  try {
    snapshot('before')
    start = monotonic(); at = now(); ms = Math.min(WINDOW_MS, Math.max(1, durationMs), expires - at); deadline = start + ms
    if (!(ms > 0)) { cpuReady = true; output.emit('not-started', { reason: 'deadline_expired' }); stop(); return null }
    stopProfile = profileStart(profile => { cpu = diagnosticProfileTimeline(profile); cpuReady = true; if (stopped) finish(); else stop() }, { maxMs: ms })
    if (!stopProfile) { cpuReady = true; output.emit('not-started', { reason: 'profiler_busy_or_unavailable' }); stop(); return null }
    stopSql = sqlStart(db, { now: monotonic, wall: now, deadline, phase: currentLagPhase })
    httpTap = { pending: pendingHttp, overflow: () => { httpDropped++ }, record: event => {
      if (stopped || monotonic() > deadline) { httpUnfinished++; return }
      if (http.length < DETAIL_CAP) http.push(event); else httpDropped++
    }
    }
    const schedule = () => {
      const armed = monotonic(), expected = armed + 100, phase = currentLagPhase(), usage = process.cpuUsage()
      probe = setTimer(() => {
        if (stopped) return
        const actual = monotonic(), lateness = Math.max(0, actual - expected), consumed = process.cpuUsage(usage)
        probes++
        if (lateness >= 100) {
          if (lag.length < DETAIL_CAP) {
            const pending = inflightSummary(now())
            lag.push({ at: now(), armed, expected, actual, lateness, phaseAtArm: phase, phase: currentLagPhase(),
              processCpuMs: (consumed.user + consumed.system) / 1000, inflightCount: pending.count,
              oldest: pending.oldest ? { name: String(pending.oldest.name).slice(0, 100),
                startedAt: pending.oldest.startedAt, ms: pending.oldest.ms } : null })
          } else lagDropped++
        }
        if (actual >= deadline) stop(); else schedule()
      }, 100)
      probe?.unref?.()
    }
    output.emit('started', { at, monotonicStart: start, targetMs: ms, initialPhase: currentLagPhase() })
    schedule()
    timer = setTimer(stop, ms); timer?.unref?.()
    return stop
  } catch {
    output.emit('capture-error', { reason: 'instrument_unavailable' })
    if (!stopProfile) cpuReady = true
    stop()
    return null
  }
}
