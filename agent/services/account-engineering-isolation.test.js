import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { initDB, setState } from '../db.js'
import { readAccountEngineering, readLatestPrices, readPerformancePopulations, readNodeWatchdogContract } from './performance-populations.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engineering-worker-'))
  const db = initDB(join(dir, 'fixture.db'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('11', 0)
  setState(db, 'ctrader_account_id', '11')
  return db
}

test('account reports coalesce within the two report slots and preserve reserved watchdog capacity', async t => {
  const db = fixture(t)
  const account = readAccountEngineering(db)
  assert.equal(readAccountEngineering(db), account)
  const prices = readLatestPrices(db)
  const excess = assert.rejects(readPerformancePopulations(db), /performance_report_worker_capacity/)
  const watchdog = readNodeWatchdogContract(db, { now: Date.now() })
  const [report, , , contract] = await Promise.all([account, prices, excess, watchdog])
  assert.equal(report.accounts[0].accountId, '11')
  assert.equal(contract.service, 'node')
})

test('locked account report leaves management timers running and fails without fabricated account evidence', async t => {
  const db = fixture(t)
  db.pragma('journal_mode = DELETE')
  const lock = new Database(db.name)
  t.after(() => { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() })
  lock.exec('BEGIN EXCLUSIVE')
  let settled = false, ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  t.after(() => clearInterval(timer))
  const result = readAccountEngineering(db).then(
    value => { settled = true; return { value } },
    error => { settled = true; return { error } },
  )
  await delay(50)
  assert.equal(settled, false)
  assert.ok(ticks > 0, 'management callbacks continue while the separate reader waits')
  const failure = await result
  assert.equal(failure.value, undefined)
  assert.match(failure.error.message, /locked/)
  lock.exec('ROLLBACK')
})
