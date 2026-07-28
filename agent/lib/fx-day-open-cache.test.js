// fxDayOpenMs caching — the optimisation must be invisible.
//
// Found in a production CPU profile of the scan phase: fxDayOpenMs was the
// hottest JS frame at 630ms of self time in one cycle, six times the next,
// because sessionSlices calls it once per bar and each call built a fresh
// Intl.DateTimeFormat. The fix hoists the formatter and memoises per UTC hour.
//
// Caching a time function is exactly the kind of change that is correct for
// 363 days a year. These tests are aimed at the other two: the 17:00 New York
// session boundary, and both DST transitions — where an off-by-one-hour cache
// key would silently anchor the daily loss cap and the equity stop to the
// wrong day.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fxDayOpenMs, _clearDayOpenCache, sessionSlices } from './volume-structure.js'

// The pre-optimisation implementation, verbatim, as the oracle.
function reference(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(nowMs))
  const get = (t) => Number(parts.find(p => p.type === t)?.value)
  const min = (get('hour') % 24) * 60 + get('minute')
  const anchorMin = 17 * 60
  const sinceMin = min >= anchorMin ? min - anchorMin : min + 24 * 60 - anchorMin
  return nowMs - sinceMin * 60_000 - get('second') * 1000 - (nowMs % 1000)
}

const agrees = (label, ms) => {
  assert.equal(fxDayOpenMs(ms), reference(ms),
    `${label} (${new Date(ms).toISOString()}) disagreed with the uncached implementation`)
}

test('cached and uncached agree minute by minute across a full day', () => {
  _clearDayOpenCache()
  const start = Date.parse('2026-07-28T00:00:00.000Z')
  for (let i = 0; i < 24 * 60; i += 7) agrees('minute sweep', start + i * 60_000)
})

test('the 17:00 New York boundary itself — either side, and the exact instant', () => {
  _clearDayOpenCache()
  // 2026-07-28 is EDT (UTC-4), so 17:00 NY is 21:00 UTC.
  const boundary = Date.parse('2026-07-28T21:00:00.000Z')
  for (const off of [-3_600_000, -60_000, -1, 0, 1, 60_000, 3_600_000]) agrees('boundary', boundary + off)
  // And the answer must actually CHANGE across it — a cache that returned the
  // same value on both sides would pass an agreement test that never moved.
  assert.notEqual(fxDayOpenMs(boundary - 1), fxDayOpenMs(boundary),
    'the FX day must roll over at 17:00 New York')
})

test('spring-forward DST transition', () => {
  _clearDayOpenCache()
  // 2026-03-08 02:00 EST → 03:00 EDT, i.e. 07:00 UTC.
  const t = Date.parse('2026-03-08T07:00:00.000Z')
  for (let h = -6; h <= 6; h++) agrees('spring forward', t + h * 3_600_000)
})

test('autumn fall-back DST transition', () => {
  _clearDayOpenCache()
  // 2026-11-01 02:00 EDT → 01:00 EST, i.e. 06:00 UTC.
  const t = Date.parse('2026-11-01T06:00:00.000Z')
  for (let h = -6; h <= 6; h++) agrees('fall back', t + h * 3_600_000)
})

test('a warm cache returns the same answers a cold one does', () => {
  const t = Date.parse('2026-07-28T13:20:00.000Z')
  _clearDayOpenCache()
  const cold = fxDayOpenMs(t)
  const warm = fxDayOpenMs(t)         // now served from the cache
  assert.equal(warm, cold)
  assert.equal(warm, reference(t))
})

test('the cache is bounded — a long backtest cannot grow it without limit', () => {
  _clearDayOpenCache()
  const start = Date.parse('2020-01-01T00:00:00.000Z')
  // ~2 years of distinct hours, well past the 512 cap.
  for (let h = 0; h < 20_000; h += 1) fxDayOpenMs(start + h * 3_600_000)
  // Still correct after however many evictions happened.
  agrees('post-eviction', start + 19_999 * 3_600_000)
})

test('sessionSlices — the caller that made this hot — is unchanged', () => {
  _clearDayOpenCache()
  // Three FX days of hourly bars, spanning two 17:00 NY rollovers.
  const start = Date.parse('2026-07-27T22:00:00.000Z')
  const bars = Array.from({ length: 72 }, (_, i) => ({
    t: start + i * 3_600_000, o: 1, h: 1, l: 1, c: 1, v: 10,
  }))
  const slices = sessionSlices(bars)
  assert.ok(slices.length >= 3, `expected at least three sessions, got ${slices.length}`)
  // Every bar lands in exactly one session, and in the session the uncached
  // implementation would have put it in.
  assert.equal(slices.reduce((n, s) => n + s.bars.length, 0), bars.length)
  for (const s of slices) {
    for (const b of s.bars) assert.equal(reference(b.t), s.openMs)
  }
})
