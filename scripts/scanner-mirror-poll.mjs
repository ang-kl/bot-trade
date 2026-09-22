// One bounded read/record pass in a separate process. No timer, credentials
// changes, ownership transfer or entry dispatch. Deployment scheduling is a
// separate reviewed rollout step.
import { createRequire } from 'node:module'
const Database = createRequire(new URL('../agent/db.js', import.meta.url))('better-sqlite3')
import { pollScannerMirrors } from '../agent/services/scanner-candidates.js'
const path = process.env.SCANNER_MIRROR_DB_PATH
if (!path) throw new Error('SCANNER_MIRROR_DB_PATH must explicitly name the existing application database')
const db = new Database(path, { fileMustExist: true, timeout: 1000 })
try { console.log(JSON.stringify(await pollScannerMirrors(db))) } finally { db.close() }
