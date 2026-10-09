// Codex · №12,721 · 2026-10-10; codex-footprint: bounded-gap-batch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState, getState } from '../db.js'
import { readScannerEvidence } from './scanner-evidence-readout.js'
import { scannerObserver } from './scanner-feed.js'
import { scannerProfileRegistry, registerScannerProfiles } from './scanner-profile-registry.js'
import { nativeProfileHash } from './scanner-profiles.js'
import { comparisonRecord } from './scanner-comparison.js'

const NOW = Date.parse('2026-10-10T00:30:00.000Z')
const ENV = { SCANNER_TIMEFRAME_URL: 'http://timeframe.invalid', SCANNER_TIMEFRAME_SECRET: 'fixture-secret-never-logged' }
const watchdog = { observedAtMs: NOW - 2000, workComplete: true, work: [{ pending: 2 }], cells: { count: 2, capacity: 1024, stale: 0 } }
const profile = (accountId = '43', symbolId = '22') => ({ source: 'cpp-scan-timeframe',
  feed: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId, symbolId }, strategy: 'fib_confluence',
  timeframe: '1h', configVersion: 'tf-v1', profileHash: nativeProfileHash('fib_confluence'), candidateTtlMs: 60000 })
function scene(t, file = false) {
  const dir = file ? mkdtempSync(join(tmpdir(), 'scanner-evidence-')) : null
  const db = initDB(dir ? join(dir, 'agent.db') : ':memory:')
  t.after(() => { db.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  db.exec("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES('42',0,1,'active'),('43',0,1,'manage_only'),('44',1,1,'active')")
  setState(db, 'ctrader_account_id', '42')
  for (const [accountId, symbolId] of [['42', 11], ['43', 22]]) setState(db, `symbol_id_map:${accountId}`, JSON.stringify({ accountId,
    builtAt: new Date(NOW - 1000).toISOString(), complete: true, sourceCount: 1, map: { EURUSD: symbolId }, secret: 'map-secret-never-logged' }))
  registerScannerProfiles(db, { expectedRevision: scannerProfileRegistry(db).revision, profiles: [profile()] }, { env: {} })
  comparisonRecord(db, 'owned-feed', 'cpp-scan-tick', 'candidate', { feed: { accountId: '42', host: 'demo.ctraderapi.com', symbolId: '11' }, profileHash: 'a'.repeat(64) }, NOW - 1000)
  return db
}

test('actual registry, account maps, route readers and native boundary retain the mismatch without writing or switching', async t => {
  const db = scene(t, true), worker = Object.assign(new EventEmitter(), { postMessage() { assert.fail('readout must not publish a profile') }, unref() {} })
  scannerObserver(db, { host: 'demo.ctraderapi.com', accountId: '42' }, { SCANNER_BRIDGE_ENABLED: '1' }, { createWorker: () => worker, now: NOW - 3000 })
  const before = db.prepare('SELECT total_changes() n').get().n, revision = scannerProfileRegistry(db).revision, requests = [], plans = []
  const prepare = db.prepare.bind(db)
  db.prepare = sql => { if (sql === 'SELECT length(value) n FROM agent_state WHERE key=?') plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all('scanner_mirror_profiles_json')); return prepare(sql) }
  const out = await readScannerEvidence(db, { now: NOW, env: ENV, fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options }); return new Response(JSON.stringify(watchdog), { status: 200 })
  } })
  assert.equal(requests.length, 1); assert.equal(new URL(requests[0].url).pathname, '/watchdog')
  assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.redirect, 'error')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
  assert.equal(out.summary.selectedAccountId, '42'); assert.equal(out.summary.revision, revision)
  assert.equal(out.summary.mirrors.bridge.timeframeCoverage.status, 'account_profile_mismatch')
  assert.equal(out.summary.mirrors.bridge.timeframeCoverage.matchingProfiles, 0)
  assert.equal(out.summary.mirrors.bridge.timeframeCoverage.observedAtMs, NOW - 3000)
  assert.equal(out.summary.nativeTimeframe.pending, 2)
  const cell = out.records.find(r => r.kind === 'scanner-profile-cell').value
  assert.equal(cell.accountId, '43'); assert.equal(cell.symbolId, '22'); assert.deepEqual(cell.symbolNames, ['EURUSD'])
  assert.equal(cell.mappingStatus, 'stored_account_map')
  assert.equal(out.records.find(r => r.kind === 'scanner-account-map' && r.value.accountId === '42').value.host, 'demo.ctraderapi.com')
  assert.equal(out.records.find(r => r.kind === 'scanner-account-map' && r.value.accountId === '44').value.host, 'live.ctraderapi.com')
  assert.equal(out.records.find(r => r.kind === 'scanner-tick-feed').value.accountId, '42')
  assert.equal(getState(db, 'ctrader_account_id'), '42'); assert.equal(scannerProfileRegistry(db).revision, revision)
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before)
  db.prepare = prepare
  assert.ok(plans.length && plans.every(rows => rows.some(p => p.detail.includes('SEARCH agent_state USING INDEX'))))
  assert.doesNotMatch(JSON.stringify(out), /fixture-secret|map-secret/)
})

test('foreign maps, stale missing feeds, unknown coverage and native failures remain explicit and never leak raw errors', async t => {
  const db = scene(t)
  setState(db, 'symbol_id_map:43', JSON.stringify({ accountId: '42', map: { WRONG: 22 } }))
  const out = await readScannerEvidence(db, { now: NOW + 3600000, env: ENV, fetchImpl: async () => {
    // A registration disappears during the native read: the projection must
    // retain unknown routing, never substitute the selected demo account.
    db.prepare('DELETE FROM accounts WHERE account_id=?').run('44')
    throw Error('Authorization: Bearer fixture-secret-never-logged')
  } })
  assert.equal(out.summary.status, 'incomplete'); assert.equal(out.summary.nativeTimeframe, null)
  assert.ok(out.summary.missing.includes('timeframe_watchdog_unreadable'))
  assert.ok(out.summary.missing.includes('no_tick_feed_observed_in_five_minutes'))
  assert.ok(out.summary.missing.includes('timeframe_coverage_not_recorded'))
  assert.equal(out.records.find(r => r.kind === 'scanner-account-map' && r.value.accountId === '43').value.status, 'map_account_conflict')
  assert.equal(out.records.find(r => r.kind === 'scanner-account-map' && r.value.accountId === '44').value.host, null)
  const cell = out.records.find(r => r.kind === 'scanner-profile-cell').value
  assert.equal(cell.mappingStatus, 'map_unavailable_or_foreign'); assert.deepEqual(cell.symbolNames, [])
  assert.doesNotMatch(JSON.stringify(out), /Authorization|fixture-secret|WRONG/)
})

test('bounded projection counts all registered anchors but labels sampled cells and refuses oversized input before native I/O', async t => {
  const db = scene(t), profiles = [], map = {}
  for (let i = 1; i <= 300; i++) { profiles.push(profile('43', String(i))); map[`S${i}`] = i }
  setState(db, 'symbol_id_map:43', JSON.stringify({ accountId: '43', map }))
  registerScannerProfiles(db, { expectedRevision: scannerProfileRegistry(db).revision, profiles }, { env: {} })
  const out = await readScannerEvidence(db, { now: NOW, env: {} })
  assert.equal(out.summary.registeredProfiles, 300); assert.equal(out.summary.cellsSelected, 256)
  assert.equal(out.summary.cellsIncluded, out.records.filter(r => r.kind === 'scanner-profile-cell').length)
  assert.ok(out.summary.cellsIncluded <= 256)
  assert.equal(out.summary.profilesTruncated, true)
  assert.equal(out.records.find(r => r.kind === 'scanner-profile-group').value.profiles, 300)
  assert.ok(out.summary.outputBytes <= out.summary.limits.bytes)
  assert.ok(out.records.every(r => Buffer.byteLength(JSON.stringify(r)) <= 12000))
  setState(db, 'scanner_mirror_profiles_json', 'x'.repeat(524289))
  const bounded = await readScannerEvidence(db, { now: NOW, env: ENV, fetchImpl: () => { assert.fail('native read after input bound') } })
  assert.equal(bounded.summary.reason, 'scanner_input_bound'); assert.deepEqual(bounded.records, [])
})

test('actual native reader enforces response size and configuration, and malformed registry is not an empty successful match', async t => {
  const db = scene(t)
  const oversized = await readScannerEvidence(db, { now: NOW, env: ENV, fetchImpl: async () => new Response('x'.repeat(262145)) })
  assert.ok(oversized.summary.missing.includes('timeframe_watchdog_unreadable'))
  setState(db, 'scanner_mirror_profiles_json', '{bad')
  const invalid = await readScannerEvidence(db, { now: NOW, env: {}, fetchImpl: () => assert.fail('unconfigured native read') })
  assert.ok(invalid.summary.missing.includes('registry_invalid'))
  assert.ok(invalid.summary.missing.includes('no_registered_profiles'))
  assert.ok(invalid.summary.missing.includes('timeframe_scanner_not_configured'))
  assert.equal(invalid.summary.mirrors.bridge.timeframeCoverage, null)
  const expired = await readScannerEvidence(db, { now: NOW, env: ENV, expiresAtMs: NOW, clock: () => NOW,
    fetchImpl: () => assert.fail('expired read must not call native boundary') })
  assert.ok(expired.summary.missing.includes('timeframe_watchdog_unreadable'))
})
