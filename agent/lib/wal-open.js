// ---------------------------------------------------------------------------
// agent/lib/wal-open.js — open the database's journal without a silent deadlock.
//
// WHY THIS EXISTS. On 18-08-2026 the agent crash-looped for hours on:
//
//   SqliteError: disk I/O error
//       at Database.pragma (better-sqlite3/lib/methods/pragma.js:10:27)
//       at initDB (file:///app/db.js:576:6)
//     code: 'SQLITE_IOERR_SHMSIZE'
//
// eleven times in twenty-four seconds, and the log said nothing else. The
// error names a mechanism ("cannot size shared memory") but not a cause, and
// the cause was a full volume — which the process could have measured and
// reported in one line, and did not. Hours went into inferring from the
// outside what the crashing process was standing on top of.
//
// WHAT `SQLITE_IOERR_SHMSIZE` ACTUALLY MEANS. WAL mode keeps its index in a
// `-shm` file beside the database, sized with ftruncate on open. That file is
// small — tens of kilobytes. Failing to size it therefore does not mean "a bit
// tight"; it means essentially NO bytes are free. That distinction matters for
// what a fallback can honestly promise, which is the next paragraph.
//
// WHAT THE FALLBACK CAN AND CANNOT DO. In exclusive locking mode SQLite holds
// the wal-index in heap memory and never creates `-shm` at all, so the open
// succeeds where the default would fail. That is worth doing: a process that
// boots can report its own state, serve /health, and run the compaction that
// reclaims the space. But it is NOT a cure. If the volume is genuinely at
// zero, the first write will fail instead of the open, and the honest outcome
// is the same crash a few lines later. The fallback buys diagnosis and a
// chance at self-repair; it does not conjure disk.
//
// THE COST OF EXCLUSIVE MODE is that no second connection can open the file
// while the agent holds it — scripts and one-off queries will be locked out
// until the next clean boot. That is the right trade when the alternative is
// a process that does not run at all, and it is why it is a FALLBACK and not
// the default: the normal path is untouched.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

/** Bytes free on the filesystem holding `p`, or null if it cannot be read. */
export function freeBytesFor(p) {
  try {
    const s = fs.statfsSync(path.dirname(path.resolve(p)))
    return Number(s.bsize) * Number(s.bavail)
  } catch {
    return null
  }
}

/** Sizes of the database and its WAL sidecars, skipping those absent. */
export function dbFileSizes(p) {
  const out = {}
  for (const [key, suffix] of [['db', ''], ['wal', '-wal'], ['shm', '-shm']]) {
    try {
      out[key] = fs.statSync(`${p}${suffix}`).size
    } catch {
      out[key] = null
    }
  }
  return out
}

const mb = (n) => (n == null ? 'unknown' : `${Math.round(n / 1e6)}MB`)

/** One line an operator can act on, rather than a mechanism with no cause. */
export function describeStorage(p, { free, sizes } = {}) {
  const f = free === undefined ? freeBytesFor(p) : free
  const s = sizes === undefined ? dbFileSizes(p) : sizes
  return `db=${mb(s.db)} wal=${mb(s.wal)} shm=${mb(s.shm)} free=${mb(f)}`
}

/** True for the I/O family that means "the filesystem refused", not "bad SQL". */
export function isDiskError(err) {
  return typeof err?.code === 'string' && err.code.startsWith('SQLITE_IOERR')
}

/**
 * Put `db` into WAL mode, falling back to exclusive locking if the `-shm`
 * file cannot be sized. Returns { mode, degraded, storage }.
 *
 * Rethrows if even the fallback fails — but with the storage line attached,
 * so the crash names its own cause instead of only its mechanism.
 */
export function openJournal(db, dbPath, { warn = console.warn } = {}) {
  const storage = describeStorage(dbPath)
  try {
    db.pragma('journal_mode = WAL')
    return { mode: 'wal', degraded: false, storage }
  } catch (err) {
    if (!isDiskError(err)) throw err
    warn(`[boot] WAL open failed (${err.code}) — ${storage}`)
    warn('[boot] retrying with locking_mode = EXCLUSIVE (wal-index in heap, no -shm file).')
    warn('[boot] While in this mode NO other process can open the database.')
    try {
      db.pragma('locking_mode = EXCLUSIVE')
      db.pragma('journal_mode = WAL')
      warn('[boot] ⚠ database open in DEGRADED exclusive mode — the volume is out of space.')
      warn('[boot] Grow the volume; housekeeping will compact and a later boot returns to normal.')
      return { mode: 'wal-exclusive', degraded: true, storage }
    } catch (err2) {
      // Both paths are gone. Say what the disk looked like, because the bare
      // SQLite error has cost this project hours of guessing from outside.
      err2.message = `${err2.message} — storage at failure: ${storage}. `
        + 'SQLITE_IOERR on a WAL open means the volume has essentially no free '
        + 'bytes: grow it before restarting.'
      throw err2
    }
  }
}
