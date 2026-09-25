// ---------------------------------------------------------------------------
// agent/services/runtime-record.js — the BOOT RECORD and the latency windows
// (V3 M1, P1/P4-1). Measurement only: nothing here decides, gates or trades.
//
// WHY. Every V3 startup observation so far had to be read by hand at the right
// moment, and several were lost: /health keeps only the LAST loop time
// (loop.js last_loop_ms), route timings live in memory and die with the
// process, the first heartbeat's band completion predated the restart
// (closure:122-124), and the #1085 boot — fast monitor 43 s max, 44-48 %
// skipped — was read fifteen minutes late with nothing recording its first
// minutes. A startup window nobody recorded is evidence lost, and the V3 rule
// is that a good later cycle does not erase a failed one (closure:196-198).
//
// WHAT IT KEEPS, per process (BOOT = process start, boot-clock.js):
//   · the boot record — when the database opened, when HTTP listened, and the
//     FIRST of each protection-relevant event after boot: the first main loop
//     {ms, phaseMs}, the first fast-monitor tick, the first protection band,
//     the first all-account Node protection audit (and the first clean one),
//     the first slow-monitor pass, the first equity-stop, adaptive-breaker and
//     performance-breaker evaluation. The equity stop and the breakers run
//     ONLY in the main loop, so their first evaluation waits for the whole
//     first loop — the first loop is protection-relevant, not only an
//     entry-completeness figure. Each stamp is written once per boot, with its
//     outcome: a first evaluation that failed says so;
//   · the startup window's HTTP status counts by route (5xx named per route);
//   · the worst event-loop stall inside the startup window, from the 100 ms
//     probe's tap (event-loop-lag.js), not the 30-second ALIVE sampler;
//   · protection budget overruns per 10-minute window (band steps including
//     loss_guardian's 5 s, the protection audit's 4 s per account);
//   · a ring of the last 360 main-loop durations with p50/p95/p99/max.
//
// PERSISTENCE. `boot_record_json` holds this boot's record and
// `boot_record_prev_json` the previous boot's, rotated exactly once per boot —
// so a restart keeps the evidence of the process it replaced. Written at most
// once every 30 s (setState is FULL-sync and the largest native write cost,
// guardian-write-batch:7-12): every 30 s inside the startup window or when a
// stamp arrived, every 5 minutes otherwise. Stamps themselves only touch
// memory, so no hot path gains a write. Served on AUTHENTICATED /health only.
//
// NO SECRETS. Only fixed field names, numbers, booleans and short strings are
// stored; any key that looks like a credential is dropped and any value that
// looks like a token is redacted (tested with planted ones).
// ---------------------------------------------------------------------------
import { getState, setState } from '../db.js'
import { BOOT_ORIGIN_MS, STARTUP_WINDOW_MS, sinceBootNowMs, inStartupWindow } from './boot-clock.js'
import { lagTapSummary, lagTapStartupWorst } from './event-loop-lag.js'

export const RECORD_KEY = 'boot_record_json'
export const PREV_RECORD_KEY = 'boot_record_prev_json'
export const PERSIST_MIN_MS = 30_000
export const PERSIST_IDLE_MS = 5 * 60_000
export const LOOP_RING_SIZE = 360
export const OVERRUN_WINDOW_MS = 10 * 60_000
const OVERRUN_KEEP = 1_000
const OVERRUN_NAMES = 32
const STARTUP_HTTP_ROUTES = 64

/** The first-after-boot events the record carries — a closed list, so the record stays bounded. */
export const FIRST_STAMPS = Object.freeze([
  'loop', 'fastTick', 'band', 'protectionAudit', 'cleanProtectionAudit',
  'slowMonitor', 'equityStop', 'adaptiveBreaker', 'performanceBreaker',
])

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

/** Nearest-rank percentile of an ascending array; null when empty. Pure. */
export function percentile(sorted, p) {
  if (!sorted?.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[i]
}

/** {n, p50, p95, p99, max} of a list of numbers; nulls when empty. Pure. */
export function summarize(values) {
  const s = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  return { n: s.length, p50: percentile(s, 0.5), p95: percentile(s, 0.95), p99: percentile(s, 0.99), max: s.length ? s[s.length - 1] : null }
}

/** A fixed-capacity ring of {at, v}; the newest overwrite the oldest. */
export function createRing(capacity) {
  const cap = Math.max(1, Math.floor(Number(capacity) || 1))
  const buf = new Array(cap)
  let i = 0
  let size = 0
  return {
    capacity: cap,
    get size() { return size },
    push(v, at = Date.now()) {
      buf[i % cap] = { at: Number(at), v: Number(v) }
      i++
      size = Math.min(cap, size + 1)
    },
    /** Entries oldest-first, optionally only those at or after `sinceMs`. */
    entries(sinceMs = -Infinity) {
      const out = []
      for (let k = i - size; k < i; k++) {
        const e = buf[((k % cap) + cap) % cap]
        if (e && e.at >= sinceMs) out.push(e)
      }
      return out
    },
  }
}

const SECRET_KEY_RE = /secret|token|password|passwd|authori[sz]ation|cookie|credential|api[_-]?key|bearer|session/i
const TOKEN_VALUE_RE = /(Bearer\s+\S+|sess_[0-9a-f]{8,}|\b[A-Za-z0-9_-]{40,}\b)/g

/**
 * Keep only what a boot record may carry: finite numbers, booleans, null,
 * strings up to 200 chars with token-shaped substrings redacted, and plain
 * objects/arrays of the same (depth 3, 40 keys, 20 items). Keys that look
 * like credentials are DROPPED, not redacted. Pure.
 */
export function sanitizeRecordValue(value, depth = 0) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.slice(0, 200).replace(TOKEN_VALUE_RE, '[redacted]')
  if (depth >= 3) return null
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitizeRecordValue(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    let k = 0
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) continue
      if (k++ >= 40) break
      out[key] = sanitizeRecordValue(v, depth + 1)
    }
    return out
  }
  return null
}

// ---------------------------------------------------------------------------
// Process state
// ---------------------------------------------------------------------------
const BOOT_ID = `${Math.round(BOOT_ORIGIN_MS)}-${process.pid}`

function freshRecord() {
  return {
    version: 1,
    bootId: BOOT_ID,
    bootAt: new Date(BOOT_ORIGIN_MS).toISOString(),
    origin: 'process start (performance.timeOrigin)',
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '').slice(0, 7) || null,
    startupWindowMs: STARTUP_WINDOW_MS,
    db: null,
    listening: null,
    first: Object.fromEntries(FIRST_STAMPS.map(k => [k, null])),
  }
}

let record = freshRecord()
let loopRing = createRing(LOOP_RING_SIZE)
let overruns = []                      // {at, name, budgetMs, ms} inside the last window
let overrunTotals = new Map()          // name -> {n, startup, lastAt, lastMs, budgetMs}
let startupHttp = new Map()            // key -> status class counts, inside the startup window
let startupHttpFirst5xx = null
let dirty = true
let lastPersistAt = 0
let rotated = false
let persistTimer = null

const stampNow = (atMs) => ({ at: new Date(atMs).toISOString(), sinceBootMs: sinceBootNowMs() })

/**
 * Stamp the FIRST `name` event of this boot. Write-once: later calls return
 * false and change nothing, so a good second pass never overwrites a failed
 * first one. `fields` are sanitised. Unknown names are refused.
 */
export function stampFirst(name, fields = {}, atMs = Date.now()) {
  try {
    if (!FIRST_STAMPS.includes(name)) return false
    if (record.first[name]) return false
    record.first[name] = { ...stampNow(atMs), ...sanitizeRecordValue(fields) }
    dirty = true
    return true
  } catch { return false }
}

/** The database's own init timing (db.js), and when it finished relative to BOOT. */
export function noteDbStartup(timing, atMs = Date.now()) {
  try {
    record.db = { openedAt: new Date(atMs).toISOString(), openedSinceBootMs: sinceBootNowMs(), init: sanitizeRecordValue(timing ?? null) }
    dirty = true
  } catch { /* measurement never breaks boot */ }
}

/** HTTP is listening. Stamped once. */
export function noteListening(atMs = Date.now()) {
  if (record.listening) return false
  record.listening = stampNow(atMs)
  dirty = true
  return true
}

/**
 * One main-loop cycle ended. Every cycle feeds the ring; the first also
 * stamps `first.loop` with its per-phase breakdown.
 */
export function noteLoopEnd({ startedAtMs, ms, phaseMs = null, ok = true } = {}, atMs = Date.now()) {
  try {
    const v = Number(ms)
    if (!Number.isFinite(v)) return
    loopRing.push(v, atMs)
    stampFirst('loop', {
      startedAt: Number.isFinite(Number(startedAtMs)) ? new Date(Number(startedAtMs)).toISOString() : null,
      ms: v, ok: ok !== false, phaseMs: phaseMs ?? null,
    }, atMs)
    dirty = true
  } catch { /* measurement never breaks the loop */ }
}

/** A protection step outlived its budget (the wait was abandoned). */
export function noteBudgetOverrun(name, budgetMs, ms, atMs = Date.now()) {
  try {
    let key = String(name || 'unknown').slice(0, 60)
    if (!overrunTotals.has(key) && overrunTotals.size >= OVERRUN_NAMES) key = '(other)'
    overruns.push({ at: atMs, name: key, budgetMs: Number(budgetMs) || null, ms: Number(ms) || null })
    const cutoff = atMs - OVERRUN_WINDOW_MS
    if (overruns.length > OVERRUN_KEEP || (overruns[0] && overruns[0].at < cutoff)) {
      overruns = overruns.filter(o => o.at >= cutoff).slice(-OVERRUN_KEEP)
    }
    const t = overrunTotals.get(key) || { n: 0, startup: 0, lastAt: null, lastMs: null, budgetMs: null }
    t.n++
    if (inStartupWindow(atMs)) t.startup++
    t.lastAt = new Date(atMs).toISOString()
    t.lastMs = Number(ms) || null
    t.budgetMs = Number(budgetMs) || null
    overrunTotals.set(key, t)
    dirty = true
  } catch { /* measurement never breaks protection */ }
}

/** Budget overruns: per name in the last 10 minutes, and since boot. */
export function budgetOverrunSummary(nowMs = Date.now()) {
  const from = nowMs - OVERRUN_WINDOW_MS
  const window = {}
  let total = 0
  for (const o of overruns) {
    if (o.at < from || o.at > nowMs) continue
    window[o.name] = (window[o.name] || 0) + 1
    total++
  }
  return { windowMs: OVERRUN_WINDOW_MS, total10m: total, byName10m: window, sinceBoot: Object.fromEntries(overrunTotals) }
}

/**
 * An HTTP response inside the startup window, by route key and status class
 * (route-timing.js hands every request here; outside the window it is a no-op).
 */
export function noteHttpStatus(key, status, atMs = Date.now()) {
  try {
    if (!inStartupWindow(atMs)) return
    let k = String(key || '/').slice(0, 120)
    if (!startupHttp.has(k) && startupHttp.size >= STARTUP_HTTP_ROUTES) k = '(other)'
    const c = startupHttp.get(k) || { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, aborted: 0, other: 0 }
    const s = Number(status)
    const cls = status === 'aborted' ? 'aborted' : s >= 500 && s < 600 ? '5xx' : s >= 400 && s < 500 ? '4xx' : s >= 300 && s < 400 ? '3xx' : s >= 200 && s < 300 ? '2xx' : 'other'
    c[cls]++
    startupHttp.set(k, c)
    if (cls === '5xx' && !startupHttpFirst5xx) startupHttpFirst5xx = { at: new Date(atMs).toISOString(), route: k, status: s }
    if (cls === '5xx' || cls === 'aborted') dirty = true
  } catch { /* never breaks a response */ }
}

/** The startup window's HTTP picture: totals, and every route with a 4xx/5xx/abort. */
export function startupHttpSummary(nowMs = Date.now()) {
  const total = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, aborted: 0, other: 0 }
  const routes = []
  for (const [route, c] of startupHttp) {
    for (const k of Object.keys(total)) total[k] += c[k]
    if (c['4xx'] || c['5xx'] || c.aborted) routes.push({ route, ...c })
  }
  routes.sort((a, b) => (b['5xx'] - a['5xx']) || (b.aborted - a.aborted) || (b['4xx'] - a['4xx']))
  return {
    windowMs: STARTUP_WINDOW_MS,
    // Until the window has passed, the counts are a partial reading.
    complete: nowMs - BOOT_ORIGIN_MS > STARTUP_WINDOW_MS,
    total,
    first5xx: startupHttpFirst5xx,
    routes: routes.slice(0, 20),
  }
}

/** The boot record as it stands now (in memory — fresher than the stored copy). */
export function runtimeRecordSnapshot(nowMs = Date.now()) {
  return {
    ...record,
    first: { ...record.first },
    startupLag: lagTapStartupWorst(),
    startupHttp: startupHttpSummary(nowMs),
    budgetOverruns: budgetOverrunSummary(nowMs),
  }
}

/** Latency windows served beside the boot record. */
export function latencyWindows(nowMs = Date.now()) {
  const loops = loopRing.entries()
  const last = loops[loops.length - 1] || null
  return {
    mainLoop: {
      ...summarize(loops.map(e => e.v)),
      capacity: loopRing.capacity,
      from: loops[0] ? new Date(loops[0].at).toISOString() : null,
      lastMs: last ? last.v : null,
      lastAt: last ? new Date(last.at).toISOString() : null,
    },
    eventLoopLag: {
      source: '100 ms probe tap (services/event-loop-lag.js)',
      last10m: lagTapSummary({ windowMs: 10 * 60_000, nowMs }),
      last2h: lagTapSummary({ windowMs: 2 * 60 * 60_000, nowMs }),
      sinceStart: lagTapSummary({ nowMs }),
    },
    budgetOverruns: budgetOverrunSummary(nowMs),
  }
}

function persistable(nowMs) {
  // Bounded: the lag summaries without their slot detail, and nothing else
  // that can grow. Asserted under 16 KB by the tests.
  const lw = latencyWindows(nowMs)
  return sanitizeRecordValue({
    ...runtimeRecordSnapshot(nowMs),
    latencyWindows: { mainLoop: lw.mainLoop, eventLoopLag: lw.eventLoopLag },
    persistedAt: new Date(nowMs).toISOString(),
  }, -3)
}

/**
 * Write this boot's record, at most once per PERSIST_MIN_MS. On the first
 * write of this process the stored record — if it belongs to another boot —
 * moves to PREV_RECORD_KEY first. Never throws.
 */
export function persistRuntimeRecord(db, { nowMs = Date.now() } = {}) {
  try {
    if (lastPersistAt && nowMs - lastPersistAt < PERSIST_MIN_MS) return { written: false, reason: 'throttled' }
    if (!rotated) {
      const existing = getState(db, RECORD_KEY)
      if (existing) {
        let prevId = null
        try { prevId = JSON.parse(existing)?.bootId ?? null } catch { prevId = null }
        if (prevId !== record.bootId) setState(db, PREV_RECORD_KEY, existing)
      }
      rotated = true
    }
    setState(db, RECORD_KEY, JSON.stringify(persistable(nowMs)))
    lastPersistAt = nowMs
    dirty = false
    return { written: true }
  } catch (err) {
    return { written: false, error: String(err?.message || err).slice(0, 200) }
  }
}

/** This boot's stored record and the previous boot's, parsed; nulls when absent. */
export function readBootRecords(db) {
  const read = (key) => { try { return JSON.parse(getState(db, key) || 'null') } catch { return null } }
  return { stored: read(RECORD_KEY), previous: read(PREV_RECORD_KEY) }
}

/**
 * Start persisting: one write now (so the previous boot's record rotates
 * before anything else can go wrong), then a 30-second check that writes when
 * a stamp arrived or the startup window is still open, and every 5 minutes
 * otherwise. Idempotent; the timer never holds the process open.
 */
export function startRuntimeRecord(db, { everyMs = PERSIST_MIN_MS } = {}) {
  if (persistTimer) return false
  persistRuntimeRecord(db)
  persistTimer = setInterval(() => {
    const now = Date.now()
    const inWindow = now - BOOT_ORIGIN_MS <= STARTUP_WINDOW_MS + everyMs
    if (dirty || inWindow || now - lastPersistAt >= PERSIST_IDLE_MS) persistRuntimeRecord(db, { nowMs: now })
  }, everyMs)
  persistTimer.unref?.()
  return true
}

/** Test seam: a fresh process-state, as if this were a new boot of the same process. */
export function _resetRuntimeRecordForTests({ bootId = null } = {}) {
  if (persistTimer) clearInterval(persistTimer)
  persistTimer = null
  record = freshRecord()
  if (bootId) record.bootId = bootId
  loopRing = createRing(LOOP_RING_SIZE)
  overruns = []
  overrunTotals = new Map()
  startupHttp = new Map()
  startupHttpFirst5xx = null
  dirty = true
  lastPersistAt = 0
  rotated = false
}
