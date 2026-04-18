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
      ctrader_position_id TEXT, analysis_id INTEGER
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
  const res = evaluateTrade(db, goodProposal())
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
  const res = evaluateTrade(db, goodProposal())
  // streak is 2 (below 3) → should approve
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
})

test('cooldown expires after window', () => {
  const db = freshDB()
  // 3 losses 2h ago — cooldown is 60m so window passed
  insertClosedTrade(db, -10, 125)
  insertClosedTrade(db, -10, 122)
  insertClosedTrade(db, -10, 120)
  const res = evaluateTrade(db, goodProposal())
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

test('kellyVolume — positive expectancy scales volume', () => {
  const stats = { total_trades: 100, win_rate: 0.55, avg_win: 20, avg_loss: -10 }
  const out = kellyVolume(stats, 0.10, DEFAULT_RISK_CONFIG)
  assert.ok(out.volume > 0 && out.volume <= 0.10, `got ${out.volume}`)
})

test('evaluateTrade — negative expectancy vetoes via kelly', () => {
  const db = freshDB()
  db.prepare(
    `INSERT INTO performance_snapshots (total_trades, winning_trades, losing_trades, win_rate, avg_win, avg_loss)
     VALUES (50, 15, 35, 0.30, 10, -20)`
  ).run()
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /negative_expectancy/)
})

// Happy path -------------------------------------------------------------

test('happy path — clean proposal on empty state approves', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, true, `got: ${res.veto_reason}`)
  assert.equal(res.adjusted_volume, 0.01)
  assert.ok(res.checks)
})
