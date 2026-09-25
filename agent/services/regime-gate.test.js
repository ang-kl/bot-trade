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
  STRATEGY_KIND,
} from './regime-gate.js'
import { STRATEGY_KEYS } from './strategies.js'

test('every registered strategy has a regime kind — an unregistered one gates nothing', () => {
  // fib_confluence and va_breakout shipped without an entry here, so both
  // fired unblocked in every regime until this test caught it. Unknown
  // strategy -> checkRegimeGate's fail-open branch, silently.
  const missing = STRATEGY_KEYS.filter(k => !(k in STRATEGY_KIND))
  assert.deepEqual(missing, [])
})

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

test('PR-D (owner principle 8): a trend/breakout signal AGAINST the measured trend is blocked (trend-vs-trend); aligned passes; quiet is unchanged; unknown direction fails open', () => {
  // a donchian short into an up-trending regime → blocked, with the reason
  const r = regimeBlocks('donchian_breakout', 'short', { regime: 'trending', trend_direction: 'long' })
  assert.equal(r.block, true)
  assert.match(r.reason, /^regime_block trend-vs-trend \(donchian_breakout\): short trend signal against a long-trending market/)
  // aligned → passes, both ways
  assert.equal(regimeBlocks('donchian_breakout', 'long', { regime: 'trending', trend_direction: 'long' }).block, false)
  assert.equal(regimeBlocks('donchian_breakout', 'short', { regime: 'trending', trend_direction: 'short' }).block, false)
  assert.equal(regimeBlocks('ema_pullback', 'long', { regime: 'trending', trend_direction: 'short' }).block, true)
  assert.equal(regimeBlocks('tsmom_long', 'short', { regime: 'trending', trend_direction: 'long' }).block, true, 'the momentum book\'s shorts meet the same wall')
  // quiet is the same block it always was; ranging/volatile never read the trend for a trend strategy
  assert.match(regimeBlocks('donchian_breakout', 'short', { regime: 'quiet', trend_direction: 'long' }).reason, /trend-in-quiet/)
  assert.equal(regimeBlocks('donchian_breakout', 'short', { regime: 'ranging', trend_direction: 'long' }).block, false)
  assert.equal(regimeBlocks('donchian_breakout', 'short', { regime: 'volatile', trend_direction: 'long' }).block, false)
  // trending with no direction → fails open for a trend strategy (a fade into it still blocks, above)
  assert.equal(regimeBlocks('donchian_breakout', 'short', { regime: 'trending', trend_direction: null }).block, false)
  // DB-backed: the same wall through checkRegimeGate; a stale row is no reading
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('NATGAS', 'trending', 'long', datetime('now'))`).run()
  assert.equal(checkRegimeGate(db, 'donchian_breakout', 'short', 'NATGAS').block, true)
  assert.equal(checkRegimeGate(db, 'donchian_breakout', 'long', 'NATGAS').block, false)
  db.prepare(`DELETE FROM regimes`).run()
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('NATGAS', 'trending', 'long', datetime('now', '-2 days'))`).run()
  assert.equal(checkRegimeGate(db, 'donchian_breakout', 'short', 'NATGAS').block, false, 'a fossil reading fails open')
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

// Plan P2 (25-09-2026): the reading AS OF a past moment, for the shadow
// counterfactual. The row computed AFTER asOfMs must never answer (no
// look-ahead), and the age bound is measured against asOfMs, not now.
test('latestRegime asOfMs: the newest row at or before T, aged against T; the later row never answers', () => {
  const db = initDB(':memory:')
  const T = Date.parse('2026-09-20T12:00:00Z')
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
  db.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)').run('EURUSD', 'trending', 'long', fmt(T - 300 * 60_000))
  db.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)').run('EURUSD', 'trending', 'short', fmt(T + 10 * 60_000))
  const stale = latestRegime(db, 'EURUSD', { maxAgeMin: 240, asOfMs: T })
  assert.equal(stale.trend_direction, 'long'); assert.equal(stale.stale, true); assert.equal(stale.ageMin, 300)
  const fresh = latestRegime(db, 'EURUSD', { maxAgeMin: 400, asOfMs: T })
  assert.equal(fresh.trend_direction, 'long'); assert.equal(fresh.stale, undefined)
  assert.equal(latestRegime(db, 'EURUSD', { maxAgeMin: 0, asOfMs: T - 400 * 60_000 }), null, 'nothing computed before T - 400 m')
  // without asOfMs, behaviour is unchanged: the newest row
  assert.equal(latestRegime(db, 'EURUSD', { maxAgeMin: 0 }).trend_direction, 'short')
})
