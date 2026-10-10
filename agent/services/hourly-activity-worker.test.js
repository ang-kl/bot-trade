// node --test agent/services/hourly-activity-worker.test.js
//
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// GET /state/hourly-activity (the Performance page, every 60 s per tab) cost
// ~151 ms median ON the trading thread and its `to=` changes every minute, so
// the 10 s response cache never served it (measured 10-10). It is built on a
// report worker now (readHourlyActivity, its own pool). These tests run the
// REAL route over a FILE database, so the worker really runs, and compare its
// body with the body the old route built inline (hourlyActivity on the main
// connection) for the same inputs — identical but for `generatedAt`, the
// moment each was computed.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { initDB } from '../db.js'
import stateRouter from '../routes/state.js'
import { hourlyActivity } from './hourly-activity.js'
import { recordDepositCurrency } from './account-money.js'
import { recordAccountHistory } from './account-history.js'
import { invalidateStateCache } from '../lib/state-cache.js'

const HOUR = 3600_000
const demo = 'demo.ctraderapi.com', live = 'live.ctraderapi.com'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hourly-activity-worker-'))
  const db = initDB(join(dir, 'fixture.db'))
  // A `to` safely in the past, so observedThrough = to for both builds.
  const to = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR + 1234
  const acct = db.prepare('INSERT INTO accounts (account_id, is_live) VALUES (?, ?)')
  acct.run('11', 0); acct.run('22', 0); acct.run('33', 1)
  recordDepositCurrency(db, { accountId: '11', host: demo, depositAssetId: 1, currency: 'USD', receivedAt: to - 5000 })
  recordDepositCurrency(db, { accountId: '22', host: demo, depositAssetId: 1, currency: 'USD', receivedAt: to - 5000 })
  recordDepositCurrency(db, { accountId: '33', host: live, depositAssetId: 7, currency: 'SGD', receivedAt: to - 5000 })
  const trade = db.prepare(`INSERT INTO trades (symbol, status, account_id, opened_at, closed_at, net_pnl, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const iso = ms => new Date(ms).toISOString()
  db.transaction(() => {
    for (let i = 0; i < 60; i++) {
      const at = to - (i * 23 * 60_000) - 1
      trade.run('EURUSD', 'closed', ['11', '22', '33', null][i % 4], iso(at - HOUR), iso(at), i % 7 === 0 ? null : (i % 3 === 0 ? -1.5 * i : 2.25 * i), i % 5 === 0 ? 'reconciler_adopted' : 'bot')
    }
    trade.run('GBPUSD', 'open', '11', iso(to - 3 * HOUR), null, null, 'bot')
    trade.run('XAUUSD', 'closed', '22', null, null, 4, 'bot') // unknown times stay unknown
  })()
  for (const [id, host] of [['11', demo], ['33', live]]) {
    for (let h = 0; h <= 24; h += 3) {
      recordAccountHistory(db, { accountId: id, host, source: 'broker_trader', receivedAt: to - h * HOUR - 60_000, currency: id === '33' ? 'SGD' : 'USD', balance: 1000 + h, openPnl: h - 3 })
    }
  }
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(() => { db.close(); rmSync(dir, { recursive: true, force: true }); resolve() })))
  const get = query => fetch(`http://127.0.0.1:${server.address().port}/state/hourly-activity${query}`)
  return { db, to, get }
}
const withoutClock = ({ generatedAt, ...rest }) => { assert.ok(Number.isFinite(Date.parse(generatedAt))); return rest }

test('the worker-built body is the old inline body, for an account and for all accounts', async t => {
  const { db, to, get } = await fixture(t)
  for (const [account, scope] of [['11', { accountId: '11', all: false, explicit: true }], ['33', { accountId: '33', all: false, explicit: true }], ['all', { accountId: null, all: true, explicit: true }]]) {
    const old = hourlyActivity(db, scope, { to })
    const res = await get(`?account=${account}&to=${to}`)
    assert.equal(res.status, 200, account)
    const body = await res.json()
    assert.deepEqual(withoutClock(body), withoutClock(JSON.parse(JSON.stringify(old))), `account=${account}`)
    assert.ok(body.closedN > 0 && body.openedN > 0, 'the fixture exercises real rows, not an empty window')
    assert.equal(body.balanceHistory.status, 'complete', 'the balance columns were read in the worker too')
    // Observed broker balances landed in the columns (per currency group: an
    // all-accounts scope mixing USD and SGD has no single total, by rule).
    assert.ok(body.rows.some(r => (r.balance?.open?.groups ?? []).some(g => g.observedAccounts > 0)), `observed balances landed in the columns (${account})`)
  }
})

test('the route keeps its contract: 400 with the same words for a bad window, 503 with the same body when the read fails', async t => {
  const { to, get } = await fixture(t)
  for (const q of [`?to=${to}`, `?account=99&to=${to}`, '?account=11&to=no', `?account=11&to=${Date.now() + HOUR}`]) {
    assert.equal((await get(q)).status, 400, q)
  }
  const ahead = await (await get(`?account=11&to=${Date.now() + HOUR}`)).json()
  assert.equal(ahead.error, 'to must be a UTC epoch millisecond no more than 2 minutes ahead')
})

test('the read runs OFF the trading thread: a locked database leaves the event loop free and answers the same 503', async t => {
  const { db, to, get } = await fixture(t)
  db.pragma('journal_mode = DELETE')
  const lock = new Database(db.name)
  t.after(() => { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() })
  lock.exec('BEGIN EXCLUSIVE')
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  t.after(() => clearInterval(timer))
  invalidateStateCache()
  const pending = get(`?account=all&to=${to}`)
  await delay(200)
  assert.ok(ticks >= 5, `timers kept running while the read waited on the lock (${ticks} ticks)`)
  const res = await pending
  assert.equal(res.status, 503)
  assert.deepEqual(await res.json(), { error: 'activity evidence unavailable' })
})
