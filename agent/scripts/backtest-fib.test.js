// node --test agent/scripts/backtest-fib.test.js
// Exit honesty (audit fixes) + session filter windows.

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveExit, resolvePending } from './backtest-fib.js'
import { inPrimeSession } from '../lib/sessions.js'

const longPos = { dir: 1, entry: 100, sl: 95, tp: 110, entryT: 0, capMs: 0 }

test('SL before TP when both are inside one bar', () => {
  const exit = resolveExit(longPos, { t: 1, o: 100, h: 111, l: 94, c: 105 })
  assert.equal(exit.reason, 'sl')
  assert.equal(exit.price, 95)
})

test('gap through the SL fills at the open, not the SL (audit flaw #2)', () => {
  const exit = resolveExit(longPos, { t: 1, o: 90, h: 92, l: 88, c: 91 })
  assert.equal(exit.reason, 'sl')
  assert.equal(exit.price, 90) // worse than 95 — honest gap fill
  const short = { dir: -1, entry: 100, sl: 105, tp: 90, entryT: 0, capMs: 0 }
  const sExit = resolveExit(short, { t: 1, o: 108, h: 109, l: 107, c: 108 })
  assert.equal(sExit.price, 108)
})

test('gap beyond the TP still books only the TP (never better than plan)', () => {
  const exit = resolveExit(longPos, { t: 1, o: 112, h: 113, l: 111, c: 112 })
  assert.equal(exit.reason, 'tp')
  assert.equal(exit.price, 110)
})

test('no exit when the bar stays inside SL/TP', () => {
  assert.equal(resolveExit(longPos, { t: 1, o: 100, h: 105, l: 98, c: 103 }), null)
})

test('time cap closes at the bar close', () => {
  const pos = { ...longPos, capMs: 60_000 }
  const exit = resolveExit(pos, { t: 61_000, o: 100, h: 101, l: 99, c: 100.5 })
  assert.deepEqual(exit, { price: 100.5, reason: 'time_cap' })
})

test('inPrimeSession: FX trades London/NY weekday hours only', () => {
  const tue14utc = Date.UTC(2026, 6, 7, 14, 0) // Tue 14:00 UTC — prime
  const tue03utc = Date.UTC(2026, 6, 7, 3, 0)  // Tue 03:00 UTC — Asia-only hours
  const sat12utc = Date.UTC(2026, 6, 11, 12, 0)
  assert.equal(inPrimeSession('EURUSD', tue14utc), true)
  assert.equal(inPrimeSession('EURUSD', tue03utc), false)
  assert.equal(inPrimeSession('EURUSD', sat12utc), false)
})

test('inPrimeSession: indices follow the exchange window, crypto always on', () => {
  const tue15utc = Date.UTC(2026, 6, 7, 15, 0) // inside NYSE window
  const tue09utc = Date.UTC(2026, 6, 7, 9, 0)  // before NYSE open
  assert.equal(inPrimeSession('US30', tue15utc), true)
  assert.equal(inPrimeSession('US30', tue09utc), false)
  assert.equal(inPrimeSession('BTCUSD', Date.UTC(2026, 6, 11, 3, 0)), true)
})

// --- touch-fill (pending order) mechanics -----------------------------------

test('resolvePending: fills when the bar range touches the level', () => {
  const p = { dir: 1, level: 100, sl: 95, tp: 110, expireT: 10_000 }
  assert.equal(resolvePending(p, { t: 1, o: 103, h: 104, l: 99.5, c: 102 }), 'fill')
})

test('resolvePending: cancels on close beyond the stop before fill', () => {
  const p = { dir: 1, level: 100, sl: 95, tp: 110, expireT: 10_000 }
  assert.equal(resolvePending(p, { t: 1, o: 96, h: 97, l: 93, c: 94 }), 'cancel')
  const short = { dir: -1, level: 100, sl: 105, tp: 90, expireT: 10_000 }
  assert.equal(resolvePending(short, { t: 1, o: 104, h: 107, l: 103, c: 106 }), 'cancel')
})

test('resolvePending: cancels on expiry, null while waiting', () => {
  const p = { dir: 1, level: 100, sl: 95, tp: 110, expireT: 5_000 }
  assert.equal(resolvePending(p, { t: 5_000, o: 102, h: 103, l: 101, c: 102 }), 'cancel')
  assert.equal(resolvePending(p, { t: 1, o: 102, h: 103, l: 101, c: 102 }), null)
})
