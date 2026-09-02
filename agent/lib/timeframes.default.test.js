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
import { readFileSync } from 'node:fs'
import { initDB, setState, getState } from '../db.js'
import { DEFAULT_AUTOTRADE_TIMEFRAMES, armedTimeframes, armedScopeGate, parseTimeframe, fetchPlan, NATIVE_TF_MS } from './timeframes.js'

// '4d' added 02-09-2026 (owner order, with "matrix wins over the list"): the
// autotrade matrix carried 4d cells from data that this list lacked.
const OWNER_LIST = ['1w', '4d', '3d', '1d', '12h', '8h', '4h', '1h', '30m', '15m', '10m', '5m', '2m']

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

test('4d, 3d and 8h are the synthesised ones, from 1d, 1d and 4h', () => {
  assert.equal(fetchPlan(parseTimeframe('4d').ms).base, '1d')
  assert.equal(fetchPlan(parseTimeframe('4d').ms).factor, 4)
  assert.equal(fetchPlan(parseTimeframe('3d').ms).base, '1d')
  assert.equal(fetchPlan(parseTimeframe('3d').ms).factor, 3)
  assert.equal(fetchPlan(parseTimeframe('8h').ms).base, '4h')
  assert.equal(fetchPlan(parseTimeframe('8h').ms).factor, 2)
})

test("'4d' is in the default allow-list and parses to its own label (02-09-2026)", () => {
  assert.ok(DEFAULT_AUTOTRADE_TIMEFRAMES.includes('4d'))
  assert.deepEqual(parseTimeframe('4d'), { label: '4d', ms: 4 * 86_400_000 })
  assert.deepEqual(armedTimeframes(initDB(':memory:'), getState).includes('4d'), true)
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
  assert.equal(DEFAULT_AUTOTRADE_TIMEFRAMES.length, 13)
})

// ---------------------------------------------------------------------------
// Scope 'armed': THE MATRIX WINS OVER THE LIST (owner order, 02-09-2026).
// The list ran first in loop.js, so 68 of 161 matrix-armed cells on
// 3d/4d/12h/8h/1w could never dispatch. The matrix is the arming authority.
// ---------------------------------------------------------------------------

test('armedScopeGate: a matrix-armed symbol×timeframe passes even when the list lacks the timeframe', () => {
  const allowedTfs = ['4h', '1d']
  const matrix = { NATGAS: ['4d', '12h'], EURUSD: ['4h'] }
  const v = armedScopeGate({ symbol: 'natgas', timeframe: '4d', allowedTfs, matrix })
  assert.deepEqual(v, { ok: true, via: 'matrix', reason: null })
  assert.equal(armedScopeGate({ symbol: 'NATGAS', timeframe: '12h', allowedTfs, matrix }).ok, true)
  // A symbol the matrix names trades ONLY the timeframes armed for it — the
  // list does not widen the matrix either.
  const blocked = armedScopeGate({ symbol: 'NATGAS', timeframe: '4h', allowedTfs, matrix })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.via, 'matrix')
  assert.match(blocked.reason, /not armed for this symbol \(armed: 4d,12h\)/)
})

test('armedScopeGate: the list still gates symbols the matrix does not name, and everything without a matrix', () => {
  const allowedTfs = ['4h', '1d']
  const matrix = { NATGAS: ['4d'] }
  assert.equal(armedScopeGate({ symbol: 'GBPUSD', timeframe: '4h', allowedTfs, matrix }).ok, true)
  const blocked = armedScopeGate({ symbol: 'GBPUSD', timeframe: '15m', allowedTfs, matrix })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.via, 'list')
  assert.match(blocked.reason, /15m not in autotrade_timeframes \[4h,1d\]/)
  for (const m of [null, undefined, {}, [], 'junk', 42]) {
    assert.equal(armedScopeGate({ symbol: 'NATGAS', timeframe: '4h', allowedTfs, matrix: m }).via, 'list', `matrix=${JSON.stringify(m)}`)
    assert.equal(armedScopeGate({ symbol: 'NATGAS', timeframe: '4d', allowedTfs, matrix: m }).ok, false)
  }
})

// loop.js is the only caller and has no injection point; pin the wiring on
// the source with comments stripped (failure modes #2 and #4).
test('wiring: loop.js scope gate consults armedScopeGate and no longer runs the list check first', () => {
  const raw = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')
  const at = src.indexOf("=== 'armed')")
  assert.ok(at > 0, 'the scope-armed branch must exist')
  const block = src.slice(at, at + 1500)
  assert.ok(block.includes('armedScopeGate({ symbol: sym, timeframe: synth.timeframe, allowedTfs, matrix })'), 'the gate must be the matrix-first verdict')
  assert.ok(!block.includes('!allowedTfs.includes(synth.timeframe)'), 'the list-first pre-check must be gone')
  assert.ok(!src.includes("matrix[sym.toUpperCase()] || []"), 'the old inline matrix read (absent symbol ⇒ blocked) must be gone')
})
