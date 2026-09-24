// Local synthetic read/index-migration evidence; never opens production data.
// node scripts/benchmark-account-history.mjs [rows per history table]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { initDB } from '../agent/db.js'
import { engineeringView } from '../agent/services/account-engineering.js'

const rows = Number(process.argv[2] || 250000)
assert.ok(Number.isInteger(rows) && rows > 0 && rows <= 3000000)
const baselineRef = '55b286b47e13450160c4092215488d07d35aa07c'
const original = new URL('../agent/services/account-engineering.js', import.meta.url)
const source = execFileSync('git', ['show', `${baselineRef}:agent/services/account-engineering.js`], { encoding: 'utf8' })
  .replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, original).href}'`)
const { engineeringView: baseline } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const dir = mkdtempSync(join(tmpdir(), 'account-history-benchmark-'))
const path = join(dir, 'fixture.db')
let db = initDB(path)
const allocated = () => db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true })
const digest = () => Object.fromEntries(['decision_log', 'risk_events'].map(table => {
  const hash = createHash('sha256')
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate()) hash.update(JSON.stringify(row))
  return [table, hash.digest('hex')]
}))
try {
  db.exec('DROP INDEX idx_decision_log_account_latest; DROP INDEX idx_risk_events_account_latest')
  const account = db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,0,1,'active')")
  const ids = Array.from({ length: 7 }, (_, i) => String(10000000 + i))
  for (const id of ids) account.run(id)
  const decision = db.prepare("INSERT INTO decision_log(account_id,symbol,created_at,stage,decision,reason) VALUES (?,'EURUSD',?,'scan','skip','fixture')")
  const risk = db.prepare("INSERT INTO risk_events(account_id,symbol,side,created_at,approved) VALUES (?,'EURUSD','long',?,?)")
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const id = i % 17 === 0 ? null : i % 11 === 0 ? 'unregistered' : ids[i % ids.length]
      let at = new Date(Date.UTC(2026, 8, 1) + (i % 20000) * 1000).toISOString()
      if (i % 2) at = at.replace('T', ' ')
      decision.run(id, at)
      risk.run(id, at, i % 2)
    }
  })()
  db.pragma('wal_checkpoint(TRUNCATE)')
  const beforeBytes = allocated()
  const retainedBefore = digest()
  const expected = baseline(db)
  const measure = run => Array.from({ length: 5 }, () => {
    const started = performance.now()
    const report = run(db)
    const elapsedMs = performance.now() - started
    assert.deepEqual(report, expected)
    return elapsedMs
  })
  const beforeMs = measure(baseline)
  db.close()
  const started = performance.now()
  db = initDB(path)
  const reopenIncludingIndexMs = performance.now() - started
  const additionalAllocatedBytes = allocated() - beforeBytes
  const afterMs = measure(engineeringView)
  assert.deepEqual(digest(), retainedBefore)
  const plans = ['decision_log', 'risk_events'].map(table => ({ table, steps: db.prepare(
    `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE account_id=? ORDER BY created_at DESC,id ASC LIMIT 1`
  ).all(ids[0]) }))
  db.close()
  db = initDB(path)
  assert.deepEqual(engineeringView(db), expected)
  assert.deepEqual(digest(), retainedBefore)
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), baselineRef,
    purpose: 'Local synthetic account-report query and index-migration evidence; not a production SLA',
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      sqlite: db.prepare('SELECT sqlite_version() AS v').get().v },
    fixture: { registeredAccounts: 7, decisionRows: rows, riskRows: rows, includesNullAndUnregistered: true },
    beforeMs, afterMs, reopenIncludingIndexMs, additionalAllocatedBytes, plans,
    validation: { fullReportParity: true, retainedRowDigestsUnchanged: true, secondReopenIdempotent: true,
      journalMode: db.pragma('journal_mode', { simple: true }), synchronous: db.pragma('synchronous', { simple: true }) },
    limitations: ['Local storage and synthetic data; first production creation scans both history tables once.',
      'Reopen timing includes all normal initDB work. Added indexes also add normal insert and retention maintenance cost.',
      'Other report queries and management writers remain unchanged; this does not close P1/P4 acceptance.'],
  }, null, 2))
} finally {
  if (db.open) db.close()
  rmSync(dir, { recursive: true, force: true })
}
