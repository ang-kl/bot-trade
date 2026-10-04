// Interleave a real second WAL connection after the first transaction read.
// A deferred transaction permits the peer commit and then cannot upgrade its
// old snapshot. A writer reservation makes the peer wait until commit instead.
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { tempDir } from './temp-dir.js'

export const walFilename = () => join(tempDir('wal-writer-race-'), 'ledger.db')

export function installWalWriterRace(t, db) {
  const peer = new Database(db.name, { fileMustExist: true, timeout: 0 })
  const prepare = db.prepare
  const state = { attempted: false, blocked: false }
  const write = () => peer.prepare("INSERT OR REPLACE INTO agent_state (key,value) VALUES ('wal_peer_receipt','committed')").run()
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (/^\s*SELECT\b/i.test(sql)) {
      for (const method of ['get', 'all']) {
        const read = statement[method].bind(statement)
        statement[method] = (...args) => {
          const value = read(...args)
          if (db.inTransaction && !state.attempted) {
            state.attempted = true
            try { write() } catch (error) {
              if (!String(error.code).startsWith('SQLITE_BUSY')) throw error
              state.blocked = true
            }
          }
          return value
        }
      }
    }
    return statement
  }
  t.after(() => { db.prepare = prepare; peer.close() })
  return { state, write }
}
