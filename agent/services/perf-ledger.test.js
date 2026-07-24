// node --test agent/services/perf-ledger.test.js
//
// Performance Ledger aggregation: anchors, categorization, outcome
// classification, carry-forward reconciliation, market cells, edge maths.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  categorize, dayAnchor, weekAnchor, ledgerWindows, classifyOutcome,
  plannedRr, buildPerfLedger, closedAtMs,
} from './perf-ledger.js'

test('categorize: six markets + stocks ride index, unknowns other', () => {
  assert.equal(categorize('BTCUSD'), 'crypto')
  assert.equal(categorize('EURUSD'), 'fx')
  assert.equal(categorize('USDIDR'), 'fx')
  assert.equal(categorize('US30'), 'index')
  assert.equal(categorize('MCHP.US'), 'index')
  assert.equal(categorize('XAUUSD'), 'metal')
  assert.equal(categorize('NATGAS'), 'energy')
  assert.equal(categorize('WHEAT'), 'grain')
  assert.equal(categorize('???'), 'other')
})

test('anchors: day rolls at 22:00 UTC; week anchors Sunday 22:00 UTC', () => {
  // Wed 2026-07-22 10:00 UTC → day anchor Tue 21st 22:00; week anchor Sun 19th 22:00
  const now = Date.UTC(2026, 6, 22, 10)
  assert.equal(dayAnchor(now), Date.UTC(2026, 6, 21, 22))
  assert.equal(weekAnchor(now), Date.UTC(2026, 6, 19, 22))
  // Wed 23:00 UTC → day anchor is the SAME day's 22:00
  assert.equal(dayAnchor(Date.UTC(2026, 6, 22, 23)), Date.UTC(2026, 6, 22, 22))
  // Windows list is complete and ordered
  const keys = ledgerWindows(now).map(w => w.key)
  assert.deepEqual(keys, ['1h', '4h', '12h', 'yesterday', '3d', 'wtd', '1w', '2w', '30d', 'mtd', 'lastmonth', '3m', '6m', '12m'])
})

test('classifyOutcome + plannedRr + closedAtMs tolerate real row shapes', () => {
  assert.equal(classifyOutcome({ close_reason: 'TP hit at broker' }), 'tp')
  assert.equal(classifyOutcome({ close_reason: 'stop loss swept' }), 'sl')
  assert.equal(classifyOutcome({ close_reason: 'partial scale-out banked' }), 'part')
  assert.equal(classifyOutcome({ close_reason: 'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot', exit_price: 100, sl_price: 100.05 }), 'sl')
  assert.equal(classifyOutcome({ close_reason: 'owner closed from app', exit_price: 105, sl_price: 90, tp_price: 120 }), 'manual')
  assert.equal(plannedRr({ entry_price: 100, sl_price: 95, tp_price: 110 }), 2)
  assert.equal(plannedRr({ entry_price: 100, sl_price: null, tp_price: 110 }), null)
  // space-separated closed_at (production shape) parses
  assert.equal(closedAtMs({ closed_at: '2026-07-22 10:00:00' }), Date.UTC(2026, 6, 22, 10))
  assert.equal(closedAtMs({ closed_at: '2026-07-22T10:00:00Z' }), Date.UTC(2026, 6, 22, 10))
})

function seed(db, { symbol, pnl, hoursAgo, now, account = 'A', entry = 100, sl = 95, tp = 110, reason = null }) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, status, net_pnl, closed_at, close_reason, account_id, opened_at)
    VALUES (?, 'BUY', ?, ?, ?, 'closed', ?, ?, ?, ?, datetime('now','-1 day'))
  `).run(symbol, entry, sl, tp, pnl, new Date(now - hoursAgo * 3600_000).toISOString().replace('T', ' ').slice(0, 19), reason, account)
}

test('buildPerfLedger: carry-forward reconciles, market cells split, account scoping', () => {
  const db = initDB(':memory:')
  const now = Date.UTC(2026, 6, 22, 12)
  setState(db, 'account_balance_usd', '10000')
  // Three trades: crypto win 2h ago (+200), fx loss 6h ago (−100), metal win 30h ago (+50, yesterday)
  seed(db, { symbol: 'BTCUSD', pnl: 200, hoursAgo: 2, now, reason: 'TP hit' })
  seed(db, { symbol: 'EURUSD', pnl: -100, hoursAgo: 6, now, reason: 'stop loss' })
  seed(db, { symbol: 'XAUUSD', pnl: 50, hoursAgo: 30, now, reason: 'TP hit' })

  const led = buildPerfLedger(db, { now, balance: 10000 })
  const by = Object.fromEntries(led.windows.map(w => [w.key, w]))

  // 4H window: only the BTC win. carryOut = balance − nothing after = 10000.
  assert.equal(by['4h'].net, 200)
  assert.equal(by['4h'].carryOut, 10000)
  assert.equal(by['4h'].carryIn, 9800)
  assert.equal(by['4h'].markets.crypto.net, 200)
  assert.equal(by['4h'].markets.fx.trades, 0)

  // 12H: BTC + EUR → net 100, tp 1 sl 1, win% 50, carryIn 9900.
  assert.equal(by['12h'].net, 100)
  assert.equal(by['12h'].tp, 1)
  assert.equal(by['12h'].sl, 1)
  assert.equal(by['12h'].winPct, 50)
  assert.equal(by['12h'].carryIn, 9900)
  // avg planned RR 2 → required 33.3, edge 16.7
  assert.equal(by['12h'].requiredWinPct, 33.3)
  assert.equal(by['12h'].edge, 16.7)

  // Yesterday (22:00 anchors): the metal trade (30h ago = July 21 06:00,
  // inside [20th 22:00, 21st 22:00)). Its carryOut excludes today's ±100+200:
  assert.equal(by['yesterday'].net, 50)
  assert.equal(by['yesterday'].carryOut, 9900) // 10000 − (200−100) after the window
  assert.equal(by['yesterday'].carryIn, 9850)
  assert.equal(by['yesterday'].markets.metal.net, 50)

  // Reconciliation: 30D carryIn + net = carryOut = balance.
  assert.equal(by['30d'].carryIn + by['30d'].net, by['30d'].carryOut)
  assert.equal(by['30d'].carryOut, 10000)
  assert.equal(by['30d'].net, 150)

  // Account scoping: account B sees nothing (strict NULL-tolerant scope
  // still includes NULL rows, but these are stamped 'A').
  const ledB = buildPerfLedger(db, { now, accountId: 'B', balance: 500 })
  const b30 = ledB.windows.find(w => w.key === '30d')
  assert.equal(b30.net, 0)
  assert.equal(b30.trades, 0)
  assert.equal(b30.carryIn, 500)
})
