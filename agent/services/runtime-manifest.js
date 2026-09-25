// ---------------------------------------------------------------------------
// agent/services/runtime-manifest.js — what this deployment actually is, with
// every unknown labelled (phase P0 of docs/tick-momentum/plan.md, 11-09-2026).
//
// Plan §17 and blocker B18: "Volume mounts, C++ UID permissions, CPU quotas,
// deployed SQLite and service versions unknown … source changes alone cannot
// close this item." The plan's README of 10-09 asserted an installed SQLite
// 3.53.2; the lockfile pinned better-sqlite3 11.10.0 (it pins 12.8.0, SQLite
// 3.51.3, from 25-09-2026). Neither is a measurement of the deployed process.
// This module IS the measurement, taken inside the running agent, and it says
// "unknown" where it cannot read.
//
// Every item is { key, value, source, verified, note }:
//   verified: true  — read from the process, the filesystem or the database
//   verified: false — reported by configuration or not readable here
// No value is ever estimated. The route GET /state/runtime-manifest serves it.
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { walResetFixed, WAL_RESET_FIXED_FROM } from '../lib/sqlite-wal-reset.js'

const require = createRequire(import.meta.url)

function item(key, value, source, verified, note = null) {
  return { key, value: value === undefined ? null : value, source, verified, note }
}

function readText(path) {
  try { return readFileSync(path, 'utf8').trim() } catch { return null }
}

/** cgroup v2 quota as the plan asks (§8): cpu.max "quota period" or "max". */
export function cgroupLimits(root = '/sys/fs/cgroup') {
  const cpuMax = readText(`${root}/cpu.max`)
  const memMax = readText(`${root}/memory.max`)
  const cpuStat = readText(`${root}/cpu.stat`)
  let cpus = null
  if (cpuMax && cpuMax.startsWith('max')) cpus = 'unlimited' // "max 100000": no quota
  else if (cpuMax) {
    const [quota, period] = cpuMax.split(/\s+/).map(Number)
    if (quota > 0 && period > 0) cpus = Math.round((quota / period) * 100) / 100
  }
  let throttled = null
  if (cpuStat) {
    const m = /nr_throttled\s+(\d+)/.exec(cpuStat)
    if (m) throttled = Number(m[1])
  }
  return { cpuMax, cpus, memMax, throttled }
}

export function sqliteRuntime(db) {
  const out = { version: null, sourceId: null, journalMode: null, lockingMode: null, synchronous: null, bindingVersion: null }
  try { out.version = db.prepare('SELECT sqlite_version() AS v').get().v } catch { /* unreadable */ }
  try { out.sourceId = db.prepare('SELECT sqlite_source_id() AS v').get().v } catch { /* unreadable */ }
  try { out.journalMode = db.pragma('journal_mode', { simple: true }) } catch { /* unreadable */ }
  // Read-only form of the pragma: it reports the mode and changes nothing.
  try { out.lockingMode = db.pragma('locking_mode', { simple: true }) } catch { /* unreadable */ }
  try { out.synchronous = db.pragma('synchronous', { simple: true }) } catch { /* unreadable */ }
  try { out.bindingVersion = require('better-sqlite3/package.json').version } catch { /* not resolvable */ }
  return out
}

export function mountFacts(path) {
  if (!path) return { exists: false, freeBytes: null, totalBytes: null, fileBytes: null }
  try {
    const st = statSync(path)
    const fs = statfsSync(path)
    return {
      exists: true,
      fileBytes: st.size,
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
      freeInodes: fs.ffree != null ? Number(fs.ffree) : null,
    }
  } catch {
    return { exists: existsSync(path), freeBytes: null, totalBytes: null, fileBytes: null }
  }
}

/**
 * Sidecar facts from its /health, via an injected fetcher so the test never
 * touches the network. The sidecar's /health reports bootId, startedAtMs,
 * connected, accountCount, guard and counters — it does NOT report a commit,
 * and the manifest says so rather than inferring one.
 */
export async function sidecarFacts(base, { fetcher = fetch, secret = process.env.EXEC_SECRET || '', timeoutMs = 3000 } = {}) {
  if (!base) return { reachable: false, reason: 'no base url configured' }
  try {
    const res = await fetcher(`${base}/health`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { reachable: false, reason: `HTTP ${res.status}` }
    const h = await res.json()
    return {
      reachable: true,
      bootId: h.bootId ?? null,
      startedAtMs: h.startedAtMs ?? null,
      connected: h.connected ?? null,
      accountCount: h.accountCount ?? null,
      halt: h.guard?.halt ?? h.halt ?? null,
      telemetryWritten: h.telemetryWritten ?? null,
      telemetryDropped: h.telemetryDropped ?? null,
      commit: null, // not reported by the sidecar (plan B18 / TM-37)
    }
  } catch (err) {
    return { reachable: false, reason: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err) }
  }
}

const TICK_ENV = ['EXEC_ENTRY_JOURNAL_PATH', 'TICK_SPOOL_PATH', 'TICK_WORKERS', 'ENTRY_CODE_COMMIT']

export async function runtimeManifest(db, {
  env = process.env, cgroupRoot = '/sys/fs/cgroup', fetcher = fetch, now = new Date(),
  packageVersion = null,
} = {}) {
  const items = []
  // --- Node service ---
  const commit = env.RAILWAY_GIT_COMMIT_SHA || null
  items.push(item('node.commit', commit, 'env RAILWAY_GIT_COMMIT_SHA', !!commit, commit ? null : 'not set in this environment'))
  items.push(item('node.version', process.version, 'process.version', true))
  items.push(item('node.packageVersion', packageVersion, 'package.json', packageVersion != null))
  items.push(item('node.execEngine', env.EXEC_ENGINE || 'js', 'env EXEC_ENGINE', true, env.EXEC_ENGINE ? null : 'unset → js'))
  items.push(item('node.execUrlDemo', env.EXEC_URL_DEMO ? 'set' : 'unset', 'env EXEC_URL_DEMO', true))
  items.push(item('node.execUrlLive', env.EXEC_URL_LIVE ? 'set' : 'unset', 'env EXEC_URL_LIVE', true))
  items.push(item('node.execSecret', env.EXEC_SECRET ? 'set' : 'unset', 'env EXEC_SECRET', true, 'value never reported'))
  items.push(item('node.execFallback', env.EXEC_FALLBACK === '0' ? 'off' : 'on', 'env EXEC_FALLBACK', true))
  for (const k of TICK_ENV) {
    items.push(item(`tick.env.${k}`, env[k] ? 'set' : 'unset', `env ${k}`, true, env[k] ? null : 'tick engine not configured (expected until P3)'))
  }
  // --- database ---
  const sq = sqliteRuntime(db)
  items.push(item('sqlite.version', sq.version, 'sqlite_version()', sq.version != null))
  items.push(item('sqlite.sourceId', sq.sourceId, 'sqlite_source_id()', sq.sourceId != null))
  // sqlite.org/wal.html §11: 3.7.0–3.51.2 carry the WAL-reset race (fixed in
  // 3.51.3; backports 3.44.6 and 3.50.7). The scanner bridge's worker is a
  // second writing connection and is refused on an unfixed runtime.
  const fixed = walResetFixed(sq.version)
  items.push(item('sqlite.walResetFixed', fixed, `sqlite_version() vs sqlite.org/wal.html §11 (fixed from ${WAL_RESET_FIXED_FROM})`, fixed != null,
    fixed === false ? 'WAL-reset race present: a second writing connection (scanner bridge) is refused' : null))
  items.push(item('sqlite.journalMode', sq.journalMode, 'PRAGMA journal_mode', sq.journalMode != null))
  items.push(item('sqlite.lockingMode', sq.lockingMode, 'PRAGMA locking_mode', sq.lockingMode != null,
    sq.lockingMode === 'exclusive' ? 'degraded exclusive mode (lib/wal-open.js): no second connection can open the file' : null))
  items.push(item('sqlite.synchronous', sq.synchronous, 'PRAGMA synchronous', sq.synchronous != null,
    sq.synchronous === 1 ? 'NORMAL: the last commit may not survive power loss (plan §11)' : null))
  items.push(item('sqlite.binding', sq.bindingVersion, 'better-sqlite3/package.json', sq.bindingVersion != null))
  const dbPath = env.DB_PATH || null
  const mf = mountFacts(dbPath)
  items.push(item('db.path', dbPath, 'env DB_PATH', !!dbPath, dbPath ? null : 'unset'))
  items.push(item('db.fileBytes', mf.fileBytes, 'statSync', mf.fileBytes != null))
  items.push(item('db.mount.freeBytes', mf.freeBytes, 'statfsSync', mf.freeBytes != null, mf.freeBytes == null ? 'mount not readable from here' : null))
  items.push(item('db.mount.totalBytes', mf.totalBytes, 'statfsSync', mf.totalBytes != null))
  items.push(item('db.mount.freeInodes', mf.freeInodes ?? null, 'statfsSync', mf.freeInodes != null))
  // --- cgroup ---
  const cg = cgroupLimits(cgroupRoot)
  items.push(item('cgroup.cpuMax', cg.cpuMax, `${cgroupRoot}/cpu.max`, cg.cpuMax != null, cg.cpuMax == null ? 'not readable' : null))
  items.push(item('cgroup.cpus', cg.cpus, 'cpu.max quota/period', cg.cpus != null))
  items.push(item('cgroup.memoryMax', cg.memMax, `${cgroupRoot}/memory.max`, cg.memMax != null))
  items.push(item('cgroup.nrThrottled', cg.throttled, `${cgroupRoot}/cpu.stat`, cg.throttled != null))
  // --- sidecars ---
  for (const [name, base] of [['demo', env.EXEC_URL_DEMO], ['live', env.EXEC_URL_LIVE]]) {
    const f = await sidecarFacts(base, { fetcher, secret: env.EXEC_SECRET || '' })
    items.push(item(`sidecar.${name}.reachable`, f.reachable, `${name} /health`, true, f.reachable ? null : f.reason))
    items.push(item(`sidecar.${name}.commit`, null, `${name} /health`, false, 'the sidecar does not report its commit (TM-37)'))
    if (f.reachable) {
      items.push(item(`sidecar.${name}.bootId`, f.bootId, `${name} /health`, f.bootId != null))
      items.push(item(`sidecar.${name}.startedAtMs`, f.startedAtMs, `${name} /health`, f.startedAtMs != null))
      items.push(item(`sidecar.${name}.connected`, f.connected, `${name} /health`, f.connected != null))
      items.push(item(`sidecar.${name}.accountCount`, f.accountCount, `${name} /health`, f.accountCount != null))
      items.push(item(`sidecar.${name}.halt`, f.halt, `${name} /health`, f.halt != null))
      items.push(item(`sidecar.${name}.telemetryWritten`, f.telemetryWritten, `${name} /health`, f.telemetryWritten != null))
      items.push(item(`sidecar.${name}.telemetryDropped`, f.telemetryDropped, `${name} /health`, f.telemetryDropped != null))
    }
  }
  const unknown = items.filter(i => !i.verified).map(i => i.key)
  return { at: now.toISOString(), items, verified: items.length - unknown.length, unknown }
}
