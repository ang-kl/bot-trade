// node --test agent/services/regime-gate.test.js
//
// Regime gate: the regimes table was computed but never gated an entry, so
// the Fib FADE fired into trends and whipsaws (PF 0.15, −$2019). This matches
// each strategy's kind to the regime and blocks the mismatches.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  regimeBlocks, checkRegimeGate, latestRegime, loadRegimeGateConfig, DEFAULT_REGIME_GATE,
} from './regime-gate.js'

test('config default on; toggle off respected', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadRegimeGateConfig(db), DEFAULT_REGIME_GATE)
  setState(db, 'regime_gate_json', JSON.stringify({ on: false }))
  assert.equal(loadRegimeGateConfig(db).on, false)
})

test('mean-reversion is blocked in a volatile regime', () => {
  assert.equal(regimeBlocks('fib_618_fade', 'long', { regime: 'volatile' }).block, true)
  assert.equal(regimeBlocks('rsi_meanrev', 'short', { regime: 'volatile' }).block, true)
})

test('mean-reversion fading AGAINST a live trend is blocked; WITH the trend is allowed', () => {
  // short fade into an up-trend → block
  assert.equal(regimeBlocks('fib_618_fade', 'short', { regime: 'trending', trend_direction: 'long' }).block, true)
  // long fade in an up-trend (buying the dip) → allowed
  assert.equal(regimeBlocks('fib_618_fade', 'long', { regime: 'trending', trend_direction: 'long' }).block, false)
  // trending but direction unknown → block (risky default)
  assert.equal(regimeBlocks('fib_618_fade', 'long', { regime: 'trending', trend_direction: null }).block, true)
})

test('mean-reversion is allowed in ranging/quiet — where fades work', () => {
  assert.equal(regimeBlocks('fib_618_fade', 'long', { regime: 'ranging' }).block, false)
  assert.equal(regimeBlocks('fib_618_fade', 'short', { regime: 'quiet' }).block, false)
})

test('trend/breakout strategies are blocked in a quiet regime, allowed in a trend', () => {
  assert.equal(regimeBlocks('ema_pullback', 'long', { regime: 'quiet' }).block, true)
  assert.equal(regimeBlocks('donchian_breakout', 'short', { regime: 'quiet' }).block, true)
  assert.equal(regimeBlocks('ema_pullback', 'long', { regime: 'trending', trend_direction: 'long' }).block, false)
  assert.equal(regimeBlocks('ema_pullback', 'long', { regime: 'volatile' }).block, false)
})

test('unknown regime or unknown strategy fails open (never blocks)', () => {
  assert.equal(regimeBlocks('fib_618_fade', 'long', null).block, false)
  assert.equal(regimeBlocks('fib_618_fade', 'long', { regime: null }).block, false)
  assert.equal(regimeBlocks('some_new_strategy', 'long', { regime: 'volatile' }).block, false)
})

test('checkRegimeGate: reads the latest regime row and honours the off switch', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('XAUUSD', 'trending', 'long', datetime('now'))`).run()
  // A short fade into the up-trend → blocked while on.
  assert.equal(checkRegimeGate(db, 'fib_618_fade', 'short', 'XAUUSD').block, true)
  // Latest row wins: a newer 'ranging' row flips it to allowed.
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('XAUUSD', 'ranging', null, datetime('now', '+1 second'))`).run()
  assert.equal(latestRegime(db, 'XAUUSD').regime, 'ranging')
  assert.equal(checkRegimeGate(db, 'fib_618_fade', 'short', 'XAUUSD').block, false)
  // Off switch disables entirely.
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('XAUUSD', 'volatile', null, datetime('now', '+2 seconds'))`).run()
  setState(db, 'regime_gate_json', JSON.stringify({ on: false }))
  assert.equal(checkRegimeGate(db, 'fib_618_fade', 'long', 'XAUUSD').block, false)
})
