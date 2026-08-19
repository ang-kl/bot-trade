// ---------------------------------------------------------------------------
// agent/services/db-compact.js — return deleted pages to the filesystem.
//
// THE DEFECT THIS FIXES. Retention has existed and worked for months:
// loop.js prunes scans, signals, regimes, risk_events, decision_log and more
// on a cadence, services/retention.js prunes trades and analyses, and every one
// of those DELETEs succeeds. The database file still only ever grew, until on
// 2026-08-17 the Railway volume filled and the agent crash-looped on boot:
//
//   SqliteError: disk I/O error   code: SQLITE_IOERR_SHMSIZE
//     at Database.pragma (better-sqlite3/lib/methods/pragma.js:10)
//     at initDB (db.js:576)      <- journal_mode = WAL
//
// SQLite does not shrink a file on DELETE. Freed pages go on the freelist and
// are reused for NEW rows, so a database that deletes as fast as it inserts
// stays flat — and one that inserts faster grows for ever, no matter how much
// it prunes. Nothing in the codebase ran VACUUM. The only mention of it was
// storage-report.js reporting `freelistPages` with the comment "pages already
// reclaimable without VACUUM", which MEASURED the problem for weeks without
// anything acting on it.
//
// So the prune was never broken. It was answering a question nobody asked:
// "are old rows gone?" — yes — while the question that mattered was "is the
// file smaller?", and that one had no code behind it at all.
//
// WHY THE FREE-SPACE GUARD IS THE IMPORTANT PART. VACUUM rebuilds the database
// into a NEW file and swaps it, so it needs roughly as much free space as the
// database occupies. On a volume that is already full — precisely the machine
// that needs compaction — an unguarded VACUUM fails, and can fail partway. So
// this refuses to start unless the space is demonstrably there, and says how
// much is missing when it will not run.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import { getState, setState } from '../db.js'

export const LAST_COMPACT_KEY = 'db_last_compact_json'

/**
 * Deferrals are recorded, not merely logged.
 *
 * The compaction guard skips a rebuild whenever any position is open — and
 * this bot's job is holding positions, on a window that comes round every 8
 * hours. Stacked with the 24-hour interval, the 20% fraction and the 25MB
 * floor, it is entirely possible for the reclaim never to fire again while
 * the file keeps growing, with the only evidence a console line nobody reads.
 * That is the protection-audit shape from CLAUDE.md: the controller runs, the
 * record is stuck, and the panel looks healthy. A counter that survives a
 * restart makes "deferred 47 passes in a row" answerable from state instead
 * of from log archaeology.
 */
export const LAST_DEFER_KEY = 'db_compact_deferred_json'

/** Record one deferral and return the running count. */
export function recordDeferral(db, { reason, nowMs = Date.now() } = {}) {
  let prev = null
  try { prev = JSON.parse(getState(db, LAST_DEFER_KEY) || 'null') } catch { prev = null }
  const consecutive = Number(prev?.consecutive || 0) + 1
  const rec = { atMs: nowMs, at: new Date(nowMs).toISOString(), reason: reason ?? null, consecutive }
  try { setState(db, LAST_DEFER_KEY, JSON.stringify(rec)) } catch { /* a counter must not break the pass */ }
  return rec
}

/** Clear the streak once a rebuild actually happens. */
export function clearDeferrals(db) {
  try { setState(db, LAST_DEFER_KEY, JSON.stringify({ consecutive: 0 })) } catch { /* as above */ }
}

/** VACUUM needs a full second copy; this is the margin on top of that. */
export const SPACE_HEADROOM = 1.15

export const DEFAULT_COMPACT = Object.freeze({
  on: true,
  minFreeFrac: 0.20,      // compact once >=20% of the file is reclaimable...
  minReclaimBytes: 25_000_000, // ...and that is worth at least 25 MB
  minIntervalHours: 24,   // VACUUM rewrites the whole file; not a hot path
})

export function loadCompactConfig(db) {
  try {
    const p = JSON.parse(getState(db, 'db_compact_json') || 'null')
    if (p && typeof p === 'object') {
      return {
        on: p.on !== false,
        minFreeFrac: Number.isFinite(Number(p.minFreeFrac)) ? Math.min(0.9, Math.max(0.01, Number(p.minFreeFrac))) : DEFAULT_COMPACT.minFreeFrac,
        minReclaimBytes: Number.isFinite(Number(p.minReclaimBytes)) ? Math.max(0, Number(p.minReclaimBytes)) : DEFAULT_COMPACT.minReclaimBytes,
        minIntervalHours: Number.isFinite(Number(p.minIntervalHours)) ? Math.max(0, Number(p.minIntervalHours)) : DEFAULT_COMPACT.minIntervalHours,
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_COMPACT }
}

/**
 * How much of the file is dead weight, from SQLite's own page accounting.
 * Pure apart from the pragma reads. Returns nulls rather than throwing when a
 * pragma is unavailable — a report must never be the thing that breaks a boot.
 */
export function bloatOf(db) {
  const pragma = (n) => { try { return db.pragma(n, { simple: true }) } catch { return null } }
  const pageSize = Number(pragma('page_size'))
  const pageCount = Number(pragma('page_count'))
  const freelistPages = Number(pragma('freelist_count'))
  if (![pageSize, pageCount, freelistPages].every(Number.isFinite) || pageCount <= 0) {
    return { pageSize: null, pageCount: null, freelistPages: null, totalBytes: null, reclaimableBytes: null, freeFrac: null }
  }
  return {
    pageSize,
    pageCount,
    freelistPages,
    totalBytes: pageSize * pageCount,
    reclaimableBytes: pageSize * freelistPages,
    freeFrac: freelistPages / pageCount,
  }
}

/** Bytes free on the filesystem holding `path`, or null if it cannot be read. */
export function freeBytesFor(path) {
  try {
    const s = fs.statfsSync(path)
    return Number(s.bsize) * Number(s.bavail)
  } catch { return null }
}

/**
 * Should a VACUUM run now, and is there room for it?
 *
 * `blocked` is deliberately distinct from `compact: false`. "Not worth it yet"
 * and "worth it but the disk cannot take it" are different states, and the
 * second one is the one an operator has to act on — it is the message that
 * says grow the volume.
 *
 * @returns {{compact:boolean, blocked:boolean, reason:string, needBytes:number|null, freeBytes:number|null}}
 */
export function compactDecision({ bloat, freeBytes, cfg, lastAtMs, nowMs }) {
  if (!cfg?.on) return { compact: false, blocked: false, reason: 'off', needBytes: null, freeBytes }
  if (bloat?.totalBytes == null) return { compact: false, blocked: false, reason: 'page stats unavailable', needBytes: null, freeBytes }

  const hours = Number(cfg.minIntervalHours) || 0
  if (hours > 0 && lastAtMs != null && nowMs - lastAtMs < hours * 3_600_000) {
    return { compact: false, blocked: false, reason: 'within the minimum interval', needBytes: null, freeBytes }
  }
  const worthIt = bloat.freeFrac >= cfg.minFreeFrac && bloat.reclaimableBytes >= cfg.minReclaimBytes
  if (!worthIt) {
    return {
      compact: false,
      blocked: false,
      reason: `only ${(bloat.freeFrac * 100).toFixed(1)}% / ${Math.round(bloat.reclaimableBytes / 1e6)}MB reclaimable — below the threshold`,
      needBytes: null,
      freeBytes,
    }
  }
  // The guard that matters. Unknown free space is treated as NOT enough:
  // attempting a rebuild blind on the machine that just filled its disk is
  // how a cleanup becomes an outage.
  const needBytes = Math.ceil(bloat.totalBytes * SPACE_HEADROOM)
  if (freeBytes == null) {
    return { compact: false, blocked: true, reason: 'free space unknown — refusing to rebuild blind', needBytes, freeBytes }
  }
  if (freeBytes < needBytes) {
    return {
      compact: false,
      blocked: true,
      reason: `needs ~${Math.round(needBytes / 1e6)}MB free to rebuild, only ${Math.round(freeBytes / 1e6)}MB available — grow the volume`,
      needBytes,
      freeBytes,
    }
  }
  return { compact: true, blocked: false, reason: `reclaiming ${Math.round(bloat.reclaimableBytes / 1e6)}MB`, needBytes, freeBytes }
}

/**
 * One compaction pass. Never throws — a failed cleanup must not take down the
 * process it was meant to keep alive.
 *
 * `dryRun` reports what WOULD happen and touches nothing, so the decision can
 * be inspected before a rewrite of the whole database is set going.
 */
export function runCompact(db, { dbPath, nowMs = Date.now(), dryRun = false, deps = {} } = {}) {
  try {
    const cfg = deps.cfg ?? loadCompactConfig(db)
    const before = bloatOf(db)
    const path = dbPath || process.env.DB_PATH || './agent.db'
    const freeBytes = deps.freeBytesFor ? deps.freeBytesFor(path) : freeBytesFor(path)
    let lastAtMs = null
    try { lastAtMs = JSON.parse(getState(db, LAST_COMPACT_KEY) || 'null')?.atMs ?? null } catch { lastAtMs = null }

    const d = compactDecision({ bloat: before, freeBytes, cfg, lastAtMs, nowMs })
    if (!d.compact || dryRun) return { ran: false, dryRun, ...d, before, after: null, freedBytes: 0 }

    db.exec('VACUUM')
    const after = bloatOf(db)
    const freedBytes = (before.totalBytes ?? 0) - (after.totalBytes ?? 0)
    clearDeferrals(db)
    setState(db, LAST_COMPACT_KEY, JSON.stringify({
      atMs: nowMs, at: new Date(nowMs).toISOString(),
      beforeBytes: before.totalBytes, afterBytes: after.totalBytes, freedBytes,
    }))
    return { ran: true, dryRun: false, ...d, before, after, freedBytes }
  } catch (err) {
    return { ran: false, dryRun, compact: false, blocked: true, reason: `error: ${err?.message ?? err}`, before: null, after: null, freedBytes: 0 }
  }
}
