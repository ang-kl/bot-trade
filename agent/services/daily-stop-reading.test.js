// node --test agent/services/daily-stop-reading.test.js
//
// WEB-2 (8,989-A row 4): the account card's daily stop is the cap the risk
// engine ENFORCES, read through the engine's own functions, in the unit the
// config states it in; loss-cap used is measured realised + floating loss ÷
// that cap, or null with the reason.
//
// The production shape these fixtures copy (GET /state/risk-full 25-09 13:37
// UTC, every account): dailyLossLimit 150, dailyLossPct 0.03, dailyLossFloorUsd
// 200, tier 3% / 4% at 10,000, no account overlay. Under it the card printed
// balance × 3% (−900 on 30,004.36) and /risk-full printed 150; the engine's
// verdict rows read 4% of the balance (1,191.42 on 29,785.52, 17-09).

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { evaluateTrade } from './risk.js'
import { dailyStopReading, lossCapUsed, DAILY_STOP_CURRENCY } from './daily-stop-reading.js'
import { clampToFxDay } from '../test-support/fx-day.js'
import stateRouter from '../routes/state.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'

const PROD_CFG = {
  dailyLossLimit: 150, dailyLossPct: 0.03,
  dailyLossFloorUsd: 200, dailyLossTierAtUsd: 10000, dailyLossTierSmallPct: 0.03, dailyLossTierLargePct: 0.04,
}

function fresh(cfg = PROD_CFG) {
  const db = initDB(':memory:')
  setState(db, 'risk_config_json', JSON.stringify(cfg))
  return db
}

function closed(db, account, pnl) {
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, net_pnl, closed_at, account_id, opened_at)
    VALUES ('EURUSD', 'BUY', 1.1, 'closed', ?, ?, ?, datetime('now', '-70 minutes'))`).run(pnl, clampToFxDay(10), account)
}

test('the card reads the engine cap — the 4% large tier on a 30,004 account, not balance × 3% and not the flat 150', () => {
  const db = fresh()
  setState(db, 'acct:46130058:account_balance_usd', '30004.36')
  const r = dailyStopReading(db, '46130058', { moneyCurrency: 'USD', openPnl: 0 })
  assert.equal(r.status, 'in_force')
  assert.equal(r.capUsd, 1200.17) // 30,004.36 × 4%
  assert.notEqual(r.capUsd, 900.13) // the old card: balance × dailyLossPct
  assert.notEqual(r.capUsd, 150) // /risk-full: the flat cap the tier rule took out of force
  assert.equal(r.binding, 'pct')
  assert.equal(r.parts.tierPct, 0.04)
  assert.equal(r.parts.flatInForceUsd, null)
  assert.equal(r.currency, 'USD')
  assert.equal(r.balanceUsed, 30004.36)
  assert.equal(r.dayAnchor, 'fx_day_17_00_new_york')
})

test('the USD 200 floor binds on small, unfunded and unstamped accounts — never a −0 or a −20.87 stop', () => {
  const db = fresh()
  setState(db, 'acct:46979908:account_balance_usd', '695.59')
  setState(db, 'acct:43002148:account_balance_usd', '0')
  for (const [id, balanceUsed] of [['46979908', 695.59], ['43002148', 0], ['42993489', null]]) {
    const r = dailyStopReading(db, id, { moneyCurrency: 'USD', openPnl: 0 })
    assert.equal(r.capUsd, 200, id)
    assert.equal(r.binding, 'floor', id)
    assert.equal(r.parts.floorBinding, true, id)
    assert.equal(r.balanceUsed, balanceUsed, id)
    assert.match(r.explain, /USD 200\.00 floor binds/, id)
  }
})

test('parity: the reading equals the daily_cap_usd the risk gate stamps on its own verdict for the same account', () => {
  const db = fresh()
  // Tier (A), floor over the small tier (B), floor over the flat cap with no
  // balance stamped (D). A stamped zero is covered by the floor test above:
  // evaluateTrade itself throws on it past the daily step (portfolioMarginStatus
  // returns null for balance 0 at risk.js:845, read at :2349), which is not
  // this change's to fix.
  const cases = { A: '30004.36', B: '695.59', D: null }
  for (const [id, bal] of Object.entries(cases)) if (bal != null) setState(db, `acct:${id}:account_balance_usd`, bal)
  // An overlay the gate merges on top: the reading must follow it too.
  setState(db, 'acct:E:account_balance_usd', '44251.18')
  setState(db, 'acct:E:risk_config_json', JSON.stringify({ dailyLossTierLargePct: 0.02 }))
  closed(db, 'A', -40)
  for (const id of ['A', 'B', 'D', 'E']) {
    const gate = evaluateTrade(db, {
      symbol: 'GBPUSD', side: 'BUY', entry: 1.25, sl: 1.245, tp1: 1.2675, requestedVolume: 0.01, accountId: id,
    })
    assert.ok('daily_cap_usd' in gate.checks, `the gate reached the daily check for ${id}: ${gate.veto_reason}`)
    const r = dailyStopReading(db, id, { moneyCurrency: 'USD', openPnl: 0 })
    assert.equal(r.capUsd, gate.checks.daily_cap_usd, id)
    assert.equal(r.binding, gate.checks.daily_cap_binding, id)
    assert.equal(r.realisedTodayPnl, Number(gate.checks.daily_pnl.toFixed(2)), id)
  }
  assert.equal(dailyStopReading(db, 'E', { moneyCurrency: 'USD', openPnl: 0 }).capUsd, 885.02) // 44,251.18 × 2%
})

test('the reading follows the config it reads — flat cap in force when the tier rule is off', () => {
  const db = fresh({ ...PROD_CFG, dailyLossTierSmallPct: null, dailyLossTierLargePct: null, dailyLossFloorUsd: null })
  setState(db, 'acct:X:account_balance_usd', '30004.36')
  const r = dailyStopReading(db, 'X', { moneyCurrency: 'USD', openPnl: 0 })
  assert.equal(r.capUsd, 150)
  assert.equal(r.binding, 'usd')
})

test('both checks off: uncapped, said as such — no cap, no percentage', () => {
  const db = fresh({ ...PROD_CFG, dailyLossLimit: null, dailyLossPct: null, dailyLossFloorUsd: null, dailyLossTierSmallPct: null })
  setState(db, 'acct:X:account_balance_usd', '5000')
  const r = dailyStopReading(db, 'X', { moneyCurrency: 'USD', openPnl: -10 })
  assert.equal(r.status, 'uncapped')
  assert.equal(r.capUsd, null)
  assert.equal(r.lossCapUsed.status, 'uncapped')
  assert.equal(r.lossCapUsed.pct, null)
})

test('loss-cap used = (realised loss today + floating loss now) ÷ cap, from this account only', () => {
  const db = fresh()
  setState(db, 'acct:A:account_balance_usd', '30004.36')
  closed(db, 'A', -100)
  closed(db, 'A', 30)
  closed(db, 'B', -5000) // another account's loss must not reach A's card
  const r = dailyStopReading(db, 'A', { moneyCurrency: 'USD', openPnl: -50.5 })
  assert.equal(r.realisedTodayPnl, -70)
  assert.equal(r.lossCapUsed.status, 'measured')
  assert.equal(r.lossCapUsed.realisedLoss, 70)
  assert.equal(r.lossCapUsed.floatingLoss, 50.5)
  assert.equal(r.lossCapUsed.consumed, 120.5)
  assert.equal(r.lossCapUsed.pct, 10) // 120.5 / 1,200.17
  assert.equal(r.remainingUsd, 1130.17) // the engine's own remaining: cap − realised
})

test('a floating gain does not pay back a realised loss, and a day in profit uses none of the stop', () => {
  assert.deepEqual(
    lossCapUsed({ capUsd: 200, realisedTodayPnl: -100, openPnl: 500, unitsComparable: true, moneyCurrency: 'USD' }),
    { pct: 50, consumed: 100, realisedLoss: 100, floatingLoss: 0, status: 'measured', reason: null })
  assert.equal(lossCapUsed({ capUsd: 200, realisedTodayPnl: 40, openPnl: 0, unitsComparable: true, moneyCurrency: 'USD' }).pct, 0)
  // Past the stop is reported as measured, not clamped into a safer-looking 100.
  assert.equal(lossCapUsed({ capUsd: 200, realisedTodayPnl: -250, openPnl: -50, unitsComparable: true, moneyCurrency: 'USD' }).pct, 150)
})

test('floating not read → loss-cap used is "not read", never the realised part passed off as the whole', () => {
  const db = fresh()
  setState(db, 'acct:A:account_balance_usd', '30004.36')
  closed(db, 'A', -100)
  const r = dailyStopReading(db, 'A', { moneyCurrency: 'USD', openPnl: null })
  assert.equal(r.capUsd, 1200.17) // the stop itself is still read
  assert.equal(r.lossCapUsed.status, 'not_read')
  assert.equal(r.lossCapUsed.pct, null)
  assert.equal(r.lossCapUsed.realisedLoss, 100)
  assert.match(r.lossCapUsed.reason, /floating/)
})

test('a non-USD account shows the engine cap in USD, flags H-P2-4, and refuses a cross-unit percentage', () => {
  const db = fresh()
  setState(db, 'acct:42993489:account_balance_usd', '51.46') // native SGD under a _usd key (H-P2-4)
  const r = dailyStopReading(db, '42993489', { moneyCurrency: 'SGD', openPnl: 0 })
  assert.equal(r.capUsd, 200) // exactly what the engine enforces — no conversion, no limit change
  assert.equal(r.currency, DAILY_STOP_CURRENCY)
  assert.equal(r.unitsComparable, false)
  assert.match(r.unitsNote, /H-P2-4/)
  assert.match(r.unitsNote, /SGD/)
  assert.equal(r.lossCapUsed.status, 'not_comparable')
  assert.equal(r.lossCapUsed.pct, null)
  // Broker currency not read: the percentage is not read either.
  const u = dailyStopReading(db, '42993489', { moneyCurrency: null, openPnl: 0 })
  assert.equal(u.unitsComparable, null)
  assert.equal(u.lossCapUsed.status, 'not_read')
})

test('the engine\'s own block is carried: a day past its stop names daily_loss_limit_hit', () => {
  const db = fresh()
  setState(db, 'acct:B:account_balance_usd', '695.59')
  closed(db, 'B', -250)
  const r = dailyStopReading(db, 'B', { moneyCurrency: 'USD', openPnl: 0 })
  assert.equal(r.engineBlock?.guard, 'daily_loss_limit_hit')
  assert.equal(r.lossCapUsed.pct, 125)
})

test('an engine read that fails is "not_read" with the error named — it never throws into the route', () => {
  const db = fresh()
  db.exec('DROP TABLE trades')
  const r = dailyStopReading(db, 'A', { moneyCurrency: 'USD', openPnl: -5 })
  assert.equal(r.status, 'not_read')
  assert.equal(r.capUsd, null)
  assert.match(r.reason, /engine read failed/)
  assert.equal(r.lossCapUsed.status, 'not_read')
})

test('GET /state/account-overview carries each account\'s engine daily stop (the wiring the cards read)', async t => {
  const db = fresh(); t.after(() => db.close())
  for (const id of ['46130058', '43002148']) db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(?,0)').run(id)
  setState(db, 'acct:46130058:account_balance_usd', '30004.36')
  recordDepositCurrency(db, { accountId: '46130058', host: 'demo.ctraderapi.com', depositAssetId: '1', currency: 'USD' })
  recordAccountMoney(db, { accountId: '46130058', host: 'demo.ctraderapi.com', trader: { depositAssetId: '1' }, balance: 30004.36 })
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/state/account-overview`)).json()
  const row = id => body.accounts.find(a => a.accountId === id)
  assert.equal(row('46130058').dailyStop.capUsd, 1200.17)
  assert.equal(row('46130058').dailyStop.currency, 'USD')
  assert.equal(row('46130058').dailyStop.moneyCurrency, 'USD')
  // No complete fresh position reading in this fixture → floating unread → not read.
  assert.equal(row('46130058').dailyStop.lossCapUsed.status, 'not_read')
  assert.equal(row('43002148').dailyStop.capUsd, 200)
  assert.equal(row('43002148').dailyStop.binding, 'floor')
  // The old field is still present for any other reader; the cards no longer use it.
  assert.equal(row('46130058').dailyLossPct, 0.03)
})
