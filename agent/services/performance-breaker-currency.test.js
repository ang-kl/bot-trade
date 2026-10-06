import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { recordDepositCurrency } from './account-money.js'
import { rollingStats, runPerformanceBreaker } from './performance-breaker.js'

function account(db, id, currency, host = 'demo.ctraderapi.com') {
  upsertAccount(db, { accountId: id, isLive: false })
  recordDepositCurrency(db, { accountId: id, host, depositAssetId: '1', currency,
    receivedAt: Date.parse('2026-10-06T00:00:00Z') })
}

function close(db, id, net, at = '2026-10-03T00:00:00Z') {
  db.prepare(`INSERT INTO trades (symbol, side, status, account_id, net_pnl, closed_at)
    VALUES ('EURUSD', 'BUY', 'closed', ?, ?, ?)`).run(id, net, at)
}

function seedBad(db, id) {
  for (let i = 0; i < 20; i++) close(db, id, i < 5 ? 20 : -100)
}

test('verified USD and SGD rows never produce pooled PF, net, expectancy or an alert', () => {
  const db = initDB(':memory:')
  try {
    account(db, '1001', 'USD'); account(db, '1002', 'SGD')
    for (let i = 0; i < 20; i++) close(db, i < 5 ? '1001' : '1002', i < 5 ? 20 : -100)
    const stats = rollingStats(db, 20)
    assert.equal(stats.trades, 20)
    assert.equal(stats.winRate, 25)
    assert.equal(stats.profitFactor, null)
    assert.equal(stats.net, null)
    assert.equal(stats.expectancy, null)
    assert.equal(stats.currency, null)
    assert.equal(stats.moneyReason, 'mixed_currencies')
    assert.deepEqual(stats.currencyCounts, { USD: 5, SGD: 15 })
    const notes = []
    const out = runPerformanceBreaker(db, { notify: text => notes.push(text) })
    assert.equal(out.skipped, 'mixed_currencies')
    assert.equal(notes.length, 0)
    assert.equal(getState(db, 'performance_breaker_acted_id'), null)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM action_log WHERE method='PERF_BREAKER'").get().n, 0)
  } finally { db.close() }
})

for (const [name, id, setup] of [
  ['missing account', null, () => {}],
  ['unregistered account', '1001', () => {}],
  ['missing currency evidence', '1001', db => upsertAccount(db, { accountId: '1001', isLive: false })],
  ['wrong host evidence', '1001', db => {
    account(db, '1001', 'USD')
    const key = 'acct:1001:deposit_currency_evidence_json'
    const ev = JSON.parse(getState(db, key)); ev.host = 'live.ctraderapi.com'
    setState(db, key, JSON.stringify(ev))
  }],
  ['wrong account evidence', '1001', db => {
    account(db, '1001', 'USD')
    const key = 'acct:1001:deposit_currency_evidence_json'
    const ev = JSON.parse(getState(db, key)); ev.accountId = '1002'
    setState(db, key, JSON.stringify(ev))
  }],
]) {
  test(`${name} leaves monetary statistics unavailable without consuming the alert`, () => {
    const db = initDB(':memory:')
    try {
      setup(db); seedBad(db, id)
      const notes = []
      const out = runPerformanceBreaker(db, { notify: text => notes.push(text) })
      assert.equal(out.skipped, 'unverified_currency')
      assert.equal(out.stats.profitFactor, null)
      assert.equal(out.stats.net, null)
      assert.equal(out.stats.expectancy, null)
      assert.equal(notes.length, 0)
      assert.equal(getState(db, 'performance_breaker_acted_id'), null)
      assert.equal(db.prepare("SELECT COUNT(*) n FROM action_log WHERE method='PERF_BREAKER'").get().n, 0)
    } finally { db.close() }
  })
}

test('late account-owned currency evidence permits the same newest trade to alert exactly once', () => {
  const db = initDB(':memory:')
  try {
    upsertAccount(db, { accountId: '1001', isLive: false }); seedBad(db, '1001')
    const notes = []
    const initial = runPerformanceBreaker(db, { notify: text => notes.push(text) })
    assert.equal(initial.skipped, 'unverified_currency')
    account(db, '1001', 'SGD')
    const valid = runPerformanceBreaker(db, { notify: text => notes.push(text) })
    assert.equal(valid.triggered, true)
    assert.equal(valid.stats.newestId, initial.stats.newestId)
    assert.equal(valid.stats.currency, 'SGD')
    assert.equal(valid.stats.net, -1400)
    assert.equal(valid.stats.expectancy, -70)
    assert.equal(valid.stats.profitFactor, 0.07)
    assert.match(valid.message, /SGD/)
    assert.equal(runPerformanceBreaker(db).skipped, 'already_alerted')
    assert.equal(notes.length, 1)
  } finally { db.close() }
})

test('one known currency across accounts preserves global latest-N scope, historical rows and flags', () => {
  const db = initDB(':memory:')
  try {
    account(db, '1001', 'USD'); account(db, '1002', 'USD'); account(db, '1003', 'SGD')
    close(db, '1003', 10000, '2026-10-01T00:00:00Z')
    for (let i = 0; i < 20; i++) close(db, i < 5 ? '1001' : '1002', i < 5 ? 20 : -100)
    setState(db, 'performance_breaker_json', JSON.stringify({ window: 20, minTrades: 20, pfThreshold: 0.1, autoDisarm: true }))
    setState(db, 'autotrade_enabled', 'true')
    setState(db, 'acct:1001:autotrade_enabled', 'true')
    const out = runPerformanceBreaker(db, { notify: () => {} })
    assert.equal(out.triggered, true)
    assert.equal(out.stats.trades, 20)
    assert.equal(out.stats.currency, 'USD')
    assert.equal(out.stats.net, -1400)
    assert.equal(out.stats.profitFactor, 0.07)
    assert.equal(getState(db, 'autotrade_enabled'), 'true')
    assert.equal(getState(db, 'acct:1001:autotrade_enabled'), 'true')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 21)
    assert.equal(db.prepare("SELECT net_pnl FROM trades WHERE account_id='1003'").get().net_pnl, 10000)
  } finally { db.close() }
})
