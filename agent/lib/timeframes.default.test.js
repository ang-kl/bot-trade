// node --test agent/lib/timeframes.default.test.js
//
// Owner (2026-07-30): "The timeframe for Pipeline - default are, and we should
// use these. 1w 3d 1d 12h 8h 4h 1h 30m 15m 10m 5m 2m."
//
// Pinned as a LIST, in order, because four separate modules previously each
// carried their own ['4h','1d'] literal — which is how a "default" comes to mean
// four different things depending on which one you read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { DEFAULT_AUTOTRADE_TIMEFRAMES, armedTimeframes, parseTimeframe, fetchPlan, NATIVE_TF_MS } from './timeframes.js'

const OWNER_LIST = ['1w', '3d', '1d', '12h', '8h', '4h', '1h', '30m', '15m', '10m', '5m', '2m']

test('the default IS the owner\'s list, in the owner\'s order', () => {
  assert.deepEqual([...DEFAULT_AUTOTRADE_TIMEFRAMES], OWNER_LIST)
})

test('every default timeframe is actually obtainable — native or exact synthesis', () => {
  for (const tf of DEFAULT_AUTOTRADE_TIMEFRAMES) {
    const p = parseTimeframe(tf)
    assert.ok(p, `${tf} must parse`)
    assert.equal(p.label, tf, `${tf} must be its own canonical label`)
    if (NATIVE_TF_MS[tf] != null) continue
    // Non-native ⇒ must synthesise from a native base by a WHOLE factor, or the
    // last bar is partial and every level derived from it is wrong.
    const plan = fetchPlan(p.ms)
    assert.ok(plan, `${tf} must have a fetch plan`)
    assert.equal(p.ms % NATIVE_TF_MS[plan.base], 0, `${tf} must be an exact multiple of ${plan.base}`)
    assert.ok(Number.isInteger(plan.factor) && plan.factor > 1, `${tf} factor must be a whole number`)
  }
})

test('3d and 8h are the two synthesised ones, from 1d and 4h', () => {
  assert.equal(fetchPlan(parseTimeframe('3d').ms).base, '1d')
  assert.equal(fetchPlan(parseTimeframe('3d').ms).factor, 3)
  assert.equal(fetchPlan(parseTimeframe('8h').ms).base, '4h')
  assert.equal(fetchPlan(parseTimeframe('8h').ms).factor, 2)
})

test('armedTimeframes: a stored list WINS over the default', () => {
  const db = initDB(':memory:')
  assert.deepEqual(armedTimeframes(db, getState), OWNER_LIST)
  setState(db, 'autotrade_timeframes', JSON.stringify(['4h']))
  assert.deepEqual(armedTimeframes(db, getState), ['4h'])
})

test('armedTimeframes: junk or empty falls back rather than arming nothing', () => {
  const db = initDB(':memory:')
  for (const bad of ['[]', 'not json', 'null', '{}', '""']) {
    setState(db, 'autotrade_timeframes', bad)
    assert.deepEqual(armedTimeframes(db, getState), OWNER_LIST, `stored=${bad}`)
  }
})

test('the returned array is a COPY — a caller cannot mutate the shared default', () => {
  const db = initDB(':memory:')
  const a = armedTimeframes(db, getState)
  a.push('1s')
  assert.deepEqual(armedTimeframes(db, getState), OWNER_LIST)
  assert.equal(DEFAULT_AUTOTRADE_TIMEFRAMES.length, 12)
})
