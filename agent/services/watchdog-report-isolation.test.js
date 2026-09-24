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
