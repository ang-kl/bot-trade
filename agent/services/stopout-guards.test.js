// node --test agent/services/stopout-guards.test.js
//
// Owner order, 2026-08-22 ("do 1, 2, 3 and 4" on the account-46130058 audit):
//   1. NatGas disarmed at the gate (symbolBlocklist)
//   2. Daily-loss gauges count broker-side stop-outs (NULL net_pnl) at
//      PLANNED risk immediately, instead of waiting for the P&L backfill
//   3. The per-symbol cooldown arms on a NULL-pnl stop-out, not only on a
//      filled-in loss
//   4. TP1 partial trigger re-based to ~1R (tested in the position-manager /
//      asset-controllers suites; the class values are pinned here too)
//
// Every case is behavioural: real INSERTs, evaluateTrade / the estimator
// running against a real schema, assertions on verdicts and sums — no
// source-text matching.

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  DEFAULT_RISK_CONFIG,
  evaluateTrade,
  blocklistedSymbol,
  OWNER_DISARMED_SYMBOLS,
} from './risk.js'
import { estimateStopoutLossUsd, plannedRiskUsd, countsAsStopout } from './stopout-estimate.js'
import { accountPnlToday } from './equity-stop.js'
import { evaluateGlobalGuards } from './global-guards.js'
import { CLASS_RULE_DEFAULTS } from './asset-controllers.js'
import { DEFAULT_RULES, evaluatePosition } from './position-manager.js'

// Harness — same shape as risk.test.js -------------------------------------

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
    sl: 1.0970,
    tp1: 1.1105,
    requestedVolume: 0.01,
    strategy: 'trend',
    conviction: 8,
    ...overrides,
  }
}

/** A broker-side stop-out: closed, NULL net_pnl, entry/sl/volume recorded. */
function insertStopout(db, { symbol = 'EURUSD', entry = 1.1000, sl = 1.0970, volume = 0.5, minsAgo = 5, accountId = null, closeReason = null, exitPrice = null, tp = null } = {}) {
  const closedAt = new Date(Date.now() - minsAgo * 60_000).toISOString()
  db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, tp_price, volume, net_pnl, status, close_reason, closed_at, account_id)
     VALUES (?, 'BUY', ?, ?, ?, ?, ?, NULL, 'closed', ?, ?, ?)`
  ).run(symbol, entry, exitPrice, sl, tp, volume, closeReason, closedAt, accountId)
}

// ---------------------------------------------------------------------------
// Item 1 — symbol blocklist
// ---------------------------------------------------------------------------

test('disarm — NATGAS is on the code-pinned OWNER_DISARMED_SYMBOLS list', () => {
  assert.ok(OWNER_DISARMED_SYMBOLS.includes('NATGAS'))
})

test('disarm — a NATGAS proposal is vetoed, naming the owner order', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal({ symbol: 'NATGAS', entry: 2.700, sl: 2.680, tp1: 2.770 }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /symbol_blocked NATGAS/)
  assert.match(res.veto_reason, /disarmed by owner order/)
})

test('disarm — matching is case/punctuation-insensitive ("NatGas", "nat-gas")', () => {
  assert.equal(blocklistedSymbol(['NATGAS'], 'NatGas'), 'NATGAS')
  assert.equal(blocklistedSymbol(['NATGAS'], 'nat-gas'), 'NATGAS')
  assert.equal(blocklistedSymbol(['NATGAS'], 'EURUSD'), null)
  assert.equal(blocklistedSymbol([], 'NATGAS'), null)
  assert.equal(blocklistedSymbol(null, 'NATGAS'), null)
})

test('disarm — the broker spelling "NatGas" is refused too', () => {
  const db = freshDB()
  const res = evaluateTrade(db, goodProposal({ symbol: 'NatGas', entry: 2.700, sl: 2.680, tp1: 2.770 }))
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /disarmed by owner order/)
})

test('disarm — a stored blockedSymbols config CANNOT mask the standing order', () => {
  const db = freshDB()
  // The exact masking hazard: loadRiskConfig spreads stored config over the
  // defaults, so a saved blockedSymbols array replaces any default. The
  // code-pinned list must hold regardless.
  const cfg = { ...DEFAULT_RISK_CONFIG, blockedSymbols: ['BTCUSD'], symbolCooldownMinutes: 0 }
  const res = evaluateTrade(db, goodProposal({ symbol: 'NATGAS', entry: 2.700, sl: 2.680, tp1: 2.770 }), cfg)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /disarmed by owner order/)
})

test('disarm — the config-level blockedSymbols gate still works beside it (regression)', () => {
  const db = freshDB()
  const cfg = { ...DEFAULT_RISK_CONFIG, blockedSymbols: ['GBPUSD'], symbolCooldownMinutes: 0 }
  const res = evaluateTrade(db, goodProposal({ symbol: 'GBPUSD', entry: 1.2700, sl: 1.2665, tp1: 1.2825 }), cfg)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /symbol_blocked GBPUSD/)
  assert.ok(!/disarmed by owner order/.test(res.veto_reason), 'config block mislabelled as the standing order')
})

// ---------------------------------------------------------------------------
// Item 2 — the estimator itself
// ---------------------------------------------------------------------------

test('plannedRiskUsd — EURUSD 30 pips × 0.5 lots = $150', () => {
  assert.equal(plannedRiskUsd({ symbol: 'EURUSD', entry_price: 1.1000, sl_price: 1.0970, volume: 0.5 }), 150)
})

test('plannedRiskUsd — missing stop or volume is null, never zero', () => {
  assert.equal(plannedRiskUsd({ symbol: 'EURUSD', entry_price: 1.1, sl_price: null, volume: 0.5 }), null)
  assert.equal(plannedRiskUsd({ symbol: 'EURUSD', entry_price: 1.1, sl_price: 1.097, volume: null }), null)
  assert.equal(plannedRiskUsd({ symbol: 'EURUSD', entry_price: 1.1, sl_price: 1.1, volume: 0.5 }), null)
})

test('countsAsStopout — TP-shaped closes are the only exemption', () => {
  assert.equal(countsAsStopout({ close_reason: 'take profit hit', net_pnl: null }), false)
  assert.equal(countsAsStopout({ close_reason: 'stopped beyond the SL — gap', net_pnl: null }), true)
  assert.equal(countsAsStopout({ close_reason: null, net_pnl: null }), true, 'an unreadable close counts as a stop-out')
})

test('estimateStopoutLossUsd — NULL rows priced, filled rows excluded, TP rows skipped', () => {
  const db = freshDB()
  const since = '2000-01-01 00:00:00'
  insertStopout(db, {})                                             // $150
  insertStopout(db, { volume: 1.0 })                                // $300
  insertStopout(db, { closeReason: 'take profit hit' })             // skipped
  insertStopout(db, { sl: null })                                   // unpriceable
  db.prepare(`INSERT INTO trades (symbol, net_pnl, status, closed_at) VALUES ('EURUSD', -500, 'closed', ?)`)
    .run(new Date().toISOString())                                  // filled → not estimated
  const est = estimateStopoutLossUsd(db, { sinceSql: since })
  assert.equal(est.estUsd, 450)
  assert.equal(est.counted, 2)
  assert.equal(est.unpriceable, 1)
  assert.equal(est.tpSkipped, 1)
})

test('estimateStopoutLossUsd — scoping: scoped folds NULL-account rows in, attributed does not', () => {
  const db = freshDB()
  const since = '2000-01-01 00:00:00'
  insertStopout(db, { accountId: 'A', volume: 0.5 })   // $150 on A
  insertStopout(db, { accountId: null, volume: 1.0 })  // $300 unattributed
  insertStopout(db, { accountId: 'B', volume: 2.0 })   // $600 on B
  assert.equal(estimateStopoutLossUsd(db, { sinceSql: since, accountId: 'A', scope: 'scoped' }).estUsd, 450)
  assert.equal(estimateStopoutLossUsd(db, { sinceSql: since, accountId: 'A', scope: 'attributed' }).estUsd, 150)
  assert.equal(estimateStopoutLossUsd(db, { sinceSql: since }).estUsd, 1050)
})

test('estimateStopoutLossUsd — respects the day boundary', () => {
  const db = freshDB()
  insertStopout(db, { minsAgo: 5 })
  insertStopout(db, { minsAgo: 60 * 48 })
  const since = new Date(Date.now() - 60 * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  assert.equal(estimateStopoutLossUsd(db, { sinceSql: since }).estUsd, 150)
})

// ---------------------------------------------------------------------------
// Item 2 — wired into the gauges
// ---------------------------------------------------------------------------

test('daily loss gauge — a day made of NULL-pnl stop-outs now trips the cap', () => {
  const db = freshDB()
  // Planned risk 2 × $300 = $600 ≥ the $300 default flat cap. Zero filled
  // P&L anywhere — before this change the SUM read the day as flat.
  insertStopout(db, { volume: 1.0, minsAgo: 10 })
  insertStopout(db, { volume: 1.0, minsAgo: 8 })
  // The cooldown would also (rightly) veto this EURUSD proposal now, so use
  // another symbol and disable the gates that sit in front of the daily cap.
  const cfg = { ...DEFAULT_RISK_CONFIG, symbolCooldownMinutes: 0, blockOnUnknownPnl: false }
  const res = evaluateTrade(db, goodProposal({ symbol: 'GBPUSD', entry: 1.2700, sl: 1.2665, tp1: 1.2825 }), cfg)
  assert.equal(res.approved, false, 'expected the daily cap to trip on estimated stop-outs')
  assert.match(res.veto_reason, /daily_loss_limit_hit/)
  assert.equal(res.checks.daily_pnl, -600)
  assert.equal(res.checks.daily_pnl_estimated_stopouts, 2)
})

test('daily loss gauge — backfill replaces the estimate, never double-counts', () => {
  const db = freshDB()
  insertStopout(db, { volume: 1.0, minsAgo: 10 })
  const cfg = { ...DEFAULT_RISK_CONFIG, symbolCooldownMinutes: 0, blockOnUnknownPnl: false }
  const before = evaluateTrade(db, goodProposal({ symbol: 'GBPUSD', entry: 1.2700, sl: 1.2665, tp1: 1.2825 }), cfg)
  assert.equal(before.checks.daily_pnl, -300, 'estimated while NULL')
  // The backfill lands: the real loss was worse than planned (slippage).
  db.prepare(`UPDATE trades SET net_pnl = -420 WHERE net_pnl IS NULL`).run()
  const after = evaluateTrade(db, goodProposal({ symbol: 'GBPUSD', entry: 1.2700, sl: 1.2665, tp1: 1.2825 }), cfg)
  assert.equal(after.checks.daily_pnl, -420, 'real figure only — the estimate is gone')
  assert.equal(after.checks.daily_pnl_estimated_stopouts, undefined)
})

test('portfolio guard — NULL-pnl stop-outs count against portfolioDailyLossUsd', () => {
  const db = freshDB()
  insertStopout(db, { volume: 1.0, accountId: 'A' })
  insertStopout(db, { volume: 1.0, accountId: 'B' })
  const res = evaluateGlobalGuards(db, {
    halt: false, portfolioDailyLossUsd: 500, maxTotalOpenPositions: 0,
    blockOnUnknownPnl: false,
  })
  assert.equal(res.ok, false)
  assert.match(res.reason, /portfolio_daily_loss/)
  assert.equal(res.checks.portfolio_daily_pnl, -600)
  assert.equal(res.checks.portfolio_estimated_stopouts, 2)
})

test('equity stop — accountPnlToday charges attributed stop-outs at planned risk', () => {
  const db = freshDB()
  insertStopout(db, { volume: 1.0, accountId: '46130058' })   // $300 estimated
  insertStopout(db, { volume: 9.9, accountId: null })          // unattributed — NOT charged here
  db.prepare(`INSERT INTO trades (symbol, net_pnl, status, closed_at, account_id)
              VALUES ('EURUSD', -100, 'closed', ?, '46130058')`).run(new Date().toISOString())
  const { pnl, unknownCount, estimatedStopoutUsd } = accountPnlToday(db, '46130058', '2000-01-01 00:00:00')
  assert.equal(pnl, -400)
  assert.equal(estimatedStopoutUsd, 300)
  assert.equal(unknownCount, 1)
})

// ---------------------------------------------------------------------------
// Item 3 — cooldown arms on NULL-pnl stop-outs
// ---------------------------------------------------------------------------

test('cooldown — a NULL-pnl stop-out 10 minutes ago vetoes re-entry on that symbol', () => {
  const db = freshDB()
  insertStopout(db, { minsAgo: 10, closeReason: 'stopped beyond the SL — gap/slippage through the stop' })
  const cfg = { ...DEFAULT_RISK_CONFIG, blockOnUnknownPnl: false }
  const res = evaluateTrade(db, goodProposal(), cfg)
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /symbol_cooldown/)
  assert.match(res.veto_reason, /unknown \(broker-side stop-out/)
})

test('cooldown — a NULL-pnl close with NO reason still arms (unreadable ≠ fine)', () => {
  const db = freshDB()
  insertStopout(db, { minsAgo: 10, closeReason: null })
  const res = evaluateTrade(db, goodProposal(), { ...DEFAULT_RISK_CONFIG, blockOnUnknownPnl: false })
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /symbol_cooldown/)
})

test('cooldown — a TP-shaped NULL-pnl close does NOT arm (loss-only doctrine holds)', () => {
  const db = freshDB()
  insertStopout(db, { minsAgo: 10, closeReason: 'take profit hit' })
  const res = evaluateTrade(db, goodProposal(), { ...DEFAULT_RISK_CONFIG, blockOnUnknownPnl: false })
  assert.ok(!/symbol_cooldown/.test(res.veto_reason || ''), `cooldown armed on a winner: ${res.veto_reason}`)
})

test('cooldown — a filled-in loss still arms (regression)', () => {
  const db = freshDB()
  const closedAt = new Date(Date.now() - 10 * 60_000).toISOString()
  db.prepare(`INSERT INTO trades (symbol, net_pnl, status, closed_at) VALUES ('EURUSD', -50, 'closed', ?)`)
    .run(closedAt)
  const res = evaluateTrade(db, goodProposal())
  assert.equal(res.approved, false)
  assert.match(res.veto_reason, /symbol_cooldown/)
})

test('cooldown — expires: a stop-out outside the window does not veto on cooldown', () => {
  const db = freshDB()
  insertStopout(db, { minsAgo: DEFAULT_RISK_CONFIG.symbolCooldownMinutes + 5 })
  const res = evaluateTrade(db, goodProposal(), { ...DEFAULT_RISK_CONFIG, blockOnUnknownPnl: false })
  assert.ok(!/symbol_cooldown/.test(res.veto_reason || ''), `cooldown outlived its window: ${res.veto_reason}`)
})

// ---------------------------------------------------------------------------
// Item 4 — TP1 partial at ~1R
// ---------------------------------------------------------------------------

test('partial — global default trigger is 1.0R and fires at +1.0R', () => {
  assert.equal(DEFAULT_RULES.partialTriggerR, 1.0)
  const pos = {
    id: 1, symbol: 'XAUUSD', side: 'long',
    entry_price: 3400, current_sl: 3380, initial_risk: 20,
    mfe_r: 0, mae_r: 0, be_moved: 1, scaled_out: 0,
    created_at: new Date().toISOString(),
  }
  const at1R = evaluatePosition(pos, { currentPrice: 3420 })
  assert.equal(at1R.action, 'PARTIAL_EXIT', `expected partial at +1R, got ${at1R.action} (${at1R.reason})`)
  const below = evaluatePosition(pos, { currentPrice: 3419 })
  assert.notEqual(below.action, 'PARTIAL_EXIT', 'fired below the trigger')
})

test('partial — every class trigger sits in the ~1R band, spread preserved', () => {
  for (const [cls, rules] of Object.entries(CLASS_RULE_DEFAULTS)) {
    assert.ok(rules.partialTriggerR <= 1.1, `${cls} trigger ${rules.partialTriggerR} above the re-based band`)
    assert.ok(rules.partialTriggerR >= 0.8, `${cls} trigger ${rules.partialTriggerR} below the re-based band`)
    assert.ok(rules.partialTriggerR > DEFAULT_RULES.partialTrailR, `${cls} trail would sit above its own trigger`)
    assert.ok(rules.partialTriggerR > rules.beTriggerR, `${cls} partial fires before breakeven — order inverted`)
  }
  // The whippy classes still bank earlier than the clean trenders.
  assert.ok(CLASS_RULE_DEFAULTS.crypto.partialTriggerR < CLASS_RULE_DEFAULTS.index.partialTriggerR)
  assert.ok(CLASS_RULE_DEFAULTS.commodity.partialTriggerR < CLASS_RULE_DEFAULTS.metal.partialTriggerR)
})
