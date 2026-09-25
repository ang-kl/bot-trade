// agent/services/watchdog-contract-entry-diagnostics.test.js — V3 C4
// (SEQUENCE PR-4, WP-B B2 + WP-C PR-C1): what the tick receipt and the entry
// diagnostics add to the Node watchdog contract must never fail it, empty it
// or push it past the bounds cpp-verify enforces (256 KiB contract, 96 KiB of
// calendars, 2048 work lookups).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { nodeWatchdogContract, CONTRACT_MAX_BYTES } from './watchdog-contract.js'
import { ENTRY_DIAGNOSTICS_MAX_BYTES } from './blocker-report.js'
import { recordMarketCalendar } from './market-calendar.js'
import { recordScannerWork } from './scanner-work.js'
import { recordTickEntryWork } from './tick-entry-work.js'

const now = Date.parse('2026-09-22T06:00:00Z')
const size = value => Buffer.byteLength(JSON.stringify(value))
function fixture(t, accounts = ['11', '22']) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const [i, id] of accounts.entries()) db.prepare('INSERT INTO accounts (account_id,is_live,enabled) VALUES (?,?,1)').run(id, i % 2)
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: false }))
  return db
}
const position = db => db.prepare("INSERT INTO monitored_positions (symbol,account_id,source,created_at,paused) VALUES ('EURUSD','11','autopilot',?,0)").run(new Date(now - 60_000).toISOString())

test('the contract carries entry diagnostics for every registry account, complete in the healthy case', t => {
  const db = fixture(t)
  db.prepare("INSERT INTO decision_log (account_id,stage,decision,reason,created_at) VALUES ('11','stage_matrix','skip','strategy off',?)").run(new Date(now - 60_000).toISOString())
  const d = nodeWatchdogContract(db, { now }).entryDiagnostics
  assert.equal(d.complete, true)
  assert.equal(d.source, 'node_records')
  assert.deepEqual(d.accounts.map(a => a.accountId), ['11', '22'])
  assert.deepEqual(d.accounts[0].bases, ['bar'])
  assert.equal(d.accounts[0].tick.status, 'not_evaluated')
  assert.equal(d.accounts[0].tick.checks.profile_pinned.ok, false)
  assert.equal(d.accounts[0].dominantRefusal.stage, 'stage_matrix')
  assert.equal(d.accounts[1].environment, 'live')
})

test('a failing diagnostics read never fails or empties the contract; the entry_activity blocker names its own failure', t => {
  const db = fixture(t)
  position(db)
  setState(db, 'symbol_id_map:11', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 7 } }))
  recordMarketCalendar(db, { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' },
    { symbolId: 7, scheduleTimeZone: 'UTC', schedule: [{ startSecond: 21 * 3600, endSecond: 5 * 86400 + 21 * 3600 }], holiday: [] }, { nowMs: now - 1000 })
  recordScannerWork(db, { creds: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', ready: true }, scopeAccounts: ['11'], symbolMap: { EURUSD: 7 },
    result: { scans: [{ symbol: 'EURUSD' }], errors: [], coverage: { scanned: 1, total: 1 } }, completedAt: now - 500, nextDue: now + 300_000 })
  db.exec('DROP TABLE cpp_decisions')
  const out = nodeWatchdogContract(db, { now })
  assert.equal(out.workComplete, true)
  assert.ok(out.work.some(w => w.role === 'management'), 'management work is still published')
  const activity = out.work.find(w => w.role === 'entry_activity')
  assert.equal(activity.ordersSinceOpen, 0, 'the activity evidence does not depend on the blocker read')
  assert.equal(activity.blocker, 'blocker_report_unavailable')
  assert.equal(out.entryDiagnostics.complete, false)
  assert.equal(out.entryDiagnostics.reason, 'entry_diagnostics_unavailable', 'RED if the try/catch around the diagnostics is dropped (the whole contract throws)')
})

test('over its own 32 KiB bound the diagnostics block is explicitly incomplete, with work intact', t => {
  const accounts = Array.from({ length: 64 }, (_, i) => String(10_000 + i))
  const db = fixture(t, accounts)
  position(db)
  const log = db.prepare("INSERT INTO decision_log (account_id,stage,decision,reason,created_at) VALUES (?,'stage_matrix','skip',?,?)")
  for (const id of accounts) log.run(id, 'r'.repeat(180), new Date(now - 60_000).toISOString())
  const out = nodeWatchdogContract(db, { now })
  assert.equal(out.entryDiagnostics.complete, false)
  assert.equal(out.entryDiagnostics.reason, 'entry_diagnostics_size_bound')
  assert.deepEqual(out.entryDiagnostics.accounts, [])
  assert.ok(size(out.entryDiagnostics) < ENTRY_DIAGNOSTICS_MAX_BYTES)
  assert.equal(out.workComplete, true); assert.ok(out.work.length > 0)
})

test('at the 256 KiB contract bound the diagnostics are dropped FIRST, before work is emptied', t => {
  const accounts = Array.from({ length: 24 }, (_, i) => String(20_000 + i))
  const db = fixture(t, ['11', ...accounts])
  const log = db.prepare("INSERT INTO decision_log (account_id,stage,decision,reason,created_at) VALUES (?,'stage_matrix','skip',?,?)")
  for (const id of accounts) log.run(id, 'q'.repeat(180), new Date(now - 60_000).toISOString())
  // Measure, then fill `work` with management items until the contract WITH
  // the diagnostics is over the bound but the contract without them is not.
  for (let i = 0; i < 20; i++) position(db)
  let out = nodeWatchdogContract(db, { now })
  const diag = size(out.entryDiagnostics), perPosition = size(out.work[0]) + 1
  assert.equal(out.entryDiagnostics.complete, true)
  assert.ok(diag > 8 * 1024, `the diagnostics must be large enough to decide the bound (${diag} B)`)
  const target = CONTRACT_MAX_BYTES + Math.floor(diag / 2) // over WITH the diagnostics, under WITHOUT them
  const add = Math.floor((target - size(out)) / perPosition)
  for (let i = 0; i < add; i++) position(db)
  out = nodeWatchdogContract(db, { now })
  assert.equal(out.entryDiagnostics.reason, 'contract_size_bound', 'RED if the diagnostics are not dropped first')
  assert.equal(out.workComplete, true, 'work survives because the diagnostics went first')
  assert.ok(out.work.length > 20)
  assert.ok(size(out) <= CONTRACT_MAX_BYTES)
})

test('realistic load: 7 dual accounts × 56 tick names plus the bar receipt stay inside every bound', t => {
  const accounts = ['42993489', '43002148', '43069009', '43097342', '46130058', '46979908', '47790949']
  const db = fixture(t, accounts)
  const tickNames = Array.from({ length: 56 }, (_, i) => `TICK${i}`)
  const barNames = Array.from({ length: 59 }, (_, i) => i < 30 ? `TICK${i}` : `BAR${i}`)
  const schedules = [
    { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 21 * 3600, endSecond: 5 * 86400 + 21 * 3600 }] },
    { scheduleTimeZone: 'UTC', schedule: [0, 1, 2, 3, 4].map(d => ({ startSecond: d * 86400 + 22 * 3600, endSecond: d * 86400 + 22 * 3600 + 23 * 3600 })) },
    { scheduleTimeZone: 'UTC', schedule: [1, 2, 3, 4, 5].map(d => ({ startSecond: d * 86400 + 1 * 3600, endSecond: d * 86400 + 20 * 3600 })) },
  ]
  const names = [...new Set([...tickNames, ...barNames])]
  for (const [n, id] of accounts.entries()) {
    const map = Object.fromEntries(names.map((s, i) => [s, 1000 * (n + 1) + i]))
    setState(db, `symbol_id_map:${id}`, JSON.stringify({ builtAt: new Date(now).toISOString(), map }))
    for (const [i, s] of names.entries()) {
      recordMarketCalendar(db, { provider: 'ctrader', host: n % 2 ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', accountId: id, symbolId: String(map[s]) },
        { symbolId: map[s], ...schedules[i % schedules.length], holiday: [] }, { nowMs: now - 1000 })
    }
  }
  for (let i = 0; i < 32; i++) db.prepare("INSERT INTO monitored_positions (symbol,account_id,source,created_at,paused) VALUES (?,?,'autopilot',?,0)").run(names[i], accounts[i % 7], new Date(now - 60_000).toISOString())
  const feed = accounts[4]
  const feedMap = Object.fromEntries(names.map((s, i) => [s, 5000 + i]))
  recordScannerWork(db, { creds: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: feed, ready: true }, scopeAccounts: accounts, symbolMap: feedMap,
    result: { scans: barNames.map(symbol => ({ symbol })), errors: [], coverage: { scanned: 59, total: 59 } }, completedAt: now - 500, nextDue: now + 300_000 })
  // The demo pass is newer than the bar batch (its accounts are judged on tick),
  // the live pass older (bar); both are complete, so every pair is looked up.
  for (const [sideName, ids, completedAt] of [['cpp_exec_demo', accounts.filter((_, i) => i % 2 === 0), now - 200], ['cpp_exec', accounts.filter((_, i) => i % 2 === 1), now - 10_000]]) {
    recordTickEntryWork(db, { side: { name: sideName }, creds: { ready: true }, accounts: ids, completedAt,
      result: { pushed: true, carried: tickNames, work: ids.map(accountId => ({ accountId, permits: 0, paused: 'account_pregate:daily_loss', firstRefusal: null, refused: [] })) } })
  }
  const t0 = performance.now()
  const out = nodeWatchdogContract(db, { now })
  const ms = performance.now() - t0
  assert.ok(size(out) < CONTRACT_MAX_BYTES, `contract ${size(out)} B`)
  assert.equal(out.workComplete, true)
  assert.equal(out.work.some(w => w.inventoryComplete === false), false, 'the 2048 lookup bound holds (59 × 8 bar + 56 × 7 tick)')
  assert.ok(size(out.calendars) <= 96 * 1024, `calendars ${size(out.calendars)} B`)
  assert.equal(out.entryDiagnostics.complete, true)
  const activity = out.work.filter(w => w.role === 'entry_activity')
  assert.deepEqual([...new Set(activity.map(w => w.accountId))].sort(), [...accounts].sort(), 'every dual account has entry_activity')
  assert.ok(activity.some(w => w.basis === 'tick') && activity.some(w => w.basis === 'bar'))
  assert.ok(ms < 15_000, `built in ${Math.round(ms)} ms, inside the watchdog worker's 15 s deadline`)
  const byRole = {}; for (const w of out.work) byRole[w.role] = (byRole[w.role] || 0) + size(w)
  t.diagnostic(`contract ${size(out)} B, work ${out.work.length} (${JSON.stringify(byRole)}), entry_activity ${activity.length}, calendars ${size(out.calendars)} B, diagnostics ${size(out.entryDiagnostics)} B, built in ${Math.round(ms)} ms`)
})
