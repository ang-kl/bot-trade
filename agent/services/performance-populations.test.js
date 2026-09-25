import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { buildPerformancePopulations, readPerformancePopulations, buildDecisionsDaily, buildLatestPrices, readDecisionsDaily, readLatestPrices, readStageMatrixStats, readDecisionAudit } from './performance-populations.js'
import { stageMatrixStats } from './stage-matrix.js'
import { getState } from '../db.js'
import { reportStats, reportLedger, reportCurrency, reportCurrencyStats, populationStats, emptyPopulation } from '../shared/performance-populations.js'
import { recordDepositCurrency } from './account-money.js'
import { accountAnalytics } from './account-analytics.js'
import { auditDecisions } from './decision-audit.js'
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
// WEB-7 (8,989-A rows 8-9): money is pooled per recorded deposit currency and
// never across two. The evidence is written by the production writer, so a
// drift in its state key fails here rather than silently emptying the pool.
function registerCurrencies(db) {
  const acct = db.prepare('INSERT INTO accounts (account_id, is_live) VALUES (?, ?)')
  for (const [id, live] of [['11', 0], ['22', 0], ['33', 1], ['44', 0], ['55', 0]]) acct.run(id, live)
  const demo = 'demo.ctraderapi.com', live = 'live.ctraderapi.com'
  assert.equal(recordDepositCurrency(db, { accountId: '11', host: demo, depositAssetId: 1, currency: 'USD', receivedAt: NOW - 5000 }), true)
  assert.equal(recordDepositCurrency(db, { accountId: '22', host: demo, depositAssetId: 1, currency: 'USD', receivedAt: NOW - 5000 }), true)
  assert.equal(recordDepositCurrency(db, { accountId: '33', host: live, depositAssetId: 7, currency: 'SGD', receivedAt: NOW - 5000 }), true)
  // Evidence for the other host is not this account's currency.
  assert.equal(recordDepositCurrency(db, { accountId: '44', host: live, depositAssetId: 1, currency: 'USD', receivedAt: NOW - 5000 }), true)
}
test('the report names each account deposit currency from broker evidence on its own host, never a default', t => {
  const { db, add } = setup(t)
  registerCurrencies(db); add({ pnl: 1 })
  const r = buildPerformancePopulations(db, { now: NOW })
  assert.equal(r.currencyByAccount['11'].currency, 'USD')
  assert.equal(r.currencyByAccount['11'].source, 'broker_asset_list')
  assert.equal(r.currencyByAccount['33'].currency, 'SGD')
  assert.deepEqual(r.currencyByAccount['44'], { currency: null, reason: 'deposit_currency_evidence_mismatch' })
  assert.deepEqual(r.currencyByAccount['55'], { currency: null, reason: 'deposit_currency_not_recorded' })
  assert.equal(reportCurrency(r, '44'), null)
  assert.equal(reportCurrency(r, null), null)
  assert.equal(reportCurrency(r, '99'), null)
})
test('money pools within one recorded currency, never across currencies, and a partial pool says so', t => {
  const { db, add } = setup(t)
  registerCurrencies(db)
  add({ account: '11', pnl: 20 }); add({ account: '22', pnl: -5 }); add({ account: '33', pnl: 7 })
  add({ account: '44', pnl: 100 }); add({ account: null, pnl: 1000 })
  const r = buildPerformancePopulations(db, { now: NOW })
  const usd = reportCurrencyStats(r, '30d', 'USD')
  assert.equal(usd.pnl, 15); assert.equal(usd.n, 2); assert.equal(usd.currency, 'USD')
  assert.equal(usd.moneyState, 'recorded_currency_units')
  assert.equal(reportCurrencyStats(r, '30d', 'SGD').pnl, 7)
  // The account without evidence and the unstamped close are in no currency.
  assert.equal(reportCurrencyStats(r, '30d', 'USD', g => g.accountId === '44').n, 0)
  // The pre-existing all-accounts rule is unchanged: no cross-account sum.
  assert.equal(reportStats(r, '30d').pnl, null)
  assert.equal(reportStats(r, '30d').moneyState, 'unverified_cross_account_units')
  assert.equal(reportStats(r, '30d', '11').moneyState, 'recorded_account_units')
  add({ account: '22', pnl: null })
  const partial = reportCurrencyStats(buildPerformancePopulations(db, { now: NOW }), '30d', 'USD')
  assert.equal(partial.pnl, 15); assert.equal(partial.n, 3); assert.equal(partial.pricedN, 2)
  assert.equal(partial.moneyState, 'partial_recorded_currency_units')
})
test('a pool whose groups span two currencies adds nothing, whatever the caller filtered', () => {
  const g = (accountId, net) => ({ accountId, stats: { ...emptyPopulation(), n: 1, pricedN: 1, net, gw: Math.max(0, net), gl: Math.max(0, -net) } })
  const currencyOf = id => ({ 11: 'USD', 22: 'USD', 33: 'SGD' })[id] ?? null
  const mixed = populationStats([g('11', 20), g('33', 7)], { currency: 'USD', currencyOf })
  assert.equal(mixed.pnl, null); assert.equal(mixed.moneyState, 'unverified_cross_account_units'); assert.equal(mixed.currency, null)
  assert.equal(populationStats([g('11', 20), g(null, 1)], { currency: 'USD', currencyOf }).pnl, null)
  assert.equal(populationStats([g('11', 20), g('22', -5)], { currency: 'usd', currencyOf }).pnl, null)
  assert.equal(populationStats([g('11', 20), g('22', -5)], { currency: 'USD', currencyOf }).pnl, 15)
  assert.equal(populationStats([g('11', 20), g('22', -5)], { currency: 'USD' }).pnl, null)
  assert.equal(reportCurrencyStats({ status: 'complete', windows: [{ key: '30d', groups: [] }] }, '30d', null).state, 'unavailable')
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


test('decisions, prices and stage statistics preserve exact output in read-only workers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'state-report-isolation-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db } = setup(t, join(dir, 'fixture.db'))
  const at = new Date().toISOString()
  const risk = db.prepare(`INSERT INTO risk_events
    (symbol,side,approved,proposal_json,account_id,created_at,repeat_count)
    VALUES(?,'BUY',?,'{}',?,?,?)`)
  risk.run('EURUSD', 1, '11', at, 1)
  risk.run('EURUSD', 0, '22', at, 3)
  risk.run('EURUSD', 0, null, at, 2)
  const scan = db.prepare(`INSERT INTO scans
    (symbol,bias,confidence,timeframe,price,scanned_at) VALUES(?,?,?,?,?,?)`)
  scan.run('EURUSD', 'long', 7, '1h', 1.1, at)
  scan.run('EURUSD', 'short', 8, '1h', 1.2, at)
  scan.run('GBPUSD', 'long', 6, '1h', 1.3, at)

  const directDecisions = buildDecisionsDaily(db, { days: 1, accountId: '11' })
  const directPrices = buildLatestPrices(db)
  const directStage = stageMatrixStats(db, getState)
  assert.deepEqual(await readDecisionsDaily(db, { days: 1, accountId: '11' }), directDecisions)
  assert.deepEqual(await readLatestPrices(db), directPrices)
  assert.deepEqual(await readStageMatrixStats(db), directStage)
  assert.equal(directDecisions.reduce((n, r) => n + r.approved + r.vetoed_distinct, 0), 2)
  assert.equal(directPrices.EURUSD.price, 1.2)
  assert.equal(directPrices.GBPUSD.price, 1.3)
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})


test('post-decision audit preserves the synchronous verdict in a read-only worker', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-audit-isolation-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db } = setup(t, join(dir, 'fixture.db'))
  const at = new Date().toISOString()
  db.prepare(`INSERT INTO decision_log(symbol,stage,decision,reason,account_id,created_at)
    VALUES('EURUSD','stage_matrix','skip','strategy','11',?)`).run(at)
  const nowMs = Date.now()
  const direct = auditDecisions(db, { marketOpen: true, now: new Date(nowMs) })
  const isolated = await readDecisionAudit(db, { marketOpen: true, nowMs })
  assert.deepEqual(isolated, direct)
  assert.equal(isolated.verdict, 'blocked')
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})
