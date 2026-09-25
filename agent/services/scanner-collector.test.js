import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState } from '../db.js'
import { createScannerCollector, startScannerCollector } from './scanner-collector.js'
import { scannerMirrorStatus } from './scanner-candidates.js'
const env = { SCANNER_TICK_URL: 'http://fixture', SCANNER_TICK_SECRET: 'fixture' }
function fixture(t) { const db = initDB(':memory:'); t.after(() => db.close()); return db }
const page = (after, latest = 12, instanceId = 'a'.repeat(64)) => ({ instanceId, orderAuthority: false, oldestCursor: 1, latestCursor: latest, gap: false, candidates: after < latest ? [{ cursor: after + 1 }] : [] })
test('bounded drain reschedules backlog promptly and continues exact cursor, servicing mirror streams every round', async t => {
  const db = fixture(t), seen = []; let mirrorRounds = 0, yields = 0
  const collect = createScannerCollector(db, { env, now: () => 1800000000000,
    mirrors: async () => { mirrorRounds++; return { outcomes: [] } }, yieldTurn: async () => { yields++ },
    request: async (_u,_s,path) => { const after = Number(path.split('=')[1]); seen.push(after); return page(after) } })
  const first = await collect(); assert.equal(first.tickPages, 8); assert.equal(first.delayMs, 10); assert.equal(first.tickCursor, 8)
  const second = await collect(); assert.equal(second.tickPages, 4); assert.equal(second.delayMs, 100); assert.equal(second.tickCursor, 12)
  assert.deepEqual(seen, Array.from({ length: 12 }, (_,i) => i)); assert.equal(mirrorRounds, 2); assert.equal(yields, 11)
  assert.equal(JSON.parse(getState(db, 'scanner_bridge_poll_json')).orderAuthority, false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n, 0)
})
test('slow or unavailable input cannot overlap or spin; restart requests replay and gap stays explicit', async t => {
  const db = fixture(t); let release
  const collect = createScannerCollector(db, { env, mirrors: async () => ({ outcomes: [] }), request: () => new Promise(resolve => { release = resolve }) })
  const pending = collect(); await new Promise(r => setImmediate(r))
  assert.equal((await collect()).skipped, 'in_flight')
  release(page(0, 1)); assert.equal((await pending).tickCursor, 1)
  const broken = createScannerCollector(db, { env, mirrors: async () => ({ outcomes: [] }), request: async () => ({ ...page(0, 2), candidates: [] }) })
  assert.equal((await broken()).error, 'comparison_read_or_contract_failed')
  let epoch = 'a'.repeat(64); const requests = []
  const restart = createScannerCollector(db, { env, mirrors: async () => ({ outcomes: [] }), request: async (_u,_s,path) => { requests.push(path); return { ...page(0, 3, epoch), oldestCursor: 3, candidates: [{ cursor: 3 }], gap: true } } })
  await restart(); epoch = 'b'.repeat(64); await restart()
  assert.deepEqual(requests, ['/comparisons?after=0', '/comparisons?after=3', '/comparisons?after=0'])
  assert.ok(db.prepare("SELECT COUNT(*) n FROM scanner_comparisons WHERE state='input_gap'").get().n >= 2)
})
test('the collector round is readable from the status route; its record is written at most once a second', async t => {
  const db = fixture(t); let clock = 1_800_000_000_000, fail = false
  const collect = createScannerCollector(db, { env, now: () => clock, mirrors: async () => ({ outcomes: [] }),
    request: async () => { if (fail) throw new Error('down'); return page(0, 0) } })
  const first = await collect()
  let collector = scannerMirrorStatus(db).collector
  assert.equal(collector.readAtMs, first.readAtMs); assert.equal(collector.error, undefined)
  assert.equal(collector.orderAuthority, false); assert.equal(typeof collector.durationMs, 'number')
  clock += 200; fail = true
  const failed = await collect()
  assert.equal(failed.error, 'comparison_read_or_contract_failed')
  assert.equal(scannerMirrorStatus(db).collector.readAtMs, first.readAtMs, 'a round 200 ms later must not write')
  clock += 1000; fail = false
  const recovered = await collect()
  collector = scannerMirrorStatus(db).collector
  assert.equal(collector.readAtMs, recovered.readAtMs); assert.equal(collector.error, undefined)
  // The skipped round's error is not lost: it rides the next record.
  assert.deepEqual(collector.lastError, { error: 'comparison_read_or_contract_failed', atMs: failed.readAtMs })
})
test('continuous timer uses completion delay, stops cleanly and is wired into the worker', async t => {
  const db = fixture(t), scheduled = []; let cleared
  const stop = startScannerCollector(db, { env: {}, mirrors: async () => ({ outcomes: [] }), setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length }, clearTimeout: id => { cleared = id } })
  assert.equal(scheduled[0].ms, 0); await scheduled[0].fn(); assert.equal(scheduled[1].ms, 100)
  stop(); assert.equal(cleared, 2); await scheduled[1].fn(); assert.equal(scheduled.length, 2)
  const source = readFileSync(new URL('./scanner-bridge-worker.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  assert.match(source, /startScannerCollector\(db\)/)
})
