// node --test agent/services/lessons-tuner.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  computeSlWidenFactors, refreshLessonTuning, loadLessonTuning, applySlWiden,
  computeDecayKeys, isDecayed, lessonTuningKey,
  STOP_HUNT_LOOKBACK, SL_WIDEN_FACTOR,
} from './lessons-tuner.js'

function seed(db, strategy, classes, accountId = null) {
  for (const c of classes) {
    db.prepare(`INSERT INTO trade_postmortems (trade_id, symbol, strategy, classification, account_id) VALUES (NULL, 'EURUSD', ?, ?, ?)`)
      .run(strategy, c, accountId)
  }
}

// ---------------------------------------------------------------------------
// Account scoping (owner order, 02-09-2026): the widen factors read
// trade_postmortems unscoped while computeDecayKeys was scoped — one
// account's stop hunts widened every account's stops.
// ---------------------------------------------------------------------------

const HUNTS = Array(STOP_HUNT_LOOKBACK).fill('stop_hunt')

test('computeSlWidenFactors: scoped to the account — a demo account\'s hunts do not widen a live account\'s stop', () => {
  const db = initDB(':memory:')
  seed(db, 'fib_618_fade', HUNTS, 'DEMO-1')
  assert.ok(computeSlWidenFactors(db, 'DEMO-1').fib_618_fade, 'the account that produced the lessons is tuned')
  assert.deepEqual(computeSlWidenFactors(db, 'LIVE-1'), {}, 'another account is not')
  // Explicit null = the selected account (computeDecayKeys contract); with
  // no selected account every row counts, as before.
  assert.ok(computeSlWidenFactors(db).fib_618_fade, 'no selected account → unscoped')
  setState(db, 'ctrader_account_id', 'LIVE-1')
  assert.deepEqual(computeSlWidenFactors(db), {}, 'selected account is the default scope')
  // Legacy NULL rows count everywhere.
  seed(db, 'ema_pullback', HUNTS, null)
  assert.ok(computeSlWidenFactors(db, 'LIVE-1').ema_pullback)
})

test('refresh/load: one key per account; an account never refreshed is computed live, not served another\'s factors', () => {
  const db = initDB(':memory:')
  seed(db, 'fib_618_fade', HUNTS, 'DEMO-1')
  assert.ok(refreshLessonTuning(db, 'DEMO-1').fib_618_fade)
  assert.equal(lessonTuningKey('DEMO-1'), 'lesson_sl_widen_json:DEMO-1')
  assert.ok(JSON.parse(getState(db, lessonTuningKey('DEMO-1'))).fib_618_fade, 'stored under the account key')
  assert.equal(getState(db, lessonTuningKey('LIVE-1')), null, 'LIVE-1 has no stored key')
  assert.deepEqual(loadLessonTuning(db, 'LIVE-1'), {}, 'live compute for LIVE-1 sees no hunts of its own')
  assert.ok(loadLessonTuning(db, 'DEMO-1').fib_618_fade)
  // A stored key is authoritative once written (self-clearing happens on refresh).
  setState(db, lessonTuningKey('LIVE-1'), JSON.stringify({ vp_value: { factor: 1.3, evidence: 'x' } }))
  assert.ok(loadLessonTuning(db, 'LIVE-1').vp_value)
  // Live compute fires when the key is ABSENT for an account that does have evidence.
  seed(db, 'vwap_trend', HUNTS, 'DEMO-2')
  assert.ok(loadLessonTuning(db, 'DEMO-2').vwap_trend, 'never refreshed, still tuned from its own evidence')
})

test('wiring: loop.js loads and refreshes the tuner with the account in play (source pin, comments stripped)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')
  assert.ok(src.includes('loadLessonTuning(db, accountId)'), 'autoTrade must load the factors for its account')
  assert.ok(src.includes('refreshLessonTuning(db, accountId)'), 'the sweep must refresh the account in play')
  assert.ok(src.includes('refreshLessonTuning(db, a.accountId)'), 'and the rest of the roster')
  assert.ok(!src.includes('loadLessonTuning(db)') && !src.includes('refreshLessonTuning(db)'), 'no unscoped call left')
})

test('computeSlWidenFactors: stop-hunt-dominated strategy gets the widen factor', () => {
  const db = initDB(':memory:')
  seed(db, 'fib_618_fade', ['stop_hunt', 'stop_hunt', 'stop_hunt', 'stop_hunt', 'stop_hunt', 'stop_hunt', 'chop', 'chop', 'thesis_wrong', 'chop'])
  const f = computeSlWidenFactors(db)
  assert.equal(f.fib_618_fade.factor, SL_WIDEN_FACTOR)
  assert.match(f.fib_618_fade.evidence, /6\/10/)
})

test('computeSlWidenFactors: needs a full lookback of evidence; mixed losses no-op', () => {
  const db = initDB(':memory:')
  seed(db, 'ema_pullback', ['stop_hunt', 'stop_hunt', 'stop_hunt']) // only 3 — not enough
  seed(db, 'vp_value', ['thesis_wrong', 'thesis_wrong', 'chop', 'chop', 'stop_hunt', 'stop_hunt', 'stop_hunt', 'chop', 'thesis_wrong', 'chop']) // 3/10 hunts
  const f = computeSlWidenFactors(db)
  assert.deepEqual(f, {})
})

test('factors self-clear: newer non-hunt losses push hunts out of the window', () => {
  const db = initDB(':memory:')
  seed(db, 'fib_618_fade', Array(STOP_HUNT_LOOKBACK).fill('stop_hunt'))
  assert.ok(refreshLessonTuning(db).fib_618_fade)
  // 10 newer thesis_wrong losses displace the hunts entirely
  seed(db, 'fib_618_fade', Array(STOP_HUNT_LOOKBACK).fill('thesis_wrong'))
  const after = refreshLessonTuning(db)
  assert.equal(after.fib_618_fade, undefined)
  assert.deepEqual(loadLessonTuning(db), {})
})

test('applySlWiden: widens the stop away from entry, direction-aware', () => {
  const factors = { fib_618_fade: { factor: 1.3, evidence: 'x' } }
  const long = applySlWiden({ strategy: 'fib_618_fade', entry: 100, sl: 98 }, factors)
  assert.ok(Math.abs(long.signal.sl - 97.4) < 1e-9) // 100 - 2*1.3
  assert.match(long.note, /lesson_tuner/)
  const short = applySlWiden({ strategy: 'fib_618_fade', entry: 100, sl: 102 }, factors)
  assert.ok(Math.abs(short.signal.sl - 102.6) < 1e-9)
  // untouched: unknown strategy, missing sl
  assert.equal(applySlWiden({ strategy: 'other', entry: 100, sl: 98 }, factors).note, null)
  assert.equal(applySlWiden({ strategy: 'fib_618_fade', entry: 100, sl: null }, factors).note, null)
})

function seedDecay(db, symbol, strategy, timeframe, decayFlag) {
  db.prepare(`
    INSERT INTO trade_postmortems (trade_id, symbol, strategy, timeframe, classification, alpha_decay)
    VALUES (NULL, ?, ?, ?, 'thesis_wrong', ?)
  `).run(symbol, strategy, timeframe, decayFlag)
}

test('computeDecayKeys: keys the EXACT Symbol+Strategy+Timeframe, not symbol alone', () => {
  const db = initDB(':memory:')
  seedDecay(db, 'EURUSD', 'fib_618_fade', 'M15', 'decay')
  // same symbol, different strategy — independent edge, must NOT be swept in
  seedDecay(db, 'EURUSD', 'ema_pullback', 'M15', 'ok')
  const keys = computeDecayKeys(db)
  assert.ok(keys.has('EURUSD|fib_618_fade|M15'))
  assert.ok(!keys.has('EURUSD|ema_pullback|M15'))
})

test('computeDecayKeys: only the LATEST postmortem per key counts (self-clearing)', () => {
  const db = initDB(':memory:')
  seedDecay(db, 'EURUSD', 'fib_618_fade', 'M15', 'decay')
  seedDecay(db, 'EURUSD', 'fib_618_fade', 'M15', 'ok') // most recent row (higher id) clears it
  const keys = computeDecayKeys(db)
  assert.ok(!keys.has('EURUSD|fib_618_fade|M15'))
})

test('isDecayed: true only for the exact key on cool-off, false otherwise (fails safe)', () => {
  const db = initDB(':memory:')
  seedDecay(db, 'EURUSD', 'fib_618_fade', 'M15', 'decay')
  assert.equal(isDecayed(db, 'EURUSD', 'fib_618_fade', 'M15'), true)
  assert.equal(isDecayed(db, 'EURUSD', 'fib_618_fade', 'H1'), false)
  assert.equal(isDecayed(db, 'GBPUSD', 'fib_618_fade', 'M15'), false)
  assert.equal(isDecayed(null, 'EURUSD', 'fib_618_fade', 'M15'), false)
})
