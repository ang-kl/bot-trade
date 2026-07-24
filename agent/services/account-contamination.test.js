// node --test agent/services/account-contamination.test.js
//
// Multi-account plan M5 contamination test (built in M1b, extended as more
// reads scope): run two accounts through overlapping trade lifecycles and
// assert AT THE QUERY LEVEL that account-scoped reads never see the other
// account's rows — not merely that final balances happen to match.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { evaluateTrade, DEFAULT_RISK_CONFIG, drawdownDeriskFactor } from './risk.js'
import { computeDecayKeys } from './lessons-tuner.js'

function fresh() {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, 'account_leverage', '100')
  setState(db, 'ctrader_account_id', 'A')
  return db
}

function insertClosedTrade(db, { account, symbol = 'EURUSD', pnl, closedAgoMin = 10 }) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, status, net_pnl, closed_at, account_id, opened_at)
    VALUES (?, 'BUY', 1.1, 'closed', ?, datetime('now', ?), ?, datetime('now', ?))
  `).run(symbol, pnl, `-${closedAgoMin} minutes`, account, `-${closedAgoMin + 60} minutes`)
}

function insertOpenPosition(db, { account, symbol }) {
  const tradeId = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id)
    VALUES (?, 'SELL', 2400, 0.1, 'open', datetime('now'), ?)
  `).run(symbol, account).lastInsertRowid
  db.prepare(`
    INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status, account_id)
    VALUES (?, ?, 'short', 2400, 'active', ?)
  `).run(symbol, tradeId, account)
}

const proposalFor = (account, over = {}) => ({
  symbol: 'GBPUSD', side: 'BUY', entry: 1.25, sl: 1.245, tp1: 1.26,
  requestedVolume: 0.01, accountId: account, ...over,
})

// Two accounts, overlapping lifecycles: A is deep in losses and heavy with
// positions; B is clean. B's gate must not feel ANY of A's state.
test('contamination: daily loss, streak, and open positions never cross accounts', () => {
  const db = fresh()
  // A: blown day (−$500) + 3-loss streak + 3 open positions.
  insertClosedTrade(db, { account: 'A', pnl: -200, closedAgoMin: 30 })
  insertClosedTrade(db, { account: 'A', pnl: -150, closedAgoMin: 20 })
  insertClosedTrade(db, { account: 'A', pnl: -150, closedAgoMin: 10 })
  insertOpenPosition(db, { account: 'A', symbol: 'XAUUSD' })
  insertOpenPosition(db, { account: 'A', symbol: 'US30' })
  insertOpenPosition(db, { account: 'A', symbol: 'NATGAS' })
  // B: one healthy win, no open positions.
  insertClosedTrade(db, { account: 'B', pnl: +50, closedAgoMin: 15 })

  const cfg = { ...DEFAULT_RISK_CONFIG, dailyLossPct: 0.03, maxConsecutiveLosses: 3, maxOpenPositions: 3 }

  // A's own gate: vetoed on its own daily loss (500 > 300 cap).
  const resA = evaluateTrade(db, proposalFor('A'), cfg)
  assert.equal(resA.approved, false)
  assert.match(resA.veto_reason, /daily_loss_limit_hit/)
  assert.equal(resA.checks.account_id, 'A')
  assert.equal(resA.checks.daily_pnl, -500)

  // B's gate: none of A's losses, streak, or positions leak in.
  const resB = evaluateTrade(db, proposalFor('B'), cfg)
  assert.equal(resB.checks.account_id, 'B')
  assert.equal(resB.checks.daily_pnl, 50, `B must see only its own P&L, saw ${resB.checks.daily_pnl}`)
  assert.equal(resB.checks.loss_streak, 0, 'account A streak must not cool B down')
  assert.equal(resB.checks.open_positions, 0, 'account A positions must not count against B')
  assert.equal(resB.approved, true, `B expected clean approval, got: ${resB.veto_reason}`)
})

test('contamination: legacy NULL rows count for every account (stricter, never looser)', () => {
  const db = fresh()
  insertClosedTrade(db, { account: null, pnl: -400, closedAgoMin: 5 }) // pre-backfill legacy row
  const res = evaluateTrade(db, proposalFor('B'), { ...DEFAULT_RISK_CONFIG, dailyLossPct: 0.03 })
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /daily_loss_limit_hit/)
})

test('contamination: balance and leverage resolve per-account (M1c seam)', () => {
  const db = fresh() // global balance 10000, leverage 100, selected account A
  // B carries its own stamped equity — a small $1,000 account at 1:200.
  setState(db, 'acct:B:account_balance_usd', '1000')
  setState(db, 'acct:B:account_leverage', '200')

  const cfg = { ...DEFAULT_RISK_CONFIG, dailyLossPct: 0.03 }
  // A has no scoped keys → falls back to the legacy global values.
  const resA = evaluateTrade(db, proposalFor('A'), cfg)
  assert.equal(resA.checks.balance, 10000)
  assert.equal(resA.checks.leverage, 100)
  assert.equal(resA.checks.daily_cap_usd, 300)

  // B's gate sizes off B's OWN equity: cap = 3% of 1000, not of 10000.
  const resB = evaluateTrade(db, proposalFor('B'), cfg)
  assert.equal(resB.checks.balance, 1000, 'B must size off its own stamped balance')
  assert.equal(resB.checks.leverage, 200)
  assert.equal(resB.checks.daily_cap_usd, 30)

  // A $50 loss is nothing to A but breaches B's 3% cap ($30) — the SAME
  // loss row gates differently because the equity context differs.
  insertClosedTrade(db, { account: 'B', pnl: -50, closedAgoMin: 5 })
  const resB2 = evaluateTrade(db, proposalFor('B'), cfg)
  assert.equal(resB2.approved, false)
  assert.match(resB2.veto_reason, /daily_loss_limit_hit/)
  const resA2 = evaluateTrade(db, proposalFor('A'), cfg)
  assert.equal(resA2.checks.daily_pnl, 0, 'B loss must not appear in A daily sum')
})

test('contamination: drawdown de-risk and lesson decay stay per-account', () => {
  const db = fresh()
  // A tilts: −$600 in the window → factor 0.5 for A…
  insertClosedTrade(db, { account: 'A', pnl: -600, closedAgoMin: 30 })
  const cfg = { ...DEFAULT_RISK_CONFIG, deriskOnDrawdown: true, deriskWindowHours: 24, deriskTriggerPct: 0.05, deriskMult: 0.5 }
  assert.equal(drawdownDeriskFactor(db, 10000, cfg, 'A'), 0.5)
  // …but B keeps full size.
  assert.equal(drawdownDeriskFactor(db, 10000, cfg, 'B'), 1)

  // A's decayed edge must not cool the same edge for B.
  db.prepare(`
    INSERT INTO trade_postmortems (trade_id, symbol, strategy, timeframe, classification, alpha_decay, account_id)
    VALUES (1, 'EURUSD', 'rsi2_reversion', '1h', 'chop', 'decay', 'A')
  `).run()
  assert.ok(computeDecayKeys(db, 14, 'A').has('EURUSD|rsi2_reversion|1h'))
  assert.ok(!computeDecayKeys(db, 14, 'B').has('EURUSD|rsi2_reversion|1h'), 'A’s decay flag leaked into B')
})
