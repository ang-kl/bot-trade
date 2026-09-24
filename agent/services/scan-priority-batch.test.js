import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getState, setState, initDB } from '../db.js'
import { queueScanPriority, flushScanPriority, configurePriorityScheduler } from './scan-priority-batch.js'
import { takeScanPrioritySymbols, startGuardian, spotFor } from './guardian.js'

function fixture(t, path = ':memory:') {
  const db = new Database(path)
  db.exec('CREATE TABLE IF NOT EXISTS agent_state(key TEXT PRIMARY KEY,value TEXT)')
  t.after(() => { if (db.open) db.close() })
  let task, delay, schedules = 0
  configurePriorityScheduler(db, {
    schedule: (fn, ms) => { task = fn; delay = ms; schedules++; return 1 },
    cancel: () => { task = null },
  })
  return { db, fire: () => task?.(), schedules: () => schedules, delay: () => delay }
}

test('a tick burst shares one 250ms write and keeps every latest event time', t => {
  const f = fixture(t), now = Date.now()
  for (let i = 0; i < 1000; i++) queueScanPriority(f.db, `symbol${i % 200}`, now + i)
  assert.equal(f.schedules(), 1)
  assert.equal(f.delay(), 250)
  assert.equal(getState(f.db, 'scan_priority_symbols_json'), null)
  f.fire()
  const stored = JSON.parse(getState(f.db, 'scan_priority_symbols_json'))
  assert.equal(Object.keys(stored).length, 200)
  assert.equal(stored.SYMBOL0, now + 800)
  assert.equal(stored.SYMBOL199, now + 999)
})

test('consumption flushes first, clears once, and a subsequent event can requeue', t => {
  const f = fixture(t), now = Date.now()
  setState(f.db, 'scan_priority_symbols_json', JSON.stringify({ EURUSD: now, EXPIRED: now - 900001 }))
  queueScanPriority(f.db, 'xauusd', now)
  assert.deepEqual(takeScanPrioritySymbols(f.db).sort(), ['EURUSD', 'XAUUSD'])
  f.fire()
  assert.deepEqual(takeScanPrioritySymbols(f.db), [])
  queueScanPriority(f.db, 'xauusd', now)
  assert.deepEqual(takeScanPrioritySymbols(f.db), ['XAUUSD'])
})

test('a failed flush retains its pending hints for retry without throwing', t => {
  const f = fixture(t), now = Date.now()
  f.db.exec("CREATE TRIGGER refuse_priority BEFORE INSERT ON agent_state BEGIN SELECT RAISE(ABORT,'locked fixture'); END")
  queueScanPriority(f.db, 'EURUSD', now)
  assert.equal(flushScanPriority(f.db), false)
  f.db.exec('DROP TRIGGER refuse_priority')
  assert.equal(flushScanPriority(f.db), true)
  assert.equal(JSON.parse(getState(f.db, 'scan_priority_symbols_json')).EURUSD, now)
})

test('different database handles cannot mix hints; closed handles never throw', t => {
  const a = fixture(t), b = fixture(t)
  queueScanPriority(a.db, 'EURUSD')
  queueScanPriority(b.db, 'XRPUSD')
  assert.deepEqual(takeScanPrioritySymbols(a.db), ['EURUSD'])
  assert.deepEqual(takeScanPrioritySymbols(b.db), ['XRPUSD'])
  queueScanPriority(a.db, 'ETHUSD')
  a.db.close()
  assert.doesNotThrow(() => a.fire())
})

test('flushed hints survive WAL reopen and preserve FULL durability', t => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-priority-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.db'), f = fixture(t, path)
  f.db.pragma('journal_mode=WAL'); f.db.pragma('synchronous=FULL')
  queueScanPriority(f.db, 'ETHUSD')
  flushScanPriority(f.db)
  assert.equal(f.db.pragma('synchronous', { simple: true }), 2)
  f.db.close()
  // synchronous is per connection; the application pins it in initDB.
  const reopened = initDB(path)
  t.after(() => reopened.close())
  assert.equal(reopened.pragma('journal_mode', { simple: true }), 'wal')
  assert.equal(reopened.pragma('synchronous', { simple: true }), 2)
  assert.deepEqual(takeScanPrioritySymbols(reopened), ['ETHUSD'])
})

test('the guardian stream queues flat-symbol hints while recording spot immediately', async t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  setState(db, 'symbol_id_map', JSON.stringify({ ETHUSD: 991 }))
  setState(db, 'watchlist_json', JSON.stringify(['ETHUSD']))
  let onTick
  const stop = startGuardian(db, () => ({ ready: true }), {
    maintMs: 5,
    streamSpots: async (...args) => { onTick = args[6]; return { close() {} } },
  })
  t.after(stop)
  const deadline = Date.now() + 1000
  while (!onTick && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(typeof onTick, 'function')
  onTick({ symbolId: 991, bid: 100, ask: 100 })
  await new Promise(resolve => setTimeout(resolve, 2))
  onTick({ symbolId: 991, bid: 101, ask: 101 })
  assert.equal(spotFor(991), 101)
  assert.equal(getState(db, 'scan_priority_symbols_json'), null, 'no immediate durable hint write')
  assert.deepEqual(takeScanPrioritySymbols(db), ['ETHUSD'], 'real stream wiring reaches the queue')
})
