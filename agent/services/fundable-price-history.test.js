import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { lastScanPrice } from './fundable-universe.js'

function fixture(db) {
  const put = db.prepare('INSERT INTO scans(symbol,price,scanned_at) VALUES (?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) put.run('ETHUSD', 2000 + i, '2026-09-24')
    put.run('ETHUSD', 2711.25, '2020-01-01') // latest id, deliberately older timestamp
    put.run('ETHUSD', null, '2026-09-25')
    put.run('ETHUSD', 0, '2026-09-25')
    put.run('ETHUSD', -2, '2026-09-25')
    put.run('XRPUSD', 1.52, '2026-09-25')
  })()
}

test('fundable price uses a symbol seek without sorting retained history', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  fixture(db)
  const statements = []
  const traced = { prepare(sql) { statements.push(sql); return db.prepare(sql) } }
  assert.equal(lastScanPrice(traced, 'ethusd'), 2711.25)
  assert.equal(lastScanPrice(traced, 'XRPUSD'), 1.52)
  assert.equal(lastScanPrice(traced, 'ABSENT'), null)
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all('ETHUSD').map(r => r.detail).join('\n')
  assert.match(plan, /SEARCH scans USING (?:COVERING )?INDEX/)
  assert.doesNotMatch(plan, /TEMP B-TREE|SCAN scans/, plan)
})

test('fundable price upgrade preserves every scan and WAL/FULL across reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fundable-price-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'agent.db')
  let db = initDB(path)
  fixture(db)
  const before = db.prepare('SELECT * FROM scans ORDER BY id').all()
  db.exec('DROP INDEX IF EXISTS idx_scans_symbol_positive_id')
  db.close()
  for (let i = 0; i < 2; i++) {
    db = initDB(path)
    try {
      assert.deepEqual(db.prepare('SELECT * FROM scans ORDER BY id').all(), before)
      assert.equal(lastScanPrice(db, 'ETHUSD'), 2711.25)
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
      assert.equal(db.pragma('synchronous', { simple: true }), 2)
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT price FROM scans WHERE symbol = ? AND price > 0 ORDER BY id DESC LIMIT 1').all('ETHUSD')
      assert.ok(plan.every(r => !/TEMP B-TREE/.test(r.detail)), JSON.stringify(plan))
    } finally { db.close() }
  }
})
