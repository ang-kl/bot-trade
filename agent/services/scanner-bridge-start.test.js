import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ensureScannerBridge, startScannerBridge, scannerObserver, scannerBridgeStatus } from './scanner-feed.js'

// A file database with only agent_state: the bridge gate reads nothing else,
// and the worker itself is replaced by a fake, so no scanner runs here.
const feed = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' }
const profile = (over = {}) => ({ source: 'cpp-scan-timeframe', feed, strategy: 'fib_confluence', timeframe: '1h', configVersion: 'tf-v1', profileHash: 'h', candidateTtlMs: 60000, ...over })
function fileDb(t, profiles = [profile()]) {
  const dir = mkdtempSync(join(tmpdir(), 'scanner-bridge-start-'))
  const db = new Database(join(dir, 'bridge.db'))
  db.exec('CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT)')
  if (profiles !== null) db.prepare('INSERT INTO agent_state VALUES (?,?)').run('scanner_mirror_profiles_json', JSON.stringify(profiles))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  return db
}
// createWorker spy: each call returns a fake worker (an EventEmitter with the
// three methods the bridge uses) and records how it was built.
function workers({ postMessage } = {}) {
  const built = []
  const createWorker = (url, options) => {
    const w = Object.assign(new EventEmitter(), { url: String(url), options, sent: [], terminated: 0,
      postMessage: postMessage ?? (job => w.sent.push(job)), terminate() { w.terminated++; return Promise.resolve(0) }, unref() {} })
    built.push(w); return w
  }
  return { built, createWorker }
}
function timer() {
  const t = { fn: null, ms: null, cleared: null, unrefs: 0 }
  t.setInterval = (fn, ms) => { t.fn = fn; t.ms = ms; return { id: 1, unref() { t.unrefs++ } } }
  t.clearInterval = handle => { t.cleared = handle }
  return t
}
const env = { SCANNER_BRIDGE_ENABLED: '1', SCANNER_TICK_URL: 'http://tick', SCANNER_TICK_SECRET: 's', UNRELATED: 'x' }

test('collector starts at boot without any bar scan', t => {
  const db = fileDb(t), w = workers(), clock = timer()
  const stop = startScannerBridge(db, { env, createWorker: w.createWorker, setInterval: clock.setInterval, clearInterval: clock.clearInterval, now: () => 1_000_000 })
  assert.equal(w.built.length, 1, 'the starter must build the worker itself, not wait for runLoop to reach the scan')
  assert.match(w.built[0].url, /scanner-bridge-worker\.js$/)
  assert.equal(w.built[0].options.workerData.path, db.name)
  assert.deepEqual(w.built[0].options.env, { SCANNER_TICK_URL: 'http://tick', SCANNER_TICK_SECRET: 's' })
  assert.equal(scannerBridgeStatus(db).enabled, true)
  assert.equal(scannerBridgeStatus(db).orderAuthority, false)
  assert.equal(clock.ms, 60_000); assert.equal(clock.unrefs, 1)
  stop(); assert.equal(clock.cleared.id, 1)
})

test('the approval gate is unchanged: no flag, flag 0, memory DB, no/empty/over-limit profiles', t => {
  const cases = [
    [fileDb(t), {}], [fileDb(t), { SCANNER_BRIDGE_ENABLED: '0' }],
    [new Database(':memory:'), env], [fileDb(t, []), env], [fileDb(t, null), env],
    [fileDb(t, Array.from({ length: 1025 }, (_, i) => profile({ timeframe: `tf${i}` }))), env],
  ]
  cases[2][0].exec("CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT); INSERT INTO agent_state VALUES ('scanner_mirror_profiles_json','[{}]')")
  t.after(() => cases[2][0].close())
  for (const [db, e] of cases) {
    const w = workers(), clock = timer()
    const stop = startScannerBridge(db, { env: e, createWorker: w.createWorker, setInterval: clock.setInterval, clearInterval: clock.clearInterval })
    clock.fn()
    assert.equal(w.built.length, 0); assert.equal(typeof stop, 'function')
    assert.equal(ensureScannerBridge(db, e, { createWorker: w.createWorker }), null)
    assert.equal(scannerBridgeStatus(db).enabled, false)
  }
})

test('one bridge per DB: the timer, a second ensure and the scan observer share one worker', t => {
  const db = fileDb(t), w = workers()
  const first = ensureScannerBridge(db, env, { createWorker: w.createWorker })
  assert.equal(ensureScannerBridge(db, env, { createWorker: w.createWorker }).bridge, first.bridge)
  assert.deepEqual(first.profiles, [profile()])
  const observe = scannerObserver(db, { host: feed.host, accountId: 11 }, env, { createWorker: w.createWorker })
  observe({ symbolId: 7, timeframe: '1h', strategy: 'fib_confluence', bars: [{ t: 1 }], cacheIdentity: { host: feed.host, accountId: 11 } })
  assert.equal(w.built.length, 1)
  assert.equal(w.built[0].sent.length, 1)
  assert.deepEqual(w.built[0].sent[0].feed, feed)
  assert.equal(w.built[0].sent[0].configVersion, 'tf-v1')
})

test('a crashed worker is rebuilt by the timer, once, after terminating the old one', t => {
  for (const event of ['exit', 'error']) {
    const db = fileDb(t), w = workers(), clock = timer(); let now = 1_000_000
    startScannerBridge(db, { env, createWorker: w.createWorker, setInterval: clock.setInterval, clearInterval: clock.clearInterval, now: () => now })
    w.built[0].emit(event, event === 'error' ? new Error('boom') : 1)
    assert.equal(scannerBridgeStatus(db).failed, true)
    assert.equal(scannerBridgeStatus(db).failure, `worker_${event}`)
    // A caller that reaches the dead bridge within 30 s does not rebuild it:
    // a worker that dies on start cannot turn every scan into a rebuild.
    now += 10_000; clock.fn()
    assert.equal(w.built.length, 1)
    now += 50_000; clock.fn()
    assert.equal(w.built[0].terminated, 1, event)
    assert.equal(w.built.length, 2, event)
    const status = scannerBridgeStatus(db)
    assert.equal(status.failed, false); assert.equal(status.restarts, 1); assert.equal(status.dropped, 0)
    // The old worker's late events cannot fail the new bridge.
    w.built[0].emit('exit', 1)
    assert.equal(scannerBridgeStatus(db).failed, false)
    now += 60_000; clock.fn()
    assert.equal(w.built.length, 2, 'a healthy bridge is not rebuilt')
  }
})

test('a construction throw is recorded and rebuilt on a later tick', t => {
  const db = fileDb(t), w = workers(), clock = timer(); let now = 1_000_000, fail = true
  const createWorker = (url, options) => { if (fail) throw new Error('resource limits'); return w.createWorker(url, options) }
  startScannerBridge(db, { env, createWorker, setInterval: clock.setInterval, clearInterval: clock.clearInterval, now: () => now })
  assert.equal(scannerBridgeStatus(db).failed, true)
  assert.equal(scannerBridgeStatus(db).failure, 'worker_construction')
  fail = false; now += 60_000; clock.fn()
  assert.equal(w.built.length, 1)
  assert.deepEqual([scannerBridgeStatus(db).failed, scannerBridgeStatus(db).restarts], [false, 1])
})

test('a failed send() is recorded against the job and never rebuilds a healthy worker', t => {
  let throwNext = true
  const w = workers({ postMessage(job) { if (throwNext) { throwNext = false; throw Object.assign(new Error('could not be cloned'), { name: 'DataCloneError' }) } w.built[0].sent.push(job) } })
  const db = fileDb(t), clock = timer(); let now = 1_000_000
  startScannerBridge(db, { env, createWorker: w.createWorker, setInterval: clock.setInterval, clearInterval: clock.clearInterval, now: () => now })
  const { bridge } = ensureScannerBridge(db, env, { createWorker: w.createWorker, now })
  assert.equal(bridge.offer({ bars: [] }), false)
  let status = scannerBridgeStatus(db)
  assert.deepEqual([status.failed, status.sendFailures, status.lastSendError, status.dropped], [false, 1, 'DataCloneError', 1])
  now += 120_000; clock.fn()
  assert.equal(w.built.length, 1, 'a job the worker could not accept is not a dead worker')
  assert.equal(w.built[0].terminated, 0)
  assert.equal(bridge.offer({ bars: [] }), true)
  assert.equal(w.built[0].sent.length, 1)
  status = scannerBridgeStatus(db)
  assert.deepEqual([status.failed, status.restarts, status.pending], [false, 0, 1])
})

test('the observer offers exactly the registered cells of one evaluation sweep', t => {
  const strategies = ['fib_confluence', 'rsi2_reversion', 'donchian_breakout', 'fib_618_fade', 'cup_handle', 'inv_cup_handle', 'ema_pullback', 'rsi_meanrev', 'vp_value', 'va_breakout', 'fvg_retrace', 'vwap_trend', 'tsmom_long']
  const timeframes = ['5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mo']
  const registered = [profile({ strategy: 'fib_confluence', timeframe: '1h' }), profile({ strategy: 'fib_confluence', timeframe: '4h' }),
    profile({ strategy: 'rsi2_reversion', timeframe: '1h' }), profile({ strategy: 'rsi2_reversion', timeframe: '4h' }),
    profile({ strategy: 'rsi2_reversion', timeframe: '1h', feed: { ...feed, symbolId: '8' } }),
    profile({ strategy: 'rsi2_reversion', timeframe: '1h', feed: { ...feed, accountId: '22' } }),
    profile({ source: 'cpp-scan-tick', strategy: 'rsi2_reversion', timeframe: '1h' })]
  const db = fileDb(t, registered), w = workers()
  const observe = scannerObserver(db, { host: feed.host, accountId: '11' }, env, { createWorker: w.createWorker })
  for (const strategy of strategies) for (const timeframe of timeframes)
    observe({ symbolId: 7, strategy, timeframe, bars: [{ t: 1 }], cacheIdentity: { host: feed.host, accountId: '11' } })
  assert.deepEqual(w.built[0].sent.map(j => `${j.strategy}:${j.timeframe}`).sort(),
    ['fib_confluence:1h', 'fib_confluence:4h', 'rsi2_reversion:1h', 'rsi2_reversion:4h'])
  // A cache built for another account is still refused before any offer.
  assert.equal(observe({ symbolId: 7, strategy: 'fib_confluence', timeframe: '1h', bars: [{ t: 1 }], cacheIdentity: { host: feed.host, accountId: '22' } }), false)
  assert.equal(w.built[0].sent.length, 4)
})
