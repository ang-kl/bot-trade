import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { DEFAULT_LEVERAGE, DEFAULT_RISK_CONFIG, getAccountLeverage, getAccountLeverageEvidence, accountMarginPool, evaluateTrade } from './risk.js'
import stateRouter from '../routes/state.js'

function fixture(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  for (const id of ['11', '22']) db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run(id)
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'account_leverage', '1000')
  setState(db, 'acct:11:account_leverage', '500')
  for (const id of ['11', '22']) setState(db, `acct:${id}:account_balance_usd`, '1000')
  return db
}

test('a named account never borrows selected/global leverage; missing retains the existing numeric default', t => {
  const db = fixture(t)
  assert.equal(DEFAULT_LEVERAGE, 100)
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG, '11'), 500)
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG, '22'), 100)
  setState(db, 'account_leverage', '2')
  setState(db, 'acct:11:account_leverage', '10')
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG, '22'), 100)
  assert.deepEqual(getAccountLeverageEvidence(db, '22'), {
    accountId: '22', value: 100, source: 'assumed_default', verified: false, observedAt: null, reason: 'leverage_missing',
  })
})

test('selected scope is isolated too; no-account legacy behaviour remains labelled', t => {
  const db = fixture(t)
  setState(db, 'ctrader_account_id', '22')
  assert.equal(getAccountLeverage(db, {}), 100)
  assert.equal(getAccountLeverageEvidence(db).accountId, '22')
  setState(db, 'ctrader_account_id', null)
  assert.equal(getAccountLeverage(db, {}), 1000)
  assert.equal(getAccountLeverageEvidence(db).source, 'legacy_global')
  assert.equal(getAccountLeverageEvidence(db).verified, false)
})

test('invalid own leverage never falls through; valid fractional broker ratios remain usable but unverified', t => {
  const db = fixture(t)
  for (const raw of ['', '0', '-1', 'NaN', 'Infinity', 'bad']) {
    setState(db, 'acct:22:account_leverage', raw)
    assert.equal(getAccountLeverage(db, {}, '22'), 100, raw)
    assert.equal(getAccountLeverageEvidence(db, '22').source, 'assumed_default')
  }
  setState(db, 'acct:22:account_leverage', '33.33')
  assert.equal(getAccountLeverage(db, {}, '22'), 33.33)
  assert.equal(getAccountLeverageEvidence(db, '22').source, 'account_stored')
  assert.equal(getAccountLeverageEvidence(db, '22').observedAt, null)
})

test('the real margin pool estimates the account with its own/default leverage and records the assumption', t => {
  const db = fixture(t)
  const trade = db.prepare("INSERT INTO trades (symbol, side, entry_price, volume, status, account_id) VALUES ('EURUSD', 'BUY', 1.1, 1, 'open', '22')").run().lastInsertRowid
  db.prepare("INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status, account_id) VALUES ('EURUSD', ?, 'long', 1.1, 'active', '22')").run(trade)
  const row = accountMarginPool(db, DEFAULT_RISK_CONFIG, ['22'])[0]
  assert.equal(Math.round(row.status.usedMargin), 1100, 'not the $110 estimated using another account/global 1:1000')
  assert.equal(row.leverageEvidence.source, 'assumed_default')
  setState(db, 'acct:22:account_leverage', '200')
  assert.equal(Math.round(accountMarginPool(db, DEFAULT_RISK_CONFIG, ['22'])[0].status.usedMargin), 550)
})

test('an entry verdict names leverage evidence even when an earlier gate refuses the trade', t => {
  const db = fixture(t)
  const result = evaluateTrade(db, { accountId: '22', symbol: 'EURUSD', side: 'long', entry: 1.1, sl: 1.09, tp1: 1.13, volume: 0.01 }, { ...DEFAULT_RISK_CONFIG, blockedSymbols: ['EURUSD'] })
  assert.equal(result.approved, false)
  assert.equal(result.checks.leverage, 100)
  assert.equal(result.checks.leverage_evidence.accountId, '22')
  assert.equal(result.checks.leverage_evidence.source, 'assumed_default')
})

test('risk-config and watchlist HTTP reports expose the same isolated leverage evidence', async t => {
  const db = fixture(t)
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const get = path => fetch(`http://127.0.0.1:${server.address().port}/state${path}`).then(r => r.json())
  const config = await get('/risk-config?account=22')
  assert.equal(config.derived.leverage, 100)
  assert.equal(config.leverageEvidence.source, 'assumed_default')
  const lists = await get('/watchlists')
  const account = lists.accounts.find(a => a.accountId === '22')
  assert.equal(account.leverage, 100)
  assert.deepEqual(account.leverageEvidence, config.leverageEvidence)
})
