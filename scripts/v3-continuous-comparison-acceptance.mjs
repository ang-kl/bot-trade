// Loopback-only evidence through the real isolated collector and shared SQLite.
// Neither this synthetic rate nor the SQLite probe is broker latency evidence.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { initDB, getState, setState } from '../agent/db.js'
import { registerScannerProfiles, scannerProfileRegistry } from '../agent/services/scanner-profile-registry.js'
const root = new URL('../', import.meta.url)
const fixture = JSON.parse(readFileSync(new URL('cpp-scan-tick/src/tests/fixtures/tick_momentum_fixture.json', root)))
const profileHash = JSON.parse(readFileSync(new URL('cpp-scan-tick/src/tests/fixtures/tick_momentum_expected.json', root))).profileHash
const dir = mkdtempSync(join(tmpdir(), 'v3-collector-')), db = initDB(join(dir, 'fixture.db'))
const socket = createServer().listen(0, '127.0.0.1'); await new Promise(r => socket.once('listening', r))
const port = socket.address().port; await new Promise(r => socket.close(r))
const url = `http://127.0.0.1:${port}`, secret = 'local-only-fixture'
const child = spawn(new URL('cpp-scan-tick/bin/cpp-scan-tick', root).pathname, [], { env: { PORT: String(port), SCANNER_SECRET: secret }, stdio: 'ignore' })
let worker, probe, childError, workerError
child.on('error', e => { childError = e })
const latencies = [], streams = 50, pacingMs = 100
const percentiles = values => { const sorted = [...values].sort((a,b) => a-b); return Object.fromEntries([['p95',.95],['p99',.99],['max',1]].map(([key,p]) => [key, sorted[Math.ceil(sorted.length*p)-1] ?? null])) }
async function request(path, body) {
  const r = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000), ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() }
}
try {
  let ready = false
  for (let i = 0; i < 200 && !ready; i++) { if (childError) throw childError; try { ready = (await request('/health')).status === 200 } catch { await delay(10) } }
  assert.ok(ready)
  db.prepare('INSERT INTO accounts(account_id) VALUES(11)').run()
  setState(db, 'symbol_id_map:11', JSON.stringify({ map: Object.fromEntries(Array.from({ length: streams }, (_, i) => [`FIXTURE${i}`, i+1])) }))
  const profiles = Array.from({ length: streams }, (_, i) => ({ source: 'cpp-scan-tick', feed: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: String(i+1) }, strategy: 'tick_momentum_breakout', profileHash, profile: fixture.params, candidateTtlMs: 60000, configVersion: 'fixture-v1' }))
  registerScannerProfiles(db, { expectedRevision: scannerProfileRegistry(db).revision, profiles }, { env: {} })
  worker = new Worker(new URL('agent/services/scanner-bridge-worker.js', root), { workerData: { path: db.name }, env: { SCANNER_TICK_URL: url, SCANNER_TICK_SECRET: secret }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
  worker.on('error', e => { workerError = e })
  probe = setInterval(() => { const start = performance.now(); setState(db, 'local_latency_probe', String(Date.now())); latencies.push(performance.now()-start) }, 50)
  let accepted = 0, dropped = 0, retried = 0
  const start = performance.now()
  for (const policy of profiles) {
    if (workerError) throw workerError
    const shift = Date.now()-1000-fixture.events.at(-1).recvMs
    const body = { ...policy, schemaVersion: 1, purpose: 'mirror', feedEpoch: 'paced-fixture', records: fixture.events.map(q => ({ sequence: q.seq, sourceSequence: q.seq, receivedAtMs: q.recvMs+shift, sourceTimestampMs: null, bid:q.bid, ask:q.ask,
      flags:(q.bid!=null?1:0)|(q.ask!=null?2:0)|(q.snapshot?16:0)|(q.crossed?32:0)|(q.changed?0:64) })) }
    delete body.source
    let done = false
    for (let attempt=0; attempt<100; attempt++) {
      const r = await request('/feed',body)
      if (r.status===429) { retried++; await delay(5); continue }
      assert.equal(r.status,202); accepted+=r.body.accepted; dropped+=r.body.dropped; done=true; break
    }
    assert.ok(done); await delay(pacingMs)
  }
  const inputMs = performance.now()-start, expected = streams*fixture.events.length
  let receipt
  for (let i=0; i<300; i++) {
    if (workerError) throw workerError
    receipt = JSON.parse(getState(db,'scanner_bridge_poll_json')||'null')
    if (receipt?.tickCursor>=expected) break
    await delay(100)
  }
  clearInterval(probe)
  const populations = db.prepare('SELECT state,COUNT(*) n FROM scanner_comparisons GROUP BY state').all()
  const native = (await request('/watchdog')).body
  const result = { observedAt:new Date().toISOString(),scope:'local paced synthetic comparison, not production peak', streams,pacingMs,submitted:expected,accepted,processed:native.processed,dropped,retried,inputMs,elapsedMs:performance.now()-start,populations,collector:receipt,sqliteProbeMs:{ samples:latencies.length,...percentiles(latencies) },orderIntents:db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n }
  console.log(JSON.stringify(result,null,2))
  assert.equal(accepted,expected);assert.equal(native.processed,expected);assert.equal(dropped,0)
  assert.equal(populations.reduce((n,p)=>n+p.n,0),expected)
  assert.ok(populations.every(p=>['matched','native_expired'].includes(p.state)))
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scanner_comparisons WHERE json_array_length(json_extract(detail,'$.differences')) > 0").get().n,0)
  assert.equal(result.orderIntents,0)
} finally {
  clearInterval(probe); if(worker) await worker.terminate(); db.close()
  if(child.exitCode==null&&!childError){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r))}
  rmSync(dir,{recursive:true,force:true})
}
