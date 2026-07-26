// node --test agent/scripts/backtest-fib.test.js
// Exit honesty (audit fixes) + session filter windows.

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveExit, resolvePending, computeStats, runBacktest } from './backtest-fib.js'
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

// --- computeStats: the stop-clamp telemetry rollup ---------------------

test('computeStats.slClamp is null when no trade carries the field (fib etc.)', () => {
  const trades = [
    { dir: 1, entry: 100, exit: 102, entryT: 0, exitT: 1000, pnlPct: 2, reason: 'tp' },
    { dir: 1, entry: 100, exit: 95, entryT: 0, exitT: 1000, pnlPct: -5, reason: 'sl' },
  ]
  assert.equal(computeStats(trades).slClamp, null)
})

test('computeStats.slClamp aggregates min/max/avg and the widened-to-floor rate', () => {
  const trades = [
    { dir: 1, entry: 100, exit: 102, entryT: 0, exitT: 1000, pnlPct: 2, reason: 'tp', slAtrMult: 0.8, slWidenedToFloor: true },
    { dir: 1, entry: 100, exit: 95, entryT: 0, exitT: 1000, pnlPct: -5, reason: 'sl', slAtrMult: 1.5, slWidenedToFloor: false },
    { dir: -1, entry: 100, exit: 97, entryT: 0, exitT: 1000, pnlPct: 3, reason: 'tp', slAtrMult: 2.4, slWidenedToFloor: false },
  ]
  const { slClamp } = computeStats(trades)
  assert.deepEqual(slClamp, {
    reporting: 3,
    widenedToFloor: 1,
    widenedToFloorPct: 33.33,
    minMult: 0.8,
    maxMult: 2.4,
    avgMult: 1.57,
  })
})

test('computeStats.slClamp only counts trades that actually reported it — mixed strategies', () => {
  const trades = [
    { dir: 1, entry: 100, exit: 102, entryT: 0, exitT: 1000, pnlPct: 2, reason: 'tp', slAtrMult: 1.0, slWidenedToFloor: false },
    { dir: 1, entry: 100, exit: 95, entryT: 0, exitT: 1000, pnlPct: -5, reason: 'sl' }, // no telemetry
  ]
  const { slClamp } = computeStats(trades)
  assert.equal(slClamp.reporting, 1)
  assert.equal(slClamp.minMult, 1.0)
})

// --- runBacktest: the telemetry actually reaches computeStats end to end ---

// Reuses ema-pullback.test.js's exact fixture shape (trendBars + withPullbackBar)
// so this is a real, currently-registered strategy firing through the real
// dispatch path — not a mock.
function trendBars(n, start, slope, range = 1) {
  const bars = []
  for (let i = 0; i < n; i++) {
    const c = start + slope * i
    bars.push({ t: i * 3_600_000, o: c - slope, h: c + range / 2, l: c - range / 2, c, v: 1 })
  }
  return bars
}

test('runBacktest: ema_pullback trades carry sl_atr_mult through to computeStats', async () => {
  const { emaSeries } = await import('../services/ema-pullback.js')
  const K20 = 2 / 21
  const base = trendBars(240, 100, 0.15)
  const prevEma20 = emaSeries(base, 20)[base.length - 1]
  const c = base[base.length - 1].c + 0.1
  const ema20 = c * K20 + prevEma20 * (1 - K20)
  const pullback = { t: base.length * 3_600_000, o: c, h: c + 0.5, l: ema20 - 0.3, c, v: 1 }
  // Bars AFTER the pullback so the loop has a "next" bar to fill the entry
  // on, and enough runway to travel to TP (2R, a few tenths of a point here).
  const runway = trendBars(30, c + 0.15, 0.15).map((b, i) => ({ ...b, t: pullback.t + (i + 1) * 3_600_000 }))
  const bars = [...base, pullback, ...runway]

  const { trades, stats } = runBacktest(bars, { timeframe: '1h', strategy: 'ema_pullback', minConviction: 0 })
  assert.ok(trades.length >= 1, 'expected at least one ema_pullback trade')
  assert.equal(typeof trades[0].slAtrMult, 'number')
  assert.ok(stats.slClamp, 'stats should report the clamp rollup for this strategy')
  assert.equal(stats.slClamp.reporting, trades.length)
})
