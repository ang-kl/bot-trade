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
// poll. The route that serves it sits behind the normal state cache.
import fs from 'node:fs'
import path from 'node:path'

const sizeOf = (p) => { try { return fs.statSync(p).size } catch { return null } }

/**
 * @param {object} db      better-sqlite3 handle (db.name is the file path)
 * @param {{dbPath?: string, topStateKeys?: number}} opts
 */
export function storageReport(db, { dbPath = null, topStateKeys = 10 } = {}) {
  const file = dbPath || db.name || process.env.DB_PATH || './agent.db'

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

  // ---- per-table bytes via dbstat, when this build ships it --------------
  let bytesByTable = null
  try {
    bytesByTable = new Map(
      db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all()
        .map(r => [r.name, r.bytes]),
    )
  } catch { /* dbstat vtab not compiled in — counts alone still rank tables */ }

  // ---- per-table row counts ----------------------------------------------
  const tables = []
  try {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name)
    for (const name of names) {
      let rows = null
      try { rows = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n } catch { /* virtual/corrupt */ }
      tables.push({ name, rows, bytes: bytesByTable?.get(name) ?? null })
    }
    tables.sort((a, b) => (b.bytes ?? b.rows ?? 0) - (a.bytes ?? a.rows ?? 0))
  } catch { /* even a schema read failing should not kill the report */ }

  // ---- biggest agent_state keys: JSON blobs hide here (caches, snapshots) —
  let stateKeys = []
  try {
    stateKeys = db.prepare(
      'SELECT key, LENGTH(value) AS bytes FROM agent_state ORDER BY LENGTH(value) DESC LIMIT ?'
    ).all(topStateKeys)
  } catch { /* table absent in some tests */ }

  const pragma = (name) => { try { return db.pragma(name, { simple: true }) } catch { return null } }

  return {
    at: new Date().toISOString(),
    files,
    volume,
    pageSize: pragma('page_size'),
    pageCount: pragma('page_count'),
    freelistPages: pragma('freelist_count'), // pages already reclaimable without VACUUM
    dbstatAvailable: bytesByTable != null,
    tables,
    largestStateKeys: stateKeys,
  }
}
