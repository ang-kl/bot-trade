import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { buildHeavyStateReport, readHeavyStateReport } from './heavy-state-reports.js'

function fixture(t, memory = true) {
  const dir = memory ? null : mkdtempSync(join(tmpdir(), 'heavy-state-'))
  const db = new Database(memory ? ':memory:' : join(dir, 'state.db'))
  t.after(() => { db.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  db.exec(`
    CREATE TABLE risk_events(id INTEGER PRIMARY KEY, account_id TEXT, created_at TEXT, approved INTEGER, repeat_count INTEGER, proposal_json TEXT);
    CREATE TABLE scans(id INTEGER PRIMARY KEY, symbol TEXT, price REAL, bias TEXT, confidence REAL, scanned_at TEXT);
    CREATE TABLE analyses(id INTEGER PRIMARY KEY, strategy TEXT, auto_trade INTEGER, analyzed_at TEXT);
    CREATE TABLE trades(id INTEGER PRIMARY KEY, status TEXT, closed_at TEXT, label_strategy TEXT, strategy TEXT, net_pnl REAL, gross_pnl REAL);
    CREATE TABLE agent_state(key TEXT PRIMARY KEY, value TEXT);
  `)
  return db
}

test('decisions report preserves account scope and repeated veto counts', t => {
  const db = fixture(t)
  db.prepare("INSERT INTO risk_events(account_id,created_at,approved,repeat_count) VALUES(?,datetime('now'),?,?)").run('A', 0, 3)
  db.prepare("INSERT INTO risk_events(account_id,created_at,approved,repeat_count) VALUES(?,datetime('now'),?,?)").run('B', 1, 1)
  const all = buildHeavyStateReport(db, 'decisions-daily', { days: 7 })
  assert.equal(all.rows[0].approved, 1); assert.equal(all.rows[0].vetoed, 3)
  const a = buildHeavyStateReport(db, 'decisions-daily', { days: 7, accountId: 'A' })
  assert.equal(a.rows[0].approved, 0); assert.equal(a.rows[0].vetoed, 3)
})

test('prices report returns exactly the latest priced row per symbol', t => {
  const db = fixture(t)
  const put = db.prepare('INSERT INTO scans(symbol,price,bias,confidence,scanned_at) VALUES(?,?,?,?,?)')
  put.run('EURUSD', 1.1, 'up', .7, '2026-09-23T00:00:00Z')
  put.run('EURUSD', null, 'down', .2, '2026-09-23T00:01:00Z')
  put.run('EURUSD', 1.2, 'up', .8, '2026-09-23T00:02:00Z')
  assert.deepEqual(buildHeavyStateReport(db, 'prices').prices.EURUSD,
    { price: 1.2, bias: 'up', confidence: .8, at: '2026-09-23T00:02:00Z' })
})

test('stage stats preserve scan, trade and manage attribution', t => {
  const db = fixture(t)
  db.prepare("INSERT INTO analyses(strategy,auto_trade,analyzed_at) VALUES('fib_618_fade',1,datetime('now'))").run()
  db.prepare("INSERT INTO risk_events(account_id,created_at,approved,repeat_count,proposal_json) VALUES('A',datetime('now'),0,2,'{\"strategy\":\"fib_618_fade\"}')").run()
  db.prepare("INSERT INTO trades(status,closed_at,label_strategy,net_pnl) VALUES('closed',datetime('now'),'fib_618_fade',5)").run()
  const stats = buildHeavyStateReport(db, 'stage-matrix-stats').stats
  assert.deepEqual(stats['strategy|fib_618_fade|scan'], { ok: 1, fail: 0 })
  assert.deepEqual(stats['strategy|fib_618_fade|trade'], { ok: 0, fail: 2 })
  assert.deepEqual(stats['strategy|fib_618_fade|manage'], { ok: 1, fail: 0 })
})

test('disk-backed report runs in worker and leaves caller event loop responsive', async t => {
  const db = fixture(t, false)
  const put = db.prepare('INSERT INTO scans(symbol,price,bias,confidence,scanned_at) VALUES(?,?,?,?,?)')
  const tx = db.transaction(() => { for (let i = 0; i < 20000; i++) put.run('S' + (i % 100), i, 'up', .5, '2026-09-23T00:00:00Z') })
  tx()
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  const report = await readHeavyStateReport(db, 'prices')
  clearInterval(timer)
  assert.equal(Object.keys(report.prices).length, 100)
  assert.ok(ticks > 0)
})

test('unknown report kind fails explicitly', t => {
  const db = fixture(t)
  assert.throws(() => buildHeavyStateReport(db, 'other'), /heavy_state_report_kind/)
})
