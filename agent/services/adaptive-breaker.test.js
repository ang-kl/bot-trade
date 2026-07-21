// node --test agent/services/adaptive-breaker.test.js
//
// Adaptive breaker: a per-strategy loss streak triggers ADAPTATION through
// the stage matrix (disarm the strategy / arm the next filter) instead of a
// human-style pause. Acts once per streak; a win resets the count.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { runAdaptiveBreaker, strategyLossStreak, loadAdaptiveBreakerConfig, DEFAULT_ADAPTIVE_BREAKER } from './adaptive-breaker.js'
import { loadStageMatrix } from './stage-matrix.js'

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
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'disarmed_strategy' }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, false)
  assert.equal(m.strategies.find(s => s.key === 'ema_pullback').stages.trade, true)
  assert.match(notes[0], /disarmed at Auto Trade/)
})

test('AGGRESSIVE default: streak on the LAST armed strategy → DISARMED (not filter-laddered)', () => {
  const db = initDB(':memory:') // default: fib only, aggressive default on
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'disarmed_last_strategy' }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, false, 'bleeding strategy is cut')
})

test('conservative (aggressive:false): LAST armed strategy → next filter armed instead of going idle', () => {
  const db = initDB(':memory:')
  setState(db, 'adaptive_breaker_json', JSON.stringify({ on: true, aggressive: false }))
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'armed_filter', filter: 'vwap' }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, true, 'strategy stays live')
  assert.equal(m.filters.find(f => f.key === 'vwap').stages.trade, true, 'VWAP filter armed')
})

test('acts ONCE per streak; a new loss re-triggers (conservative ladder)', () => {
  const db = initDB(':memory:')
  setState(db, 'adaptive_breaker_json', JSON.stringify({ on: true, aggressive: false }))
  for (const m of [20, 10, 5]) closeTrade(db, 'fib_618_fade', -1, m)
  assert.equal(runAdaptiveBreaker(db, {}).actions.length, 1) // arms vwap (rsi already on by default)
  assert.equal(runAdaptiveBreaker(db, {}).actions.length, 0) // same streak — no repeat
  closeTrade(db, 'fib_618_fade', -1, 0)                      // 4th loss = new information
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions[0], { strategy: 'fib_618_fade', streak: 4, did: 'armed_filter', filter: 'fvg' })
})

test('off → no actions even with a streak', () => {
  const db = initDB(':memory:')
  setState(db, 'adaptive_breaker_json', JSON.stringify({ on: false }))
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  assert.equal(runAdaptiveBreaker(db, {}).skipped, 'off')
})
