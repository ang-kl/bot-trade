// Isolated local WAL/FULL fixture; never opens a production database.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { flagScanPriority } from '../agent/services/guardian.js'
import { queueScanPriority, flushScanPriority } from '../agent/services/scan-priority-batch.js'

const Database = createRequire(new URL('../agent/package.json', import.meta.url))('better-sqlite3')

const dir = mkdtempSync(join(tmpdir(), 'priority-benchmark-'))
const runs = []
try {
  for (let round = 0; round < 3; round++) {
    const results = {}
    for (const mode of ['immediate', 'batched']) {
      const db = new Database(join(dir, `${round}-${mode}.db`))
      try {
        db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL')
        db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)')
        const start = performance.now()
        for (let i = 0; i < 1000; i++) {
          if (mode === 'immediate') flagScanPriority(db, `SYMBOL${i % 200}`)
          else queueScanPriority(db, `SYMBOL${i % 200}`)
        }
        if (mode === 'batched') assert.equal(flushScanPriority(db), true)
        const ms = performance.now() - start
        const value = JSON.parse(db.prepare('SELECT value FROM agent_state').get().value)
        assert.equal(Object.keys(value).length, 200)
        assert.ok(Object.values(value).every(at => at <= Date.now() && at >= Date.now() - 60000))
        results[mode] = { ms, writes: db.prepare('SELECT total_changes() AS n').get().n,
          symbols: Object.keys(value).sort(), synchronous: db.pragma('synchronous', { simple: true }) }
      } finally { db.close() }
    }
    assert.deepEqual(results.immediate.symbols, results.batched.symbols)
    assert.equal(results.immediate.writes, 1000)
    assert.equal(results.batched.writes, 1)
    for (const value of Object.values(results)) delete value.symbols
    runs.push(results)
  }
  const evidence = {
    generatedAt: new Date().toISOString(), purpose: 'Local synthetic write amplification measurement, not production acceptance',
    node: process.version, platform: process.platform, arch: process.arch,
    fixture: { events: 1000, symbols: 200, rounds: 3, journal: 'WAL', synchronous: 'FULL' }, runs,
    validation: { sameSymbols: true, freshTimestamps: true, noDurabilityPragmaChange: true },
    limits: ['Timers schedule a flush after 250 ms; event-loop stalls can delay it.',
      'Only advisory scan rotation hints are batched. A crash can lose unflushed hints.',
      'The synthetic burst is not the measured proportion of all production state writes.'],
  }
  if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
} finally { rmSync(dir, { recursive: true, force: true }) }
