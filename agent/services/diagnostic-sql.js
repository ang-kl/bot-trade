// Codex · №12,410 · 2026-10-09; codex-footprint: bounded-node-diagnostic.
// Temporary measurements only. No SQL text, arguments or results leave here.
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export function queryId(sql) {
  const shape = String(sql).replace(/'(?:''|[^'])*'/g, '?').replace(/\b\d+(?:\.\d+)?\b/g, '?')
  return createHash('sha256').update(shape).digest('hex').slice(0, 16)
}

function caller() {
  return (new Error().stack || '').split('\n').filter(x => x.includes('/agent/')
    && !x.includes('/diagnostic-sql.js')).slice(0, 3)
    .map(x => x.trim().replace(/(?:file:\/\/)?[^ (]*\/agent\//g, 'agent/').slice(0, 240))
}

/** Covers cached statements as well as new prepares on THIS connection only.
 * Iterators retain identity/close semantics; each native next/return is timed.
 * Transaction wrappers are untouched. Native methods, receivers, values and
 * thrown objects are preserved. Restoration runs even if collection fails. */
export function captureSql(db, { now = () => performance.now(), wall = Date.now,
  thresholdMs = 100, cap = 200, deadline = Infinity, phase = () => null } = {}) {
  const saved = [], details = [], totals = {}, ids = new Map()
  let active = true, dropped = 0, diagnosticErrors = 0
  const probe = db.prepare('SELECT 1'), iterator = probe.iterate()
  const dp = Object.getPrototypeOf(db), sp = Object.getPrototypeOf(probe), ip = Object.getPrototypeOf(iterator)
  iterator.return()
  const measure = (op, receiver, fn, args, sql) => {
    const start = now(), at = wall()
    if (!active || start >= deadline) return Reflect.apply(fn, receiver, args)
    let code = null
    try { return Reflect.apply(fn, receiver, args) } catch (e) {
      code = /^SQLITE_[A-Z_]+$/.test(e?.code) ? e.code : 'OTHER'
      throw e
    } finally {
      try {
        const end = now(), ms = end - start
        const t = totals[op] ||= { count: 0, totalMs: 0, maxMs: 0, errors: 0 }
        t.count++; t.totalMs += ms; t.maxMs = Math.max(t.maxMs, ms); if (code) t.errors++
        if (ms >= thresholdMs || code) {
          if (details.length >= cap) dropped++
          else {
            // Cache only bounded statement identities; never retain bindings.
            let id = ids.get(sql)
            if (!id) { id = queryId(sql); if (ids.size < 256) ids.set(sql, id) }
            details.push({ op, queryId: id, role: 'main', at, start, end, ms, code, phase: phase(), caller: caller() })
          }
        }
      } catch { diagnosticErrors++ }
    }
  }
  const wrap = (proto, name, own, sql) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name), original = descriptor.value
    function timed(...args) {
      if (!active || !own(this)) return Reflect.apply(original, this, args)
      return measure(name, this, original, args, sql(this, args))
    }
    Object.defineProperty(proto, name, { ...descriptor, value: timed })
    saved.push(() => {
      if (Object.getOwnPropertyDescriptor(proto, name)?.value === timed) Object.defineProperty(proto, name, descriptor)
    })
  }
  try {
    for (const name of ['prepare', 'exec', 'pragma']) wrap(dp, name, x => x === db, (_, args) => args[0])
    for (const name of ['run', 'get', 'all', 'iterate']) wrap(sp, name, x => x.database === db, x => x.source)
    for (const name of ['next', 'return']) wrap(ip, name, x => x.statement?.database === db, x => x.statement.source)
  } catch (e) { active = false; for (const restore of saved.reverse()) restore(); throw e }
  return () => {
    active = false
    for (const restore of saved.splice(0).reverse()) restore()
    ids.clear()
    return { coverage: 'main connection; native calls including cached statements and iterator steps',
      excluded: 'other connections/processes; JavaScript work outside SQLite calls',
      thresholdMs, cap, dropped, diagnosticErrors, totals, details }
  }
}
