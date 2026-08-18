// ---------------------------------------------------------------------------
// agent/services/emergency-reclaim.js — get off a 100%-full volume at boot.
//
// THE DEADLOCK THIS BREAKS. Compaction (services/db-compact.js) reclaims the
// space that retention frees, but it runs inside the agent's housekeeping
// pass — and on 18-08-2026 the agent could not boot, because a full volume
// cannot size the WAL's `-shm` file. The cure was locked inside the patient.
// This runs at open time instead: after the journal is up (see lib/wal-open.js,
// which falls back to exclusive locking precisely so this point is reachable)
// and before schema work, which writes.
//
// WHAT WORKS AT ZERO FREE BYTES, AND WHAT DOES NOT. This is the whole design.
//
//   Reading a directory listing        — always works.
//   Deleting a file                    — always works.
//   PRAGMA wal_checkpoint(TRUNCATE)    — usually works, and is the big win.
//   DELETE FROM …                      — needs to write. May fail at zero.
//   VACUUM                             — needs ~the database's size free.
//
// So the order is fixed by what the disk allows, not by what seems tidiest:
// measure, then free files, then truncate the WAL, and only then try row
// deletes. Each step re-reads free space, and each is allowed to fail without
// taking down the ones after it — a reclaim that aborts on its first failure
// on a full disk is no reclaim at all.
//
// WHY THE WAL IS THE FIRST REAL SUSPECT. A `-wal` file grows until a
// checkpoint folds it back into the database. A process that crash-loops
// never checkpoints cleanly, so the file that grows fastest during an outage
// is the one nobody is watching. Truncating it returns those bytes outright.
//
// WHAT THIS WILL NOT TOUCH. Trades, positions, orders, accounts, config and
// credentials are never deleted here. An emergency is exactly when a process
// should not be improvising about which of the owner's records are expendable,
// so the delete list is a fixed set of high-churn telemetry tables — the same
// ones the routine housekeeping pass already prunes on a schedule.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

/** Below this, the volume is treated as an emergency rather than "getting on". */
export const EMERGENCY_FREE_BYTES = 50_000_000

/** Telemetry only. Deliberately excludes trades and everything money-shaped. */
export const PURGE_TABLES = Object.freeze([
  { table: 'scans', column: 'scanned_at' },
  { table: 'signals', column: 'recorded_at' },
  { table: 'regimes', column: 'computed_at' },
  { table: 'position_events', column: 'created_at' },
  { table: 'decision_log', column: 'created_at' },
  { table: 'risk_events', column: 'created_at' },
  { table: 'phase_flag_trace', column: 'at' },
])

/** Files beside the database that are safe to remove without losing data. */
export function reclaimableFiles(dir, dbName) {
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of entries) {
    // NEVER the database, and NEVER the -wal: deleting a WAL discards
    // committed transactions that have not been checkpointed. The WAL is
    // reclaimed through SQLite's own truncation below, not with unlink.
    if (name === dbName || name === `${dbName}-wal`) continue
    const isStale = name.endsWith('.bak')
      || name.endsWith('.old')
      || name.endsWith('.tmp')
      || /\.db-journal$/.test(name)
      || /^core(\.\d+)?$/.test(name)
    if (!isStale) continue
    try {
      out.push({ name, path: path.join(dir, name), size: fs.statSync(path.join(dir, name)).size })
    } catch { /* vanished between listing and stat */ }
  }
  return out.sort((a, b) => b.size - a.size)
}

/** Everything on the volume, largest first — the report that was missing. */
export function volumeReport(dir, limit = 12) {
  try {
    return fs.readdirSync(dir)
      .map((name) => {
        try {
          return { name, size: fs.statSync(path.join(dir, name)).size }
        } catch {
          return { name, size: null }
        }
      })
      .sort((a, b) => (b.size ?? -1) - (a.size ?? -1))
      .slice(0, limit)
  } catch {
    return []
  }
}

// Sub-megabyte values print in kB. Rounding a 400kB file to "0MB" in a report
// whose entire job is to say what is eating the disk would be the same class
// of mistake this module exists to correct.
const mb = (n) => {
  if (n == null) return '?'
  if (n < 1e6) return `${Math.round(n / 1e3)}kB`
  return `${Math.round(n / 1e6)}MB`
}

export function freeBytesFor(p) {
  try {
    const s = fs.statfsSync(path.dirname(path.resolve(p)))
    return Number(s.bsize) * Number(s.bavail)
  } catch {
    return null
  }
}

/**
 * Reclaim space at boot when the volume is critically low.
 *
 * Returns a record of what each step actually achieved — not what it
 * attempted. On a full disk most steps can fail, and a summary that reports
 * intentions would be the same lie this codebase keeps tripping over.
 */
export function emergencyReclaim(db, dbPath, {
  now = Date.now,
  retainDays = 7,
  warn = console.warn,
  log = console.log,
  deps = {},
} = {}) {
  const rm = deps.unlink ?? ((p) => fs.unlinkSync(p))
  const free = deps.freeBytes ?? freeBytesFor
  const dir = path.dirname(path.resolve(dbPath))
  const dbName = path.basename(dbPath)

  const before = free(dbPath)
  const steps = []
  const result = { ran: true, freeBefore: before, freeAfter: before, steps }

  warn(`[reclaim] volume critically low (free=${mb(before)}) — emergency reclaim starting`)
  for (const f of volumeReport(dir)) warn(`[reclaim]   ${mb(f.size).padStart(8)}  ${f.name}`)

  // 1. Delete stale files. Works even at exactly zero free bytes.
  let filesFreed = 0
  for (const f of reclaimableFiles(dir, dbName)) {
    try {
      rm(f.path)
      filesFreed += f.size
      warn(`[reclaim] removed ${f.name} (${mb(f.size)})`)
    } catch (err) {
      warn(`[reclaim] could not remove ${f.name}: ${err.message}`)
    }
  }
  steps.push({ step: 'stale-files', freedBytes: filesFreed })

  // 2. Truncate the WAL. During a crash-loop this is usually the largest
  //    single reclaimable object, because nothing ever checkpointed it.
  let walFreed = 0
  try {
    const walBefore = (() => {
      try { return fs.statSync(`${dbPath}-wal`).size } catch { return 0 }
    })()
    db.pragma('wal_checkpoint(TRUNCATE)')
    const walAfter = (() => {
      try { return fs.statSync(`${dbPath}-wal`).size } catch { return 0 }
    })()
    walFreed = Math.max(0, walBefore - walAfter)
    steps.push({ step: 'wal-truncate', freedBytes: walFreed, ok: true })
    if (walFreed > 0) warn(`[reclaim] WAL truncated — ${mb(walFreed)} returned`)
  } catch (err) {
    steps.push({ step: 'wal-truncate', freedBytes: 0, ok: false, error: err.message })
    warn(`[reclaim] WAL truncate failed: ${err.message}`)
  }

  // 3. Row deletes. These need to write, so they are LAST and each is
  //    individually survivable — one failing table must not skip the rest.
  const cutoff = new Date(now() - retainDays * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  let rows = 0
  for (const { table, column } of PURGE_TABLES) {
    try {
      const info = db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff)
      rows += info.changes || 0
    } catch { /* table absent on this schema, or the disk refused the write */ }
  }
  steps.push({ step: 'row-purge', rows, retainDays })
  if (rows > 0) log(`[reclaim] purged ${rows} telemetry rows older than ${retainDays}d`)

  result.freeAfter = free(dbPath)
  const gained = (result.freeAfter ?? 0) - (before ?? 0)
  warn(`[reclaim] done — free ${mb(before)} → ${mb(result.freeAfter)} (${gained >= 0 ? '+' : ''}${mb(Math.abs(gained))})`)
  if ((result.freeAfter ?? 0) < EMERGENCY_FREE_BYTES) {
    warn('[reclaim] STILL critically low. Deleting rows does not shrink a SQLite file —')
    warn('[reclaim] the space returns only when VACUUM rebuilds it, and VACUUM needs')
    warn('[reclaim] roughly the database size free to do that. Grow the volume.')
  }
  return result
}

/** Run only when the volume is actually in trouble. */
export function maybeEmergencyReclaim(db, dbPath, opts = {}) {
  const free = (opts.deps?.freeBytes ?? freeBytesFor)(dbPath)
  const forced = process.env.EMERGENCY_PURGE === '1'
  if (!forced && (free == null || free >= EMERGENCY_FREE_BYTES)) {
    return { ran: false, freeBefore: free, freeAfter: free, steps: [] }
  }
  return emergencyReclaim(db, dbPath, opts)
}
