// Codex · №12,721 · 2026-10-10; codex-footprint: bounded-gap-batch.
// Opt-in observation only. Native SQL return values/errors and transaction
// ordering are untouched. No SQL text, bindings, money or broker data is emitted.
import { createHash } from 'node:crypto'
import { getEnvironmentData, setEnvironmentData, threadId } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { queryId } from './diagnostic-sql.js'

const CHANNEL = 'bot-trade-contention-diagnostic-v1'
const LIMIT = { ms: 120_000, events: 500, bytes: 256 * 1024, connections: 8 }
const I = { mutex: 0, events: 1, bytes: 2, dropped: 3, stop: 4, attached: 5, restored: 6, slots: 7, sequence: 8 }
const REASONS = ['active', 'deadline', 'cap', 'operator_stop', 'instrumentation_failed']
const mono = () => process.hrtime.bigint()
const hash = x => createHash('sha256').update(String(x)).digest('hex').slice(0, 16)
let activeMain = null
const STATE_KEYS = new Set(['independent_watchdog_json', 'independent_protection_json', 'loop_inflight_json',
  'hybrid_tick_controller_json', 'momentum_partial_pass_json', 'cashflow_collection_account_cursor', 'minute_review_last_event_id'])

function operation(sql, args) {
  if (/\bagent_state\b/i.test(sql)) {
    const key = args[0]
    return STATE_KEYS.has(key) ? `state:${key}`
      : typeof key === 'string' && /^acct:\d+:cashflow_collection_json$/.test(key) ? 'state:account_cashflow_status' : 'state:other'
  }
  if (/\bcontroller_heartbeats\b/i.test(sql)) return args[0] === 'minute_review' ? 'heartbeat:minute_review' : 'heartbeat:other'
  for (const name of ['scanner_mirror_cursors', 'scanner_mirror_outcomes', 'scanner_mirror_candidates',
    'scanner_comparisons', 'scanner_references', 'scanner_comparison_state', 'account_history', 'account_cashflow_windows']) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(sql)) return name
  }
  return 'other'
}

function control(sql) {
  const text = String(sql).trim().replace(/;$/, '').trim()
  if (/^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?$/i.test(text))
    return /\bIMMEDIATE\b/i.test(text) ? 'begin_immediate' : /\bEXCLUSIVE\b/i.test(text) ? 'begin_exclusive' : 'begin_deferred'
  if (/^(?:COMMIT|END)(?:\s+TRANSACTION)?$/i.test(text)) return 'commit'
  if (/^ROLLBACK(?:\s+TRANSACTION)?$/i.test(text)) return 'rollback'
  if (/^ROLLBACK(?:\s+TRANSACTION)?\s+TO\b/i.test(text)) return 'rollback_savepoint'
  if (/^SAVEPOINT\s+/i.test(text)) return 'savepoint'
  if (/^RELEASE(?:\s+SAVEPOINT)?\s+/i.test(text)) return 'release_savepoint'
  return null
}

function budget(config, log) {
  const shared = new Int32Array(config.shared)
  const stop = reason => Atomics.compareExchange(shared, I.stop, 0, reason)
  const emit = (role, connection, kind, value, terminal = false) => {
    if (!terminal && Atomics.load(shared, I.stop)) return false
    const row = { diagnostic: 'contention-v1', runId: config.runId, bootAt: config.bootAt,
      commit: config.commit, deployment: config.deployment, pid: config.pid, dbId: config.dbId,
      threadId, role, connection, sequence: Atomics.add(shared, I.sequence, 1) + 1, kind, ...value }
    let line
    try { line = JSON.stringify(row) } catch { Atomics.add(shared, I.dropped, 1); return false }
    const bytes = Buffer.byteLength(line) + 1
    // The single main exit owns its reserved slot independently of a worker's
    // reservation mutex, including if that worker dies while holding it.
    if (terminal) {
      if (bytes > 8192) return false
      Atomics.add(shared, I.events, 1); Atomics.add(shared, I.bytes, bytes)
      try { log(line) } catch { Atomics.add(shared, I.dropped, 1) }
      return true
    }
    // A bounded nonblocking reservation protects the aggregate across threads.
    // One final record and 8 KiB are reserved for the main connection's exit.
    if (Atomics.compareExchange(shared, I.mutex, 0, 1) !== 0) { Atomics.add(shared, I.dropped, 1); return false }
    let allowed = false
    try {
      const eventLimit = config.events - 1, byteLimit = config.bytes - 8192
      if (Atomics.load(shared, I.events) < eventLimit && Atomics.load(shared, I.bytes) + bytes <= byteLimit) {
        Atomics.add(shared, I.events, 1); Atomics.add(shared, I.bytes, bytes); allowed = true
      } else { Atomics.add(shared, I.dropped, 1); stop(2) }
    } finally { Atomics.store(shared, I.mutex, 0) }
    if (allowed) { try { log(line) } catch { Atomics.add(shared, I.dropped, 1) } }
    return allowed
  }
  return { shared, stop, emit }
}

/** Instrument one specific Database handle, including cached/native transaction
 * statements. A successful BEGIN IMMEDIATE/EXCLUSIVE proves reservation at its
 * return, never at entry. Other writes, including no-op DDL, do not prove a
 * reservation. Autocommit calls expose a span, not an acquisition instant. */
function attach(db, config, role, { log = console.log, thresholdMs = 50 } = {}) {
  const { shared, stop: requestStop, emit } = budget(config, log)
  const slot = Atomics.add(shared, I.slots, 1)
  if (slot >= LIMIT.connections) { Atomics.add(shared, I.dropped, 1); return null }
  const bit = 1 << slot, connection = `${role}:${threadId}:${slot}`
  Atomics.or(shared, I.attached, bit)
  const deadline = BigInt(config.deadlineMono), saved = []
  let stopped = false, transaction = db.inTransaction ? { id: `${connection}:preexisting`, reservation: false } : null
  let txSequence = 0, timer, finalTimer, finalWritten = false, restored = true
  const emitHere = (kind, fields) => emit(role, connection, kind, fields)
  const at = () => ({ at: Date.now(), monoNs: mono().toString() })
  const finish = () => {
    if (role !== 'main' || finalWritten) return
    finalWritten = emit(role, connection, 'exit', { ...at(), startedAt: config.startedAt,
      elapsedMs: Number(mono() - BigInt(config.startedMono)) / 1e6,
      reason: REASONS[Atomics.load(shared, I.stop)] || 'unknown',
      eventsBeforeExit: Atomics.load(shared, I.events), bytesBeforeExit: Atomics.load(shared, I.bytes),
      dropped: Atomics.load(shared, I.dropped), attachedMask: Atomics.load(shared, I.attached),
      restoredMask: Atomics.load(shared, I.restored), hooksRestored: Atomics.load(shared, I.attached) === Atomics.load(shared, I.restored),
      limits: { targetMs: config.durationMs, events: config.events, bytes: config.bytes },
      exclusions: 'Unregistered connections; statements below threshold except transaction controls/first write observations; reservation for deferred/no-op writes and autocommit/compound exec; execution versus wait/fsync split. Native in-flight calls are never interrupted.' }, true)
  }
  const stop = (reason = 3) => {
    requestStop(reason)
    if (stopped) return
    stopped = true; clearInterval(timer)
    for (const restore of saved.splice(0).reverse()) { try { if (!restore()) restored = false } catch { restored = false } }
    if (restored) Atomics.or(shared, I.restored, bit)
    if (role === 'main') {
      setEnvironmentData(CHANNEL, undefined)
      // Give participating workers their 50 ms stop check before the one exit.
      finalTimer = setTimeout(finish, 150); finalTimer.unref?.()
    }
  }
  const current = () => {
    if (stopped) return false
    if (mono() >= deadline || Date.now() >= config.expiresAt) requestStop(1)
    if (Atomics.load(shared, I.stop)) { stop(Atomics.load(shared, I.stop)); return false }
    return true
  }
  const measure = (method, receiver, fn, args, sql) => {
    if (!current()) return Reflect.apply(fn, receiver, args)
    const start = mono(), wall = Date.now(), before = db.inTransaction, type = control(sql)
    const reservationBefore = before && (transaction?.reservation ?? false)
    const writes = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)
    if (type?.startsWith('begin') || (type === 'savepoint' && !before)) {
      const candidate = `${connection}:tx${++txSequence}`
      if (!before) transaction = { id: candidate, reservation: false }
    }
    const txId = transaction?.id ?? null
    let code = null
    try { return Reflect.apply(fn, receiver, args) } catch (error) {
      code = /^SQLITE_[A-Z_]+$/.test(error?.code) ? error.code : 'OTHER'
      throw error
    } finally {
      // Observation failures must never replace the native result/exception.
      try {
        const end = mono(), after = db.inTransaction, elapsedMs = Number(end - start) / 1e6
        let acquired = false, reservation = transaction?.reservation ?? false
        const firstWrite = !code && after && writes && before && transaction && !transaction.writeObserved
        if (firstWrite) transaction.writeObserved = true
        if (!code && after && (type === 'begin_immediate' || type === 'begin_exclusive')) {
          transaction ||= { id: `${connection}:tx${++txSequence}`, reservation: false }
          transaction.reservation = true; acquired = true; reservation = true
        }
        if (type || firstWrite || elapsedMs >= thresholdMs || code) {
          emitHere(acquired ? 'writer_reserved' : firstWrite ? 'first_write_observed' : 'statement', {
            at: wall, startMonoNs: start.toString(), endAt: Date.now(), endMonoNs: end.toString(), ms: elapsedMs,
            queryId: queryId(sql), operation: operation(sql, args), method, control: type, code, transactionId: transaction?.id ?? txId,
            inTransactionBefore: before, inTransactionAfter: after, reservationKnownAfter: after && reservation,
            reservationHeldThroughStart: reservationBefore,
            releaseConfirmed: before && !after && !code, reservationReleased: before && !after && !code && reservation,
            acquiredAfterReturn: acquired, crossedDeadline: end >= deadline,
            autocommitSpanOnly: method !== 'exec' && !before && !after && !type,
            compoundExecSpanOnly: method === 'exec' && !type })
        }
        if (!after) transaction = null
        current()
      } catch { Atomics.add(shared, I.dropped, 1) }
    }
  }
  const wrap = (proto, name, owns, sql) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name), original = descriptor?.value
    if (typeof original !== 'function') throw Error('diagnostic_hook_unavailable')
    function measured(...args) { return owns(this) ? measure(name, this, original, args, sql(this, args)) : Reflect.apply(original, this, args) }
    Object.defineProperty(proto, name, { ...descriptor, value: measured })
    saved.push(() => {
      if (Object.getOwnPropertyDescriptor(proto, name)?.value !== measured) return false
      Object.defineProperty(proto, name, descriptor); return true
    })
  }
  try {
    const probe = db.prepare('SELECT 1'), iterator = probe.iterate()
    const dp = Object.getPrototypeOf(db), sp = Object.getPrototypeOf(probe), ip = Object.getPrototypeOf(iterator)
    iterator.return()
    for (const name of ['exec', 'pragma']) wrap(dp, name, x => x === db, (_, args) => String(args[0]))
    for (const name of ['run', 'get', 'all', 'iterate']) wrap(sp, name, x => x.database === db, x => x.source)
    for (const name of ['next', 'return']) wrap(ip, name, x => x.statement?.database === db, x => x.statement.source)
    emitHere('registered', { ...at(), transactionAlreadyOpen: db.inTransaction,
      coverage: 'This Database handle; cached statements and native transaction controls; no bindings/results', thresholdMs })
    timer = setInterval(current, 50); timer.unref?.()
    current()
  } catch { stop(4) }
  return { stop, finish, config, connection, get stopped() { return stopped }, get hooksRestored() { return restored },
    dispose() { stop(); clearTimeout(finalTimer); finish() } }
}

/** Durable main claim is the sole activation authority. Worker environment data
 * are inherited only after this claim, never taken from a worker's raw env. */
export function startContentionDiagnostic(db, { env = process.env, log = console.log,
  durationMs = LIMIT.ms, events = LIMIT.events, bytes = LIMIT.bytes, thresholdMs = 50 } = {}) {
  const runId = env.CONTENTION_DIAGNOSTIC_RUN_ID, expires = Date.parse(env.CONTENTION_DIAGNOSTIC_EXPIRES_AT || '')
  const now = Date.now()
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(runId) || !Number.isFinite(expires) || expires <= now || expires - now > 3600_000) return null
  const legacyExpiry = Date.parse(env.NODE_DIAGNOSTIC_EXPIRES_AT || '')
  const legacyRequested = /^[A-Za-z0-9_-]{8,64}$/.test(env.NODE_DIAGNOSTIC_RUN_ID || '')
    && Number.isFinite(legacyExpiry) && legacyExpiry > now && legacyExpiry - now <= 3600_000
  if (legacyRequested || (activeMain && !activeMain.stopped)) {
    try { log(JSON.stringify({ diagnostic: 'contention-v1', runId, kind: 'not_started',
      reason: legacyRequested ? 'legacy_sql_capture_requested' : 'contention_capture_active' })) } catch { /* observation only */ }
    return null
  }
  setEnvironmentData(CHANNEL, undefined)
  const duration = Math.min(LIMIT.ms, Math.max(1, durationMs), expires - now), startedMono = mono()
  const config = { runId, bootAt: new Date(performance.timeOrigin).toISOString(), pid: process.pid,
    commit: /^[a-f0-9]{40}$/.test(env.RAILWAY_GIT_COMMIT_SHA || '') ? env.RAILWAY_GIT_COMMIT_SHA : null,
    deployment: /^[a-f0-9-]{36}$/.test(env.RAILWAY_DEPLOYMENT_ID || '') ? env.RAILWAY_DEPLOYMENT_ID : null,
    dbId: hash(db.name), startedAt: now, startedMono: startedMono.toString(), expiresAt: expires,
    durationMs: duration, deadlineMono: (startedMono + BigInt(Math.ceil(duration * 1e6))).toString(),
    events: Math.min(LIMIT.events, Math.max(2, events)), bytes: Math.min(LIMIT.bytes, Math.max(16384, bytes)), shared: new SharedArrayBuffer(64) }
  try {
    const claim = db.prepare('INSERT OR IGNORE INTO agent_state(key,value) VALUES (?,?)')
      .run(`contention_diagnostic:${runId}`, JSON.stringify({ at: now, bootAt: config.bootAt, deployment: config.deployment, dbId: config.dbId }))
    if (claim.changes !== 1) return null
  } catch { return null }
  const handle = attach(db, config, 'main', { log, thresholdMs })
  activeMain = handle
  if (handle && !handle.stopped) setEnvironmentData(CHANNEL, config)
  return handle
}

export function startContentionWorkerDiagnostic(db, options = {}) {
  const config = getEnvironmentData(CHANNEL)
  if (!config || !(config.shared instanceof SharedArrayBuffer) || config.dbId !== hash(db.name)
    || config.pid !== process.pid || mono() >= BigInt(config.deadlineMono) || Atomics.load(new Int32Array(config.shared), I.stop)) return null
  return attach(db, config, 'scanner-worker', options)
}
