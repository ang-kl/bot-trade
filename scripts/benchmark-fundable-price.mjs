// Local synthetic evidence only; never opens production data.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { initDB } from '../agent/db.js'
import { lastScanPrice } from '../agent/services/fundable-universe.js'

const rows = Number(process.argv[2] || 250000)
assert.ok(Number.isInteger(rows) && rows > 0 && rows <= 3000000)
const dir = mkdtempSync(join(tmpdir(), 'fundable-price-benchmark-'))
const path = join(dir, 'fixture.db')
let db = initDB(path)
const allocated = () => db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true })
const digest = () => {
  const hash = createHash('sha256')
  for (const row of db.prepare('SELECT * FROM scans ORDER BY id').iterate()) hash.update(JSON.stringify(row))
  return hash.digest('hex')
}
const symbols = ['ETHUSD', 'XRPUSD', 'ABSENT']
const read = () => symbols.map(symbol => lastScanPrice(db, symbol))
const plan = () => db.prepare('EXPLAIN QUERY PLAN SELECT price FROM scans WHERE symbol=? AND price>0 ORDER BY id DESC LIMIT 1').all('ETHUSD')
try {
  db.exec('DROP INDEX idx_scans_symbol_positive_id')
  const put = db.prepare('INSERT INTO scans(symbol,price,scanned_at) VALUES (?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < rows; i++) put.run(i % 7 ? 'ETHUSD' : 'XRPUSD', i % 17 ? 2000 + i / rows : null,
      new Date(Date.UTC(2026, 8, 1) + (i % 20000) * 1000).toISOString())
  })()
  db.pragma('wal_checkpoint(TRUNCATE)')
  const beforeBytes = allocated(), beforeDigest = digest(), expected = read(), beforePlan = plan()
  const measure = () => Array.from({ length: 5 }, () => {
    const start = performance.now(), actual = read(), ms = performance.now() - start
    assert.deepEqual(actual, expected)
    return ms
  })
  const beforeMs = measure()
  db.close()
  const started = performance.now()
  db = initDB(path)
  const reopenIncludingIndexMs = performance.now() - started
  const additionalAllocatedBytes = allocated() - beforeBytes, afterMs = measure(), afterPlan = plan()
  assert.equal(digest(), beforeDigest)
  db.close()
  db = initDB(path)
  assert.deepEqual(read(), expected)
  assert.equal(digest(), beforeDigest)
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), baselineRef: 'b5a57a157b79f8478da0f62bf08b6e1c12a8f43a',
    purpose: 'Local synthetic lookup and index-migration evidence, not production acceptance',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    fixture: { rows, symbols, includesNullPrice: true, nonChronologicalTimestamps: true },
    beforeMs, afterMs, beforePlan, afterPlan, reopenIncludingIndexMs, additionalAllocatedBytes,
    validation: { exactPriceParity: true, retainedRowDigest: beforeDigest, retainedRowsUnchanged: true,
      secondReopenIdempotent: true, journalMode: db.pragma('journal_mode', { simple: true }),
      synchronous: db.pragma('synchronous', { simple: true }) },
    limitations: ['Synthetic local storage; production first index creation scans retained scans once.',
      'Reopen includes all initDB work. Index adds insert and retention maintenance cost.',
      'Main-thread state writes and other startup work remain outside this correction.'],
  }, null, 2))
} finally {
  if (db.open) db.close()
  rmSync(dir, { recursive: true, force: true })
}
