// agent/services/runtime-manifest.test.js — a measurement that says "unknown"
// where it cannot read, and never a number it did not take.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { mkdtempSync } from '../test-support/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDB } from '../db.js'
import { runtimeManifest, sqliteRuntime, cgroupLimits, sidecarFacts, recorderFacts } from './runtime-manifest.js'

test('sqlite facts come from the running library, not the lockfile', () => {
  const db = initDB(':memory:')
  const sq = sqliteRuntime(db)
  assert.match(sq.version, /^3\.\d+\.\d+$/)
  assert.ok(sq.sourceId.length > 10)
  assert.equal(typeof sq.bindingVersion, 'string')
  assert.ok(['wal', 'memory', 'delete'].includes(String(sq.journalMode)))
})

test('cgroup limits: a v2 quota is read as CPUs and throttling; an absent tree is unknown, not zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-'))
  writeFileSync(join(dir, 'cpu.max'), '200000 100000\n')
  writeFileSync(join(dir, 'memory.max'), '2147483648\n')
  writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 1\nnr_periods 10\nnr_throttled 3\n')
  assert.deepEqual(cgroupLimits(dir), { cpuMax: '200000 100000', cpus: 2, memMax: '2147483648', throttled: 3 })
  writeFileSync(join(dir, 'cpu.max'), 'max 100000\n')
  assert.equal(cgroupLimits(dir).cpus, 'unlimited')
  const empty = mkdtempSync(join(tmpdir(), 'cg-empty-'))
  assert.deepEqual(cgroupLimits(empty), { cpuMax: null, cpus: null, memMax: null, throttled: null })
})

test('sidecar facts: reachable health is read field by field, the commit is reported as not reported, failures name the reason', async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ bootId: 'b9', startedAtMs: 5, connected: true, accountCount: 3, guard: { halt: false }, telemetryWritten: 12, telemetryDropped: 0 }) })
  const f = await sidecarFacts('http://demo:8091', { fetcher: ok, secret: 's' })
  assert.deepEqual(f, { reachable: true, bootId: 'b9', startedAtMs: 5, connected: true, accountCount: 3, halt: false, telemetryWritten: 12, telemetryDropped: 0, commit: null })
  const http503 = async () => ({ ok: false, status: 503 })
  assert.deepEqual(await sidecarFacts('http://demo:8091', { fetcher: http503 }), { reachable: false, reason: 'HTTP 503' })
  const boom = async () => { throw new Error('ECONNREFUSED') }
  assert.deepEqual(await sidecarFacts('http://demo:8091', { fetcher: boom }), { reachable: false, reason: 'ECONNREFUSED' })
  assert.deepEqual(await sidecarFacts('', { fetcher: ok }), { reachable: false, reason: 'no base url configured' })
})

test('the manifest labels every unknown, never estimates, and never prints a secret', async () => {
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'mf-'))
  mkdirSync(join(dir, 'cg'))
  const dbPath = join(dir, 'agent.db')
  writeFileSync(dbPath, 'x'.repeat(1000))
  const env = { EXEC_ENGINE: 'cpp', EXEC_URL_DEMO: 'http://demo:8091', EXEC_SECRET: 'hunter2', DB_PATH: dbPath }
  const fetcher = async (url) => url.startsWith('http://demo') ? ({ ok: true, status: 200, json: async () => ({ bootId: 'b1', connected: true, accountCount: 4 }) }) : (() => { throw new Error('no such host') })()
  const m = await runtimeManifest(db, { env, cgroupRoot: join(dir, 'cg'), fetcher, packageVersion: '0.1.381', now: new Date('2026-09-11T00:00:00Z') })
  const byKey = Object.fromEntries(m.items.map(i => [i.key, i]))
  assert.equal(byKey['node.commit'].value, null); assert.equal(byKey['node.commit'].verified, false)
  assert.equal(byKey['node.execSecret'].value, 'set'); assert.ok(!JSON.stringify(m).includes('hunter2'))
  assert.equal(byKey['tick.env.TICK_SPOOL_PATH'].value, 'unset')
  assert.equal(byKey['db.fileBytes'].value, 1000); assert.equal(byKey['db.mount.freeBytes'].verified, true)
  assert.equal(byKey['cgroup.cpuMax'].value, null); assert.equal(byKey['cgroup.cpuMax'].verified, false)
  assert.equal(byKey['sidecar.demo.reachable'].value, true)
  assert.equal(byKey['sidecar.demo.accountCount'].value, 4)
  assert.equal(byKey['sidecar.demo.commit'].value, null); assert.equal(byKey['sidecar.demo.commit'].verified, false)
  assert.equal(byKey['sidecar.live.reachable'].value, false); assert.equal(byKey['sidecar.live.reachable'].note, 'no base url configured')
  assert.ok(m.unknown.includes('node.commit') && m.unknown.includes('cgroup.cpuMax') && m.unknown.includes('sidecar.demo.commit'))
  assert.equal(m.verified + m.unknown.length, m.items.length)
  for (const i of m.items) assert.ok('key' in i && 'value' in i && 'source' in i && typeof i.verified === 'boolean')
})

test('the manifest says whether the running SQLite carries the WAL-reset fix, and the locking mode a second connection depends on', async () => {
  const opts = { env: {}, cgroupRoot: '/nonexistent-cgroup', fetcher: async () => { throw new Error('offline') } }
  // The real library, through the production open.
  const db = initDB(':memory:')
  let byKey = Object.fromEntries((await runtimeManifest(db, opts)).items.map(i => [i.key, i]))
  assert.equal(byKey['sqlite.walResetFixed'].value, true, `runtime ${byKey['sqlite.version'].value}`)
  assert.equal(byKey['sqlite.walResetFixed'].verified, true)
  assert.equal(byKey['sqlite.walResetFixed'].note, null)
  assert.equal(byKey['sqlite.lockingMode'].value, 'normal')
  // A connection reporting production's pre-bump runtime in the degraded mode.
  const old = {
    prepare: sql => ({ get: () => ({ v: /sqlite_version/.test(sql) ? '3.49.2' : 'src-id' }) }),
    pragma: name => (name === 'locking_mode' ? 'exclusive' : name === 'journal_mode' ? 'wal' : 2),
  }
  byKey = Object.fromEntries((await runtimeManifest(old, opts)).items.map(i => [i.key, i]))
  assert.equal(byKey['sqlite.version'].value, '3.49.2')
  assert.equal(byKey['sqlite.walResetFixed'].value, false)
  assert.equal(byKey['sqlite.walResetFixed'].verified, true)
  assert.match(byKey['sqlite.walResetFixed'].note, /second writing connection .*refused/)
  assert.equal(byKey['sqlite.lockingMode'].value, 'exclusive')
  assert.match(byKey['sqlite.lockingMode'].note, /no second connection/)
  // Unreadable is unknown, never true or false.
  const blind = { prepare() { throw new Error('closed') }, pragma() { throw new Error('closed') } }
  const m = await runtimeManifest(blind, opts)
  byKey = Object.fromEntries(m.items.map(i => [i.key, i]))
  assert.deepEqual([byKey['sqlite.walResetFixed'].value, byKey['sqlite.walResetFixed'].verified], [null, false])
  assert.ok(m.unknown.includes('sqlite.walResetFixed') && m.unknown.includes('sqlite.lockingMode'))
})

test('V3 R1: each sidecar\'s own recorder is in the manifest, and Node\'s unset TICK_SPOOL_PATH no longer reads as "tick engine not configured"', async () => {
  const db = initDB(':memory:')
  // Production's shape at 25-09-2026 16:48 UTC: both sidecars RECORDING while
  // Node's own environment has no TICK_SPOOL_PATH (it never needs one).
  const health = {
    'http://demo:8091': { bootId: 'bd', connected: true, tick: { enabled: true, recording: true, state: 'RECORDING', events: 8_710_918, segmentsSealed: 5, sealedBytes: 671_088_720, openBytes: 12_892_744, diskAvailBytes: 47_338_317_872, usagePct: 3, symbols: 53 } },
    'http://live:8091': { bootId: 'bl', connected: true, tick: null, commit: 'abc1234' },
  }
  const fetcher = async (url) => { const h = health[url.replace(/\/health$/, '')]; return h ? { ok: true, status: 200, json: async () => h } : { ok: false, status: 404 } }
  const env = { EXEC_URL_DEMO: 'http://demo:8091', EXEC_URL_LIVE: 'http://live:8091', EXEC_SECRET: 's' }
  const m = await runtimeManifest(db, { env, cgroupRoot: '/nonexistent-cgroup', fetcher })
  const byKey = Object.fromEntries(m.items.map(i => [i.key, i]))
  assert.equal(byKey['sidecar.demo.recorder'].verified, true)
  assert.deepEqual(
    [byKey['sidecar.demo.recorder'].value.state, byKey['sidecar.demo.recorder'].value.recording, byKey['sidecar.demo.recorder'].value.segmentsSealed, byKey['sidecar.demo.recorder'].value.sealedBytes],
    ['RECORDING', true, 5, 671_088_720], 'RED if sidecarFacts drops /health.tick again')
  assert.deepEqual(byKey['sidecar.live.recorder'].value, { enabled: false })
  assert.match(byKey['sidecar.live.recorder'].note, /no TICK_SPOOL_PATH on this sidecar/)
  // the commit is read when a build reports it, and stays "not reported" otherwise
  assert.deepEqual([byKey['sidecar.live.commit'].value, byKey['sidecar.live.commit'].verified], ['abc1234', true])
  assert.deepEqual([byKey['sidecar.demo.commit'].value, byKey['sidecar.demo.commit'].verified], [null, false])
  // Node's env: still reported, no longer presented as the engine's state
  assert.equal(byKey['tick.env.TICK_SPOOL_PATH'].value, 'unset')
  assert.doesNotMatch(byKey['tick.env.TICK_SPOOL_PATH'].note, /tick engine not configured/)
  assert.match(byKey['tick.env.TICK_SPOOL_PATH'].note, /Node's environment only/)
  // an older build with no tick field at all is "not reported", not "disabled"
  const older = await sidecarFacts('http://x', { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ bootId: 'b' }) }) })
  assert.equal('recorder' in older, false)
})

test('R1 (rebuild): the recorder facts carry the cap the sidecar holds and where it came from (GW-CAP), and an unreported field is null, never 0', () => {
  // Production's /health.tick on cpp-acct, 25-09-2026 22:49 UTC: 5 GiB from the environment on the new volume.
  const r = recorderFacts({ enabled: true, recording: true, state: 'RECORDING', segmentsSealed: 0, sealedBytes: 0, openBytes: 254_464, diskAvailBytes: 48_871_976_200, usagePct: 0, symbols: 53,
    limits: { spoolCapBytes: 5_368_709_120, spoolCapSource: 'env', fitsMount: true, segmentBytes: 67_108_864 } })
  assert.deepEqual([r.spoolCapBytes, r.spoolCapSource, r.fitsMount], [5_368_709_120, 'env', true], 'RED if the reported cap is dropped from the manifest')
  assert.deepEqual([r.segmentsSealed, r.sealedBytes, r.usagePct], [0, 0, 0], 'a reported 0 stays 0')
  // An older build: no limits object, and a field sent as null.
  const old = recorderFacts({ enabled: true, recording: true, state: 'RECORDING', segmentsSealed: null, sealedBytes: 5 })
  assert.deepEqual([old.spoolCapBytes, old.spoolCapSource, old.fitsMount], [null, null, null])
  assert.equal(old.segmentsSealed, null, 'RED if a null the sidecar sent becomes a fake 0')
  assert.equal(old.diskAvailBytes, null)
  // fitsMount null (mount unmeasured) is not read as false.
  assert.equal(recorderFacts({ limits: { fitsMount: null } }).fitsMount, null)
})
