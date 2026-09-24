import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'

test('database startup reports finite ordered phase timings without SQL or values', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  const timing = db.startupTiming
  assert.ok(timing)
  assert.ok(timing.totalMs >= 0)
  assert.deepEqual(timing.phases.map(p => p.name), [
    'open_and_journal', 'base_schema', 'legacy_repairs', 'column_migrations',
    'indexes', 'history_schema', 'final_migrations_and_seed',
  ])
  for (const phase of timing.phases) {
    assert.deepEqual(Object.keys(phase).sort(), ['ms', 'name'])
    assert.ok(Number.isFinite(phase.ms) && phase.ms >= 0)
  }
  assert.ok(Math.abs(timing.phases.reduce((sum, p) => sum + p.ms, 0) - timing.totalMs) < 0.01)
  assert.equal(db.pragma('synchronous', { simple: true }), 2)
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
})
