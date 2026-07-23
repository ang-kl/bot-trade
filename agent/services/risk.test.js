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
      gross_pnl REAL, net_pnl REAL,
      status TEXT DEFAULT 'open',
      close_reason TEXT, thesis TEXT, strategy TEXT, conviction REAL,
      ctrader_position_id TEXT, analysis_id INTEGER, label_strategy TEXT
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
    tp1: 1.1060,    // RR = 2.0
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
  const res = evaluateTrade(db, goodProposal({ tp1: 1.1045 }))
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

test('equity-aware — $10k balance, EURUSD: risk-based volume computed (5% default)', () => {
  const db = freshDB()
  setBalance(db, 10000)
  // budget = $10k × 5% = $500, usd_per_lot = $300 → 1.66 lot, capped by requestedVolume 0.01
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.checks.risk_based_volume, 1.66)
  // Final volume is min(1.66, 0.01 requested) = 0.01
  assert.equal(res.adjusted_volume, 0.01)
})

test('equity-aware — daily cap scales with balance (%)', () => {
  const db = freshDB()
  setBalance(db, 10000) // 3% = $300 daily cap
  insertClosedTrade(db, -350)
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
  assert.equal(res.checks.daily_cap_usd, 150) // 5000 × 3%
  assert.equal(res.checks.risk_budget, 250)   // 5000 × 5% default
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
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 52000,
  }))
  assert.equal(res.checks.tier, 'full')
})

test('crypto allowed at any tier when budget supports it', () => {
  // $5k × 1% = $50 budget. BTCUSD $1000 SL × 1 contract = $1000/lot → 0.05 lot.
  const db = freshDB()
  setBalance(db, 5000)
  const res = evaluateTrade(db, goodProposal({
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 52000,
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
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2410,
    requestedVolume: 0.01,
  }))
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

test('blockedSymbols config vetoes listed symbols', () => {
  const db = freshDB()
  setBalance(db, 10000)
  const config = { ...DEFAULT_RISK_CONFIG, blockedSymbols: ['BTCUSD', 'XRPUSD'] }
  const res = evaluateTrade(db, goodProposal({
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 52000,
  }), config)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /symbol_blocked/)
})

test('blockedSymbols is case-insensitive', () => {
  const db = freshDB()
  setBalance(db, 10000)
  const config = { ...DEFAULT_RISK_CONFIG, blockedSymbols: ['btcusd'] }
  const res = evaluateTrade(db, goodProposal({
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 52000,
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
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2410,
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
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2410,
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
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2410,
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
    symbol: 'XAUUSD', entry: 2400, sl: 2395, tp1: 2410,
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
      tp1:   sym === 'BTCUSD' ? 52000 : sym === 'XAUUSD' ? 2410 : sym === 'US30' ? 40400 : 1.106,
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
    symbol: 'BTCUSD', entry: 50000, sl: 49000, tp1: 52000,
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
  const proposal = { symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0950, tp1: 1.1100, requestedVolume: null }
  const r = evaluateTrade(db, proposal, { ...NO_SYMBOL_COOLDOWN, perTradeRiskPct: 0.01 })
  assert.equal(r.approved, true, r.veto_reason)
  assert.ok(r.adjusted_volume >= 0.9, `expected ~1 lot risk-based size, got ${r.adjusted_volume}`)
  assert.equal(r.checks.risk_based_volume, r.adjusted_volume)
})

test('explicit Max lots cap still reduces the risk-based size', () => {
  const db = freshDB()
  setBalance(db, 50_000)
  setLeverage(db, 200)
  const proposal = { symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0950, tp1: 1.1100, requestedVolume: 0.05 }
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
  const proposal = { symbol: 'EURUSD', side: 'BUY', entry: 1.1, sl: 1.09, tp1: 1.12, requestedVolume: 0.01 }
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
  const proposal = { symbol: 'GBPJPY', side: 'BUY', entry: 195, sl: 194.5, tp1: 195.9, requestedVolume: null }
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
