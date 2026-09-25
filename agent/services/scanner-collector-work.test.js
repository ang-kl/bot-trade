// agent/services/scanner-collector-work.test.js — V3 CV-1 (SEQUENCE PR-6).
// cpp-scan-timeframe now lists only work that is due, so an idle cell has no
// deadline for cpp-verify; the liveness of the timeframe mirror's INPUT is
// this Node work item, which goes stale when the bridge worker's collector
// stops recording rounds. cpp-verify's side (role 'collector': calendar-free,
// a warning stall at nextDueMs + service grace) is test_watchdog.cpp.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync } from '../test-support/temp-dir.js'
import { tmpdir } from 'node:os'
import { initDB, setState } from '../db.js'
import { scannerCollectorWork, COLLECTOR_DUE_MS } from './scanner-work.js'
import { nodeWatchdogContract } from './watchdog-contract.js'

const now = Date.parse('2026-09-25T15:00:00Z'), startedAtMs = now - 600_000
const ON = { SCANNER_BRIDGE_ENABLED: '1' }
const profile = { source: 'cpp-scan-timeframe', feed: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '46130058', symbolId: '1' },
  strategy: 'donchian_breakout', timeframe: '1h', configVersion: 'tf-v1', profileHash: 'x', candidateTtlMs: 3600000 }
function fileDb(t, profiles = [profile]) {
  const db = initDB(join(mkdtempSync(join(tmpdir(), 'collector-work-')), 'agent.db')); t.after(() => db.close())
  if (profiles) setState(db, 'scanner_mirror_profiles_json', JSON.stringify(profiles))
  return db
}

test('no item while the bridge gate is closed: an unconfigured bridge is not a stalled one', t => {
  assert.deepEqual(scannerCollectorWork(fileDb(t), now, { env: {}, startedAtMs }), [], 'flag unset')
  assert.deepEqual(scannerCollectorWork(fileDb(t, null), now, { env: ON, startedAtMs }), [], 'no registered profiles')
  assert.deepEqual(scannerCollectorWork(fileDb(t, []), now, { env: ON, startedAtMs }), [], 'an empty registry')
  const memory = initDB(':memory:'); t.after(() => memory.close())
  setState(memory, 'scanner_mirror_profiles_json', JSON.stringify([profile]))
  assert.deepEqual(scannerCollectorWork(memory, now, { env: ON, startedAtMs }), [], 'the bridge never runs on an in-memory database')
})

test('gate open and no round yet: the deadline runs from process start, and passing it is reachable', t => {
  const [item] = scannerCollectorWork(fileDb(t), now, { env: ON, startedAtMs })
  assert.equal(item.role, 'collector')
  assert.equal(item.id, 'scanner-bridge:collector')
  assert.equal(item.lastCompletedAtMs, null)
  assert.equal(item.nextDueMs, startedAtMs + COLLECTOR_DUE_MS)
  assert.equal(item.blocker, 'no_collector_round_since_process_start')
  // Nothing moves the deadline while no round is recorded: cpp-verify's
  // stall (nextDueMs + 60 s grace) is reached, not deferred forever.
  const later = scannerCollectorWork(fileDb(t), now + 3_600_000, { env: ON, startedAtMs })[0]
  assert.equal(later.nextDueMs, item.nextDueMs)
  assert.ok(now + 3_600_000 >= later.nextDueMs + 60_000)
})

test('each recorded round moves the deadline; a round from before this process does not count', t => {
  const db = fileDb(t)
  setState(db, 'scanner_bridge_poll_json', JSON.stringify({ readAtMs: now - 1000, durationMs: 12, tickBacklog: false }))
  let [item] = scannerCollectorWork(db, now, { env: ON, startedAtMs })
  assert.equal(item.lastCompletedAtMs, now - 1000)
  assert.equal(item.nextDueMs, now - 1000 + COLLECTOR_DUE_MS)
  assert.equal(item.blocker, null)
  assert.equal(item.durationMs, 12)
  setState(db, 'scanner_bridge_poll_json', JSON.stringify({ readAtMs: now - 1000, error: 'comparison_read_or_contract_failed', lastError: { error: 'comparison_read_or_contract_failed', atMs: now - 1000 } }))
  assert.equal(scannerCollectorWork(db, now, { env: ON, startedAtMs })[0].blocker, 'comparison_read_or_contract_failed')
  setState(db, 'scanner_bridge_poll_json', JSON.stringify({ readAtMs: now - 1000, lastError: { error: 'old', atMs: now - COLLECTOR_DUE_MS } }))
  assert.equal(scannerCollectorWork(db, now, { env: ON, startedAtMs })[0].blocker, null, 'an old error riding the record is not named')
  setState(db, 'scanner_bridge_poll_json', JSON.stringify({ readAtMs: startedAtMs - 1 }))
  ;[item] = scannerCollectorWork(db, now, { env: ON, startedAtMs })
  assert.equal(item.lastCompletedAtMs, null)
  assert.equal(item.nextDueMs, startedAtMs + COLLECTOR_DUE_MS)
  assert.equal(item.blocker, 'no_collector_round_since_process_start')
})

test('the Node watchdog contract carries the collector item, and it keeps the contract complete', t => {
  const db = fileDb(t)
  setState(db, 'scanner_bridge_poll_json', JSON.stringify({ readAtMs: now - 1000 }))
  const on = nodeWatchdogContract(db, { now, env: ON, startedAtMs })
  const item = on.work.find(w => w.role === 'collector')
  assert.equal(item?.nextDueMs, now - 1000 + COLLECTOR_DUE_MS)
  assert.equal(on.workComplete, true)
  assert.equal(nodeWatchdogContract(db, { now, env: {}, startedAtMs }).work.some(w => w.role === 'collector'), false)
})
