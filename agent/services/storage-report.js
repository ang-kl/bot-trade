// What is actually on the bot-trade volume, and how big is each piece?
//
// Owner 01-08 (after growing the Railway volume 1GB → 5GB): "is the storage
// usage going faster than expected, what are we storing". This answers with
// numbers instead of suspicion: file sizes on disk, per-table row counts and
// bytes, the biggest agent_state keys, and the volume's own free space. Read
// only — it never deletes anything; retention changes stay an owner decision.
//
// Cost note: row counts walk each table's b-tree and dbstat walks every page,
// so this is an ON-DEMAND diagnostics read, not something a dashboard should
// poll. GET /state/storage and POST /actions/storage-purge run it on the
// read-only storage worker (performance-populations.js readStorageReport):
// run synchronously it held the event loop for 20.99 s in production, and it
// later outgrew its 60 s bound — hence the progress snapshots below.
import fs from 'node:fs'
import path from 'node:path'

const sizeOf = (p) => { try { return fs.statSync(p).size } catch { return null } }
const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`

/**
 * @param {object} db      better-sqlite3 handle (db.name is the file path)
 * @param {{dbPath?: string, topStateKeys?: number,
 *   onProgress?: ((snapshot: object) => void) | null, progressEveryMs?: number,
 *   clock?: () => number, shouldStop?: () => boolean}} opts
 *
 * V3 M2b (M2 check nit 9): the walk measures in steps — files and pragmas,
 * the largest agent_state keys, bytes per b-tree (dbstat, one b-tree at a
 * time), then rows per table — and hands `onProgress` a snapshot of what it
 * has measured so far (the first at once, then at most every
 * progressEveryMs). A snapshot is `status: 'partial'` and names what it has
 * not measured yet in `unmeasured`; every value in it is a measurement or
 * null, never an estimate. A step that FAILED is named in `errors` (and the
 * report is 'partial'), instead of a locked schema read passing as "no
 * tables" or a busy dbstat as "dbstat not compiled in".
 */
export function storageReport(db, { dbPath = null, topStateKeys = 10, onProgress = null, progressEveryMs = 1000, clock = Date.now, shouldStop = () => false } = {}) {
  const startedAtMs = clock()
  const file = dbPath || db.name || process.env.DB_PATH || './agent.db'
  const errors = []
  const fail = (step, error, extra = {}) => errors.push({ step, ...extra, message: String(error?.message ?? error).slice(0, 300) })

  // ---- files on disk: the DB itself plus its WAL/SHM sidecars. A WAL far
  // larger than the DB means checkpointing is being starved by long reads —
  // that is a finding, not a detail.
  const files = {
    db: { path: file, bytes: sizeOf(file) },
    wal: { path: `${file}-wal`, bytes: sizeOf(`${file}-wal`) },
    shm: { path: `${file}-shm`, bytes: sizeOf(`${file}-shm`) },
  }

  // ---- volume capacity (statfs of the directory holding the DB) ----------
  let volume = null
  try {
    const s = fs.statfsSync(path.dirname(path.resolve(file)))
    volume = {
      totalBytes: s.blocks * s.bsize,
      freeBytes: s.bfree * s.bsize,
      availableBytes: s.bavail * s.bsize,
    }
  } catch { /* statfs unsupported → sizes above still tell the story */ }

  const pragmasUnmeasured = new Set(['page_size', 'page_count', 'freelist_count'])
  const pragma = (name) => {
    try { const value = db.pragma(name, { simple: true }); pragmasUnmeasured.delete(name); return value }
    catch (e) { fail('pragma', e, { pragma: name }); return null }
  }
  let pageSize = null, pageCount = null, freelistPages = null
  let names = null
  const bytes = new Map(), rows = new Map()
  let dbstatAvailable = null // unknown until the dbstat step runs
  // A step is "done" only when it measured; a failed step stays unmeasured
  // and is named in `errors` as well.
  let stateKeysDone = false, bytesDone = false
  let stateKeys = []

  const snapshot = (status) => {
    const known = names ?? []
    const tables = known.map(name => ({ name, rows: rows.has(name) ? rows.get(name) : null, bytes: bytes.get(name) ?? null }))
    tables.sort((a, b) => (b.bytes ?? b.rows ?? 0) - (a.bytes ?? a.rows ?? 0))
    const now = clock()
    return {
      at: new Date(now).toISOString(),
      status,
      files,
      volume,
      pageSize,
      pageCount,
      freelistPages, // pages already reclaimable without VACUUM
      dbstatAvailable,
      tables,
      largestStateKeys: stateKeys,
      // What this report has NOT measured (yet): those figures are null (or
      // the table list empty) because they were not read, not because they
      // are zero. A virtual table has no b-tree of its own, so after a
      // finished dbstat walk its null bytes are not "unmeasured".
      unmeasured: {
        pragmas: [...pragmasUnmeasured],
        tableList: names == null,
        largestStateKeys: !stateKeysDone,
        bytes: bytesDone || dbstatAvailable === false ? [] : known.filter(n => !bytes.has(n)),
        rows: known.filter(n => !rows.has(n)),
      },
      errors: errors.slice(),
      walk: { startedAt: new Date(startedAtMs).toISOString(), elapsedMs: now - startedAtMs },
    }
  }
  let lastEmit = -Infinity
  const emit = () => {
    if (!onProgress) return
    const now = clock()
    if (now - lastEmit < progressEveryMs) return
    lastEmit = now
    onProgress(snapshot('partial'))
  }
  // The first snapshot goes out before any SQL: file sizes and the volume
  // are measured even while the database is locked.
  emit()

  // shouldStop is checked before every statement: a stopped walk returns
  // what it measured (status 'partial', the rest named in `unmeasured`). It
  // is the only way the walk is stopped — never Worker.terminate(), which
  // aborts the whole process when it lands inside a better-sqlite3 call that
  // then throws (FATAL "v8::ToLocalChecked Empty MaybeLocal" from
  // Database::ThrowSqliteError, reproduced 25-09 by the M2b storage test).
  const go = () => !shouldStop()

  if (go()) pageSize = pragma('page_size')
  if (go()) pageCount = pragma('page_count')
  if (go()) freelistPages = pragma('freelist_count')

  if (go()) {
    try {
      names = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all().map(r => r.name)
    } catch (e) { fail('schema', e) }
    emit()
  }

  // ---- biggest agent_state keys: JSON blobs hide here (caches, snapshots) —
  // an absent table (some tests) is an empty list, not a failure.
  if (names?.includes('agent_state')) {
    if (go()) {
      try {
        stateKeys = db.prepare(
          'SELECT key, LENGTH(value) AS bytes FROM agent_state ORDER BY LENGTH(value) DESC LIMIT ?'
        ).all(topStateKeys)
        stateKeysDone = true
      } catch (e) { fail('state_keys', e) }
      emit()
    }
  } else if (names) stateKeysDone = true

  // ---- bytes per b-tree via dbstat, one b-tree at a time (aggregate = TRUE:
  // one row per b-tree, the same SUM(pgsize) the whole-file GROUP BY gave),
  // when this build ships the dbstat virtual table.
  let dbstat = null
  if (go()) {
    try {
      dbstat = db.prepare('SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE')
    } catch (e) {
      if (/no such table: dbstat/i.test(String(e?.message))) { dbstatAvailable = false; bytesDone = true } // not compiled in — counts alone still rank tables
      else fail('bytes', e)
    }
  }
  if (dbstat) {
    dbstatAvailable = true
    try {
      let stopped = false
      for (const r of dbstat.iterate()) {
        bytes.set(r.name, r.pgsize); emit()
        if (!go()) { stopped = true; break } // break closes the statement
      }
      bytesDone = !stopped
    } catch (e) { fail('bytes', e) }
  }

  // ---- per-table row counts ----------------------------------------------
  for (const name of names ?? []) {
    if (!go()) break
    try { rows.set(name, db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get().n) }
    catch (e) { fail('rows', e, { table: name }) }
    emit()
  }

  const s = snapshot('complete')
  const u = s.unmeasured
  if (s.errors.length || u.pragmas.length || u.tableList || u.largestStateKeys || u.bytes.length || u.rows.length) s.status = 'partial'
  return s
}
