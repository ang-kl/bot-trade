import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { initDB, setState } from '../db.js'
import { nodeWatchdogContract } from './watchdog-contract.js'
import { recordMarketCalendar } from './market-calendar.js'
import { recordScannerWork } from './scanner-work.js'
import { readNodeWatchdogContract, readDecisionsDaily, readLatestPrices, readPerformancePopulations } from './performance-populations.js'

const now = Date.parse('2026-09-22T06:00:00Z'), host = 'demo.ctraderapi.com'
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-report-'))
  const db = initDB(join(dir, 'fixture.db'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('11', 0)
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('22', 1)
  setState(db, 'symbol_id_map:11', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 7 } }))
  const feed = { provider: 'ctrader', host, accountId: '11', symbolId: '7' }
  recordMarketCalendar(db, feed, { symbolId: 7, scheduleTimeZone: 'UTC',
    schedule: [{ startSecond: 21 * 3600, endSecond: 5 * 86400 + 21 * 3600 }], holiday: [] }, { nowMs: now - 1000 })
  const put = db.prepare("INSERT INTO monitored_positions(symbol,account_id,source,created_at,paused) VALUES ('EURUSD',?,?,?,?)")
  for (const [account, source, paused] of [['11', 'autopilot', 0], ['22', 'autopilot', 0], ['11', 'external', 0], ['11', 'autopilot', 1]]) {
    put.run(account, source, new Date(now - 120000).toISOString(), paused)
  }
  setState(db, 'fast_monitor_position_work_json', JSON.stringify({ at: new Date(now - 500).toISOString(), positions: [
    { accountId: '11', positionId: 1, state: 'evaluated', lastCompletedAt: new Date(now - 2000).toISOString(), nextDueAt: new Date(now + 2000).toISOString() },
  ] }))
  recordScannerWork(db, { creds: { ...feed, ready: true }, scopeAccounts: ['11', '22'], symbolMap: { EURUSD: 7 },
    result: { scans: [{ symbol: 'EURUSD' }], errors: [], coverage: { scanned: 1, total: 7 } }, completedAt: now - 500, nextDue: now + 300000 })
  db.prepare("INSERT INTO decision_log(account_id,stage,decision,reason,created_at) VALUES ('11','margin_pool','skip','fixture blocker',?)").run(new Date(now - 1000).toISOString())
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: false, quiet: { start: '13:00', end: '15:00' }, tz: 'Asia/Singapore', urgentBypass: false }))
  setState(db, 'watchdog_incident_owner', 'cpp-verify')
  return db
}

test('read-only worker preserves exact account, calendar, activity, ownership and notification evidence', async t => {
  const db = fixture(t)
  const before = db.prepare('SELECT * FROM agent_state ORDER BY key').all()
  const direct = nodeWatchdogContract(db, { now })
  assert.deepEqual(await readNodeWatchdogContract(db, { now }), direct)
  assert.equal(direct.work.find(w => w.role === 'entry_activity').ordersSinceOpen, 0)
  assert.equal(direct.work.find(w => w.accountId === '22').calendar, null)
  assert.equal(direct.work.find(w => w.id === 'position:1').lastCompletedAtMs, now - 2000)
  assert.equal(direct.work.some(w => w.id === 'position:3' || w.id === 'position:4'), false)
  assert.equal(direct.notificationPolicy.owner, 'cpp-verify')
  assert.equal(direct.notificationPolicy.enabled, false)
  assert.deepEqual(db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before)
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})

test('dashboard saturation leaves one coalesced watchdog flight, without unbounded extra workers', async t => {
  const db = fixture(t)
  const firstReport = readDecisionsDaily(db), secondReport = readLatestPrices(db)
  const watchdog = readNodeWatchdogContract(db, { now })
  assert.equal(readNodeWatchdogContract(db, { now }), watchdog)
  const fullWatchdog = assert.rejects(readNodeWatchdogContract(db, { now: now + 1 }), /watchdog_report_worker_capacity/)
  const fullReports = assert.rejects(readPerformancePopulations(db), /performance_report_worker_capacity/)
  const [, , contract] = await Promise.all([firstReport, secondReport, watchdog, fullWatchdog, fullReports])
  assert.equal(contract.service, 'node')
  assert.equal(contract.observedAtMs, now)
})

test('a locked database leaves the event loop responsive and never becomes healthy empty evidence', async t => {
  const db = fixture(t)
  db.pragma('journal_mode = DELETE')
  const lock = new Database(db.name)
  t.after(() => { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() })
  lock.exec('BEGIN EXCLUSIVE')
  let finished = false, ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  t.after(() => clearInterval(timer))
  const result = readNodeWatchdogContract(db, { now }).then(
    value => { finished = true; return { value } }, error => { finished = true; return { error } },
  )
  await delay(50)
  assert.equal(finished, false, 'the read is still waiting on the locked database')
  assert.ok(ticks > 0, 'management timers progress while SQLite waits in the worker')
  const failure = await result
  assert.equal(failure.value, undefined)
  assert.match(failure.error.message, /locked/)
  lock.exec('ROLLBACK')
})

test('watchdog dispatch counts seek the account instead of scanning retained decision history', t => {
  const db = fixture(t)
  const put = db.prepare('INSERT INTO decision_log(account_id,stage,decision,created_at) VALUES (?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) put.run('11', 'scan', 'proceed', '2026-09-20T22:00:00Z')
    for (const at of ['2026-09-20T21:00:00Z', '2026-09-21 00:00:00', '2026-09-21T08:00:00+08:00', '2026-09-22T06:00:00.000Z']) {
      put.run('11', 'dispatch', 'proceed', at)
    }
    for (const at of ['2026-09-20T20:59:59.999Z', '2026-09-22T06:00:00.001Z', 'invalid date']) {
      put.run('11', 'dispatch', 'proceed', at)
    }
    put.run('22', 'dispatch', 'proceed', '2026-09-21 00:00:00')
    put.run(null, 'dispatch', 'proceed', '2026-09-21 00:00:00')
    put.run('11', 'dispatch', 'skip', '2026-09-21 00:00:00')
  })()
  const queries = [], prepare = db.prepare
  db.prepare = function (sql) {
    if (/SELECT COUNT\(\*\) n FROM decision_log/.test(sql)) queries.push(sql)
    return prepare.call(this, sql)
  }
  let contract
  try { contract = nodeWatchdogContract(db, { now }) } finally { db.prepare = prepare }
  const activity = contract.work.find(w => w.role === 'entry_activity')
  assert.equal(activity.orderEvidence.dispatches, 4)
  assert.equal(activity.hasRecordedOrder, true)
  assert.equal(activity.ordersSinceOpen, null)
  assert.equal(queries.length, 1, 'inspect the statement the actual watchdog executed')
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all('11',
    new Date(activity.sessionOpenedAtMs).toISOString(), new Date(now + 1).toISOString())
  assert.ok(plan.some(row => /SEARCH decision_log .*account_id=\?/.test(row.detail)),
    `watchdog must seek the account's dispatch records: ${JSON.stringify(plan)}`)
  assert.ok(!plan.some(row => /SCAN decision_log/.test(row.detail)), 'unrelated retained decisions must not be scanned')
})

test('dispatch index upgrades an existing decision log without attributing its unassigned history', t => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-index-upgrade-')), path = join(dir, 'fixture.db')
  let db = initDB(path)
  t.after(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }) })
  // Recreate the prior production schema. decision_log has always declared
  // account_id; older/global receipts may leave its value NULL.
  db.exec('DROP INDEX idx_decision_log_dispatch_account')
  db.prepare("INSERT INTO decision_log(stage,decision,created_at) VALUES ('dispatch','proceed','2026-09-21 00:00:00')").run()
  db.close()
  db = initDB(path)
  assert.deepEqual(db.prepare('SELECT account_id,stage,decision,created_at FROM decision_log').all(), [
    { account_id: null, stage: 'dispatch', decision: 'proceed', created_at: '2026-09-21 00:00:00' },
  ])
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM decision_log WHERE account_id=? AND stage='dispatch' AND decision='proceed'").all('11')
  assert.ok(plan.some(row => /SEARCH decision_log .*account_id=\?/.test(row.detail)))
  db.close()
  db = initDB(path)
  assert.equal(db.prepare('SELECT count(*) n FROM decision_log WHERE account_id IS NULL').get().n, 1)
  assert.equal(db.prepare("SELECT count(*) n FROM decision_log WHERE account_id='11'").get().n, 0)
})
