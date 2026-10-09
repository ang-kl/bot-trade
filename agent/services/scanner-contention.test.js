// Codex · №12,751 · 2026-10-10; codex-footprint: bounded-comparison-commits.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { createScannerCollector } from './scanner-collector.js'
import { comparisonRecord, TickComparisonReader } from './scanner-comparison.js'
import { DEFAULT_PARAMS, profileHash } from '../lib/tick-strategy.js'

const NOW = 1_800_000_000_000, env = { SCANNER_TICK_URL: 'http://fixture', SCANNER_TICK_SECRET: 'fixture' }
const page = (after, count = 16, extra = {}) => ({ instanceId: 'a'.repeat(64), orderAuthority: false,
  oldestCursor: 1, latestCursor: count, gap: false,
  candidates: Array.from({ length: count }, (_, i) => ({ cursor: i + 1 })).filter(r => r.cursor > after), ...extra })
function fixture(t, file = false) {
  const dir = file ? mkdtempSync(join(tmpdir(), 'scanner-contention-')) : null
  const db = initDB(dir ? join(dir, 'agent.db') : ':memory:')
  comparisonRecord(db, 'seed', 'cpp-scan-tick', 'fixture', {}, NOW)
  db.prepare('DELETE FROM scanner_comparisons').run()
  t.after(() => { db.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  return db
}
const options = extra => ({ env, now: () => NOW, mirrors: async () => ({ outcomes: [] }), ...extra })

test('real collector/file-SQLite worker permits a main write at the released prefix boundary', async t => {
  const db = fixture(t, true), shared = new SharedArrayBuffer(8), control = new Int32Array(shared)
  db.pragma('busy_timeout=100')
  const require = createRequire(import.meta.url), messages = [], wakes = []
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const Database=require(workerData.database), db=new Database(workerData.path);
      const {createScannerCollector}=await import(workerData.collector);
      const state=new Int32Array(workerData.shared);let released=false, firstYield=true, unblock;
      parentPort.on('message',m=>{if(m==='continue'){released=true;unblock?.()}});
      db.function('controlled_insert_latency',()=>{
        const n=Atomics.add(state,1,1)+1;
        if(n===1){parentPort.postMessage({writing:true});Atomics.wait(state,0,0,5000)}
        Atomics.wait(state,0,1,25);return 0;
      });
      db.exec('CREATE TEMP TRIGGER comparison_latency BEFORE INSERT ON scanner_comparisons BEGIN SELECT controlled_insert_latency(); END');
      const collect=createScannerCollector(db,{env:workerData.env,now:()=>workerData.now,
        mirrors:async()=>({outcomes:[]}),request:async()=>workerData.page,
        // Hold the first released boundary to prove lock release, not a
        // production scheduler latency guarantee. Default yield is covered below.
        yieldTurn:async()=>{if(firstYield){firstYield=false;parentPort.postMessage({yielded:Atomics.load(state,1)});
          if(!released)await new Promise(r=>{unblock=r})}else await new Promise(r=>setImmediate(r))}});
      const result=await collect();
      parentPort.postMessage({done:result,rows:db.prepare('SELECT COUNT(*) n FROM scanner_comparisons').get().n});
      db.close();parentPort.close();
    })().catch(e=>{throw e});
  `, { eval: true, workerData: { path: db.name, shared, env, now: NOW, page: page(0),
    database: require.resolve('better-sqlite3'), collector: new URL('./scanner-collector.js', import.meta.url).href } })
  t.after(() => worker.terminate())
  worker.on('message', x => { messages.push(x); for (const wake of wakes.splice(0)) wake() })
  let workerError; worker.on('error', e => { workerError = e })
  const waitFor = async key => {
    const until = Date.now() + 7000
    while (!messages.some(x => key in x)) {
      if (workerError) throw workerError
      assert.ok(Date.now() < until, `worker did not report ${key}`)
      await Promise.race([new Promise(r => wakes.push(r)), delay(10)])
    }
    return messages.find(x => key in x)
  }
  await waitFor('writing'); Atomics.store(control, 0, 1); Atomics.notify(control, 0)
  let failure
  try { setState(db, 'independent_watchdog_json', 'main-write-survived') } catch (e) { failure = e }
  worker.postMessage('continue')
  const done = await waitFor('done')
  assert.equal(failure?.code, undefined, 'old whole-page writer makes the real main UPSERT SQLITE_BUSY')
  assert.equal(getState(db, 'independent_watchdog_json'), 'main-write-survived')
  assert.equal(messages.find(x => 'yielded' in x)?.yielded, 2)
  assert.equal(done.rows, 16); assert.equal(done.done.tickCursor, 16); assert.equal(done.done.tickRecords, 16)
})

test('whole native malformed tail is refused before any prefix; budget leaves a refetchable committed cursor', async t => {
  const db = fixture(t), reader = new TickComparisonReader(); let clock = NOW
  const malformed = createScannerCollector(db, options({ reader,
    request: async () => page(0, 8, { candidates: [...page(0, 8).candidates.slice(0, 7), { cursor: 99 }] }) }))
  assert.equal((await malformed()).error, 'comparison_read_or_contract_failed')
  assert.equal(reader.after, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM scanner_comparisons').get().n, 0)
  const requested = [], collect = createScannerCollector(db, options({ reader, now: () => clock,
    request: async (_u,_s,path) => { const after = Number(path.split('=')[1]); requested.push(after); return page(after, 12) },
    yieldTurn: async () => { clock += 600 } }))
  const first = await collect()
  assert.equal(first.tickRecords, 4); assert.equal(first.tickCursor, 4); assert.equal(first.tickBacklog, true)
  assert.equal(first.tickPages, 1); assert.equal(first.tickCommits, 2)
  const second = await collect(); assert.equal(second.tickCursor, 8); assert.equal(requested[1], 4)
  await collect(); assert.equal(reader.after, 12)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scanner_comparisons').get().n, 12)
})

test('first or later storage failure keeps only committed prefixes and replay/restart does not duplicate', async t => {
  const db = fixture(t), reader = new TickComparisonReader(); let writes = 0, fail = true, failAt = 1
  db.function('fail_comparison', () => { writes++; if (fail && writes === failAt) throw Error('controlled-write-failure'); return 0 })
  db.exec('CREATE TEMP TRIGGER comparison_failure BEFORE INSERT ON scanner_comparisons BEGIN SELECT fail_comparison(); END')
  const collect = createScannerCollector(db, options({ reader, request: async (_u,_s,path) => page(Number(path.split('=')[1]), 8), yieldTurn: async () => {} }))
  const firstFailed = await collect()
  assert.equal(firstFailed.error, 'comparison_read_or_contract_failed')
  assert.equal(firstFailed.tickBacklog, true)
  assert.equal(firstFailed.tickCursor, 0); assert.equal(firstFailed.tickRecords, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scanner_comparisons').get().n, 0)
  writes = 0; failAt = 4
  const failed = await collect()
  assert.equal(failed.error, 'comparison_read_or_contract_failed')
  assert.equal(failed.tickBacklog, true)
  assert.equal(reader.after, 2); assert.equal(failed.tickRecords, 2)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scanner_comparisons').get().n, 2)
  fail = false; const complete = await collect(); assert.equal(complete.tickCursor, 8); assert.equal(complete.tickRecords, 6)
  const replay = createScannerCollector(db, options({ request: async (_u,_s,path) => page(Number(path.split('=')[1]), 8), yieldTurn: async () => {} }))
  assert.equal((await replay()).tickCursor, 8)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scanner_comparisons').get().n, 8)
})

test('native-page profile memo remains one read across prefixes, oracle continuity and first-prefix gap retained', async t => {
  const db = fixture(t), feed = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '1000' }
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(11,0)').run()
  setState(db, 'symbol_id_map:11', JSON.stringify({ accountId: '11', map: { X: 1000 } }))
  const hash = profileHash(DEFAULT_PARAMS)
  setState(db, 'scanner_mirror_profiles_json', JSON.stringify([{ source: 'cpp-scan-tick', feed, strategy: 'tick_momentum_breakout', configVersion: 'v1', profileHash: hash, candidateTtlMs: 60000 }]))
  const raw = page(0, 128)
  raw.gap = true
  raw.candidates = raw.candidates.map((r,i) => ({ ...r, feed: i % 3 === 2 ? { ...feed, accountId: '22' } : feed,
    strategy: 'tick_momentum_breakout', feedEpoch: 'epoch-a', configVersion: 'v1',
    profileHash: hash, profile: DEFAULT_PARAMS, outcome: 'no_signal', orderAuthority: false, completedAtMs: NOW,
    quote: { seq: i+1, recvMs: NOW, bid: 100, ask: 101, snapshot: i===0, crossed: false, changed: true } }))
  let profileReads = 0
  const view = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql)
      if (!/SELECT value FROM agent_state WHERE key/.test(sql)) return statement
      return new Proxy(statement, { get(s,k) {
        if (k==='get') return (...args) => { if(args[0]==='scanner_mirror_profiles_json') profileReads++; return s.get(...args) }
        const v=Reflect.get(s,k,s); return typeof v==='function'?v.bind(s):v
      } })
    }
    const v=Reflect.get(target,key,target); return typeof v==='function'?v.bind(target):v
  } })
  const reader = new TickComparisonReader(), collect = createScannerCollector(view, options({ reader, request: async () => raw }))
  const result = await collect()
  assert.equal(result.tickCursor, 128); assert.equal(result.tickCommits, 64); assert.equal(profileReads, 1)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scanner_comparisons WHERE state='input_gap'").get().n, 1)
  assert.equal(reader.streams.size, 1); assert.equal([...reader.streams.values()][0].last, 128)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scanner_comparisons WHERE state='reference_warmup_unknown'").get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scanner_comparisons WHERE state='contract_rejected'").get().n, 42,
    'foreign account rows remain refused across prefix memo reuse')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n, 0)
})
