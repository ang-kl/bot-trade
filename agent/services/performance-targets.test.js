import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'
import { assessPerformanceTargets, performanceTargets, PERFORMANCE_TARGETS } from './performance-targets.js'
import { EVIDENCE_RULES } from './position-lifecycle-evidence.js'

const START = Date.parse(PERFORMANCE_TARGETS.effectiveAt), DAY = 86_400_000
const NOW = Date.parse('2026-10-13T01:00:00Z')
const row = (id, pnl, at = NOW - DAY) => ({ accountId: '11', positionId: String(id), netPnl: pnl, closedAtMs: at, complete: true })
const sample = (wins, win = 1, loss = -1) => Array.from({ length: 20 }, (_, i) => row(i + 1, i < wins ? win : loss, NOW - 100_000 + i))

test('the owner targets and reporting-only effect are fixed with the correct effective UTC instant', () => {
  assert.equal(START, Date.parse('2026-10-04T07:35:00+08:00'))
  assert.equal(PERFORMANCE_TARGETS.winRatePct, 75)
  assert.equal(PERFORMANCE_TARGETS.profitFactor, 1.68)
  assert.equal(PERFORMANCE_TARGETS.effect, 'reporting_only')
})

test('15 of 20 and PF exactly 1.68 qualify; rounding cannot turn a shortfall into success', () => {
  const out = assessPerformanceTargets(sample(15, 0.56), { now: NOW })
  assert.equal(out.winRate.qualified, true)
  assert.equal(out.profitFactor.qualified, true)
  const below = assessPerformanceTargets(sample(15, 0.5599), { now: NOW })
  assert.equal(below.profitFactor.qualified, false)
  assert.equal(below.winRate.qualified, true)
})

test('only the latest 20 forward closes count, with WR and PF assessed independently', () => {
  const records = [...sample(14, 10), ...Array.from({ length: 30 }, (_, i) => row(i + 30, 100, START - i - 1))]
  const out = assessPerformanceTargets(records, { now: NOW })
  assert.equal(out.forwardCloses, 20)
  assert.equal(out.latest20.n, 20)
  assert.equal(out.winRate.qualified, false)
  assert.equal(out.profitFactor.qualified, true)
  assert.equal(assessPerformanceTargets([row(1, 1, START), row(2, 1, NOW + 1)], { now: NOW }).forwardCloses, 0)
})

test('an incomplete losing close cannot be omitted to qualify the priced subset', () => {
  const records = sample(15)
  records[19] = { ...records[19], netPnl: null, complete: false }
  const out = assessPerformanceTargets(records, { now: NOW })
  assert.equal(out.latest20.pending, 1)
  assert.equal(out.latest20.winRatePct, null)
  assert.equal(out.winRate.latest20Status, 'unmeasurable')
  assert.equal(out.winRate.qualified, false)
})

test('no closes, fewer than 20 and an undefined PF cannot establish success', () => {
  const empty = assessPerformanceTargets([], { now: NOW })
  assert.equal(empty.winRate.qualified, false)
  const short = assessPerformanceTargets(sample(20).slice(0, 19), { now: NOW })
  assert.equal(short.winRate.latest20Status, 'insufficient_sample')
  const allWins = assessPerformanceTargets(sample(20), { now: NOW })
  assert.equal(allWins.winRate.qualified, true)
  assert.equal(allWins.profitFactor.latest20Status, 'undefined')
  assert.equal(allWins.profitFactor.qualified, false)
})

test('3 completed SGT days can qualify WR with fewer than 20 closes; today stays provisional', () => {
  const todayStart = Date.parse('2026-10-13T00:00:00+08:00')
  const records = Array.from({ length: 3 }, (_, d) => Array.from({ length: 4 }, (_, i) => row(d * 4 + i + 1, i < 3 ? 1 : -1, todayStart - (d + 1) * DAY + 1000))).flat()
  const out = assessPerformanceTargets(records, { now: NOW })
  assert.equal(out.winRate.latest20Status, 'insufficient_sample')
  assert.equal(out.winRate.consecutiveDays, 3)
  assert.equal(out.winRate.qualified, true)
  const shifted = assessPerformanceTargets(records.map(r => ({ ...r, closedAtMs: r.closedAtMs + DAY })), { now: NOW })
  assert.equal(shifted.winRate.consecutiveDays, 2)
  assert.equal(shifted.currentDay.n, 4)
  assert.equal(shifted.winRate.qualified, false)
})

test('8 individually passing PF days qualify with 16 closes and an empty day breaks the streak', () => {
  const todayStart = Date.parse('2026-10-13T00:00:00+08:00')
  const records = Array.from({ length: 8 }, (_, d) => [row(d * 2 + 1, 2, todayStart - (d + 1) * DAY + 1000), row(d * 2 + 2, -1, todayStart - (d + 1) * DAY + 2000)]).flat()
  const out = assessPerformanceTargets(records, { now: NOW })
  assert.equal(out.profitFactor.latest20Status, 'insufficient_sample')
  assert.equal(out.profitFactor.consecutiveDays, 8)
  assert.equal(out.profitFactor.qualified, true)
  assert.equal(out.winRate.qualified, false)
  const gap = assessPerformanceTargets(records.filter(r => r.closedAtMs < todayStart - DAY), { now: NOW })
  assert.equal(gap.profitFactor.consecutiveDays, 0)
  assert.equal(gap.profitFactor.qualified, false)
})

test('the day route requires each day to meet the threshold, not just a pooled average', () => {
  const todayStart = Date.parse('2026-10-13T00:00:00+08:00')
  const records = [row(1, 100, todayStart - DAY + 1000), row(2, -1, todayStart - DAY + 2000),
    row(3, 1, todayStart - 2 * DAY + 1000), row(4, -2, todayStart - 2 * DAY + 2000)]
  const out = assessPerformanceTargets(records, { now: NOW })
  assert.equal(out.profitFactor.consecutiveDays, 1)
  assert.equal(out.profitFactor.qualified, false)
})

test('the DB reader counts a whole broker lifecycle once despite duplicate ledger/partial deal rows and isolates accounts', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  recordDepositCurrency(db, { accountId: '11', host: 'demo.ctraderapi.com', depositAssetId: '14', currency: 'SGD', receivedAt: START })
  recordAccountMoney(db, { accountId: '11', host: 'demo.ctraderapi.com', trader: { depositAssetId: 14 }, balance: 100, receivedAt: START })
  const time = NOW - 1000
  const trade = db.prepare("INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, closed_at_ms) VALUES ('BTCUSD', 'buy', 'closed', ?, ?, ?)")
  trade.run('11', '123', time); trade.run('11', '123.0', time); trade.run('22', '123', time)
  for (const id of ['1', '2']) db.prepare('INSERT INTO broker_deals (deal_id, position_id, account_id, closed_at) VALUES (?, ?, ?, ?)').run(id, '123', '11', new Date(time).toISOString())
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, host, verdict, rules, final_close_ms, broker_net, broker_gross, broker_commission, broker_swap, conversion_fee, read_at)
    VALUES ('11','123','demo.ctraderapi.com','money_bearing_fragment', ?, ?, 9, 10, -1, 0, 0, ?)`).run(EVIDENCE_RULES, time, new Date(time).toISOString())
  const out = performanceTargets(db, { accountIds: ['11', '22'], now: NOW })
  assert.equal(out.accounts[0].latest20.n, 1)
  assert.equal(out.accounts[0].latest20.eligible, 1)
  assert.equal(out.accounts[0].latest20.grossWin, 9)
  assert.equal(out.accounts[0].currency, 'SGD')
  assert.equal(out.accounts[1].latest20.n, 1)
  assert.equal(out.accounts[1].latest20.pending, 1)
  db.prepare("UPDATE position_lifecycle_evidence SET verdict='open_at_broker', final_close_ms=NULL WHERE account_id='11'").run()
  const partial = performanceTargets(db, { accountIds: ['11'], now: NOW })
  assert.equal(partial.accounts[0].latest20.n, 0)
  assert.equal(partial.accounts[0].excludedOpen, 1)
})

test('unscoped or undated cohort evidence prevents both qualification routes and failed sources stay unavailable', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare("INSERT INTO trades (symbol, side, status, account_id, closed_at_ms) VALUES ('BTCUSD', 'buy', 'closed', NULL, ?)").run(NOW - 1000)
  db.prepare("INSERT INTO trades (symbol, side, status, account_id) VALUES ('BTCUSD', 'buy', 'closed', '11')").run()
  const out = performanceTargets(db, { accountIds: ['11'], now: NOW })
  assert.equal(out.unattributed, 1)
  assert.equal(out.unknownCloseTime, 1)
  assert.equal(out.accounts[0].winRate.qualified, null)
  assert.equal(out.accounts[0].profitFactor.latest20Status, 'unmeasurable')
  assert.equal(out.accounts[0].scope.coverage, null)
  const failed = performanceTargets({ prepare() { throw new Error('offline') } }, { accountIds: ['11'], now: NOW })
  assert.match(failed.unavailable, /offline/)
  assert.deepEqual(failed.accounts, [])
})

test('a stale open receipt cannot hide a later closing deal and incompatible scope stays pending', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  recordDepositCurrency(db, { accountId: '11', host: 'demo.ctraderapi.com', depositAssetId: '14', currency: 'SGD', receivedAt: START })
  recordAccountMoney(db, { accountId: '11', host: 'demo.ctraderapi.com', trader: { depositAssetId: 14 }, balance: 100, receivedAt: START })
  const time = NOW - 1000
  db.prepare('INSERT INTO broker_deals (deal_id, position_id, account_id, closed_at) VALUES (?, ?, ?, ?)').run('1', '123', '11', new Date(time).toISOString())
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, host, verdict, rules, final_close_ms, broker_net, broker_gross, broker_commission, broker_swap, conversion_fee, read_at)
    VALUES ('11','123','demo.ctraderapi.com','open_at_broker', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`).run(EVIDENCE_RULES, new Date(time - 1000).toISOString())
  let out = performanceTargets(db, { accountIds: ['11'], now: NOW })
  assert.equal(out.accounts[0].latest20.pending, 1)
  assert.equal(out.accounts[0].excludedOpen, 0)
  db.prepare("UPDATE position_lifecycle_evidence SET verdict='agrees', final_close_ms=?, broker_net=9, broker_gross=10, broker_commission=-1, broker_swap=0, conversion_fee=0, read_at=?, host='live.ctraderapi.com'").run(time, new Date(time).toISOString())
  out = performanceTargets(db, { accountIds: ['11'], now: NOW })
  assert.equal(out.accounts[0].latest20.pending, 1)
  db.prepare("UPDATE position_lifecycle_evidence SET host='demo.ctraderapi.com', rules=?").run(EVIDENCE_RULES - 1)
  assert.equal(performanceTargets(db, { accountIds: ['11'], now: NOW }).accounts[0].latest20.pending, 1)
})
