// Codex · №12,944 · 2026-10-10; codex-footprint: bounded-startup-sql.
// Observe existing startup calls only: no probe, claim SQL, timer or DB change.
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isMainThread, threadId } from 'node:worker_threads'
import { queryId } from './diagnostic-sql.js'

const LIMIT = { ms: 120_000, events: 500, bytes: 256 * 1024 }
const PHASES = new Set(['open_and_journal', 'base_schema', 'legacy_repairs', 'column_migrations',
  'indexes', 'history_schema', 'final_migrations_and_seed'])
const usedRuns = new Set()
let captureActive = false
const safeCode = error => /^SQLITE_[A-Z_]+$/.test(error?.code) ? error.code : 'OTHER'
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
function control(sql) {
  const text = typeof sql === 'string' ? sql.trim().replace(/;$/, '').trim() : ''
  if (/^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?$/i.test(text))
    return /\bIMMEDIATE\b/i.test(text) ? 'begin_immediate' : /\bEXCLUSIVE\b/i.test(text) ? 'begin_exclusive' : 'begin_deferred'
  if (/^(?:COMMIT|END)(?:\s+TRANSACTION)?$/i.test(text)) return 'commit'
  if (/^ROLLBACK(?:\s+TRANSACTION)?$/i.test(text)) return 'rollback'
  if (/^ROLLBACK(?:\s+TRANSACTION)?\s+TO\b/i.test(text)) return 'rollback_savepoint'
  if (/^SAVEPOINT\s+/i.test(text)) return 'savepoint'
  if (/^RELEASE(?:\s+SAVEPOINT)?\s+/i.test(text)) return 'release_savepoint'
  return null
}

/** Off unless explicitly requested for an unexpired, at-most-one-hour window.
 * The once-only guard is process-local, not a durable restart claim: creating
 * an agent_state claim before schema initialization would add a competing write.
 * No native call is interrupted. Expiry/caps stop observation at call boundaries.
 */
export function createStartupSqlDiagnostic({ env = process.env, log = console.log,
  now = Date.now, monotonic = () => performance.now(), durationMs = LIMIT.ms,
  events = LIMIT.events, bytes = LIMIT.bytes } = {}) {
  let runId, expires, at, start
  try {
    if (!isMainThread) return null
    runId = env.STARTUP_SQL_DIAGNOSTIC_RUN_ID
    expires = Date.parse(env.STARTUP_SQL_DIAGNOSTIC_EXPIRES_AT || '')
    at = now()
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(runId)
      || !Number.isFinite(expires) || expires <= at || expires - at > 3_600_000
      || usedRuns.has(runId) || usedRuns.size >= 64 || captureActive) return null
    if (![durationMs, events, bytes].every(Number.isFinite)) return null
    start = monotonic()
    if (!Number.isFinite(start)) return null
  } catch { return null }
  usedRuns.add(runId)
  captureActive = true
  const duration = Math.min(LIMIT.ms, Math.max(1, durationMs), expires - at)
  const eventCap = Math.min(LIMIT.events, Math.max(2, Math.floor(events)))
  const byteCap = Math.min(LIMIT.bytes, Math.max(16384, Math.floor(bytes)))
  const deadline = start + duration, saved = [], statementPrototypes = new WeakSet(), iteratorPrototypes = new WeakSet()
  const identity = { diagnostic: 'startup-sql-v1', runId, role: 'main', connection: 'startup-main', threadId,
    bootAt: new Date(performance.timeOrigin).toISOString(), pid: process.pid,
    commit: /^[a-f0-9]{40}$/.test(env.RAILWAY_GIT_COMMIT_SHA || '') ? env.RAILWAY_GIT_COMMIT_SHA : null,
    deployment: /^[a-f0-9-]{36}$/.test(env.RAILWAY_DEPLOYMENT_ID || '') ? env.RAILWAY_DEPLOYMENT_ID : null }
  let db = null, dbId = null, phase = 'open_and_journal', stopped = false, reason = 'active'
  let emitted = 0, outputBytes = 0, dropped = 0, diagnosticErrors = 0, restored = true, depth = 0, sequence = 0
  let transaction = null, transactionSequence = 0
  const emit = (kind, value, terminal = false) => {
    try {
      const line = JSON.stringify({ ...identity, dbId, sequence: ++sequence, kind, ...value })
      const n = Buffer.byteLength(line) + 1
      if (n > (terminal ? 8192 : 16000) || emitted >= (terminal ? eventCap : eventCap - 1)
        || outputBytes + n > (terminal ? byteCap : byteCap - 8192)) {
        dropped++; if (!terminal) reason = 'cap'; return
      }
      emitted++; outputBytes += n
      try { log(line) } catch { dropped++ }
    } catch { diagnosticErrors++ }
  }
  const stop = (why = 'completed') => {
    if (stopped) return
    stopped = true
    captureActive = false
    if (reason === 'active') reason = why
    for (const restore of saved.splice(0).reverse()) {
      try { if (!restore()) restored = false } catch { restored = false; diagnosticErrors++ }
    }
    try {
      emit('exit', { at: now(), elapsedMs: monotonic() - start, reason, hooksRestored: restored,
        eventsBeforeExit: emitted, bytesBeforeExit: outputBytes, dropped, diagnosticErrors,
        limits: { durationMs: duration, events: eventCap, bytes: byteCap },
        onceOnly: 'process', durableReplayProtection: false,
        exclusions: 'Compound exec is one call, not individual SQL statements; pragma includes prepare/read. Unregistered connections/processes, JavaScript outside calls and execution versus wait/I/O are unmeasured. Native calls are never interrupted.' }, true)
    } catch { /* observation cannot replace startup result or error */ }
  }
  const current = () => {
    if (stopped) return false
    try {
      if (reason === 'cap' || monotonic() >= deadline || now() >= expires) {
        stop(reason === 'cap' ? 'cap' : 'deadline'); return false
      }
      return true
    } catch { diagnosticErrors++; stop('instrumentation_failed'); return false }
  }
  const measure = (method, receiver, fn, args, sql) => {
    if (depth || !current()) return Reflect.apply(fn, receiver, args)
    let before, began, beganNs, wall, type, executedControl, id, txId, held
    try {
      before = db?.inTransaction ?? false
      type = control(sql); id = typeof sql === 'string' ? queryId(sql) : null
      // prepare/iterate only create objects; their SQL text does not prove that
      // a transaction control ran or acquired a writer reservation.
      executedControl = ['exec', 'run', 'get', 'all', 'next'].includes(method) ? type : null
      if (!before && (executedControl?.startsWith('begin') || executedControl === 'savepoint'))
        transaction = { id: `main:tx${++transactionSequence}`, reservation: false }
      txId = transaction?.id ?? null; held = before && (transaction?.reservation ?? false)
      wall = now(); began = monotonic(); beganNs = process.hrtime.bigint()
    } catch { diagnosticErrors++; return Reflect.apply(fn, receiver, args) }
    let code = null
    depth++
    try { return Reflect.apply(fn, receiver, args) }
    catch (error) { try { code = safeCode(error) } catch { code = 'OTHER' }; throw error }
    finally {
      depth--
      try {
        const endNs = process.hrtime.bigint(), end = monotonic(), after = db?.inTransaction ?? false
        const acquired = !code && !before && after
          && (executedControl === 'begin_immediate' || executedControl === 'begin_exclusive')
        if (acquired && transaction) transaction.reservation = true
        emit('span', { at: wall, endAt: now(), start: began, end, startMonoNs: beganNs.toString(),
          endMonoNs: endNs.toString(), ms: end - began, phase, method, queryId: id, code,
          control: type, transactionId: txId, inTransactionBefore: before, inTransactionAfter: after,
          acquiredAfterReturn: acquired, reservationHeldThroughStart: held,
          reservationKnownAfter: after && (transaction?.reservation ?? false),
          releaseConfirmed: before && !after && !code,
          reservationReleased: before && !after && !code && (transaction?.reservation ?? false),
          compoundExecSpanOnly: method === 'exec' && !type, crossedDeadline: end >= deadline || now() >= expires })
        if (!after) transaction = null
        current()
      } catch { diagnosticErrors++ }
      if (method === 'open' && code) stop('startup_error')
    }
  }
  const wrap = (proto, name, owns, sql, after = null) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name), original = descriptor?.value
    if (typeof original !== 'function') throw Error('startup_hook_unavailable')
    function measured(...args) {
      let own = false, source = null
      try { own = owns(this); if (own) source = sql(this, args) } catch { diagnosticErrors++ }
      if (!own || stopped) return Reflect.apply(original, this, args)
      const value = measure(name, this, original, args, source)
      if (!stopped && after) { try { after(value) } catch { diagnosticErrors++; stop('instrumentation_failed') } }
      return value
    }
    Object.defineProperty(proto, name, { ...descriptor, value: measured })
    saved.push(() => {
      if (Object.getOwnPropertyDescriptor(proto, name)?.value !== measured) return false
      Object.defineProperty(proto, name, descriptor); return true
    })
  }
  const attachIterator = iterator => {
    const proto = Object.getPrototypeOf(iterator)
    if (iteratorPrototypes.has(proto)) return
    iteratorPrototypes.add(proto)
    for (const name of ['next', 'return']) wrap(proto, name, x => x.statement?.database === db, x => x.statement.source)
  }
  const attachStatement = statement => {
    const proto = Object.getPrototypeOf(statement)
    if (statementPrototypes.has(proto)) return
    statementPrototypes.add(proto)
    for (const name of ['run', 'get', 'all']) wrap(proto, name, x => x.database === db, x => x.source)
    wrap(proto, 'iterate', x => x.database === db, x => x.source, attachIterator)
  }
  emit('started', { at, start, targetMs: duration, expires, onceOnly: 'process', durableReplayProtection: false })
  return {
    open: work => measure('open', null, work, [], null),
    attach(handle) {
      if (!current()) return
      try {
        db = handle; dbId = hash(handle.name)
        const proto = Object.getPrototypeOf(handle)
        wrap(proto, 'prepare', x => x === db, (_, args) => args[0], attachStatement)
        for (const name of ['exec', 'pragma']) wrap(proto, name, x => x === db, (_, args) => args[0])
      } catch { diagnosticErrors++; stop('instrumentation_failed') }
    },
    phase(name) { if (PHASES.has(name)) phase = name },
    stop,
  }
}
