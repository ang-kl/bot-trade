// node --test agent/services/entry-account-scope.test.js
//
// EVERY ENTRY PATH MUST GATE THE ACCOUNT IT IS ABOUT TO TRADE.
//
// Measured on production 2026-08-04: six 0005.HK positions on account
// 43097342, all stamped opened_at 01:40:40, six distinct broker fills, every
// one adopted with the thesis "reconciled; local row was missing". The day
// before, nine 0066.HK the same way on the same account. Meanwhile all 400
// risk_events in the 07:37Z-09:54Z window carried account_id 47790949 and
// nothing else, and the decision_log for 0005.HK was 45 rows on 47790949
// saying "strategy 'vwap_trend' is OFF" -> skip.
//
// The seam was never missing. `evaluateTrade` has read `proposal.accountId`
// since M1b, with a fallback to the selected account documented as
// "behaviour-identical in the single-account era". That era ended when a
// second account was enabled, and no bot entry path ever filled the field
// in. So the duplicate-symbol check read account A's monitored_positions
// while the order was placed with account B's creds; the next cycle found A
// still clean and approved again, and again.
//
// This file pins the contract at the level that failed — the QUERY, not the
// arithmetic. A gate that reads the wrong book is not a stricter gate or a
// looser one, it is a gate answering a question nobody asked.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { evaluateTrade, DEFAULT_RISK_CONFIG } from './risk.js'

function fresh() {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, 'account_leverage', '100')
  // The SELECTED account is deliberately not the one under test — that is
  // exactly the production shape, and a test that selects the account it
  // asserts on cannot tell the fallback from the fix.
  setState(db, 'ctrader_account_id', 'SELECTED')
  return db
}

function openPositionOn(db, account, symbol) {
  const tradeId = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id)
    VALUES (?, 'BUY', 100, 0.1, 'open', datetime('now'), ?)
  `).run(symbol, account).lastInsertRowid
  db.prepare(`
    INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status, account_id)
    VALUES (?, ?, 'long', 100, 'active', ?)
  `).run(symbol, tradeId, account)
}

const proposalFor = (account) => ({
  symbol: '0005.HK', side: 'BUY', entry: 100, sl: 95, tp1: 115,
  requestedVolume: 0.1, strategy: 'vwap_trend', source: 'auto_signal',
  ...(account === undefined ? {} : { accountId: account }),
})

test('a duplicate on the TRADING account is vetoed even when the selected account is clean', () => {
  const db = fresh()
  openPositionOn(db, 'TRADING', '0005.HK')

  const r = evaluateTrade(db, proposalFor('TRADING'), DEFAULT_RISK_CONFIG)
  assert.equal(r.approved, false)
  assert.match(r.veto_reason, /duplicate_symbol/,
    'the position is on TRADING and the proposal names TRADING — this is the veto that did not fire six times')
  assert.equal(r.checks.account_id, 'TRADING')
})

test('the same proposal WITHOUT an accountId reads the selected account and approves — the production bug, pinned', () => {
  const db = fresh()
  openPositionOn(db, 'TRADING', '0005.HK')

  // Not a wish: this documents what the fallback still does, so that if
  // anyone ever removes the accountId from a call site the failure has a
  // named shape in the suite rather than surfacing as broker positions.
  const r = evaluateTrade(db, proposalFor(undefined), DEFAULT_RISK_CONFIG)
  assert.equal(r.checks.account_id, 'SELECTED')
  assert.equal(r.checks.account_source, 'selected',
    'an inferred account must be visible in checks_json, not silently identical to a deliberate one')
  assert.ok(!/duplicate_symbol/.test(r.veto_reason || ''),
    'SELECTED holds no 0005.HK, so the gate cannot see the one on TRADING — this is precisely how six fills happened')
})

test('an explicit account is reported as explicit', () => {
  const db = fresh()
  const r = evaluateTrade(db, proposalFor('TRADING'), DEFAULT_RISK_CONFIG)
  assert.equal(r.checks.account_source, 'proposal')
})

test('max_positions counts the trading account, not the selected one', () => {
  const db = fresh()
  const cfg = { ...DEFAULT_RISK_CONFIG, maxOpenPositions: 2 }
  for (const s of ['AAA', 'BBB']) openPositionOn(db, 'TRADING', s)

  const r = evaluateTrade(db, { ...proposalFor('TRADING'), symbol: 'CCC' }, cfg)
  assert.equal(r.approved, false)
  assert.match(r.veto_reason, /max_positions=2\/2/,
    'the cap is per account; reading the selected account would have let TRADING run unbounded')
})

// ---------------------------------------------------------------------------
// The call sites themselves. The behaviour above is only worth anything if
// every path that can place an order actually passes the account, and that is
// a property of the SOURCE, not of any single run — a path can be correct in
// the suite and still omit the field on the branch production takes.
// ---------------------------------------------------------------------------

const ENTRY_PATHS = [
  ['../loop.js', 'autoTrade — market orders'],
  ['./pending-orders.js', 'fib pending limit orders'],
  ['./closed-market-limits.js', 'closed-market resting limits'],
  ['../routes/actions.js', 'manual /actions routes'],
]

test('every entry path names the account on the proposal it gates', () => {
  for (const [rel, label] of ENTRY_PATHS) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    // Each proposal literal that reaches evaluateTrade is built within a few
    // dozen lines of the call. Rather than parse, assert the two facts that
    // together make the gate and the order agree.
    assert.ok(/accountId[,:]/.test(src), `${label}: no accountId on any proposal`)
    // Scoped narrowly on purpose. Plenty of loadRiskConfig(db) calls in this
    // codebase are correctly global — the risk matrix's Global column, the
    // config-patch routes, the portfolio margin gate at loop.js:1229 which is
    // cross-account BY DESIGN. Only the config that feeds a gate whose verdict
    // becomes an order has to name an account, so only that shape is banned.
    assert.ok(
      !/evaluateTrade\(\s*db\s*,\s*\w+\s*,\s*loadRiskConfig\(db\)\s*\)/.test(src),
      `${label}: gating on an unscoped config drops that account's risk overlay`,
    )
  }
})
