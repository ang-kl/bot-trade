// agent/services/scanner-work-tick.test.js — V3 C4 (SEQUENCE PR-4, WP-B B2d):
// entry_activity (and so cpp-verify's no_orders) for tick-only and dual
// accounts, judged on the newest COMPLETE work receipt, whether or not the
// bar scan ran. The bar items keep their ids and fields.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, setState } from '../db.js'
import { nodeWatchdogContract } from './watchdog-contract.js'
import { recordMarketCalendar } from './market-calendar.js'
import { recordScannerWork, scannerWork } from './scanner-work.js'
import { recordTickEntryWork } from './tick-entry-work.js'
import { readNodeWatchdogContract } from './performance-populations.js'

const now = Date.parse('2026-09-22T06:00:00Z')
const FX = { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 21 * 3600, endSecond: 5 * 86400 + 21 * 3600 }], holiday: [] }
function fixture(t, { disk = false } = {}) {
  const db = initDB(disk ? join(tempDir('scanner-work-tick-'), 'fixture.db') : ':memory:')
  t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('11', 0)
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('22', 1)
  setState(db, 'symbol_id_map:11', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 7 } }))
  setState(db, 'symbol_id_map:22', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 9 } }))
  recordMarketCalendar(db, { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' }, { symbolId: 7, ...FX }, { nowMs: now - 1000 })
  recordMarketCalendar(db, { provider: 'ctrader', host: 'live.ctraderapi.com', accountId: '22', symbolId: '9' }, { symbolId: 9, ...FX }, { nowMs: now - 1000 })
  return db
}
const tickPass = (db, { accounts = ['11'], completedAt = now - 10_000, pushed = true, error = null, work = null, sideName = 'cpp_exec_demo' } = {}) =>
  recordTickEntryWork(db, { side: { name: sideName }, creds: { ready: true }, accounts, completedAt,
    result: { pushed, error, carried: ['EURUSD'], work: work ?? accounts.map(accountId => ({ accountId, permits: 2, paused: null, firstRefusal: null, refused: [] })) } })
const barPass = (db, { completedAt = now - 500, nextDue = now + 300_000, scope = ['11'], deadlineHit = false } = {}) =>
  recordScannerWork(db, { creds: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', ready: true }, scopeAccounts: scope, symbolMap: { EURUSD: 7 },
    result: { scans: [{ symbol: 'EURUSD' }], errors: [], coverage: { scanned: 1, total: 7 }, deadlineHit }, completedAt, nextDue })
const activity = (db, at = now) => nodeWatchdogContract(db, { now: at }).work.filter(w => w.role === 'entry_activity')

test('a tick-only account gets entry_activity with no bar receipt at all; the read writes nothing', t => {
  const db = fixture(t)
  tickPass(db)
  const before = db.prepare('SELECT * FROM agent_state ORDER BY key').all()
  const items = activity(db)
  assert.equal(items.length, 1, 'RED if scannerWork still returns [] without the bar receipt')
  const [a] = items
  assert.equal(a.accountId, '11'); assert.equal(a.basis, 'tick')
  assert.equal(a.activityComplete, true); assert.equal(a.ordersSinceOpen, 0)
  assert.equal(a.lastCompletedAtMs, now - 10_000); assert.equal(a.nextDueMs, now + 110_000)
  assert.equal(a.scanCoverage, null)
  assert.deepEqual(a.tickPass, { side: 'cpp_exec_demo', permits: 2, paused: null, firstRefusal: null })
  assert.equal(a.reason, 'retained_account_activity_after_completed_tick_permit_pass')
  assert.equal(a.id, `entry-activity:11:${a.sessionId}`, 'the id shape cpp-verify keys its incidents on is unchanged')
  assert.equal(typeof a.blocker, 'string')
  assert.equal(nodeWatchdogContract(db, { now }).work.some(w => w.role === 'scanner'), false, 'no bar receipt, no legacy-scan item')
  assert.deepEqual(db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before, 'read-only')
})

test('freshest COMPLETE receipt wins for a dual account: a fresh tick pass beats a stale bar batch', t => {
  const db = fixture(t)
  barPass(db, { completedAt: now - 600_000, nextDue: now - 300_000 })
  tickPass(db, { completedAt: now - 10_000 })
  const items = activity(db)
  assert.equal(items.length, 1, 'one item per (account, session)')
  assert.equal(items[0].basis, 'tick', 'RED if the bar receipt is taken first unconditionally (a stale nextDue would never let cpp-verify raise no_orders)')
  assert.equal(items[0].nextDueMs, now + 110_000)
})

test('an INCOMPLETE newer tick pass does not suppress a complete bar batch; with no complete source the item reports no observed zero', t => {
  const db = fixture(t)
  barPass(db, { completedAt: now - 60_000, nextDue: now + 240_000 })
  tickPass(db, { completedAt: now - 10_000, pushed: false, error: 'sidecar refused the tick permit push' })
  let [a] = activity(db)
  assert.equal(a.basis, 'bar', 'RED if the newest source wins regardless of completeness')
  assert.equal(a.activityComplete, true); assert.equal(a.ordersSinceOpen, 0)
  // no complete source at all: the newest speaks, and it is not an observed zero
  barPass(db, { completedAt: now - 60_000, nextDue: now + 240_000, deadlineHit: true })
  ;[a] = activity(db)
  assert.equal(a.basis, 'tick')
  assert.equal(a.activityComplete, false); assert.equal(a.ordersSinceOpen, null)
})

test('the tick refusal reason rides the item and its blocker line; a paused account still reports completed work', t => {
  const db = fixture(t)
  db.prepare("INSERT INTO decision_log(account_id,stage,decision,reason,created_at) VALUES ('11','margin_pool','skip','free margin exhausted',?)").run(new Date(now - 1000).toISOString())
  tickPass(db, { work: [{ accountId: '11', permits: 0, paused: 'account_pregate:daily_loss', firstRefusal: null, refused: [] }] })
  const [a] = activity(db)
  assert.equal(a.tickPass.paused, 'account_pregate:daily_loss')
  assert.equal(a.activityComplete, true, 'a pause is a completed pass that stopped the account, not missing work')
  assert.equal(a.blocker, 'tick permits paused: account_pregate:daily_loss; margin_pool ×1 of 1 entry stops since session open; latest margin_pool: free margin exhausted')
})

test('a tick receipt older than 360 s emits nothing, and neither does one for an unregistered account', t => {
  const db = fixture(t)
  tickPass(db, { completedAt: now - 360_000 })
  assert.equal(activity(db).length, 0)
  tickPass(db, { accounts: ['99'] })
  assert.equal(activity(db).length, 0)
})

test('bar items keep their ids and fields; tick lookups can never crowd the bar legacy-scan items out of the 2048 bound', t => {
  const db = fixture(t)
  barPass(db, { scope: ['11', '22'] })
  const work = nodeWatchdogContract(db, { now }).work
  const legacy = work.filter(w => w.role === 'scanner')
  assert.deepEqual(legacy.map(w => [w.id, w.outcome, w.lastCompletedAtMs]), [['legacy-scan:11:7', 'batch_evaluated', now - 500]])
  const bar = work.filter(w => w.role === 'entry_activity')
  assert.deepEqual(bar.map(w => [w.accountId, w.basis, w.reason, w.lastCompletedAtMs, w.nextDueMs, w.activityComplete, w.ordersSinceOpen]), [
    ['11', 'bar', 'retained_account_activity_after_completed_scan_batch', now - 500, now + 300_000, true, 0],
    ['22', 'bar', 'retained_account_activity_after_completed_scan_batch', now - 500, now + 300_000, true, 0],
  ])
  assert.deepEqual(bar[0].scanCoverage, { scanned: 1, total: 7 })
  assert.equal(bar[0].tickPass, undefined)
  // 512 tick names × 4 accounts = 2048 more lookups: the bound trips, but only after every bar legacy-scan item
  const names = Array.from({ length: 512 }, (_, i) => `SYM${i}`)
  recordTickEntryWork(db, { side: { name: 'cpp_exec_demo' }, creds: { ready: true }, accounts: ['91', '92', '93', '94'], completedAt: now - 10_000,
    result: { pushed: true, carried: names, work: [] } })
  const capped = scannerWork(db, new Map([['11', { is_live: 0 }], ['22', { is_live: 1 }]]), now)
  assert.equal(capped.filter(w => w.role === 'scanner').length, 1)
  assert.equal(capped.at(-1).id, 'legacy-inventory-capacity'); assert.equal(capped.at(-1).inventoryComplete, false)
})

test('the read-only watchdog worker builds the same contract as the direct build with a tick receipt present', async t => {
  const db = fixture(t, { disk: true })
  barPass(db)
  tickPass(db, { accounts: ['11', '22'] })
  const direct = nodeWatchdogContract(db, { now })
  assert.deepEqual(await readNodeWatchdogContract(db, { now }), direct)
  // 11: both complete, the bar batch (now - 500) is newer than the tick pass (now - 10 s); 22 is outside the bar scope.
  assert.deepEqual(direct.work.filter(w => w.role === 'entry_activity').map(w => [w.accountId, w.basis]).sort(), [['11', 'bar'], ['22', 'tick']])
})
