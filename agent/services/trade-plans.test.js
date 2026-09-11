// node --test agent/services/trade-plans.test.js
//
// §7,437·B·4 (owner, 08-09-2026): the plan is written at entry, before the
// fill anchor, the trail or the book overwrite the trade row, and the close
// is scored against it — slippage in R, realised versus planned R, hold
// versus intended hold, exit reason versus rule.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState, closeTradeRow } from '../db.js'
import { recordTradePlan, scoreClosedPlans, tradePlansReport, exitRuleFor, exitKind, ruleAdmits } from './trade-plans.js'

const T0 = Date.parse('2026-09-08T06:00:00Z')

function openTrade(db, { symbol = 'EURUSD', side = 'BUY', entry = 1.1000, sl = 1.0950, tp = 1.1100, origin = 'bot_market_dispatch', openedAgoMin = 120 } = {}) {
  return db.prepare(`INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at, status, origin, account_id)
                     VALUES (?, ?, ?, ?, ?, 1000, ?, 'open', ?, 'A1')`)
    .run(symbol, side, entry, sl, tp, new Date(T0 - openedAgoMin * 60_000).toISOString().replace('T', ' ').slice(0, 19), origin).lastInsertRowid
}

test('recordTradePlan keeps the planned levels and derives R, hold and the exit rule', () => {
  const db = initDB(':memory:')
  const id = openTrade(db)
  const p = recordTradePlan(db, id, { accountId: 'A1', symbol: 'EURUSD', side: 'BUY', strategy: 'donchian_breakout', timeframe: '1h',
    entry: 1.1000, sl: 1.0950, tp: 1.1100, timeCapAt: new Date(T0 + 240 * 60_000).toISOString(), source: 'auto_signal', now: T0 })
  assert.equal(p.plannedR, 2)
  assert.equal(p.plannedHoldMin, 240)
  assert.equal(p.exitRule, 'time_cap_240m')
  const row = db.prepare('SELECT * FROM trade_plans WHERE trade_id = ?').get(id)
  assert.equal(row.planned_entry, 1.1); assert.equal(row.planned_sl, 1.095); assert.equal(row.family, 'breakout')
  // the trade row can now be overwritten by the fill without touching the plan
  db.prepare('UPDATE trades SET entry_price = 1.1010, sl_price = 1.0960 WHERE id = ?').run(id)
  assert.equal(db.prepare('SELECT planned_entry FROM trade_plans WHERE trade_id = ?').get(id).planned_entry, 1.1)
})

test('exitRuleFor: momentum trails, a cap names its minutes, a managed account names its trail, else stop/target', () => {
  const db = initDB(':memory:')
  assert.equal(exitRuleFor(db, { strategy: 'tsmom_long' }), 'momentum_trail_3atr')
  assert.equal(exitRuleFor(db, { source: 'momentum_account', strategy: 'x' }), 'momentum_trail_3atr')
  assert.equal(exitRuleFor(db, { strategy: 'rsi_meanrev', timeCapMin: 30 }), 'time_cap_30m')
  assert.equal(exitRuleFor(db, { strategy: 'rsi_meanrev' }), 'stop_target')
})

test('scoreClosedPlans: slippage is adverse-positive, realised R against the plan, exit matched against the rule', () => {
  const db = initDB(':memory:')
  const id = openTrade(db, { entry: 1.1010, sl: 1.0960, tp: 1.1110 }) // filled 10 pips above the plan
  recordTradePlan(db, id, { accountId: 'A1', symbol: 'EURUSD', side: 'BUY', strategy: 'donchian_breakout',
    entry: 1.1000, sl: 1.0950, tp: 1.1100, timeCapMin: 240, source: 'auto_signal', now: T0 - 120 * 60_000 })
  closeTradeRow(db, id, { exitPrice: 1.1100, closeReason: 'take_profit', grossPnl: 90, netPnl: 85, closedAtMs: T0 })
  const r = scoreClosedPlans(db, { now: T0 })
  assert.equal(r.scored, 1)
  const row = db.prepare('SELECT * FROM trade_plans WHERE trade_id = ?').get(id)
  assert.equal(row.entry_slippage_r, 0.2, '10 pips adverse on a 50-pip stop is +0.2R')
  assert.equal(row.realised_r, 1.8, 'exit at the planned target from a worse fill realises 1.8R')
  assert.equal(row.exit_reason, 'take_profit')
  assert.equal(row.exit_matched, 1)
  assert.match(row.score_note, /slippage \+0\.2R/)
  assert.equal(scoreClosedPlans(db, { now: T0 }).scored, 0, 'a scored plan is not scored twice')
})

test('exitKind and ruleAdmits: a trail exit outside a stop/target rule is flagged', () => {
  assert.equal(exitKind('stop_loss'), 'stop'); assert.equal(exitKind('take_profit'), 'target')
  assert.equal(exitKind('trail_locked'), 'trail'); assert.equal(exitKind('time_cap'), 'time_cap'); assert.equal(exitKind('weekend_bank'), 'manual')
  assert.equal(ruleAdmits('stop_target', 'trail'), false)
  assert.equal(ruleAdmits('managed_trail0.5R', 'trail'), true)
  assert.equal(ruleAdmits('momentum_trail_3atr', 'stop'), true)
  assert.equal(ruleAdmits('time_cap_30m', 'time_cap'), true)
})

test('exitKind: a close the bot did not make is broker_closed, not other/unknown, and no rule admits it (PR-E)', () => {
  assert.equal(exitKind('already_closed'), 'broker_closed')
  assert.equal(exitKind('closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot'), 'broker_closed')
  assert.equal(exitKind('closed at the broker with NO STOP LOSS on record — this position was unprotected; cause of exit unknown (reclassified from the broker exit price)'), 'broker_closed')
  assert.notEqual(exitKind('already_closed'), 'other')
  assert.notEqual(exitKind('already_closed'), 'unknown')
  for (const rule of ['stop_target', 'managed_trail0.5R', 'momentum_trail_3atr', 'time_cap_30m']) assert.equal(ruleAdmits(rule, 'broker_closed'), false, rule)
  assert.equal(exitKind('stop_loss'), 'stop', 'a bot exit is unaffected')
})

test('tradePlansReport: coverage counts bot closes apart from adopted ones, and aggregates the scored', () => {
  const db = initDB(':memory:')
  const a = openTrade(db); recordTradePlan(db, a, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, sl: 1.095, tp: 1.11, now: T0 })
  closeTradeRow(db, a, { exitPrice: 1.095, closeReason: 'stop_loss', netPnl: -50, closedAtMs: T0 })
  const b = openTrade(db, { origin: 'reconciler_adopted' })
  closeTradeRow(db, b, { exitPrice: 1.1, closeReason: 'closed_at_broker', netPnl: 0, closedAtMs: T0 })
  const c = openTrade(db) // bot close with NO plan — the coverage gap
  closeTradeRow(db, c, { exitPrice: 1.1, closeReason: 'x', netPnl: 0, closedAtMs: T0 })
  scoreClosedPlans(db, { now: T0 })
  const r = tradePlansReport(db, { days: 1, now: T0 + 1000 })
  assert.equal(r.coverage.closed, 3)
  assert.equal(r.coverage.botClosed, 2)
  assert.equal(r.coverage.botPlanned, 1)
  assert.equal(r.coverage.botScored, 1)
  assert.equal(r.coverage.byOrigin.reconciler_adopted.closed, 1)
  assert.equal(r.aggregate.n, 1)
  assert.equal(r.aggregate.meanRealisedR, -1)
})

test('wiring pin: every bot entry path writes a plan (loop autoTrade, pending fill, manual route)', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const pend = strip(readFileSync(new URL('./pending-orders.js', import.meta.url), 'utf8'))
  const act = strip(readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8'))
  // Bounded windows, not lazy [\s\S]*?: the first draft of these pins stayed
  // green with the plan write altered because the lazy span reached a later
  // occurrence of the same field (mutation-checked 08-09).
  assert.match(loop, /recordTradePlan\(db, tradeId, \{[^}]{0,400}source: synth\.source \|\| 'auto_signal'/, 'autoTrade records the plan with its source')
  assert.match(loop, /tp2: synth\.tp2 \?\? null,[\s\S]{0,400}?timeframe: synth\.timeframe \?\? null,[\s\S]{0,200}?conviction: synth\.overall_conviction/, 'the autoTrade proposal carries its timeframe')
  assert.match(pend, /recordTradePlan\(db, tradeId, \{[\s\S]*?source: 'bot_pending_fill'/, 'a pending fill records the plan')
  assert.match(act, /recordTradePlan\(db, tradeId, \{[\s\S]*?source: 'manual_broker'/, 'the manual route records the plan')
  const cml = strip(readFileSync(new URL('./closed-market-limits.js', import.meta.url), 'utf8'))
  assert.match(cml, /if \(!hasPlan\) \{\s+recordTradePlan\(db, adopted\.id, \{[\s\S]{0,500}?source: 'closed_market_limit_fill'/, 'a closed-market limit fill records the plan at adoption (08-09-2026 21:32 SGT gap)')
  assert.match(loop, /scoreClosedPlans\(db\)/, 'the loop scores closed plans')
  assert.equal(typeof setState, 'function')
})
