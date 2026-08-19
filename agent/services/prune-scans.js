// ---------------------------------------------------------------------------
// agent/services/prune-scans.js — delete old scans without tripping the FK.
//
// MEASURED IN PRODUCTION, 19-08-2026:
//
//   [loop] Housekeeping step "prune-scans" failed (non-fatal):
//          FOREIGN KEY constraint failed
//   [boot] storage: db=1459MB wal=88MB shm=0MB free=4923MB journal=wal
//
// `analyses.scan_id REFERENCES scans(id)` and the connection runs with
// `foreign_keys = ON`, so ONE surviving analysis row aborts the entire DELETE.
// The step therefore pruned nothing, every pass, for months — while reporting
// itself as a non-fatal failure that nobody read. scans is the highest-churn
// table in the system: every loop writes a row per symbol scanned.
//
// This is the same shape the compaction work chased and did not find. Freed
// pages being reused explains a file that never SHRINKS; it does not explain
// one that reaches 1.4GB. A retention step that deletes zero rows does.
//
// The fix is not new: retention.js already excludes analyses still referenced
// by trades, with exactly this NOT IN. It was simply never applied here.
//
// Deliberately NOT `ON DELETE CASCADE` and NOT a delete of the analyses:
// an analysis is the reasoning behind a trade and outlives its scan on
// purpose. A scan still referenced is a scan still in use — it waits for the
// analysis to age out under its own retention, and is collected on a later
// pass. Retention that quietly destroys the record it is referenced BY is a
// worse bug than the one being fixed.
// ---------------------------------------------------------------------------

/**
 * Delete scans older than `cutoffIso`, except those an analysis still points
 * at. Returns the better-sqlite3 RunResult so the caller reads `.changes`.
 */
export function pruneScans(db, cutoffIso) {
  return db.prepare(
    `DELETE FROM scans
      WHERE scanned_at < ?
        AND id NOT IN (SELECT scan_id FROM analyses WHERE scan_id IS NOT NULL)`
  ).run(cutoffIso)
}

/** How many old scans are being held back, and by how many analyses. */
export function heldByAnalyses(db, cutoffIso) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM scans
      WHERE scanned_at < ?
        AND id IN (SELECT scan_id FROM analyses WHERE scan_id IS NOT NULL)`
  ).get(cutoffIso)?.n ?? 0
}
