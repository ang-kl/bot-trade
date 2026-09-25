// V3 B3 (P5d-1): account history summarises the whole requested window.
// At 09:19 UTC on 25-09 46130058's 24 h window returned 2,000 points with
// hasMore, so the summary said "cashflow_coverage_gap" when nothing was
// missing but the page; a 7-day window (at least 10,080 points) could never
// complete. These tests put the evidence that decides the answer (the first
// equity, the deposit, the drawdown) OUTSIDE the newest page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from '../routes/state.js'
import { accountHistory, recordAccountHistory, HISTORY_SUMMARY_SQL } from './account-history.js'
import { recordCashflowWindow } from './account-cashflows.js'

const MIN = 60_000, DAY = 86_400_000, host = 'demo.ctraderapi.com'
const NOW = Math.floor(Date.now() / MIN) * MIN
// Windows end on the last UTC midnight so bucket boundaries are known exactly.
const DAY0 = Math.floor(NOW / DAY) * DAY

function fixture(t, path = ':memory:') {
  const db = initDB(path); t.after(() => { if (db.open) db.close() })
  setState(db, 'account_history_pruned_ms', String(Date.now()))
  const point = (at, equity, extra = {}) => assert.equal(recordAccountHistory(db, { accountId: '11', host, source: 'broker_trader',
    receivedAt: at, currency: 'USD', balance: equity, equity, openPnl: 0, ...extra }), true)
  // Coverage in week-sized windows, as the collector writes it.
  const cover = (from, to, events = []) => {
    for (let a = from; a < to; a += 7 * DAY) {
      const z = Math.min(a + 7 * DAY, to)
      recordCashflowWindow(db, { accountId: '11', host, currency: 'USD', from: a, to: z, receivedAt: NOW,
        response: { ctidTraderAccountId: '11', depositWithdraw: events.filter(e => e.changeBalanceTimestamp >= a && e.changeBalanceTimestamp <= z) } })
    }
  }
  const deposit = (id, at, amount) => ({ balanceHistoryId: id, changeBalanceTimestamp: at, delta: amount * 100, moneyDigits: 2, operationType: 0 })
  return { db, point, cover, deposit }
}

// 24 h: 1,440 broker_trader minutes plus 1,060 broker_equity minutes = 2,500.
// Inserted oldest first, so the newest 2,000 ids are the newest 2,000 rows and
// the oldest 500 (minutes 0-249) sit outside the default page.
function busyDay(f, W) {
  const equity = m => m === 100 ? 5000 : m === 120 ? 500 : 1000 + m + (m >= 50 ? 300 : 0)
  f.db.transaction(() => {
    for (let m = 0; m < 1440; m++) {
      f.point(W + m * MIN + 1000, equity(m))
      if (m < 1060) f.point(W + m * MIN + 2000, equity(m), { source: 'broker_equity' })
    }
  })()
  return equity
}

test('24 h with 2,500 points is complete: first equity, deposit and drawdown come from outside the newest page', t => {
  const f = fixture(t), W = DAY0 - DAY
  const equity = busyDay(f, W)
  f.cover(W, W + DAY, [f.deposit('1', W + 50 * MIN, 300)])
  const r = accountHistory(f.db, '11', { from: W, to: W + DAY })
  assert.equal(r.points.length, 2000); assert.equal(r.hasMore, true)
  assert.equal(r.summaryScope, 'full_window'); assert.equal(r.summaryComplete, true)
  assert.equal(r.summaryObservations, 2500); assert.equal(r.summaryEquityObservations, 2500)
  assert.deepEqual(r.observationSpan, { from: W + 1000, to: W + 1439 * MIN + 1000 })
  assert.equal(r.equityChange, equity(1439) - equity(0))
  assert.equal(r.cashflows.complete, true); assert.equal(r.cashflows.externalNet, 300)
  assert.equal(r.externalFlowAdjustedChange, equity(1439) - equity(0) - 300)
  assert.equal(r.sampledDrawdown, 4500)
  assert.equal(r.reconciledSpan, null)
  // Buckets: 5 minutes across 24 h, observations partition the window, flows sum to the whole.
  assert.equal(r.bucketMs, 5 * MIN); assert.equal(r.buckets.length, 288)
  assert.equal(r.buckets.reduce((n, b) => n + b.observations, 0), 2500)
  assert.equal(r.buckets.reduce((n, b) => n + b.cashflows.external, 0), 300)
  assert.ok(r.buckets.every(b => b.cashflows.covered))
  const spike = r.buckets[20], dip = r.buckets[24]  // minutes 100-104 and 120-124
  assert.deepEqual([spike.max, spike.first.equity, spike.currency], [5000, 5000, 'USD'])
  assert.deepEqual([dip.min, dip.last.equity], [500, equity(124)])
  // Every page carries the same whole-window summary.
  const older = accountHistory(f.db, '11', { from: W, to: W + DAY, before: r.nextBefore })
  assert.equal(older.points.length, 500); assert.equal(older.hasMore, false)
  assert.equal(older.externalFlowAdjustedChange, r.externalFlowAdjustedChange)
  assert.equal(older.sampledDrawdown, 4500)
})

test('7-day window with 10,080 points completes and its buckets hold first, last, min, max and cashflow sums', t => {
  const f = fixture(t), W = DAY0 - 7 * DAY
  const equity = m => 10_000 + (m % 1440) - (m >= 5000 ? 250 : 0) + (m >= 7000 ? 1000 : 0)
  f.db.transaction(() => { for (let m = 0; m < 10_080; m++) f.point(W + m * MIN, equity(m)) })()
  f.cover(W, W + 10_079 * MIN, [f.deposit('7', W + 7000 * MIN, 1000), { ...f.deposit('8', W + 5000 * MIN, -250), operationType: 1 }])
  const r = accountHistory(f.db, '11', { from: W, to: W + 7 * DAY })
  assert.equal(r.hasMore, true); assert.equal(r.points.length, 2000)
  assert.equal(r.summaryComplete, true); assert.equal(r.summaryObservations, 10_080)
  assert.equal(r.equityChange, equity(10_079) - equity(0))
  assert.equal(r.cashflows.complete, true); assert.equal(r.cashflows.externalNet, 750)
  assert.equal(r.externalFlowAdjustedChange, equity(10_079) - equity(0) - 750)
  assert.equal(r.bucketMs, 30 * MIN); assert.equal(r.buckets.length, 336)
  assert.ok(r.buckets.every(b => b.observations === 30 && b.equityObservations === 30))
  const b = r.buckets[233]  // minutes 6990-7019: the +1,000 deposit lands inside it
  assert.deepEqual({ first: b.first, last: b.last, min: b.min, max: b.max, external: b.cashflows.external, events: b.cashflows.events },
    { first: { at: W + 6990 * MIN, equity: equity(6990) }, last: { at: W + 7019 * MIN, equity: equity(7019) },
      min: equity(6990), max: equity(7019), external: 1000, events: 1 })
  assert.equal(r.buckets.reduce((n, x) => n + x.cashflows.external, 0), 750)
  // The first bucket's flows start at the first observation, excluding it.
  assert.deepEqual([r.buckets[0].cashflows.from, r.buckets.at(-1).cashflows.to], [W, W + 10_079 * MIN])
})

test('a real cashflow hole is still reported as a gap, whole-window and in the buckets it covers', t => {
  const f = fixture(t), W = DAY0 - DAY
  busyDay(f, W)
  // Coverage stops at minute 600 and resumes at minute 700: a genuine hole.
  f.cover(W, W + 600 * MIN, [f.deposit('1', W + 50 * MIN, 300)])
  f.cover(W + 700 * MIN, W + DAY)
  const r = accountHistory(f.db, '11', { from: W, to: W + DAY })
  assert.equal(r.summaryComplete, true)
  assert.equal(r.cashflows.complete, false); assert.equal(r.cashflows.reason, 'cashflow_coverage_gap')
  assert.equal(r.cashflows.coveredThrough, W + 600 * MIN)
  assert.equal(r.externalFlowAdjustedChange, null)
  // The dated reconciled portion ends at the last equity reading inside coverage.
  assert.equal(r.reconciledSpan.to, W + 599 * MIN + 2000)
  assert.equal(r.reconciledSpan.externalNet, 300)
  assert.equal(r.reconciledSpan.pendingObservations, r.summaryEquityObservations - 2 * 600)
  const hole = r.buckets.filter(b => b.cashflows && !b.cashflows.covered)
  assert.deepEqual([hole[0].from, hole.at(-1).to], [W + 600 * MIN, W + 700 * MIN])
  assert.ok(hole.every(b => b.cashflows.external === null && b.cashflows.events === null))
  assert.equal(r.buckets[119].cashflows.covered, true); assert.equal(r.buckets[140].cashflows.covered, true)
  // A page cannot hide the hole or complete the window.
  const one = accountHistory(f.db, '11', { from: W, to: W + DAY, limit: 1 })
  assert.equal(one.cashflows.reason, 'cashflow_coverage_gap'); assert.equal(one.externalFlowAdjustedChange, null)
  assert.deepEqual(one.reconciledSpan, r.reconciledSpan)
})

test('errored readings carry no equity; a second currency voids the change and that bucket, not its neighbours', t => {
  const f = fixture(t), W = NOW - 3600_000
  f.point(W, 100); f.point(W + 10 * MIN, 90); f.point(W + 20 * MIN, 120)
  f.point(W + 15 * MIN, 1_000_000, { source: 'broker_snapshot', error: 'P&L incomplete' })
  f.cover(W, W + 20 * MIN)
  const clean = accountHistory(f.db, '11', { from: W, to: W + 3600_000 })
  assert.equal(clean.summaryObservations, 4); assert.equal(clean.summaryEquityObservations, 3)
  assert.equal(clean.sampledDrawdown, 10); assert.equal(clean.equityChange, 20)
  assert.equal(clean.bucketMs, MIN)
  assert.deepEqual([clean.buckets[15].observations, clean.buckets[15].max], [1, null])
  f.point(W + 10 * MIN + 1, 80, { source: 'broker_equity', currency: 'EUR' })
  const mixed = accountHistory(f.db, '11', { from: W, to: W + 3600_000 })
  assert.equal(mixed.currency, null); assert.equal(mixed.equityChange, null); assert.equal(mixed.sampledDrawdown, null)
  assert.equal(mixed.cashflows.reason, 'comparable_equity_unavailable')
  assert.deepEqual([mixed.buckets[10].mixedUnits, mixed.buckets[10].min, mixed.buckets[10].currency], [true, null, null])
  assert.deepEqual([mixed.buckets[0].mixedUnits, mixed.buckets[0].min, mixed.buckets[0].currency], [false, 100, 'USD'])
  assert.ok(mixed.buckets.every(b => b.cashflows === null))
})

test('the summary reads the covering index in time order; an upgraded or malformed database still boots', t => {
  const dir = mkdtempSync(join(tmpdir(), 'account-history-window-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'agent.db')
  let db = initDB(path)
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${HISTORY_SUMMARY_SQL}`).all('11', 0, 1).map(s => s.detail).join(' | ')
  assert.match(plan, /USING COVERING INDEX idx_account_history_summary/)
  assert.doesNotMatch(plan, /TEMP B-TREE/)
  // A database from before this change: rows, no index, one malformed row.
  db.exec('DROP INDEX idx_account_history_summary')
  setState(db, 'account_history_pruned_ms', String(Date.now()))
  recordAccountHistory(db, { accountId: '11', host, source: 'broker_trader', receivedAt: NOW - 2 * MIN, currency: 'USD', equity: 100 })
  recordAccountHistory(db, { accountId: '11', host, source: 'broker_trader', receivedAt: NOW - MIN, currency: 'USD', equity: 130 })
  db.prepare("INSERT INTO account_history (account_id,host,source,bucket_ms,received_ms,observation_json) VALUES ('11',?,'broker_equity',?,?,'{not json')")
    .run(host, NOW - 90 * MIN, NOW - 90 * MIN)
  db.close()
  for (let pass = 0; pass < 2; pass++) {
    db = initDB(path)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_account_history_summary'").get())
    const r = accountHistory(db, '11', { from: NOW - 10 * MIN, to: NOW })
    assert.equal(r.equityChange, 30); assert.equal(r.summaryObservations, 2)
    db.close()
  }
})

test('GET /state/account-history with no limit returns a complete 24 h summary for 2,500 points', async t => {
  const f = fixture(t), W = DAY0 - DAY
  f.db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (11,0)').run()
  const equity = busyDay(f, W)
  f.cover(W, W + DAY, [f.deposit('1', W + 50 * MIN, 300)])
  const app = express(); app.use('/state', stateRouter(f.db))
  const server = app.listen(0); await new Promise(r => server.once('listening', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const res = await fetch(`http://127.0.0.1:${server.address().port}/state/account-history?account=11&from=${W}&to=${W + DAY}`)
  assert.equal(res.status, 200)
  const r = await res.json()
  assert.equal(r.points.length, 2000); assert.equal(r.hasMore, true)
  assert.equal(r.summaryComplete, true); assert.equal(r.summaryObservations, 2500)
  assert.equal(r.externalFlowAdjustedChange, equity(1439) - equity(0) - 300)
})
