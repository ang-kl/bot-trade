// node --test agent/services/global-guards.test.js
//
// 5A global capital protection: portfolio-wide guards that only ever ADD
// vetoes on top of per-account limits, default fully off, and fail safe
// (halt) when an EXISTING config is unreadable.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { loadGlobalGuards, evaluateGlobalGuards, DEFAULT_GLOBAL_GUARDS } from './global-guards.js'
import { evaluateTrade, DEFAULT_RISK_CONFIG } from './risk.js'
import { fmtGuards, setGlobalHalt } from './telegram-control.js'

function fresh() {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, 'account_leverage', '100')
  setState(db, 'ctrader_account_id', 'A')
  return db
}

function insertClosedTrade(db, { account, pnl }) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, status, net_pnl, closed_at, account_id, opened_at)
    VALUES ('EURUSD', 'BUY', 1.1, 'closed', ?, datetime('now', '-10 minutes'), ?, datetime('now', '-70 minutes'))
  `).run(pnl, account)
}

function insertOpenTrade(db, { account, symbol }) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id)
    VALUES (?, 'BUY', 100, 0.1, 'open', datetime('now'), ?)
  `).run(symbol, account)
}

const proposal = (account) => ({
  symbol: 'GBPUSD', side: 'BUY', entry: 1.25, sl: 1.245, tp1: 1.26,
  requestedVolume: 0.01, accountId: account,
})

test('defaults: no global_guards_json → all guards off, gate untouched', () => {
  const db = fresh()
  assert.deepEqual(loadGlobalGuards(db), DEFAULT_GLOBAL_GUARDS)
  assert.equal(evaluateGlobalGuards(db).ok, true)
  const res = evaluateTrade(db, proposal('A'), { ...DEFAULT_RISK_CONFIG })
  assert.equal(res.approved, true, `expected clean approval, got: ${res.veto_reason}`)
})

test('fail-safe: an unreadable EXISTING config halts; a missing one does not', () => {
  const db = fresh()
  setState(db, 'global_guards_json', '{corrupt!!')
  const g = loadGlobalGuards(db)
  assert.equal(g.halt, true)
  const out = evaluateGlobalGuards(db)
  assert.equal(out.ok, false)
  assert.match(out.reason, /global_halt/)
  const res = evaluateTrade(db, proposal('A'), { ...DEFAULT_RISK_CONFIG })
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /global_halt/)
})

test('global halt vetoes every account', () => {
  const db = fresh()
  setState(db, 'global_guards_json', JSON.stringify({ halt: true }))
  for (const acct of ['A', 'B']) {
    const res = evaluateTrade(db, proposal(acct), { ...DEFAULT_RISK_CONFIG })
    assert.equal(res.approved, false)
    assert.match(res.veto_reason, /global_halt/)
  }
})

test('portfolio daily-loss cap sums across ALL accounts and gates every account', () => {
  const db = fresh()
  // Each account is individually fine (−$200 each vs $300 per-account cap on
  // $10k) but together breach the $350 portfolio cap.
  insertClosedTrade(db, { account: 'A', pnl: -200 })
  insertClosedTrade(db, { account: 'B', pnl: -200 })
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 350 }))
  for (const acct of ['A', 'B']) {
    const res = evaluateTrade(db, proposal(acct), { ...DEFAULT_RISK_CONFIG, dailyLossPct: 0.03 })
    assert.equal(res.approved, false, `portfolio cap must gate ${acct}`)
    assert.match(res.veto_reason, /portfolio_daily_loss/)
    assert.equal(res.checks.portfolio_daily_pnl, -400)
  }
  // Loosening the portfolio cap un-gates them (per-account caps not hit).
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 500 }))
  const res = evaluateTrade(db, proposal('B'), { ...DEFAULT_RISK_CONFIG, dailyLossPct: 0.03 })
  assert.equal(res.approved, true, `expected approval under looser cap, got: ${res.veto_reason}`)
})

test('total open-position cap counts across ALL accounts', () => {
  const db = fresh()
  insertOpenTrade(db, { account: 'A', symbol: 'XAUUSD' })
  insertOpenTrade(db, { account: 'A', symbol: 'US30' })
  insertOpenTrade(db, { account: 'B', symbol: 'NATGAS' })
  setState(db, 'global_guards_json', JSON.stringify({ maxTotalOpenPositions: 3 }))
  // B has only 1 open position (well under the per-account cap of 5) but the
  // PORTFOLIO is at its cap of 3 — B is gated by A's positions, on purpose.
  const res = evaluateTrade(db, proposal('B'), { ...DEFAULT_RISK_CONFIG })
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /portfolio_position_cap/)
  assert.equal(res.checks.portfolio_open_positions, 3)
})

test('telegram /haltall & /resumeall: flip only the halt knob, preserve other stored guards', () => {
  const db = fresh()
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 500 }))
  const on = setGlobalHalt(db, true)
  assert.equal(on.ok, true)
  assert.match(on.reply, /GLOBAL HALT/)
  assert.deepEqual(loadGlobalGuards(db), { ...DEFAULT_GLOBAL_GUARDS, halt: true, portfolioDailyLossUsd: 500 })
  const resHalted = evaluateTrade(db, proposal('A'), { ...DEFAULT_RISK_CONFIG })
  assert.match(resHalted.veto_reason, /global_halt/)
  const off = setGlobalHalt(db, false)
  assert.equal(off.ok, true)
  assert.deepEqual(loadGlobalGuards(db), { ...DEFAULT_GLOBAL_GUARDS, halt: false, portfolioDailyLossUsd: 500 })
})

test('telegram /resumeall refuses to overwrite an unreadable config (fail-safe halt stays)', () => {
  const db = fresh()
  setState(db, 'global_guards_json', '{corrupt!!')
  const out = setGlobalHalt(db, false)
  assert.equal(out.ok, false)
  assert.match(out.reply, /unreadable/)
  // Fail-safe halt still enforced.
  assert.equal(loadGlobalGuards(db).halt, true)
  // …but /haltall on a corrupt config IS allowed (halting is always safe).
  const on = setGlobalHalt(db, true)
  assert.equal(on.ok, true)
  assert.equal(loadGlobalGuards(db).halt, true)
})

test('telegram /guards panel reflects config and live portfolio numbers', () => {
  const db = fresh()
  insertClosedTrade(db, { account: 'A', pnl: -120 })
  insertOpenTrade(db, { account: 'B', symbol: 'XAUUSD' })
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 500, maxTotalOpenPositions: 4 }))
  const text = fmtGuards(db)
  assert.match(text, /halt: off/)
  assert.match(text, /\$500/)
  assert.match(text, /today across accounts: \$-120\.00/)
  assert.match(text, /open positions across accounts: 1/)
  assert.match(text, /allowing new entries/)
})

test('asymmetric merge: global guards never loosen a per-account veto', () => {
  const db = fresh()
  // A blows its own per-account daily cap; generous global settings must
  // not rescue it.
  insertClosedTrade(db, { account: 'A', pnl: -400 })
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 100000, maxTotalOpenPositions: 1000 }))
  const res = evaluateTrade(db, proposal('A'), { ...DEFAULT_RISK_CONFIG, dailyLossPct: 0.03 })
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /daily_loss_limit_hit/)
})

test('telegram /status account lines: only with 2+ enabled accounts, per-account balance and opens', async () => {
  const { fmtAccountLines } = await import('./telegram-control.js')
  const db = fresh() // selected account A, global balance 10000
  const { syncSelectedAccount, upsertAccount } = await import('./account-registry.js')
  // Single enabled account → no lines (legacy /status untouched).
  syncSelectedAccount(db, 'A', false, '5306502')
  assert.deepEqual(fmtAccountLines(db), [])
  // Enable a second account with its own stamped balance.
  upsertAccount(db, { accountId: 'B', traderLogin: '5268549', isLive: false })
  db.prepare(`UPDATE accounts SET enabled = 1 WHERE account_id = 'B'`).run()
  setState(db, 'acct:B:account_balance_usd', '538.58')
  insertOpenTrade(db, { account: 'B', symbol: 'XAUUSD' })
  insertOpenTrade(db, { account: null, symbol: 'US30' }) // legacy NULL → selected A
  const lines = fmtAccountLines(db)
  assert.equal(lines.length, 2)
  const a = lines.find(l => l.includes('5306502'))
  const b = lines.find(l => l.includes('5268549'))
  assert.match(a, /▶/)
  assert.match(a, /\$10000\.00/)
  assert.match(a, /1 open/, 'legacy NULL open trade counts for the selected account')
  assert.match(b, /\$538\.58/)
  assert.match(b, /1 open/)
})
