// node --test agent/services/adaptive-breaker.test.js
//
// Adaptive breaker: a per-strategy loss streak triggers ADAPTATION through
// the stage matrix (disarm the strategy / arm the next filter) instead of a
// human-style pause. Acts once per streak; a win resets the count.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { runAdaptiveBreaker, strategyLossStreak, loadAdaptiveBreakerConfig, DEFAULT_ADAPTIVE_BREAKER } from './adaptive-breaker.js'
import { loadStageMatrix, setStage, armedTradeKeys, FILTER_DEFS } from './stage-matrix.js'

function closeTrade(db, strategy, pnl, minutesAgo = 0) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_strategy, opened_at, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', ?, ?, datetime('now', ?), datetime('now', ?))`
  ).run(pnl, strategy, `-${minutesAgo + 30} minutes`, `-${minutesAgo} minutes`)
}

test('defaults: on at streak 3; streak clamps 2..10', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadAdaptiveBreakerConfig(db), DEFAULT_ADAPTIVE_BREAKER)
  setState(db, 'adaptive_breaker_json', JSON.stringify({ on: true, streak: 99 }))
  assert.equal(loadAdaptiveBreakerConfig(db).streak, 10)
})

test('strategyLossStreak counts leading losses only', () => {
  const db = initDB(':memory:')
  closeTrade(db, 'fib_618_fade', +5, 40) // older win
  closeTrade(db, 'fib_618_fade', -1, 30)
  closeTrade(db, 'fib_618_fade', -1, 20)
  closeTrade(db, 'fib_618_fade', -1, 10)
  assert.equal(strategyLossStreak(db, 'fib_618_fade').streak, 3)
  closeTrade(db, 'fib_618_fade', +2, 0)  // newest win resets
  assert.equal(strategyLossStreak(db, 'fib_618_fade').streak, 0)
})

test('streak on a strategy with OTHERS armed → that strategy is disarmed', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const notes = []
  const out = runAdaptiveBreaker(db, { notify: (t) => notes.push(t) })
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'disarmed_strategy', scopes: ['global'] }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, false)
  assert.equal(m.strategies.find(s => s.key === 'ema_pullback').stages.trade, true)
  assert.match(notes[0], /disarmed at Auto Trade/)
})

test('NEVER-ZERO invariant: streak on the LAST armed strategy → next filter armed, strategy stays live', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade'])) // fib as the sole armed strategy
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'armed_filter', filter: 'vwap' }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, true, 'last strategy stays live (never zero armed)')
  assert.equal(m.filters.find(f => f.key === 'vwap').stages.trade, true, 'VWAP filter armed to tighten entries')
})

test('LAST armed strategy with every filter already armed → HELD, never disarmed to zero', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade'])) // fib as the sole armed strategy
  // Arm all confluence filters up front so the ladder is exhausted.
  for (const f of FILTER_DEFS) setStage(db, { kind: 'filter', key: f.key, stage: 'trade', on: true }, { getState, setState })
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'held_last_strategy' }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, true, 'last strategy is NOT disarmed to zero')
})

test('acts ONCE per streak; a new loss re-triggers (filter ladder)', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade'])) // fib as the sole armed strategy
  for (const m of [20, 10, 5]) closeTrade(db, 'fib_618_fade', -1, m)
  assert.equal(runAdaptiveBreaker(db, {}).actions.length, 1) // arms vwap (rsi already on by default)
  assert.equal(runAdaptiveBreaker(db, {}).actions.length, 0) // same streak — no repeat
  closeTrade(db, 'fib_618_fade', -1, 0)                      // 4th loss = new information
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions[0], { strategy: 'fib_618_fade', streak: 4, did: 'armed_filter', filter: 'fvg' })
})

test('a disarm reaches per-account trade pins, not just the global list', () => {
  // 2026-08-31: the breaker disarmed donchian_breakout globally while three
  // accounts kept it armed via overlay pins and proposed it for days. The
  // disarm must land wherever the strategy is armed — except a scope where it
  // is the LAST armed strategy, which holds (never-go-dark, per scope).
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('222','2',0,1,'active')`).run()
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  const io = { getState, setState }
  // 111 pins fib armed alongside another; 222 pins fib as its ONLY armed strategy.
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true, accountId: '111' }, io)
  setStage(db, { kind: 'strategy', key: 'ema_pullback', stage: 'trade', on: true, accountId: '111' }, io)
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true, accountId: '222' }, io)
  setStage(db, { kind: 'strategy', key: 'ema_pullback', stage: 'trade', on: false, accountId: '222' }, io)
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, accountId: '222' }, io)
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: false, accountId: '222' }, io)
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.equal(out.actions[0].did, 'disarmed_strategy')
  assert.deepEqual(out.actions[0].scopes.sort(), ['111', 'global'])
  assert.equal(armedTradeKeys(db, getState, null).has('fib_618_fade'), false, 'global disarmed')
  assert.equal(armedTradeKeys(db, getState, '111').has('fib_618_fade'), false, 'pinned account disarmed')
  assert.equal(armedTradeKeys(db, getState, '222').has('fib_618_fade'), true, 'last-armed scope holds — never to zero')
})

test('a streak on a strategy armed ONLY by an account pin still triggers the breaker', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback'])) // fib globally OFF
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true, accountId: '111' }, io)
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.equal(out.actions.length, 1, 'globally-off but pin-armed must not be invisible to the breaker')
  assert.deepEqual(out.actions[0].scopes, ['111'])
  assert.equal(armedTradeKeys(db, getState, '111').has('fib_618_fade'), false)
})

test('off → no actions even with a streak', () => {
  const db = initDB(':memory:')
  setState(db, 'adaptive_breaker_json', JSON.stringify({ on: false }))
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  assert.equal(runAdaptiveBreaker(db, {}).skipped, 'off')
})
