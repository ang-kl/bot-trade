// ---------------------------------------------------------------------------
// agent/services/prune-scans.js — delete old scans without tripping the FK,
// and without holding the event loop long enough to be shot for it.
//
// MEASURED IN PRODUCTION, 19-08-2026:
//
//   [loop] Housekeeping step "prune-scans" failed (non-fatal):
//          FOREIGN KEY constraint failed
//   [boot] storage: db=1459MB wal=88MB shm=0MB free=4923MB journal=wal
//
// `analyses.scan_id REFERENCES scans(id)` and the connection runs with
// `foreign_keys = ON`, so ONE surviving analysis row aborts the entire DELETE.
// The step pruned nothing, every pass, for months — while reporting itself as
// a non-fatal failure that nobody read. scans is the highest-churn table here:
// a row per symbol per loop.
//
// Freed pages being reused explains a file that never SHRINKS. It does not
// explain one that reaches 1.4GB. A retention step deleting zero rows does.
//
// NOT `ON DELETE CASCADE`, AND NOT A DELETE OF THE ANALYSES. An analysis is
// the reasoning behind a trade and outlives its scan on purpose. A referenced
// scan waits and is collected on a later pass, once the analysis ages out
// under its own retention. Retention that destroys the record it is
// referenced BY is a worse bug than the one being fixed.
//
// WHY IT IS BATCHED, which matters more here than it would anywhere else.
// Fixing the FK means MONTHS of backlog become deletable in a single pass. In
// one synchronous statement, on the event loop, that is the same hazard as the
// VACUUM this codebase just had to guard: overrun the 12-minute loop watchdog
// and the process is killed, the implicit transaction rolls back, zero rows
// are deleted, and it repeats every 8 hours — a silent no-op replaced by a
// restart loop. So the work goes in bounded batches with a heartbeat between
// them, and progress survives even if a later batch is interrupted.
//
// The FK check is also why `idx_analyses_scan_id` exists (db.js). Deleting a
// PARENT row requires proving no child references it; without an index on the
// child key SQLite scans `analyses` once per deleted scan. That cost does not
// show up in EXPLAIN QUERY PLAN, which is exactly why it is easy to ship.
// ---------------------------------------------------------------------------

export const DEFAULT_BATCH = 20_000

/** Wall clock, not row count: the thing that hurts is time on the thread. */
export const DEFAULT_BUDGET_MS = 60_000

/**
 * Delete scans older than `cutoffIso`, except those an analysis still points
 * at, in bounded batches.
 *
 * @param {object} db
 * @param {string} cutoffIso
 * @param {{batch?: number, maxBatches?: number, onProgress?: (n: number) => void}} [opts]
 * @returns {{changes: number, batches: number, done: boolean}}
 *   `changes` matches better-sqlite3's RunResult field so callers reading
 *   `.changes` keep working. `done` is false when the cap stopped it early —
 *   the remainder is collected on the next pass rather than pretending.
 */
export async function pruneScans(db, cutoffIso, opts = {}) {
  const batch = Number(opts.batch) > 0 ? Number(opts.batch) : DEFAULT_BATCH
  const maxBatches = Number(opts.maxBatches) > 0 ? Number(opts.maxBatches) : 50
  const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : DEFAULT_BUDGET_MS
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const yieldTo = typeof opts.yieldTo === 'function'
    ? opts.yieldTo
    : () => new Promise((r) => setImmediate(r))

  // `id IN (SELECT … LIMIT ?)` rather than a bare LIMIT on the DELETE, which
  // SQLite only supports when compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT.
  const stmt = db.prepare(
    `DELETE FROM scans
      WHERE id IN (
        SELECT id FROM scans
         WHERE scanned_at < ?
           AND id NOT IN (SELECT scan_id FROM analyses WHERE scan_id IS NOT NULL)
         LIMIT ?
      )`
  )

  const startedAt = now()
  let changes = 0
  let batches = 0
  for (; batches < maxBatches; batches += 1) {
    const n = stmt.run(cutoffIso, batch).changes
    changes += n
    if (onProgress) onProgress(changes)
    if (n < batch) return { changes, batches: batches + 1, done: true, ranMs: now() - startedAt }
    // NOTE: a short batch proves the work is finished. A FULL batch does not
    // prove the opposite — the table may have drained on exactly the last
    // one — so the cap and budget paths below ask instead of assuming.

    // A REAL YIELD, and the reason this function is async at all.
    //
    // The first version of this batching stamped the watchdog between batches
    // and never yielded. better-sqlite3 is synchronous, so the whole loop ran
    // in one uninterrupted turn: nothing could observe the heartbeat, the
    // watchdog's own setInterval could not fire during it, and by the time it
    // did fire the final batch had just stamped `lastLoopActivityAt` — so a
    // twenty-minute block would have read as perfectly healthy. That is worse
    // than the bug: it removes the alarm without shortening the stall.
    //
    // It matters beyond the watchdog. fast-monitor is a setInterval on this
    // same loop; trailing stops, break-even moves and the per-position loss
    // cap are all frozen for as long as the thread is held. Yielding is what
    // actually lets them run.
    await yieldTo()

    // Bounded by TIME, not rows. 50 × 20,000 caps a pass at a million rows,
    // which says nothing about how long the thread was held.
    if (now() - startedAt >= budgetMs) {
      return { changes, batches: batches + 1, done: !anyRemaining(db, cutoffIso), ranMs: now() - startedAt }
    }
  }
  return { changes, batches, done: !anyRemaining(db, cutoffIso), ranMs: now() - startedAt }
}

/**
 * Is there anything left for a later pass? One indexed EXISTS, asked only on
 * the cap and budget paths — so "BATCH CAP HIT, more remain" means rows
 * actually remain, rather than "we stopped without seeing a short batch".
 */
export function anyRemaining(db, cutoffIso) {
  return db.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM scans
        WHERE scanned_at < ?
          AND id NOT IN (SELECT scan_id FROM analyses WHERE scan_id IS NOT NULL)
     ) AS more`
  ).get(cutoffIso)?.more === 1
}

/**
 * How many old scans are being held back because an analysis still points at
 * them. Reported in the housekeeping summary: if analyses retention ever
 * breaks, this number climbs while `pruned N scans` still looks healthy — and
 * a diagnostic nobody prints is the defect this whole area keeps producing.
 */
export function heldByAnalyses(db, cutoffIso) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM scans
      WHERE scanned_at < ?
        AND id IN (SELECT scan_id FROM analyses WHERE scan_id IS NOT NULL)`
  ).get(cutoffIso)?.n ?? 0
}
