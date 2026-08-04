// node --test agent/services/account-chrome.test.js
//
// The chrome line is on every page, so a wrong number here is wrong
// everywhere at once. These tests pin the two things that make it worth
// trusting: it reports the SAME drawdown the equity stop acts on, and it
// never renders an unknown as a zero.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { accountChrome, tradeCount24h, flagFor } from './account-chrome.js'
import { accountPnlToday } from './equity-stop.js'
import { fxDayStartSql, loadRiskConfig } from './risk.js'
import { clampToFxDay } from '../test-support/fx-day.js'

function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode, base_currency)
              VALUES ('46130058', '5203012', 0, 1, 'active', 'USD')`).run()
  setState(db, 'acct:46130058:account_balance_usd', '50000')
  setState(db, 'acct:46130058:risk_config_json', JSON.stringify({ equityStopPct: 0.08 }))
  setState(db, 'ctrader_account_id', '46130058')
  return db
}

function closed(db, { pnl, minsAgo = 30, account = '46130058' }) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, closed_at, net_pnl, account_id)
    VALUES ('EURUSD', 'BUY', 1.1, 0.1, 'closed', datetime('now', ?), ?, ?, ?)
  `).run(`-${minsAgo + 60} minutes`, clampToFxDay(minsAgo), pnl, account)
}

function openPos(db, account = '46130058') {
  const t = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id)
                        VALUES ('GBPUSD','BUY',1.2,0.1,'open',datetime('now'),?)`).run(account).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status, account_id)
              VALUES ('GBPUSD', ?, 'long', 1.2, 'active', ?)`).run(t, account)
}

test('the drawdown is the equity stop\'s own number, not a second calculation', () => {
  const db = fresh()
  closed(db, { pnl: -1200 })
  openPos(db)

  const row = accountChrome(db)[0]
  // Same inputs, same functions the circuit calls — if these ever diverge the
  // screen and the stop are telling the operator different things.
  const direct = accountPnlToday(db, '46130058', fxDayStartSql())
  assert.equal(row.drawdown.pnl, direct.pnl)
  assert.equal(row.drawdown.cap, 50000 * 0.08)
  assert.equal(row.drawdown.stopPct, loadRiskConfig(db, '46130058').equityStopPct)
  assert.equal(row.drawdown.headroom, 4000 - 1200)
  assert.ok(Math.abs(row.drawdown.spent - 1200 / 4000) < 1e-9)
})

test('an unknown P&L is counted, not summed as zero', () => {
  const db = fresh()
  closed(db, { pnl: -500 })
  closed(db, { pnl: null })
  openPos(db)

  const row = accountChrome(db)[0]
  assert.equal(row.drawdown.unknownCount, 1)
  assert.equal(row.drawdown.trustworthy, false,
    'with an unresolved trade the figure is a FLOOR — the chrome must say so rather than present it as a total')
  assert.equal(row.drawdown.pnl, -500, 'the NULL contributes nothing rather than a zero that looks like a flat trade')
})

test('a profitable day reports no drawdown rather than 0% of the way to the stop', () => {
  const db = fresh()
  closed(db, { pnl: 900 })
  openPos(db)
  const row = accountChrome(db)[0]
  assert.equal(row.drawdown.spent, 0)
  assert.ok(row.drawdown.pnl > 0)
})

test('no usable cap reports null rather than implying safety', () => {
  const db = fresh()
  setState(db, 'acct:46130058:risk_config_json', JSON.stringify({ equityStopPct: null, dailyLossLimit: null }))
  closed(db, { pnl: -800 })
  openPos(db)
  const row = accountChrome(db)[0]
  assert.equal(row.drawdown.cap, null)
  assert.equal(row.drawdown.spent, null, 'unknowable is null, not 0 — 0 reads as "nowhere near the stop"')
})

test('the 24h count is scoped to the account and splits loss from profit', () => {
  const db = fresh()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode, base_currency)
              VALUES ('47790949', '5306502', 0, 1, 'active', 'USD')`).run()
  closed(db, { pnl: -300, minsAgo: 60 })
  closed(db, { pnl: 250, minsAgo: 90 })
  closed(db, { pnl: -999, minsAgo: 60, account: '47790949' })

  const d = tradeCount24h(db, '46130058')
  assert.equal(d.trades, 2)
  assert.equal(d.wins, 1)
  assert.equal(d.losses, 1)
  assert.equal(d.profit, 250)
  assert.equal(d.loss, 300, 'loss is reported POSITIVE — the UI adds its own minus')
  assert.equal(tradeCount24h(db, '47790949').loss, 999, 'the other account is not mixed in')
})

test('a trade older than 24h is outside the window', () => {
  const db = fresh()
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, closed_at, net_pnl, account_id)
    VALUES ('EURUSD','BUY',1.1,0.1,'closed',datetime('now','-4 days'),datetime('now','-3 days'),-4000,'46130058')
  `).run()
  assert.equal(tradeCount24h(db, '46130058').trades, 0)
})

test('armed state comes from the arming helper, and the LIVE flag survives', () => {
  const db = fresh()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode, base_currency)
              VALUES ('42993489', '1251247', 1, 0, 'manage_only', 'USD')`).run()
  const rows = accountChrome(db)
  const live = rows.find(r => r.accountId === '42993489')
  assert.equal(live.isLive, true)
  assert.equal(live.enabled, false)
  assert.equal(live.armed, false, 'manage_only is not armed')
  assert.equal(rows.find(r => r.accountId === '46130058').armed, true)
})

test('a currency with no flag renders no flag rather than a wrong one', () => {
  assert.equal(flagFor('USD'), '🇺🇸')
  assert.equal(flagFor('HKD'), '🇭🇰')
  // XAU is a metal, not a country. A codepoint trick on the first two letters
  // would confidently produce a flag for a currency that has none.
  assert.equal(flagFor('XAU'), null)
  assert.equal(flagFor(null), null)
  assert.equal(flagFor('nonsense'), null)
})

test('an empty registry returns an empty list, not a throw', () => {
  const db = initDB(':memory:')
  assert.deepEqual(accountChrome(db), [])
})
