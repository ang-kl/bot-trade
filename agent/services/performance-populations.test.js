import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { buildPerformancePopulations, readPerformancePopulations } from './performance-populations.js'
import { reportStats, reportLedger } from '../shared/performance-populations.js'
import { accountAnalytics } from './account-analytics.js'
const NOW = Date.UTC(2026, 8, 22, 12)
function setup(t, file = ':memory:') {
  const db = initDB(file); t.after(() => db.close())
  const insert = db.prepare(`INSERT INTO trades(symbol,side,status,account_id,net_pnl,closed_at,closed_at_ms,
    entry_price,sl_price,tp_price,strategy,close_reason) VALUES(?, 'BUY','closed',?,?,NULL,?,100,99,102,'ema_cross','TP hit')`)
  return { db, add: ({ symbol = 'EURUSD', account = '11', pnl = 1, at = NOW - 1000 } = {}) => insert.run(symbol, account, pnl, at) }
}
test('full populations exceed the journal cap, retain unpriced closes and reconcile dimensions', t => {
  const { db, add } = setup(t)
  for (let i = 0; i < 251; i++) add({ pnl: 0.125 })
  add({ pnl: null }); add({ symbol: 'BTCUSD', pnl: -2.25 })
  const report = buildPerformancePopulations(db, { now: NOW })
  const total = reportStats(report, '30d', '11')
  assert.equal(total.n, 253); assert.equal(total.pricedN, 252)
  assert.equal(total.pnl, 29.125); assert.equal(total.unpricedN, 1)
  assert.equal(total.moneyState, 'partial_recorded_account_units')
  assert.equal(reportStats(report, '30d', '11', g => g.market === 'fx').pnl
    + reportStats(report, '30d', '11', g => g.market === 'crypto').pnl, total.pnl)
  assert.equal(reportStats(report, '30d', '11', g => g.strat === 'ema_cross').n, total.n)
  const ledger = reportLedger(report, '11').windows.find(w => w.key === '30d')
  assert.equal(ledger.carryIn, null); assert.equal(ledger.carryOut, null)
  assert.equal(ledger.trades, total.n); assert.equal(ledger.net, total.pnl)
})
test('unattributed records never enter a named account; different accounts retain counts without a money sum', t => {
  const { db, add } = setup(t)
  add({ pnl: 20 }); add({ account: '22', pnl: -5 }); add({ account: null, pnl: 1000 })
  const r = buildPerformancePopulations(db, { now: NOW })
  assert.equal(reportStats(r, '30d', '11').pnl, 20)
  assert.equal(reportStats(r, '30d', '22').pnl, -5)
  assert.equal(reportStats(r, '30d').n, 3)
  assert.equal(reportStats(r, '30d').pnl, null)
  assert.equal(reportStats(r, '30d').pf, null)
  assert.equal(reportStats(r, '30d').moneyState, 'unverified_cross_account_units')
  assert.equal(r.coverage.unattributedAccountN, 1)
})
test('zero, unpriced-only, malformed dates and report unavailability are distinct', t => {
  const { db, add } = setup(t)
  add({ pnl: null }); add({ at: null }); add({ at: NOW + 1 })
  const r = buildPerformancePopulations(db, { now: NOW })
  assert.equal(reportStats(r, '30d', '11').pnl, null)
  assert.equal(reportStats(r, '30d', '11').n, 1)
  assert.equal(reportStats(r, '30d', '22').n, 0)
  assert.equal(reportStats(r, '30d', '22').pnl, 0)
  assert.equal(reportStats(null, '30d', '22').n, null)
  assert.equal(r.coverage.unknownCloseTimeN, 1); assert.equal(r.coverage.futureCloseTimeN, 1)
  assert.throws(() => buildPerformancePopulations(db, { now: NOW, maxGroups: 0 }), /group_bound/)
  assert.throws(() => buildPerformancePopulations(db, { now: NOW, deadlineMs: -1 }), /deadline/)
})
test('session statistics and winners use the whole population; rankings remain within an account', t => {
  const { db, add } = setup(t)
  for (let i = 1; i <= 150; i++) add({ pnl: i, at: NOW - 3600000 })
  add({ account: '22', pnl: 10000 })
  const r = buildPerformancePopulations(db, { now: NOW })
  assert.equal(reportStats(r, 'session:EUR', '11').median, 75.5)
  assert.equal(reportStats(r, 'session:EUR', '11').n, 150)
  assert.equal(r.bestByAccount['11'].win[0].pnl, 150)
  assert.equal(r.bestByAccount['11'].lag[0].pnl, 1)
  assert.equal(r.bestByAccount['22'].win[0].pnl, 10000)
})
test('disk report runs in a coalesced read-only worker and leaves order state untouched', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'performance-populations-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, add } = setup(t, join(dir, 'fixture.db')); add({ at: Date.now() - 1000 })
  const a = readPerformancePopulations(db), b = readPerformancePopulations(db)
  assert.equal(a, b)
  const report = await a
  assert.equal(report.status, 'complete'); assert.equal(reportStats(report, '30d', '11').n, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})
test('reporting analytics expose unpriced coverage and isolate currencies without changing gate defaults', t => {
  const { db, add } = setup(t)
  add({ pnl: 10 }); add({ pnl: null }); add({ account: '22', pnl: -5 }); add({ account: null, pnl: 100 })
  const a = accountAnalytics(db, { now: NOW, accountId: '11', unstamped: 'exclude', reporting: true })
  assert.equal(a.net, 10); assert.equal(a.closedTrades, 2); assert.equal(a.unpricedTrades, 1)
  const all = accountAnalytics(db, { now: NOW, reporting: true })
  assert.equal(all.net, null); assert.equal(all.profitFactor, null); assert.equal(all.profitFactorInfinite, false)
  // Legacy callers have an unchanged policy until their own risk decision.
  assert.equal(accountAnalytics(db, { now: NOW }).net, 105)
})
