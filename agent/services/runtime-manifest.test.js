// agent/services/runtime-manifest.test.js — a measurement that says "unknown"
// where it cannot read, and never a number it did not take.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { mkdtempSync } from '../test-support/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDB } from '../db.js'
import { runtimeManifest, sqliteRuntime, cgroupLimits, sidecarFacts } from './runtime-manifest.js'

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
