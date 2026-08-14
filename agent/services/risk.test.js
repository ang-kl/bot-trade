// node --test agent/services/risk.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  DEFAULT_RISK_CONFIG,
  evaluateTrade,
  currencyLegs,
  netExposure,
  kellyVolume,
  computeRiskBasedVolume,
  riskBudgetUsd,
  drawdownDeriskFactor,
  getAccountBalance,
  getAccountLeverage,
  requiredMargin,
  portfolioMarginStatus,
  evaluateCommissionCost,
  evaluateSlippageDrift, fxDayOpenMs, HARD_MIN_RR, expectancyVerdict
} from './risk.js'

// Helpers ------------------------------------------------------------------

function freshDB() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, entry_price REAL, exit_price REAL,
      sl_price REAL, tp_price REAL, volume REAL,
      opened_at TEXT, closed_at TEXT, hold_duration_ms INTEGER,
      gross_pnl REAL, net_pnl REAL, commission REAL, slippage_price REAL,
      status TEXT DEFAULT 'open',
      close_reason TEXT, thesis TEXT, strategy TEXT, conviction REAL,
      ctrader_position_id TEXT, analysis_id INTEGER, label_strategy TEXT,
      account_id TEXT
    );
    CREATE TABLE monitored_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, trade_id INTEGER, side TEXT,
      entry_price REAL, current_sl REAL, current_tp REAL,
      thesis TEXT, invalidation_trigger TEXT, time_cap_at TEXT,
      initial_risk REAL, mfe_r REAL, mae_r REAL,
      be_moved INTEGER, scaled_out INTEGER, strategy TEXT,
      last_check_action TEXT, last_check_reasoning TEXT,
      last_check_at TEXT, thesis_status TEXT, paused INTEGER,
      account_id TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE performance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_trades INTEGER, winning_trades INTEGER, losing_trades INTEGER,
      win_rate REAL, profit_factor REAL, sharpe_ratio REAL,
      max_drawdown_pct REAL, total_pnl REAL,
      avg_win REAL, avg_loss REAL, avg_rr REAL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT);
  `)
  return db
}

function goodProposal(overrides = {}) {
  return {
    symbol: 'EURUSD',
    side: 'long',
    entry: 1.1000,
    sl: 1.0970,     // 30 pip risk (0.27% of entry, above minSLDistancePct 0.15%)
    // RR = 3.5. Was 2.0, which every test below inherited while testing
    // something else entirely — so raising the floor to HARD_MIN_RR 3.0 made a
    // dozen unrelated cases fail on their fixture rather than on their subject.
    // 3.5 is the plan's target rather than the 3.0 boundary, so a case that
    // means to sit AT the floor has to say so explicitly.
    tp1: 1.1105,
    requestedVolume: 0.01,
    strategy: 'trend',
    conviction: 8,
    ...overrides,
  }
}

function insertClosedTrade(db, pnl, minsAgo = 1) {
  const closedAt = new Date(Date.now() - minsAgo * 60_000).toISOString()
  db.prepare(
    `INSERT INTO trades (symbol, side, net_pnl, status, closed_at)
     VALUES ('EURUSD', 'BUY', ?, 'closed', ?)`
  ).run(pnl, closedAt)
}

function insertOpenPosition(db, symbol, side) {
  db.prepare(
    `INSERT INTO monitored_positions (symbol, side, status) VALUES (?, ?, 'active')`
  ).run(symbol, side)
}

function setBalance(db, balance) {
  db.prepare(
    `INSERT INTO agent_state (key, value) VALUES ('account_balance_usd', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(balance))
}

function setLeverage(db, leverage) {
  db.prepare(
    `INSERT INTO agent_state (key, value) VALUES ('account_leverage', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(leverage))
}

// Tests below exercise gates that fire BEFORE the per-symbol re-entry
// cooldown; recent EURUSD closed trades would otherwise trip the 240m
// symbol_cooldown veto instead of the gate under test.
const NO_SYMBOL_COOLDOWN = { ...DEFAULT_RISK_CONFIG, symbolCooldownMinutes: 0 }

// Currency legs -----------------------------------------------------------

test('currencyLegs — long FX splits base/quote', () => {
  assert.deepEqual(currencyLegs('EURUSD', 'long'), { EUR: 1, USD: -1 })
  assert.deepEqual(currencyLegs('EURUSD', 'BUY'), { EUR: 1, USD: -1 })
})

test('currencyLegs — short FX flips signs', () => {
  assert.deepEqual(currencyLegs('GBPUSD', 'short'), { GBP: -1, USD: 1 })
})

test('currencyLegs — XAUUSD treats XAU as a currency', () => {
  assert.deepEqual(currencyLegs('XAUUSD', 'long'), { XAU: 1, USD: -1 })
})

test('currencyLegs — indices treated as single unit', () => {
  assert.deepEqual(currencyLegs('US30', 'long'), { US30: 1 })
  assert.deepEqual(currencyLegs('NAS100', 'short'), { NAS100: -1 })
})

// netExposure -------------------------------------------------------------

test('netExposure sums across positions + proposal', () => {
  const positions = [
    { symbol: 'EURUSD', side: 'long' },   // +EUR -USD
    { symbol: 'GBPUSD', side: 'long' },   // +GBP -USD
  ]
  const proposal = { symbol: 'AUDUSD', side: 'long' } // +AUD -USD
  const exp = netExposure(positions, proposal)
  assert.equal(exp.USD, -3)
  assert.equal(exp.EUR, 1)
  assert.equal(exp.GBP, 1)
  assert.equal(exp.AUD, 1)
})

test('netExposure — opposite USD legs cancel', () => {
  const positions = [
    { symbol: 'EURUSD', side: 'long' },    // +EUR -USD
    { symbol: 'USDJPY', side: 'long' },    // +USD -JPY
  ]
  const exp = netExposure(positions, null)
  assert.equal(exp.USD, 0)
})

// Daily loss limit --------------------------------------------------------

test('daily loss limit — under threshold approves', () => {
  const db = freshDB()
  insertClosedTrade(db, -50)
  const res = evaluateTrade(db, goodProposal(), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true, `expected approved, got veto: ${res.veto_reason}`)
})

test('daily loss limit — at threshold vetoes', () => {
  const db = freshDB()
  insertClosedTrade(db, -DEFAULT_RISK_CONFIG.dailyLossLimit)
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /daily_loss_limit_hit/)
})

test('daily loss limit — yesterdays loss does not count', () => {
  const db = freshDB()
  // Insert a loss from 2 days ago
  const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString()
  db.prepare(
    `INSERT INTO trades (symbol, net_pnl, status, closed_at)
     VALUES ('EURUSD', ?, 'closed', ?)`
  ).run(-500, twoDaysAgo)
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, true)
})

// Consecutive-loss cooldown ----------------------------------------------

test('3 consecutive losses triggers cooldown veto', () => {
  const db = freshDB()
  insertClosedTrade(db, -10, 3)
  insertClosedTrade(db, -10, 2)
  insertClosedTrade(db, -10, 1) // most recent
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /loss_streak_cooldown/)
})

test('streak broken by win → no cooldown', () => {
  const db = freshDB()
  insertClosedTrade(db, -10, 5)
  insertClosedTrade(db, -10, 4)
  insertClosedTrade(db, 20, 3)   // win breaks streak
  insertClosedTrade(db, -10, 2)
  insertClosedTrade(db, -10, 1)
  const res = evaluateTrade(db, goodProposal(), NO_SYMBOL_COOLDOWN)
  // streak is 2 (below 3) → should approve
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

test('cooldown expires after window', () => {
  const db = freshDB()
  // 3 losses 2h ago — cooldown is 60m so window passed
  insertClosedTrade(db, -10, 125)
  insertClosedTrade(db, -10, 122)
  insertClosedTrade(db, -10, 120)
  const res = evaluateTrade(db, goodProposal(), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true)
})

// Max open positions -----------------------------------------------------

test('max open positions vetoes at cap', () => {
  const db = freshDB()
  for (let i = 0; i < DEFAULT_RISK_CONFIG.maxOpenPositions; i++) {
    insertOpenPosition(db, `SYM${i}`, 'long')
  }
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /max_positions/)
})

// Duplicate symbol -------------------------------------------------------

test('duplicate symbol vetoes', () => {
  const db = freshDB()
  insertOpenPosition(db, 'EURUSD', 'long')
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /duplicate_symbol/)
})

// Aligned plan §2.5.5.1 — Mutually Exclusive Directionality.
//
// The plan asks the scanner to "reject signal −D on Symbol X if position D is
// open". The gate already refuses BOTH directions on an occupied symbol, so
// the plan's rule is a strict subset of `duplicate_symbol` rather than
// something missing. This test pins the −D half specifically: without it, the
// only coverage is the same-direction case above, and a future relaxation of
// duplicate_symbol into "same side only" would pass every existing test while
// re-opening hedged pairs on one symbol.
test('§2.5.5.1: an OPPOSITE-side signal on an occupied symbol is refused too', () => {
  for (const [held, proposed] of [['long', 'short'], ['short', 'long']]) {
    const db = freshDB()
    insertOpenPosition(db, 'EURUSD', held)
    const res = evaluateTrade(db, goodProposal(
      proposed === 'short'
        ? { side: 'short', entry: 1.1000, sl: 1.1030, tp1: 1.0895 }
        : { side: 'long' },
    ))
    assert.equal(res.approved, false, `${proposed} against an open ${held} must not pass`)
    assert.match(res.veto_reason, /duplicate_symbol/)
    assert.match(res.veto_reason, new RegExp(`existing_side=${held}`))
  }
})

// Correlation-cluster cap -------------------------------------------------

test('correlation cap vetoes a third correlated position across cluster members', () => {
  const db = freshDB()
  // Two US-equity longs already loaded; a NAS100 long stacks the cluster
  // to +3 vs the default cap of 2 — vetoed even though no currency is shared.
  insertOpenPosition(db, 'US30', 'long')
  insertOpenPosition(db, 'US500', 'long')
  const res = evaluateTrade(db, goodProposal({ symbol: 'NAS100', side: 'long', entry: 18000, sl: 17900, tp1: 18300 }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /correlated_us_equity/)
})

test('correlation cap: a hedging position on the same cluster is allowed', () => {
  const db = freshDB()
  insertOpenPosition(db, 'USDJPY', 'long')  // +1 long USD
  insertOpenPosition(db, 'USDCHF', 'long')  // +1 long USD → net +2
  // Long EURUSD reduces long-USD exposure (beta -1) — a hedge, not a stack.
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', side: 'long' }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

// Aligned plan §2.5.5.2 — net cluster directional exposure capped at ±2.0.
//
// The +3 case above proves the long side. The cap is stated as ±2.0, so the
// short side needs its own evidence: a sign error in the netting would leave
// the long test green and the short side uncapped, which is precisely the
// direction the book was running in the 13.08 statement.
test('§2.5.5.2: the ±2 cluster cap binds on the SHORT side too, and +2 itself is allowed', () => {
  const short = freshDB()
  insertOpenPosition(short, 'US30', 'short')
  insertOpenPosition(short, 'US500', 'short')
  const stacked = evaluateTrade(short, goodProposal({
    symbol: 'NAS100', side: 'short', entry: 18000, sl: 18100, tp1: 17650,
  }))
  assert.equal(stacked.approved, false, 'a third US-equity SHORT stacks the cluster to −3')
  assert.match(stacked.veto_reason, /correlated_us_equity/)

  // The cap is a ceiling, not a fence: the position that lands exactly ON ±2
  // is allowed — otherwise the effective cap would silently be 1.
  const at2 = freshDB()
  insertOpenPosition(at2, 'US30', 'short')
  const allowed = evaluateTrade(at2, goodProposal({
    symbol: 'US500', side: 'short', entry: 5000, sl: 5030, tp1: 4895,
  }))
  assert.equal(allowed.approved, true, `net −2 must pass; got: ${allowed.veto_reason}`)
})

// R:R floor --------------------------------------------------------------

test('R:R below 1.5 vetoes', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal({ tp1: 1.1020 })) // RR = 0.67
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /bad_rr/)
})

test('R:R exactly at floor approves', () => {
  const db = freshDB()
  // 30 pip SL, 45 pip TP = RR 1.5
  // AT the floor now means 3.0, not 1.5: 30 pip risk x 3 = 90 pip reward.
  const res = evaluateTrade(db, goodProposal({ tp1: 1.1090 }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

test('missing tp1 — R:R check skipped', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal({ tp1: null }))
  assert.equal(res.approved, true)
})

// SL distance ------------------------------------------------------------

test('SL too tight vetoes', () => {
  const db = freshDB()
  // 1 pip SL on EURUSD = 0.009% of entry, below 0.15% floor
  const res = evaluateTrade(db, goodProposal({ sl: 1.0999, tp1: 1.1015 }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /sl_too_tight/)
})

test('SL at entry vetoes', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal({ sl: 1.1000 }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /sl_at_entry/)
})

test('missing entry or sl vetoes', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal({ entry: null }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /missing_entry_or_sl/)
})

// Currency exposure ------------------------------------------------------

test('net USD exposure over cap vetoes', () => {
  const db = freshDB()
  // 2 open shorts on USD crosses = net +2 USD. Proposing 3rd short = +3 USD.
  insertOpenPosition(db, 'EURUSD', 'short')  // -EUR +USD
  insertOpenPosition(db, 'GBPUSD', 'short')  // -GBP +USD
  const res = evaluateTrade(db, goodProposal({ symbol: 'AUDUSD', side: 'short' }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /overexposed_USD/)
})

test('opposing currency legs cancel — approves', () => {
  const db = freshDB()
  insertOpenPosition(db, 'EURUSD', 'long')   // +EUR -USD
  insertOpenPosition(db, 'USDJPY', 'long')   // +USD -JPY
  // Propose GBPUSD long → +GBP -USD → net USD = -2 (at cap)
  const res = evaluateTrade(db, goodProposal({ symbol: 'GBPUSD' }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

// Kelly sizing -----------------------------------------------------------

test('kellyVolume — no stats → default volume', () => {
  const out = kellyVolume(null, 0.10, DEFAULT_RISK_CONFIG)
  assert.equal(out.volume, 0.10)
  assert.match(out.note, /kelly_skipped/)
})

test('kellyVolume — < 30 trades → default volume', () => {
  const stats = { total_trades: 10, win_rate: 0.6, avg_win: 20, avg_loss: -10 }
  const out = kellyVolume(stats, 0.10, DEFAULT_RISK_CONFIG)
  assert.equal(out.volume, 0.10)
})

test('kellyVolume — negative expectancy → 0', () => {
  const stats = { total_trades: 100, win_rate: 0.3, avg_win: 10, avg_loss: -20 }
  const out = kellyVolume(stats, 0.10, DEFAULT_RISK_CONFIG)
  assert.equal(out.volume, 0)
})

test('kellyVolume — positive expectancy ships the FULL risk budget (veto-only, no haircut)', () => {
  const stats = { total_trades: 100, win_rate: 0.55, avg_win: 20, avg_loss: -10 }
  const out = kellyVolume(stats, 0.10, DEFAULT_RISK_CONFIG)
  // Proven positive expectancy → full budget, not a fraction of it. Kelly only
  // vetoes (returns 0) on negative expectancy; it never down-sizes a winner.
  assert.equal(out.volume, 0.10, `got ${out.volume}`)
  assert.match(out.note, /kelly=.*ok/)
})

// Per-strategy trade with a strategy label, on a NON-proposal symbol and old
// enough not to trip the daily-loss / streak / symbol-cooldown gates.
function insertStratTrade(db, strategy, pnl, daysAgo) {
  const closedAt = new Date(Date.now() - daysAgo * 86400_000).toISOString()
  db.prepare(
    `INSERT INTO trades (symbol, side, net_pnl, status, closed_at, label_strategy)
     VALUES ('GBPUSD', 'BUY', ?, 'closed', ?, ?)`
  ).run(pnl, closedAt, strategy)
}

test('evaluateTrade — a strategy with its OWN negative expectancy vetoes via kelly', () => {
  const db = freshDB()
  // 40 'trend' trades INSIDE the 30-day window: 30% win, +10 / −20 → negative kelly
  for (let i = 0; i < 12; i++) insertStratTrade(db, 'trend', 10, 3 + i)          // wins
  for (let i = 0; i < 28; i++) insertStratTrade(db, 'trend', -20, 3 + (i % 22))  // losses
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /negative_expectancy/)
})

test('evaluateTrade — a PROVEN strategy is NOT vetoed by ANOTHER strategy losses (per-strategy expectancy)', () => {
  const db = freshDB()
  // fib is deeply negative over 30 trades…
  for (let i = 0; i < 30; i++) insertStratTrade(db, 'fib_618_fade', -20, 5 + i)
  // …but rsi2_reversion (the proposal) has NO losing record → must not inherit
  // fib's expectancy (the bug: global snapshot vetoed every strategy).
  const res = evaluateTrade(db, goodProposal({ strategy: 'rsi2_reversion' }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

// Happy path -------------------------------------------------------------

test('happy path — clean proposal on empty state approves', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.adjusted_volume, 0.01)
  assert.ok(res.checks)
})

// Balance helpers --------------------------------------------------------

test('getAccountBalance returns null when unset', () => {
  const db = freshDB()
  assert.equal(getAccountBalance(db), null)
})

test('getAccountBalance returns numeric balance when set', () => {
  const db = freshDB()
  setBalance(db, 5000)
  assert.equal(getAccountBalance(db), 5000)
})

test('getAccountBalance ignores malformed / non-positive values', () => {
  const db = freshDB()
  setBalance(db, 'not-a-number')
  assert.equal(getAccountBalance(db), null)
  setBalance(db, -50)
  assert.equal(getAccountBalance(db), null)
  setBalance(db, 0)
  assert.equal(getAccountBalance(db), null)
})

// Equity-aware sizing ----------------------------------------------------

test('computeRiskBasedVolume — EURUSD at $10k, 30 pip SL, 1% risk = 0.33 lot', () => {
  // budget = $100, usd_per_lot = 0.003 × 100000 = $300 → 0.33 lot
  const out = computeRiskBasedVolume(10000, 'EURUSD', 0.003, 0.01)
  assert.equal(out.volume, 0.33)
  // usdRisk = 0.33 × 300 = $99 (floored from 0.3333...)
  assert.ok(Math.abs(out.usdRisk - 99) < 0.01, `got ${out.usdRisk}`)
})

test('computeRiskBasedVolume — XAUUSD at $500, $3 SL, 1% risk = 0.01 lot', () => {
  // budget = $5, usd_per_lot = 3 × 100 = $300 → 0.0166.. → floor to 0.01
  const out = computeRiskBasedVolume(500, 'XAUUSD', 3, 0.01)
  assert.equal(out.volume, 0.01)
})

test('computeRiskBasedVolume — USDJPY converts JPY loss to USD via entry price', () => {
  // budget = $100; 0.50 JPY SL × 100k = ¥50,000 → at 147.50 = $338.98/lot → 0.29 lot
  const out = computeRiskBasedVolume(10000, 'USDJPY', 0.5, 0.01, 147.5)
  assert.equal(out.volume, 0.29)
})

test('computeRiskBasedVolume — USDJPY without entry price vetoes as unknown', () => {
  const out = computeRiskBasedVolume(10000, 'USDJPY', 0.5, 0.01)
  assert.equal(out.volume, 0)
  assert.equal(out.note, 'usd_per_lot_unknown')
})

test('computeRiskBasedVolume — tiny balance rounds to 0', () => {
  // $50 balance × 1% = $0.50 budget; EURUSD 30 pip = $300/lot → 0.00166 → 0
  const out = computeRiskBasedVolume(50, 'EURUSD', 0.003, 0.01)
  assert.equal(out.volume, 0)
})

// Equity-aware mode integration -----------------------------------------

test('equity-aware — $50 balance: EURUSD 30 pip SL insufficient → veto', () => {
  const db = freshDB()
  setBalance(db, 50)
  // budget = $50 × 5% = $2.50, usd_per_lot = 0.003 × 100000 = $300 → 0.008 → floor 0
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /insufficient_equity/)
})

test('equity-aware — $10k balance, EURUSD: risk-based volume computed (1.5% cap)', () => {
  const db = freshDB()
  setBalance(db, 10000)
  // perTradeRiskPct 5% proposes $500, but maxRiskCapPct is now 1.5% (aligned
  // plan Invariant 1), so the budget is $150. usd_per_lot = $300 → 0.5 lot,
  // still capped by requestedVolume 0.01.
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.risk_based_volume, 0.49) // floored to the 0.01 lot step
  // Final volume is min(1.66, 0.01 requested) = 0.01
  assert.equal(res.adjusted_volume, 0.01)
})

// Paced daily budget (owner 03-08-2026) ------------------------------------
// The unit arithmetic lives in daily-loss-pacing.test.js. What matters HERE
// is that the gate actually uses it, and — the part that could go wrong
// silently — that an unconfigured ceiling leaves the limit exactly where it
// was.

test('paced budget — no dailyLossPctMax leaves the flat cap untouched', () => {
  // OWNER DECISION 07-08: at 10,000 the tier rule applies 4% (not 3%), so the
  // cap is 400. The point of this test is the ABSENCE of pacing, not the
  // number; the boundary moves with the policy and the assertions below are
  // unchanged.
  const db = freshDB()
  setBalance(db, 10000)                       // 4% = $400 (tier: balance >= 10,000)
  insertClosedTrade(db, -399)
  assert.equal(evaluateTrade(db, goodProposal(), NO_SYMBOL_COOLDOWN).approved, true)
  const db2 = freshDB()
  setBalance(db2, 10000)
  insertClosedTrade(db2, -401)
  const res = evaluateTrade(db2, goodProposal(), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /daily_loss_limit_hit/)
  assert.ok(!/paced/.test(res.veto_reason), 'an unpaced cap must not claim to be paced')
  assert.equal(res.checks.daily_cap_paced, undefined)
})

test('paced budget — a ceiling raises the cap and says so on the veto line', () => {
  const db = freshDB()
  setBalance(db, 10000)
  insertClosedTrade(db, -400)                 // over the flat 3% ($300)…
  // dailyLossLimit null: this test is about the PACED % ramp, and the flat $
  // cap (300 by default) would bind below it and mask what is under test.
  const cfg = { ...NO_SYMBOL_COOLDOWN, dailyLossPct: 0.03, dailyLossPctMax: 0.18, dailyLossLimit: null }
  // PIN THE CLOCK. The paced allowance ramps from 3% at the day open to 18% at
  // its close, so "over the flat cap but inside the paced one" is only true
  // once the day has moved. Run this at 21:08 UTC — minutes after the FX day
  // opens — and the paced cap is still ~3.1%, $400 is genuinely over it, and
  // the assertion below inverts. That is not a bug in the budget; it is a test
  // that never said WHEN. Half past the day.
  const res = evaluateTrade(db, goodProposal(), cfg, { nowMs: fxDayOpenMs() + 12 * 3600_000 })
  // …but inside the paced allowance, which is ≥ 3% at every point of the day.
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.daily_cap_paced, true)
  assert.ok(res.checks.daily_cap_usd >= 300)
  assert.equal(res.checks.daily_cap_ceiling_usd, 1800)
  // The ask was "how many can be trade" — the answer is on the record.
  assert.equal(typeof res.checks.daily_trades_left, 'number')
  assert.ok(res.checks.daily_budget_left_usd > 0)
})

test('paced budget — the ceiling still stops it, with the pacing explained', () => {
  const db = freshDB()
  setBalance(db, 10000)
  insertClosedTrade(db, -1900)                // past 18% of 10k
  // dailyLossLimit null: this test is about the PACED % ramp, and the flat $
  // cap (300 by default) would bind below it and mask what is under test.
  const cfg = { ...NO_SYMBOL_COOLDOWN, dailyLossPct: 0.03, dailyLossPctMax: 0.18, dailyLossLimit: null }
  // Same pinned clock as above: at the day's midpoint the ceiling is what
  // stops this, not the ramp still being low.
  const res = evaluateTrade(db, goodProposal(), cfg, { nowMs: fxDayOpenMs() + 12 * 3600_000 })
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /daily_loss_limit_hit/)
  assert.match(res.veto_reason, /paced .* through the FX day/)
  assert.equal(res.checks.daily_budget_left_usd, 0)
  assert.equal(res.checks.daily_trades_left, 0)
})

test('equity-aware — daily cap scales with balance (%)', () => {
  const db = freshDB()
  setBalance(db, 10000) // 4% = $400 daily cap (owner's tier rule, 07-08)
  insertClosedTrade(db, -450)
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /daily_loss_limit_hit/)
})

test('equity-aware — small loss under % cap approves', () => {
  const db = freshDB()
  setBalance(db, 10000)
  insertClosedTrade(db, -100) // well under $300 cap
  const res = evaluateTrade(db, goodProposal(), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

test('equity-aware — check.balance and check.daily_cap_usd are populated', () => {
  const db = freshDB()
  setBalance(db, 5000)
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.checks.balance, 5000)
  // 5000 × 3% = 150, lifted to the owner's 200 floor (07-08). The floor is
  // named as the binding rule so the page cannot show 150 and mean 200.
  assert.equal(res.checks.daily_cap_usd, 200)
  assert.equal(res.checks.daily_cap_binding, 'floor')
  assert.equal(res.checks.daily_cap_floor_usd, 200)
  assert.equal(res.checks.risk_budget, 75)    // 5000 × 1.5% cap (perTradeRiskPct 5% is ceilinged by maxRiskCapPct)
})

// Tier label + blocked-symbol gate ---------------------------------------
// Tiers are informational only — the real equity gate is `insufficient_equity`,
// which vetoes when the risk budget can't support 0.01 lot on this SL distance.

test('tier label — micro attached to checks when balance set', () => {
  const db = freshDB()
  setBalance(db, 300)
  const res = evaluateTrade(db, goodProposal())
  // May or may not approve depending on equity; tier label should be present.
  assert.equal(res.checks.tier, 'micro')
})

test('tier label — full attached when balance > $10k', () => {
  const db = freshDB()
  setBalance(db, 20000)
  const res = evaluateTrade(db, goodProposal({
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 53500,
  }))
  assert.equal(res.checks.tier, 'full')
})

test('crypto allowed at any tier when budget supports it', () => {
  // $5k × 1% = $50 budget. BTCUSD $1000 SL × 1 contract = $1000/lot → 0.05 lot.
  const db = freshDB()
  setBalance(db, 5000)
  const res = evaluateTrade(db, goodProposal({
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 53500,
    requestedVolume: 0.01,
  }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.tier, 'standard')
})

test('XAUUSD allowed on small account when SL distance affordable', () => {
  // $1500 × 1% = $15 budget. XAU $5 SL × 100oz = $500/lot → 0.03 lot → passes.
  const db = freshDB()
  setBalance(db, 1500)
  const res = evaluateTrade(db, goodProposal({
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2417.5,
    requestedVolume: 0.01,
  }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

test('blockedSymbols config vetoes listed symbols', () => {
  const db = freshDB()
  setBalance(db, 10000)
  const config = { ...DEFAULT_RISK_CONFIG, blockedSymbols: ['BTCUSD', 'XRPUSD'] }
  const res = evaluateTrade(db, goodProposal({
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 53500,
  }), config)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /symbol_blocked/)
})

test('blockedSymbols is case-insensitive', () => {
  const db = freshDB()
  setBalance(db, 10000)
  const config = { ...DEFAULT_RISK_CONFIG, blockedSymbols: ['btcusd'] }
  const res = evaluateTrade(db, goodProposal({
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 53500,
  }), config)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /symbol_blocked/)
})

// Leverage / margin headroom ---------------------------------------------

test('getAccountLeverage returns config default when unset', () => {
  const db = freshDB()
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG), DEFAULT_RISK_CONFIG.leverage)
})

test('getAccountLeverage returns stored value when set', () => {
  const db = freshDB()
  setLeverage(db, 500)
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG), 500)
})

test('getAccountLeverage falls back when non-positive', () => {
  const db = freshDB()
  setLeverage(db, -5)
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG), DEFAULT_RISK_CONFIG.leverage)
})

test('requiredMargin — EURUSD 0.01 lot at 1.10, 1:100 lev = $11 margin', () => {
  const { notional, marginRequired } = requiredMargin('EURUSD', 0.01, 1.10, 100)
  assert.equal(notional, 1100)
  assert.equal(marginRequired, 11)
})

test('requiredMargin — XAUUSD 0.01 lot at $2400, 1:200 lev = $12 margin', () => {
  const { notional, marginRequired } = requiredMargin('XAUUSD', 0.01, 2400, 200)
  assert.equal(notional, 2400)
  assert.equal(marginRequired, 12)
})

test('requiredMargin — 1:1000 leverage shrinks margin 10x vs 1:100', () => {
  const hi = requiredMargin('EURUSD', 0.01, 1.10, 1000)
  const lo = requiredMargin('EURUSD', 0.01, 1.10, 100)
  assert.equal(hi.marginRequired, 1.1)
  assert.equal(lo.marginRequired, 11)
})

test('margin gate — $500 @ 1:5 leverage vetoes XAUUSD 0.01 lot', () => {
  // $500 × 1% = $5 budget; XAU SL $5 × 100 = $500/lot → 0.01 lot (just affordable)
  // notional = 0.01 × 100 × 2400 = $2400; margin @ 1:5 = $480
  // cap = $500 × 0.5 = $250 → veto on margin
  const db = freshDB()
  setBalance(db, 500)
  setLeverage(db, 5)
  const res = evaluateTrade(db, goodProposal({
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2417.5,
    requestedVolume: 0.01,
  }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /insufficient_margin/)
  assert.equal(res.checks.leverage, 5)
})

test('margin gate — $500 @ 1:500 leverage approves XAUUSD 0.01 lot', () => {
  // Same setup, margin @ 1:500 = $4.80 < $250 cap → approves
  const db = freshDB()
  setBalance(db, 500)
  setLeverage(db, 500)
  const res = evaluateTrade(db, goodProposal({
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2417.5,
    requestedVolume: 0.01,
  }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.margin_required_usd, 4.80)
  assert.equal(res.checks.leverage, 500)
})

test('margin gate — higher leverage reduces required margin', () => {
  const { marginRequired: mLow } = requiredMargin('XAUUSD', 0.01, 2400, 20)
  const { marginRequired: mHigh } = requiredMargin('XAUUSD', 0.01, 2400, 1000)
  assert.ok(mHigh < mLow)
  assert.equal(mLow, 120)
  assert.equal(mHigh, 2.4)
})

test('margin gate — not enforced when balance unset', () => {
  // Absolute fallback mode skips the margin check entirely.
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal({
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2417.5,
  }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.notional_usd, undefined)
})

test('maxMarginUsagePct config is honoured', () => {
  const db = freshDB()
  setBalance(db, 1000)
  setLeverage(db, 100)
  // Margin = 2400/100 = $24; cap default = $500; custom cap 2% = $20 → veto
  const config = { ...DEFAULT_RISK_CONFIG, maxMarginUsagePct: 0.02 }
  const res = evaluateTrade(db, goodProposal({
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2417.5,
    requestedVolume: 0.01,
  }), config)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /insufficient_margin/)
})

// AGGREGATE margin — the cap is a PORTFOLIO ceiling: already-open positions'
// margin + the new trade must fit. Owner margin-called with 16 open at 126%
// margin level because each trade only checked its OWN margin in isolation.
function insertOpenPositionSized(db, { symbol, side = 'short', volume, entry }) {
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at)
     VALUES (?, ?, ?, ?, 'open', datetime('now'))`
  ).run(symbol, side === 'long' ? 'BUY' : 'SELL', entry, volume).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status)
     VALUES (?, ?, ?, ?, 'active')`
  ).run(symbol, tradeId, side, entry)
  return tradeId
}

test('margin gate — AGGREGATE: shrinks the new trade to fit remaining headroom instead of an all-or-nothing veto', () => {
  // Owner (2026-07-22): "why do we need such a big lot size when
  // realistically cannot trade" — the old behaviour computed the full
  // risk/Kelly volume, found it 4800+275 > 5000 cap, and discarded the
  // WHOLE trade even though $200 of headroom was still available. Now it
  // shrinks proportionally to what fits instead of wasting the headroom.
  const db = freshDB()
  setBalance(db, 10000)  // cap = $5000 margin (maxMarginUsagePct 0.5)
  setLeverage(db, 100)
  // Open XAUUSD SHORT 2.0 lots @ 2400 → margin = 2.0×100×2400/100 = $4800 used.
  // (short so its +USD leg cancels the new EURUSD long's −USD — no exposure veto)
  insertOpenPositionSized(db, { symbol: 'XAUUSD', side: 'short', volume: 2.0, entry: 2400 })
  // Requested EURUSD 0.25 lot → margin = 0.25×100000×1.1/100 = $275; 4800+275
  // > 5000, but $200 headroom remains → shrinks to 0.25×(200/275) ≈ 0.18 lot,
  // which DOES fit (4800 + 0.18×100000×1.1/100 = 4800+198 = 4998 ≤ 5000).
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.25 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true, `expected a shrunk approval, got veto: ${res.veto_reason}`)
  assert.equal(res.adjusted_volume, 0.18)
  assert.ok(res.checks.margin_used_usd >= 4800, `used margin summed: ${res.checks.margin_used_usd}`)
  assert.deepEqual(res.checks.margin_shrink, { from: 0.25, to: 0.18, reason: 'margin_headroom' })
  assert.match(res.sizing_note, /shrunk_for_margin=0\.25->0\.18/)
  assert.ok(res.checks.margin_total_usd <= res.checks.margin_cap_usd, 'shrunk position must actually fit under the cap')
})

test('margin gate — AGGREGATE: still vetoes outright when even the shrunk volume falls below the minimum lot', () => {
  const db = freshDB()
  setBalance(db, 10000)  // cap = $5000
  setLeverage(db, 100)
  // Open XAUUSD SHORT 2.0 lots @ 2495 → margin = 2.0×100×2495/100 = $4990 used,
  // leaving only $10 headroom — nowhere near enough for even a 0.01-lot EURUSD
  // position ($275/0.25 lot ⇒ ~$11/0.01 lot).
  insertOpenPositionSized(db, { symbol: 'XAUUSD', side: 'short', volume: 2.0, entry: 2495 })
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.25 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, false, `expected veto — no shrink helps here, got: ${JSON.stringify(res)}`)
  assert.match(res.veto_reason, /insufficient_margin/)
  assert.match(res.veto_reason, /used=4990/)
})

test('margin gate — AGGREGATE: no headroom left at all (existing positions alone exceed the cap) vetoes without computing a shrink', () => {
  const db = freshDB()
  setBalance(db, 10000)  // cap = $5000
  setLeverage(db, 100)
  // Open XAUUSD SHORT 3.0 lots @ 2400 → margin = 3.0×100×2400/100 = $7200,
  // already over the $5000 cap on its own.
  insertOpenPositionSized(db, { symbol: 'XAUUSD', side: 'short', volume: 3.0, entry: 2400 })
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.25 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /insufficient_margin/)
  assert.match(res.veto_reason, /no headroom left to shrink into/)
})

test('margin gate — AGGREGATE: the same new trade approves with no open positions', () => {
  const db = freshDB()
  setBalance(db, 10000)
  setLeverage(db, 100)
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.25 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.margin_used_usd, 0)
  assert.equal(res.checks.margin_source, 'estimate')
})

test('margin gate — BROKER TRUTH: a fresh broker snapshot overrides the local estimate', () => {
  // The local estimate sums our own requiredMargin() per row — it drifts
  // from the broker's real figure (owner 2026-07-24: estimated used margin
  // 28% over the cap). When the monitor's snapshot is fresh, its
  // health.usedMargin is the number the gate must use.
  const db = freshDB()
  setBalance(db, 10000)  // cap = $5000
  setLeverage(db, 100)
  // No local open positions at all (estimate would say used=0)…
  // …but the broker says $6000 is already locked — over the cap on its own.
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('broker_snapshot_cache_json', ?)`)
    .run(JSON.stringify({ account: { health: { usedMargin: 6000 } }, fetchedAt: new Date().toISOString() }))
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.25 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /insufficient_margin/)
  assert.match(res.veto_reason, /no headroom left to shrink into/)
  assert.equal(res.checks.margin_source, 'broker')
  assert.equal(res.checks.margin_used_usd, 6000)
})

test('margin gate — BROKER TRUTH: a STALE broker snapshot falls back to the estimate', () => {
  const db = freshDB()
  setBalance(db, 10000)
  setLeverage(db, 100)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('broker_snapshot_cache_json', ?)`)
    .run(JSON.stringify({ account: { health: { usedMargin: 6000 } }, fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString() }))
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.25 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true, `stale snapshot must not veto: ${res.veto_reason}`)
  assert.equal(res.checks.margin_source, 'estimate')
  assert.equal(res.checks.margin_used_usd, 0)
})

test('portfolioMarginStatus: reports headroom and source for the loop pre-gate', () => {
  const db = freshDB()
  setBalance(db, 10000)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('broker_snapshot_cache_json', ?)`)
    .run(JSON.stringify({ account: { health: { usedMargin: 5200 } }, fetchedAt: new Date().toISOString() }))
  const pm = portfolioMarginStatus(db, DEFAULT_RISK_CONFIG, { balance: 10000, leverage: 100 })
  assert.equal(pm.source, 'broker')
  assert.equal(pm.usedMargin, 5200)
  assert.equal(pm.cap, 5000)
  assert.ok(pm.headroom < 0, 'exhausted portfolio must report negative headroom')
})

test('empty blockedSymbols allows everything budget supports', () => {
  const db = freshDB()
  setBalance(db, 20000)
  // Default config has blockedSymbols = []
  for (const sym of ['BTCUSD', 'XAUUSD', 'US30', 'EURUSD']) {
    const res = evaluateTrade(db, goodProposal({
      symbol: sym,
      entry: sym === 'BTCUSD' ? 50000 : sym === 'XAUUSD' ? 2400 : sym === 'US30' ? 40000 : 1.1,
      sl:    sym === 'BTCUSD' ? 49000 : sym === 'XAUUSD' ? 2395 : sym === 'US30' ? 39800 : 1.097,
      tp1:   sym === 'BTCUSD' ? 53500 : sym === 'XAUUSD' ? 2417.5 : sym === 'US30' ? 40700 : 1.1105,
      requestedVolume: 0.01,
    }))
    assert.equal(res.approved, true, `${sym} rejected: ${res.veto_reason}`)
  }
})

// Back-compat: absolute-USD fallback -------------------------------------

test('no balance → uses absolute dailyLossLimit', () => {
  const db = freshDB()
  insertClosedTrade(db, -DEFAULT_RISK_CONFIG.dailyLossLimit)
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /daily_loss_limit_hit/)
})

test('no balance → no tier gate, crypto approves', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal({
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 53500,
  }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

// Uncapped sizing (owner 2026-07-17): requestedVolume is an OPTIONAL cap.
// Absent → the dynamic risk-based size IS the size; the old hardcoded 0.01
// fallback silently compressed every trade. Explicit caps still reduce.

test('no Max lots cap → adjusted volume is the full risk-based size', () => {
  const db = freshDB()
  setBalance(db, 50_000)
  setLeverage(db, 200)
  // EURUSD, 50-pip stop: risk budget 1% = $500; usd/lot = 100000×0.005 = $500 → 1 lot
  const proposal = { symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0950, tp1: 1.1175, requestedVolume: null }
  const r = evaluateTrade(db, proposal, { ...NO_SYMBOL_COOLDOWN, perTradeRiskPct: 0.01 })
  assert.equal(r.approved, true, r.veto_reason)
  assert.ok(r.adjusted_volume >= 0.9, `expected ~1 lot risk-based size, got ${r.adjusted_volume}`)
  assert.equal(r.checks.risk_based_volume, r.adjusted_volume)
})

test('explicit Max lots cap still reduces the risk-based size', () => {
  const db = freshDB()
  setBalance(db, 50_000)
  setLeverage(db, 200)
  const proposal = { symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0950, tp1: 1.1175, requestedVolume: 0.05 }
  const r = evaluateTrade(db, proposal, { ...NO_SYMBOL_COOLDOWN, perTradeRiskPct: 0.01 })
  assert.equal(r.approved, true, r.veto_reason)
  assert.equal(r.adjusted_volume, 0.05)
  assert.match(r.sizing_note || '', /capped_at_max_lots/)
})

test('maxConsecutiveLosses 0 disables the streak breaker entirely', () => {
  const db = freshDB()
  // 5 consecutive losses closed just now — with the breaker on this vetoes.
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO trades (symbol, side, status, net_pnl, opened_at, closed_at)
       VALUES ('US30', 'BUY', 'closed', -10, datetime('now', '-1 hour'), datetime('now'))`
    ).run()
  }
  const proposal = { symbol: 'EURUSD', side: 'BUY', entry: 1.1, sl: 1.09, tp1: 1.135, requestedVolume: 0.01 }
  const off = evaluateTrade(db, proposal, { ...NO_SYMBOL_COOLDOWN, maxConsecutiveLosses: 0 })
  assert.equal(off.approved, true, off.veto_reason)
  const on = evaluateTrade(db, proposal, { ...NO_SYMBOL_COOLDOWN, maxConsecutiveLosses: 3, cooldownMinutes: 60 })
  assert.equal(on.approved, false)
  assert.match(on.veto_reason, /loss_streak_cooldown/)
})

// Cross-pair sizing (owner 2026-07-17: burn-in on 25 crosses flooded
// "insufficient_equity … usd_per_lot_unknown"). The quote-currency loss now
// converts to USD through the scan's live majors; no rate → honest veto.

test('cross sizing: GBPJPY loss converts to USD via USDJPY', () => {
  // 1 lot GBPJPY, 0.5 JPY stop → 50,000 JPY loss; USDJPY 150 → $333.33/lot.
  const r = computeRiskBasedVolume(50_000, 'GBPJPY', 0.5, 0.01, 195, { USDJPY: 150 })
  assert.notEqual(r.note, 'usd_per_lot_unknown')
  // budget $500 ÷ $333.33 = 1.4999 → FLOORS to 1.49 (never exceed budget)
  assert.equal(r.volume, 1.49)
})

test('cross sizing: EURGBP converts via GBPUSD (direct multiply)', () => {
  // 0.005 GBP stop × 100k = 500 GBP; GBPUSD 1.25 → $625/lot; $500 budget → 0.8 lots
  const r = computeRiskBasedVolume(50_000, 'EURGBP', 0.005, 0.01, 0.86, { GBPUSD: 1.25 })
  assert.ok(Math.abs(r.volume - 0.8) < 0.01, `got ${r.volume}`)
})

test('cross sizing: no conversion rate available → still an honest veto', () => {
  const r = computeRiskBasedVolume(50_000, 'GBPJPY', 0.5, 0.01, 195, {})
  assert.equal(r.volume, 0)
  assert.equal(r.note, 'usd_per_lot_unknown')
})

test('evaluateTrade sizes a cross end-to-end using scan rates from state', () => {
  const db = freshDB()
  setBalance(db, 50_000)
  setLeverage(db, 200)
  db.prepare(
    `INSERT INTO agent_state (key, value) VALUES ('last_scan_results', ?)`
  ).run(JSON.stringify({ scans: [{ symbol: 'USDJPY', price: 150 }] }))
  const proposal = { symbol: 'GBPJPY', side: 'BUY', entry: 195, sl: 194.5, tp1: 196.75, requestedVolume: null }
  const r = evaluateTrade(db, proposal, { ...NO_SYMBOL_COOLDOWN, perTradeRiskPct: 0.01 })
  assert.equal(r.approved, true, r.veto_reason)
  assert.ok(r.adjusted_volume >= 1.4, `expected ~1.5 lots, got ${r.adjusted_volume}`)
})

// ---------------------------------------------------------------------------
// Algo hard cap: 5%/absolute budget, hard ceiling, anti-tilt de-risk
// ---------------------------------------------------------------------------
test('riskBudgetUsd: 5% of balance by default', () => {
  assert.equal(riskBudgetUsd(10000, { perTradeRiskPct: 0.05, maxRiskCapPct: 0.05 }), 500)
})
test('riskBudgetUsd: absolute perTradeRiskUsd overrides the pct', () => {
  assert.equal(riskBudgetUsd(10000, { perTradeRiskPct: 0.05, perTradeRiskUsd: 120, maxRiskCapPct: 0.05 }), 120)
})
test('riskBudgetUsd: hard ceiling caps an over-configured pct', () => {
  // 8% wanted, ceiling 5% → capped to $500
  assert.equal(riskBudgetUsd(10000, { perTradeRiskPct: 0.08, maxRiskCapPct: 0.05 }), 500)
})
test('riskBudgetUsd: absolute maxRiskUsd ceiling also bites', () => {
  assert.equal(riskBudgetUsd(10000, { perTradeRiskPct: 0.05, maxRiskCapPct: 0.05, maxRiskUsd: 300 }), 300)
})
test('riskBudgetUsd: drawdown factor scales the budget down', () => {
  assert.equal(riskBudgetUsd(10000, { perTradeRiskPct: 0.05, maxRiskCapPct: 0.05 }, 0.5), 250)
})

test('drawdownDeriskFactor: halves after a losing window, 1 otherwise', () => {
  const cfg = { deriskOnDrawdown: true, deriskWindowHours: 24, deriskTriggerPct: 0.05, deriskMult: 0.5 }
  const db = freshDB()
  // no trades → normal size
  assert.equal(drawdownDeriskFactor(db, 10000, cfg), 1)
  // down $600 in the window (> 5% of $10k = $500) → de-risk
  insertClosedTrade(db, -600)
  assert.equal(drawdownDeriskFactor(db, 10000, cfg), 0.5)
  // disabled → always 1
  assert.equal(drawdownDeriskFactor(db, 10000, { ...cfg, deriskOnDrawdown: false }), 1)
})

test('fxDayOpenMs/fxDayStartSql — anchors at the last 17:00 New York', async () => {
  const { fxDayOpenMs, fxDayStartSql } = await import('./risk.js')
  // 2026-07-24 is EDT (UTC-4): 17:00 NY = 21:00 UTC.
  const before = Date.parse('2026-07-24T20:59:00Z') // 16:59 NY → anchor = prev day 21:00 UTC
  assert.equal(new Date(fxDayOpenMs(before)).toISOString(), '2026-07-23T21:00:00.000Z')
  const after = Date.parse('2026-07-24T21:01:00Z') // 17:01 NY → anchor = today 21:00 UTC
  assert.equal(new Date(fxDayOpenMs(after)).toISOString(), '2026-07-24T21:00:00.000Z')
  // January is EST (UTC-5): 17:00 NY = 22:00 UTC.
  const winter = Date.parse('2026-01-15T23:30:00Z')
  assert.equal(new Date(fxDayOpenMs(winter)).toISOString(), '2026-01-15T22:00:00.000Z')
  // SQL form matches closeTradeRow's space-separated format.
  assert.equal(fxDayStartSql(after), '2026-07-24 21:00:00')
})

// Commission-drag gate --------------------------------------------------

function insertClosedTradeWithCommission(db, symbol, grossPnl, commission, minsAgo = 1) {
  const closedAt = new Date(Date.now() - minsAgo * 60_000).toISOString()
  db.prepare(
    `INSERT INTO trades (symbol, side, gross_pnl, commission, status, closed_at)
     VALUES (?, 'BUY', ?, ?, 'closed', ?)`
  ).run(symbol, grossPnl, commission, closedAt)
}

test('evaluateCommissionCost: too few closed trades → null, never blocks', () => {
  const db = freshDB()
  insertClosedTradeWithCommission(db, '0016.HK', 8.92, -15.87)
  insertClosedTradeWithCommission(db, '0016.HK', 4.67, -8.30)
  assert.equal(evaluateCommissionCost(db, { symbol: '0016.HK' }, 0.5, 5), null)
})

test('evaluateCommissionCost: no winning trades at all → null (avgWin undefined)', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertClosedTradeWithCommission(db, '0016.HK', -3, -1, i + 1)
  assert.equal(evaluateCommissionCost(db, { symbol: '0016.HK' }, 0.5, 5), null)
})

test('evaluateCommissionCost: commission eating most of the avg win → vetoReason', () => {
  const db = freshDB()
  // Mirrors the real 0016.HK incident: gross wins ~$8.92/$4.67, commission ~$15.87/$8.30 — commission > gross.
  for (let i = 0; i < 5; i++) insertClosedTradeWithCommission(db, '0016.HK', 8, -15, i + 1)
  const r = evaluateCommissionCost(db, { symbol: '0016.HK' }, 0.5, 5)
  assert.ok(r)
  assert.match(r.vetoReason, /commission_drag/)
  assert.match(r.detail, /avg commission/)
})

test('evaluateCommissionCost: commission is a small fraction of the avg win → detail only, no veto', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertClosedTradeWithCommission(db, 'EURUSD', 20, -1, i + 1)
  const r = evaluateCommissionCost(db, { symbol: 'EURUSD' }, 0.5, 5)
  assert.ok(r)
  assert.equal(r.vetoReason, undefined)
  assert.match(r.detail, /avg commission/)
})

test('evaluateCommissionCost: different symbol\'s history does not leak in', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertClosedTradeWithCommission(db, '0016.HK', 8, -15, i + 1)
  assert.equal(evaluateCommissionCost(db, { symbol: 'EURUSD' }, 0.5, 5), null)
})

test('evaluateTrade — commission gate default OFF does not veto even with bad history', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertClosedTradeWithCommission(db, '0016.HK', 8, -15, i + 1)
  const out = evaluateTrade(db, goodProposal({ symbol: '0016.HK' }), NO_SYMBOL_COOLDOWN)
  assert.equal(out.approved, true, `expected approved, got veto: ${out.veto_reason}`)
})

test('evaluateTrade — commission gate enabled vetoes a symbol with bad commission history', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertClosedTradeWithCommission(db, '0016.HK', 8, -15, i + 1)
  const cfg = { ...NO_SYMBOL_COOLDOWN, commissionGateEnabled: true, commissionMaxFracOfWin: 0.5, commissionGateMinTrades: 5 }
  const out = evaluateTrade(db, goodProposal({ symbol: '0016.HK' }), cfg)
  assert.equal(out.approved, false)
  assert.match(out.veto_reason, /commission_drag/)
})

test('evaluateTrade — commission gate enabled but too few trades still approves', () => {
  const db = freshDB()
  insertClosedTradeWithCommission(db, '0016.HK', 8, -15)
  const cfg = { ...NO_SYMBOL_COOLDOWN, commissionGateEnabled: true, commissionMaxFracOfWin: 0.5, commissionGateMinTrades: 5 }
  const out = evaluateTrade(db, goodProposal({ symbol: '0016.HK' }), cfg)
  assert.equal(out.approved, true, `expected approved, got veto: ${out.veto_reason}`)
})

// ---------------------------------------------------------------------------
// 0e. Margin-level floor (owner-approved build 3, 2026-07-27)
// ---------------------------------------------------------------------------

test('margin-level floor vetoes new entries when the live level is below the floor', () => {
  const db = freshDB()
  setBalance(db, 10000)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('broker_snapshot_cache_json', ?)`)
    .run(JSON.stringify({ account: { health: { marginLevelPct: 120, usedMargin: 100 } }, fetchedAt: new Date().toISOString() }))
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.01 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /margin_level_floor/)
  assert.equal(res.checks.margin_level_pct, 120)
})

test('margin-level floor passes when the level is above the floor', () => {
  const db = freshDB()
  setBalance(db, 10000)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('broker_snapshot_cache_json', ?)`)
    .run(JSON.stringify({ account: { health: { marginLevelPct: 900, usedMargin: 100 } }, fetchedAt: new Date().toISOString() }))
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.01 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true, `healthy margin level must pass: ${res.veto_reason}`)
})

test('margin-level floor fails OPEN on a stale snapshot and a flat account (null level)', () => {
  const db = freshDB()
  setBalance(db, 10000)
  // Stale snapshot with a terrible level — must NOT veto.
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('broker_snapshot_cache_json', ?)`)
    .run(JSON.stringify({ account: { health: { marginLevelPct: 60, usedMargin: 100 } }, fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString() }))
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.01 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true, `stale snapshot must fail open: ${res.veto_reason}`)

  // Flat account: marginLevelPct null (no positions) — must NOT veto.
  const db2 = freshDB()
  setBalance(db2, 10000)
  db2.prepare(`INSERT INTO agent_state (key, value) VALUES ('broker_snapshot_cache_json', ?)`)
    .run(JSON.stringify({ account: { health: { marginLevelPct: null, usedMargin: 0 } }, fetchedAt: new Date().toISOString() }))
  const res2 = evaluateTrade(db2, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.01 }), NO_SYMBOL_COOLDOWN)
  assert.equal(res2.approved, true, `flat account must fail open: ${res2.veto_reason}`)
})

test('margin-level floor is disableable with null', () => {
  const db = freshDB()
  setBalance(db, 10000)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('broker_snapshot_cache_json', ?)`)
    .run(JSON.stringify({ account: { health: { marginLevelPct: 60, usedMargin: 100 } }, fetchedAt: new Date().toISOString() }))
  const res = evaluateTrade(db, goodProposal({ symbol: 'EURUSD', requestedVolume: 0.01 }),
    { ...NO_SYMBOL_COOLDOWN, marginLevelFloorPct: null })
  assert.equal(res.approved, true, `null floor must disable the gate: ${res.veto_reason}`)
})

test('the default floor ships at 150%', () => {
  assert.equal(DEFAULT_RISK_CONFIG.marginLevelFloorPct, 150)
})

// Slippage-drift gate (hardening batch 6b) ------------------------------

function insertTradeWithSlippage(db, symbol, entryPrice, slippagePrice, minsAgo = 1) {
  const openedAt = new Date(Date.now() - minsAgo * 60_000).toISOString()
  db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, slippage_price, status, opened_at)
     VALUES (?, 'BUY', ?, ?, 'closed', ?)`
  ).run(symbol, entryPrice, slippagePrice, openedAt)
}

test('evaluateSlippageDrift: too few measured fills → null, never blocks', () => {
  const db = freshDB()
  insertTradeWithSlippage(db, 'USDCZK', 22.0, 0.05)
  assert.equal(evaluateSlippageDrift(db, { symbol: 'USDCZK' }, 0.1, 5), null)
})

test('evaluateSlippageDrift: heavy adverse slippage → vetoReason', () => {
  const db = freshDB()
  // 0.05 on a 22.0 entry = 0.227% adverse per fill, over a 0.1% limit.
  for (let i = 0; i < 5; i++) insertTradeWithSlippage(db, 'USDCZK', 22.0, 0.05, i + 1)
  const r = evaluateSlippageDrift(db, { symbol: 'USDCZK' }, 0.1, 5)
  assert.ok(r)
  assert.match(r.vetoReason, /slippage_drift/)
  assert.match(r.detail, /avg adverse slippage/)
})

test('evaluateSlippageDrift: favourable fills count as zero, not as offsets', () => {
  const db = freshDB()
  // Alternating +0.05 adverse / −0.05 favourable would NET to zero if signed
  // values were averaged raw; adverse-only clamping keeps the veto honest.
  for (let i = 0; i < 6; i++) insertTradeWithSlippage(db, 'USDCZK', 22.0, i % 2 ? 0.05 : -0.05, i + 1)
  const r = evaluateSlippageDrift(db, { symbol: 'USDCZK' }, 0.1, 5)
  assert.ok(r)
  assert.match(r.vetoReason, /slippage_drift/) // avg of (0.227%, 0, ...) ≈ 0.114% ≥ 0.1%
})

test('evaluateSlippageDrift: tight fills → detail only, no veto', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertTradeWithSlippage(db, 'EURUSD', 1.1, 0.0001, i + 1) // ~0.009%
  const r = evaluateSlippageDrift(db, { symbol: 'EURUSD' }, 0.1, 5)
  assert.ok(r)
  assert.equal(r.vetoReason, undefined)
})

test('evaluateSlippageDrift: another symbol\'s history does not leak in', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertTradeWithSlippage(db, 'USDCZK', 22.0, 0.05, i + 1)
  assert.equal(evaluateSlippageDrift(db, { symbol: 'EURUSD' }, 0.1, 5), null)
})

test('evaluateTrade — slippage gate default OFF does not veto even with bad history', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertTradeWithSlippage(db, 'EURUSD', 1.1, 0.01, i + 1) // ~0.9% adverse
  const out = evaluateTrade(db, goodProposal(), NO_SYMBOL_COOLDOWN)
  assert.equal(out.approved, true, `expected approved, got veto: ${out.veto_reason}`)
})

test('evaluateTrade — slippage gate enabled vetoes a drifting symbol', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertTradeWithSlippage(db, 'EURUSD', 1.1, 0.01, i + 1)
  const cfg = { ...NO_SYMBOL_COOLDOWN, slippageGateEnabled: true, slippageMaxAdversePct: 0.1, slippageGateMinTrades: 5 }
  const out = evaluateTrade(db, goodProposal(), cfg)
  assert.equal(out.approved, false)
  assert.match(out.veto_reason, /slippage_drift/)
})

test('evaluateTrade — slippage gate enabled but null threshold stays a no-op', () => {
  const db = freshDB()
  for (let i = 0; i < 5; i++) insertTradeWithSlippage(db, 'EURUSD', 1.1, 0.01, i + 1)
  const cfg = { ...NO_SYMBOL_COOLDOWN, slippageGateEnabled: true, slippageMaxAdversePct: null }
  const out = evaluateTrade(db, goodProposal(), cfg)
  assert.equal(out.approved, true, `expected approved, got veto: ${out.veto_reason}`)
})

// --- Per-account risk overlay (owner 02-08-2026: elevated risk on the two
// >$50k demo accounts) ------------------------------------------------------

test('loadRiskConfig merges the acct:<id>:risk_config_json overlay over global', async () => {
  const { loadRiskConfig, accountRiskOverlay } = await import('./risk.js')
  const db = freshDB()
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('risk_config_json', ?)`)
    .run(JSON.stringify({ perTradeRiskPct: 0.05, dailyLossPct: 0.03 }))
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('acct:46130058:risk_config_json', ?)`)
    .run(JSON.stringify({ perTradeRiskPct: 0.08, dailyLossPct: 0.05 }))
  // Global read: untouched.
  const global = loadRiskConfig(db)
  assert.equal(global.perTradeRiskPct, 0.05)
  assert.equal(global.dailyLossPct, 0.03)
  // Overlaid account: elevated values win, everything else inherits.
  const elevated = loadRiskConfig(db, '46130058')
  assert.equal(elevated.perTradeRiskPct, 0.08)
  assert.equal(elevated.dailyLossPct, 0.05)
  assert.equal(elevated.minRR, DEFAULT_RISK_CONFIG.minRR)
  // Non-overlaid account: identical to global.
  assert.deepEqual(loadRiskConfig(db, '43097342'), global)
  // Overlay reader: absent → null, malformed → null.
  assert.equal(accountRiskOverlay(db, '43097342'), null)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('acct:9:risk_config_json', 'not-json')`).run()
  assert.equal(accountRiskOverlay(db, '9'), null)
})

test('evaluateTrade applies the account overlay even over a pre-loaded configOverride', async () => {
  const { loadRiskConfig } = await import('./risk.js')
  const db = freshDB()
  setBalance(db, 10_000)
  // Both accounts get their OWN balance stamp. Without it the sizing-scope
  // guard fires first — correctly, since a named account with no balance of
  // its own would be sized against the shared key — and this test would be
  // asserting the wrong veto (owner decision D-1, 06-08-2026).
  for (const id of ['46130058', '43097342']) {
    db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)')
      .run(`acct:${id}:account_balance_usd`, '10000')
  }
  // The overlay blocks this symbol only for THIS account — visible proof the
  // overlay reached the gate despite the caller passing a global override.
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('acct:46130058:risk_config_json', ?)`)
    .run(JSON.stringify({ blockedSymbols: ['EURUSD'] }))
  const globalCfg = loadRiskConfig(db) // what loop.js pre-loads per cycle
  const proposal = { ...goodProposal(), accountId: '46130058' }
  const out = evaluateTrade(db, proposal, globalCfg)
  assert.equal(out.approved, false)
  assert.match(out.veto_reason || '', /blocked/i)
  // Same proposal for a non-overlaid account passes the blocked-symbol check.
  const out2 = evaluateTrade(db, { ...goodProposal(), accountId: '43097342' }, globalCfg)
  assert.ok(!/blocked/i.test(out2.veto_reason || ''), `unexpected blocked veto: ${out2.veto_reason}`)
})

// --- campaign stop (owner 07-08 "proceed") ---------------------------------
//
// The daily cap resets every FX day; this is the only limit that spans days.

test('campaign stop: unarmed changes nothing', () => {
  const db = freshDB()
  setBalance(db, 46073)
  insertClosedTrade(db, -5000)   // way past any campaign budget
  const res = evaluateTrade(db, goodProposal(), { ...DEFAULT_RISK_CONFIG, campaign: null, dailyLossFloorUsd: null, dailyLossTierAtUsd: null, dailyLossPct: null, dailyLossLimit: null })
  assert.ok(!/campaign_stop/.test(res.veto_reason || ''), 'no campaign, no campaign veto')
})

test('campaign stop: halts on the WEEK even when the day is fine', () => {
  const db = freshDB()
  setBalance(db, 46073)
  // A loss booked days ago — inside the campaign window, outside today's.
  insertClosedTrade(db, -4000, 3 * 24 * 60)
  const cfg = {
    ...DEFAULT_RISK_CONFIG,
    campaign: { maxDrawdownPct: 0.08, startEquity: 46073, startAt: '2020-01-01T00:00:00Z', label: 'test' },
  }
  const res = evaluateTrade(db, goodProposal(), cfg)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /campaign_stop \(test\)/)
  assert.match(res.veto_reason, /The daily cap resets tomorrow; this does not/)
  assert.equal(res.checks.campaign_budget_left_usd, 0)
})

test('campaign stop: inside the budget it reports and approves', () => {
  const db = freshDB()
  setBalance(db, 46073)
  insertClosedTrade(db, -100, 3 * 24 * 60)
  const cfg = {
    ...DEFAULT_RISK_CONFIG,
    campaign: { maxDrawdownPct: 0.08, startEquity: 46073, startAt: '2020-01-01T00:00:00Z', label: 'test' },
  }
  const res = evaluateTrade(db, goodProposal(), cfg, NO_SYMBOL_COOLDOWN)
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.campaign_drawdown_usd, 100)
  assert.equal(res.checks.campaign_budget_left_usd, 3585.84)
})

// ---------------------------------------------------------------------------
// THE EXPECTANCY FLOOR (owner, 13-08-2026). Measured on 438 closed deals,
// 28 Jul – 13 Aug: 24.9% win rate at a realised 1.74:1 payoff, expectancy
// −$38.34 a trade, −$16,794.78 over the period. Breakeven at that win rate is
// (1−W)/W = 3.02:1. These assert the floor cannot be lowered from anywhere,
// because "non-bypassable" was the whole requirement.
// ---------------------------------------------------------------------------

test('HARD_MIN_RR is 3.0 — above the 3.02 breakeven, not the plan\'s 2.8', () => {
  assert.equal(HARD_MIN_RR, 3.0)
  const W = 0.249
  assert.ok((1 - W) / W > 2.8, 'a 2.8 floor sits BELOW breakeven at the measured win rate')
  assert.ok(Math.abs((1 - W) / W - 3.02) < 0.02)
})

test('an account override BELOW the floor cannot lower it', () => {
  // The plan's §2.2.2: overrides permitted minRR 1.2, which at a 24.9% win
  // rate is −0.428R a trade. Config is not allowed to buy that back.
  const db = freshDB()
  setBalance(db, 20000)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('risk_config_json', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ minRR: 1.2 }))
  const res = evaluateTrade(db, goodProposal({ tp1: 1.1060 })) // RR 2.0
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /bad_rr/)
  assert.match(res.veto_reason, /raised to the 3 expectancy floor/)
})

test('a STRATEGY may not declare its way under the floor either', () => {
  // rsi2_reversion declares 1.0 in STRATEGY_MIN_RR. That is the second bypass
  // and it was the one a config-only fix would have missed entirely.
  const db = freshDB()
  setBalance(db, 20000)
  const res = evaluateTrade(db, goodProposal({ strategy: 'rsi2_reversion', tp1: 1.1060 }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /bad_rr 2.00<3/)
  assert.deepEqual(res.checks.rr_floor_raised, { requested: 1, enforced: 3 })
})

test('a floor ABOVE the hard minimum is still respected — this is a floor, not a setting', () => {
  const db = freshDB()
  setBalance(db, 20000)
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('risk_config_json', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ minRR: 4.0 }))
  assert.equal(evaluateTrade(db, goodProposal({ tp1: 1.1105 })).approved, false, 'RR 3.5 < 4.0')
  assert.equal(evaluateTrade(db, goodProposal({ tp1: 1.1130 })).approved, true, 'RR 4.33 clears it')
})

test('3.0 is BREAKEVEN, not profit — the floor stops the bleeding, it does not earn', () => {
  // Written to assert what is true rather than what would be reassuring.
  // E = W×rr − (1−W) at the measured W = 24.9%:
  //   realised 1.74 : E = −0.318R   ← the drawdown
  //   floor    3.00 : E = −0.004R   ← flat, a rounding either side of zero
  //   target   3.50 : E = +0.120R   ← the plan's target, and the first
  //                                   ratio that actually pays
  // So 3.0 removes the structural loss and buys nothing more. Profit needs a
  // better win rate or a higher ratio, and that is the honest position to
  // hold rather than calling the floor a fix for the P&L.
  const W = 0.249
  const E = rr => W * rr - (1 - W)
  assert.ok(E(1.74) < -0.3, 'the realised payoff bleeds')
  assert.ok(Math.abs(E(HARD_MIN_RR)) < 0.01, 'the floor lands on breakeven, within a rounding')
  assert.ok(E(3.5) > 0.1, 'the plan\'s 3.5 target is the one that pays')
  assert.ok(E(2.8) < E(HARD_MIN_RR), 'and 2.8 would still have been negative')
})

// ---------------------------------------------------------------------------
// ACCEPTANCE 2.6.2, second clause — Invariant 2's expectancy gate.
// bot_trade_remediation_plan_aligned.md §2.4.2 / §2.5.2.2.
//
// The invariant asks for minRR >= 2.8 AND E > 0.15R. Those contradict at this
// account's win rate, so the static floor and the dynamic gate are separate
// mechanisms: HARD_MIN_RR covers the thin-sample window, this covers the rest.
// ---------------------------------------------------------------------------

function seedClosed(db, { wins, losses }) {
  const ins = db.prepare(
    `INSERT INTO trades (symbol, status, net_pnl, closed_at, account_id)
     VALUES ('EURUSD', 'closed', ?, datetime('now', '-1 day'), NULL)`)
  for (let i = 0; i < wins; i++) ins.run(100)
  for (let i = 0; i < losses; i++) ins.run(-100)
}

test('2.6.2 — the required R:R follows the MEASURED win rate, not a constant', () => {
  // The reason this is not hardcoded at 3.62: that number is a function of a
  // win rate, and freezing it repeats the contract-table mistake.
  const at = (W, rr) => expectancyVerdict({ trades: 100, winRate: W }, rr)
  assert.equal(at(0.249, 3.5).ok, false, '24.9% needs more than the plan target')
  assert.equal(at(0.249, 3.5).need, 3.62)
  assert.equal(at(0.35, 2.9).ok, true, 'a better win rate earns a lower ratio')
  assert.ok(at(0.35, 2.9).need < 2.9)
  // And the invariant's own 2.8 floor fails its own E test at 24.9%.
  assert.equal(at(0.249, 2.8).ok, false)
})

test('2.6.2 — a real signal is vetoed as NEGATIVE EXPECTANCY, naming the ratio it needs', () => {
  const db = freshDB()
  setBalance(db, 20000)
  seedClosed(db, { wins: 25, losses: 75 })          // 25% win rate, 100 trades
  const res = evaluateTrade(db, goodProposal({ tp1: 1.1105 })) // RR 3.5, clears HARD_MIN_RR
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /negative_expectancy/)
  assert.match(res.veto_reason, /25\.0% win rate/)
  assert.match(res.veto_reason, /needs R:R ≥ 3\.6/)
  assert.equal(res.checks.win_rate, 25)
  assert.equal(res.checks.expectancy_sample, 100)
})

test('2.6.2 — the same signal passes once the win rate justifies it', () => {
  const db = freshDB()
  setBalance(db, 20000)
  seedClosed(db, { wins: 40, losses: 60 })          // 40% — E at 3.5 is +0.8R
  const res = evaluateTrade(db, goodProposal({ tp1: 1.1105 }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.ok(res.checks.expectancy_r > 0.15)
})

test('2.6.2 — a thin sample FAILS OPEN; the static floor covers that window', () => {
  // Four closed trades is not a win rate. Vetoing every entry on it would halt
  // the account to prevent a risk nothing has measured yet.
  const db = freshDB()
  setBalance(db, 20000)
  seedClosed(db, { wins: 1, losses: 3 })
  const res = evaluateTrade(db, goodProposal({ tp1: 1.1105 }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.expectancy_r, undefined, 'no verdict is recorded from four rows')
})

test('Invariant 1 — the risk ceiling is 1.5%, and it binds over perTradeRiskPct', () => {
  assert.equal(DEFAULT_RISK_CONFIG.maxRiskCapPct, 0.015)
  assert.ok(DEFAULT_RISK_CONFIG.perTradeRiskPct > DEFAULT_RISK_CONFIG.maxRiskCapPct,
    'the cap is the binding term, which is the point of it being a cap')
})
