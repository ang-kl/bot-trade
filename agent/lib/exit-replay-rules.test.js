// node --test agent/lib/exit-replay-rules.test.js
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder). The additive
// rules: partial at R, since-entry Chandelier, exit at the mean.
import test from 'node:test'
import assert from 'node:assert/strict'
import { replayExit, atrAt, smaAt, favourableExcursion } from './exit-replay.js'
import { wilderAtr } from '../services/mae-chandelier-observe.js'

const MIN = 60_000, t0 = Date.parse('2026-08-03T20:00:00Z')
const bar = (m, o, h, l, c) => [t0 + m * MIN, o, h, l, c, 0]
const LONG = { side: 'long', entry: 100, sl: 99, tp: null, openedAtMs: t0 }
const SHORT = { side: 'short', entry: 100, sl: 101, tp: null, openedAtMs: t0 }

test('partial at +1R banks half at the level and blends it with the runner\'s exit', () => {
  const bars = [bar(0, 100, 101.2, 99.9, 101.1), bar(5, 101.1, 101.3, 98.8, 98.9)]
  const r = replayExit(bars, LONG, { name: 'half_at_1R', partialAtR: 1, partialFraction: 0.5 })
  assert.equal(r.reason, 'stop'); assert.equal(r.runnerR, -1)
  assert.equal(r.rMultiple, 0, 'half banked at +1R, half stopped at −1R')
  assert.deepEqual(r.partial, { r: 1, fraction: 0.5, atMs: t0 })
  // Without the rule: the plain −1R, and no `partial` field (legacy shape).
  const plain = replayExit(bars, LONG, { name: 'as_traded' })
  assert.equal(plain.rMultiple, -1); assert.equal('partial' in plain, false)
})

test('a bar touching the partial level AND the stop resolves as the stop, never as a banked partial', () => {
  const bars = [bar(0, 100, 101.2, 98.9, 99)]
  const r = replayExit(bars, LONG, { name: 'half_at_1R', partialAtR: 1, partialFraction: 0.5 })
  assert.equal(r.reason, 'stop'); assert.equal(r.rMultiple, -1); assert.equal(r.partial, undefined)
})

test('a full partial (fraction 1) is an exit at the level; the +1R take then trails the rest', () => {
  const bars = [bar(0, 100, 101.2, 99.9, 101.1), bar(5, 101.1, 102.6, 101, 102.5), bar(10, 102.5, 102.7, 101.4, 101.5)]
  const full = replayExit(bars, LONG, { name: 'tp_1R_full', partialAtR: 1, partialFraction: 1 })
  assert.equal(full.reason, 'partial_full'); assert.equal(full.rMultiple, 1)
  // managed approximation: half at +1R, the rest on a 0.5R trail → peak 2.6R trails the stop to 2.1R
  const managed = replayExit(bars, LONG, { name: 'managed_approx', partialAtR: 1, partialFraction: 0.5, trailR: 0.5 })
  assert.equal(managed.reason, 'stop_moved'); assert.equal(managed.runnerR, 2.1); assert.equal(managed.rMultiple, 1.55)
})

test('the exit at the mean: close crossing the SMA in the trade\'s favour exits at that close; short mirrored', () => {
  // closes 100,100,100,100 then a run-up: SMA(4) lags, close ≥ SMA fires on the first bar at/above it.
  // The entry bar closes BELOW the mean (a mean-reversion long buys below it); a close at the mean is not across it.
  const bars = [bar(-3, 100, 100.1, 99.9, 100), bar(-2, 100, 100.1, 99.9, 100), bar(-1, 100, 100.1, 99.9, 100), bar(0, 99.8, 100.0, 99.7, 99.8),
    bar(1, 99.8, 100.6, 99.75, 100.5)]
  const r = replayExit(bars, { ...LONG, sl: 99 }, { name: 'mean_4', exitAtMean: { period: 4 } })
  assert.equal(r.reason, 'mean'); assert.equal(r.exitPrice, 100.5); assert.equal(r.rMultiple, 0.5)
  const sBars = [bar(-3, 100, 100.1, 99.9, 100), bar(-2, 100, 100.1, 99.9, 100), bar(-1, 100, 100.1, 99.9, 100), bar(0, 100.2, 100.3, 100, 100.2),
    bar(1, 100.2, 100.25, 99.4, 99.5)]
  const s = replayExit(sBars, SHORT, { name: 'mean_4', exitAtMean: { period: 4 } })
  assert.equal(s.reason, 'mean'); assert.equal(s.rMultiple, 0.5)
  // Too few closes for the SMA: no exit from the rule, the window truncates.
  assert.equal(replayExit(bars.slice(3), LONG, { name: 'mean_4', exitAtMean: { period: 4 } }).truncated, true)
  // A close exactly AT the mean is not across it: flat closes at 100 with SMA 100 never fire.
  const flat = [bar(-3, 100, 100.1, 99.9, 100), bar(-2, 100, 100.1, 99.9, 100), bar(-1, 100, 100.1, 99.9, 100), bar(0, 100, 100.1, 99.9, 100), bar(1, 100, 100.1, 99.9, 100)]
  assert.equal(replayExit(flat, LONG, { name: 'mean_4', exitAtMean: { period: 4 } }).truncated, true)
})

test('the since-entry Chandelier trails peak − mult·ATR, tighten-only, and its ATR equals the live module\'s wilderAtr', () => {
  // 30 flat context bars (range 0.2) then a run to 103 and a pull-back.
  const bars = []
  for (let m = -30; m < 0; m++) bars.push(bar(m, 100, 100.1, 99.9, 100))
  bars.push(bar(0, 100, 103, 99.9, 102.9), bar(1, 102.9, 103.0, 102.6, 102.7), bar(2, 102.7, 102.8, 101.9, 102.0))
  const objs = bars.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }))
  for (const i of [25, 30, 31]) assert.equal(atrAt(bars, i, 22), wilderAtr(objs.slice(0, i + 1), 22), `atr parity at ${i}`)
  const r = replayExit(bars, { ...LONG, sl: 98 }, { name: 'chandelier', chandelier: { mult: 3, period: 22 } })
  // After bar 0 the ATR (22-period Wilder: 21 context TRs of 0.2 and the 3.1-range bar) is 0.3318, so the trail sits at 103 − 0.995 = 102.0045; bar 1's lower
  // ATR cannot loosen it (tighten-only); bar 2's low 101.9 hits it. Risk is 2 (stop 98), so R ≈ 1.0.
  assert.equal(r.reason, 'stop_moved'); assert.ok(Math.abs(r.exitPrice - 102.0045) < 0.001, `trail ${r.exitPrice}`)
  assert.equal(r.rMultiple, 1.002)
  // Without enough bars for the ATR, the Chandelier is inert.
  const short = replayExit(bars.slice(28), { ...LONG, sl: 98 }, { name: 'chandelier', chandelier: { mult: 3, period: 22 } })
  assert.equal(short.truncated, true)
  assert.equal(smaAt(bars, 2, 3), (100 + 100 + 100) / 3)
})

test('favourableExcursion: the peak is a bracket — before the stop bar, and with that bar\'s own extreme', () => {
  const t0 = 1_700_000_000_000, MIN = 60_000
  // Long 100, stop 99 (risk 1). Bar 0 peaks +1R; bar 1 spikes to +3R AND hits the stop.
  const bars = [[t0, 100, 101, 99.5, 100.8, 0], [t0 + MIN, 100.8, 103, 98.9, 99.2, 0], [t0 + 2 * MIN, 99.2, 99.4, 99, 99.3, 0]]
  const ex = favourableExcursion(bars, { side: 'long', entry: 100, sl: 99, openedAtMs: t0 })
  assert.deepEqual(ex, { ok: true, stopped: true, truncated: false, barsUsed: 2, peakRBeforeStopBar: 1, peakRInclStopBar: 3 })
  // No stop inside the window: truncated, with the peak so far on both sides.
  const open = favourableExcursion(bars.slice(0, 1), { side: 'long', entry: 100, sl: 99 })
  assert.deepEqual(open, { ok: true, stopped: false, truncated: true, barsUsed: 1, peakRBeforeStopBar: 1, peakRInclStopBar: 1 })
  // A short mirrors it; bars before the open are context, not the trade.
  // Short 100, stop 102.5 (risk 2.5): bar 0 reaches 99.5 (+0.2R); bar 1 reaches 98.9 (+0.44R) and hits the stop at 103.
  const short = favourableExcursion([[t0 - MIN, 100, 105, 95, 100, 0], ...bars], { side: 'short', entry: 100, sl: 102.5, openedAtMs: t0 })
  assert.equal(short.barsUsed, 2); assert.equal(short.peakRBeforeStopBar, 0.2); assert.equal(short.peakRInclStopBar, 0.44)
  assert.equal(favourableExcursion(bars, { side: 'long', entry: 100, sl: 100 }).ok, false)
  assert.equal(favourableExcursion([], { side: 'long', entry: 100, sl: 99 }).ok, false)
})
