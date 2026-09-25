// ---------------------------------------------------------------------------
// agent/lib/sqlite-wal-reset.js — does the running SQLite carry the WAL-reset
// race, and may this process open a second writing connection on its database?
//
// sqlite.org/wal.html §11, read 25-09-2026: "The bug is likely present in all
// version of SQLite from 3.7.0 (2010-07-21) through 3.51.2 (2026-01-09). It is
// fixed in version 3.51.3 (2026-03-13) and later. Backports of the fix are
// available for some earlier releases: 3.44.6 and 3.50.7." It needs WAL mode
// and two or more connections on one file, in separate threads or processes,
// writing or checkpointing at the same instant.
//
// The scanner bridge is exactly that: scanner-bridge-worker.js opens its own
// connection in a worker thread and writes comparison rows while the main
// thread writes and checkpoints. Production measured SQLite 3.49.2 on
// 25-09-2026 (/state/runtime-manifest, better-sqlite3 11.10.0) — inside the
// range. better-sqlite3 12.8.0 is the lowest release that bundles 3.51.3 (its
// deps/sqlite3/sqlite3.h SQLITE_VERSION, and the v12.8.0 release note "Update
// SQLite to version 3.51.3", WiseLibs/better-sqlite3#1460).
//
// The dependency bump is the fix. This module is the check that the deployed
// process runs it: a lockfile is a claim, sqlite_version() is a measurement
// (docs/tick-momentum/plan.md §11: verify sqlite_version() inside each
// deployed image). The scanner bridge asks secondWriterRefusal() before it
// builds its worker, and /state/runtime-manifest reports walResetFixed().
// ---------------------------------------------------------------------------

/** The first mainline release containing the fix. */
export const WAL_RESET_FIXED_FROM = '3.51.3'
const FIXED_FROM = [3, 51, 3]
// Patch releases on older lines that carry the backported fix (same page).
const BACKPORTS = [[3, 44, 6], [3, 50, 7]]

/** "3.51.3" → [3, 51, 3]; a missing patch reads as 0; anything else → null. */
export function parseSqliteVersion(version) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/**
 * true — the version contains the fix (at or above 3.51.3, or at or above the
 * backport on the 3.44 / 3.50 line); false — it does not; null — the version
 * is unreadable, which is reported as neither.
 */
export function walResetFixed(version) {
  const v = parseSqliteVersion(version)
  if (!v) return null
  if (compare(v, FIXED_FROM) >= 0) return true
  return BACKPORTS.some(([maj, min, patch]) => v[0] === maj && v[1] === min && v[2] >= patch)
}

/** The SQLite library version this connection runs, or null if unreadable. */
export function readSqliteVersion(db) {
  try { return db.prepare('SELECT sqlite_version() AS v').get().v ?? null } catch { return null }
}

/**
 * Why a second writing connection must not be opened on `db`'s file, or null
 * when it may be. Each reason is read from the running connection:
 *   db_exclusive_degraded     — db.js fell back to locking_mode = EXCLUSIVE on
 *                               a full volume (lib/wal-open.js): no other
 *                               connection can use the file until a clean boot
 *   sqlite_version_unreadable — the fix cannot be shown present
 *   sqlite_wal_reset_unfixed  — the runtime predates the WAL-reset fix
 */
export function secondWriterRefusal(db, { readVersion = readSqliteVersion } = {}) {
  const sqliteVersion = readVersion(db)
  if (db?.__journalDegraded) return { reason: 'db_exclusive_degraded', sqliteVersion }
  const fixed = walResetFixed(sqliteVersion)
  if (fixed === null) return { reason: 'sqlite_version_unreadable', sqliteVersion }
  if (!fixed) return { reason: 'sqlite_wal_reset_unfixed', sqliteVersion }
  return null
}
