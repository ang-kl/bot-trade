// node --test agent/lib/tick-bars.test.js
// Claude · № 13,095 11-Oct (ordered № 13,093; claude-builder)
import test from 'node:test'
import assert from 'node:assert/strict'
import { timeBars, tickBars, nominalTickCount, countsAsTick, refusedByDesignFloor, POINTS_PER_PRICE, V_SEMANTICS, INVALID } from './tick-bars.js'

const T0 = 1_760_000_000_000 // on a minute boundary? 1_760_000_000_000 / 60_000 = 29_333_333.33 — not; use a rounded one
const M0 = Math.floor(T0 / 60_000) * 60_000 // minute start
const q = (ms, bid, ask = bid + 10, extra = {}) => ({ seq: ms, recvMs: ms, bid: bid * POINTS_PER_PRICE / 1000, ask: ask * POINTS_PER_PRICE / 1000, snapshot: false, crossed: false, changed: true, ...extra })
// bid in thousandths of a price unit: q(t, 100500) → 100.5

test('countsAsTick: only a two-sided, non-snapshot, non-crossed CHANGED quote counts; gaps, repeats, snapshots, crossed and one-sided do not', () => {
  assert.equal(countsAsTick(q(1, 100000)), true)
  assert.equal(countsAsTick(q(1, 100000, 100010, { changed: false })), false)
  assert.equal(countsAsTick(q(1, 100000, 100010, { snapshot: true })), false)
  assert.equal(countsAsTick(q(1, 100000, 100010, { crossed: true })), false)
  assert.equal(countsAsTick(q(1, 100020, 100010)), false, 'bid above ask is crossed even unflagged')
  assert.equal(countsAsTick({ ...q(1, 100000), ask: null }), false)
  assert.equal(countsAsTick({ gapMarker: true }), false)
  assert.equal(countsAsTick({ seq: 0, recvMs: 0, bid: 1, ask: 0, crossed: true, snapshot: false, changed: true }), false, 'the rewritten gap sentinel')
})

test('timeBars: bucketed on the clock, bid prices, v = changed quotes; empty buckets give no bar; the first partial bucket is invalid; the unclosed tail is `open`', () => {
  const quotes = [
    q(M0 + 30_000, 100000), // first bucket started mid-way: partial
    q(M0 + 60_000, 100100), q(M0 + 70_000, 100300), q(M0 + 80_000, 99900), q(M0 + 90_000, 100200), // minute 1: o100.1 h100.3 l99.9 c100.2 v4
    q(M0 + 95_000, 100200, 100210, { changed: false }), // a repeat: no tick, no price effect
    q(M0 + 100_000, 100200, 100210, { snapshot: true }), // a snapshot: no tick
    // minute 2 empty
    q(M0 + 180_000, 100250), q(M0 + 200_000, 100260), // minute 3: closed by...
    q(M0 + 240_000, 100270), // minute 4: open at the end
  ]
  const r = timeBars(quotes, { barMs: 60_000 })
  assert.equal(r.vSemantics, V_SEMANTICS.TIME); assert.equal(r.form, 'time_60000ms')
  assert.deepEqual(r.invalid, [{ t: M0, reason: INVALID.PARTIAL, n: 1 }])
  assert.equal(r.bars.length, 2, 'minute 1 and minute 3; minute 2 has no bar; minute 4 is open')
  const b1 = r.bars[0]
  assert.deepEqual([b1.t, b1.o, b1.h, b1.l, b1.c, b1.v, b1.n], [M0 + 60_000, 100.1, 100.3, 99.9, 100.2, 4, 4])
  assert.deepEqual([r.bars[1].t, r.bars[1].v], [M0 + 180_000, 2])
  assert.equal(r.open.t, M0 + 240_000); assert.equal(r.open.n, 1)
  assert.deepEqual(r.dropped, { gap: 0, one_sided: 0, snapshot: 1, crossed: 0, repeat: 1 })
  assert.deepEqual(r.segments.map(s => s.length), [2], 'no invalid bar between the two valid ones')
  // mid price
  const mid = timeBars(quotes, { barMs: 60_000, price: 'mid' })
  assert.equal(mid.bars[0].o, 100.105)
})

test('timeBars: a gap marks the bar it is seen in AND the one that follows, and splits the segments; a silence past the bound invalidates the bar after it', () => {
  const quotes = [
    q(M0, 100000), q(M0 + 10_000, 100100),
    { gapMarker: true },
    q(M0 + 20_000, 100200), // same bucket as the gap → that bucket is gap-invalid
    q(M0 + 60_000, 100300), q(M0 + 70_000, 100400), // minute 1 valid
    { seq: 0, recvMs: 0, bid: 1, ask: 0, crossed: true, snapshot: false, changed: true }, // the rewritten sentinel, between buckets
    q(M0 + 120_000, 100500), // minute 2 → gap-invalid (pending from the sentinel)
    q(M0 + 180_000, 100600), q(M0 + 190_000, 100650), // minute 3 valid
    q(M0 + 1_200_000, 100700), q(M0 + 1_210_000, 100750), // minute 20: 16 min 50 s of silence before it
    q(M0 + 1_260_000, 100800), q(M0 + 1_270_000, 100850), // minute 21 valid
    q(M0 + 1_320_000, 100900), // open
  ]
  const r = timeBars(quotes, { barMs: 60_000, maxSilenceMs: 900_000 })
  // Bucket 0 is partial (first of the stream) and holds the first gap; the
  // gap also marks minute 1, the bar that follows it. The sentinel arrives
  // while minute 1 is still open, so minute 1 and minute 2 are both marked.
  assert.deepEqual(r.invalid.map(i => [i.t - M0, i.reason]), [[0, INVALID.PARTIAL], [60_000, INVALID.GAP], [120_000, INVALID.GAP], [1_200_000, INVALID.SILENCE]])
  assert.deepEqual(r.bars.map(b => (b.t - M0) / 60_000), [3, 21])
  assert.deepEqual(r.segments.map(s => s.map(b => (b.t - M0) / 60_000)), [[3], [21]])
  assert.equal(r.dropped.gap, 2)
  // Without a silence bound minute 20 is valid.
  const loose = timeBars(quotes, { barMs: 60_000 })
  assert.deepEqual(loose.bars.map(b => (b.t - M0) / 60_000), [3, 20, 21])
  // A gap seen between two buckets with no bar open marks only the bar that follows it.
  const between = timeBars([q(M0, 100000), q(M0 + 1000, 100100), q(M0 + 60_000, 100200), { gapMarker: true }, q(M0 + 120_000, 100300), q(M0 + 180_000, 100400), q(M0 + 240_000, 100500)], { barMs: 60_000 })
  assert.deepEqual(between.invalid.map(i => [(i.t - M0) / 60_000, i.reason]), [[0, INVALID.PARTIAL], [1, INVALID.GAP], [2, INVALID.GAP]])
  assert.deepEqual(between.bars.map(b => (b.t - M0) / 60_000), [3])
})

test('tickBars: every n ticks close a bar; t is the first tick; v is speed in ticks/s with its own label; a gap inside a bar invalidates it; the tail is open', () => {
  const quotes = [
    q(M0, 100000), q(M0 + 1000, 100100), q(M0 + 2000, 100300), q(M0 + 4000, 99900), // bar A: 4 ticks over 4 s → 1 tick/s
    q(M0 + 4000, 99900, 99910, { changed: false }), // repeat: not counted
    q(M0 + 10_000, 100200), q(M0 + 10_000, 100250), q(M0 + 10_000, 100300), q(M0 + 10_000, 100350), // bar B: 4 ticks in 0 ms → speed null
    q(M0 + 20_000, 100400), q(M0 + 21_000, 100500),
    { gapMarker: true }, // bar C had 2 of 4 when the hole came: invalid, closed where it stood
    q(M0 + 30_000, 100600), q(M0 + 31_000, 100700), q(M0 + 32_000, 100800), q(M0 + 33_000, 100900), // bar D valid
    q(M0 + 40_000, 101000), // open
  ]
  const r = tickBars(quotes, { n: 4, nominalMs: 60_000 })
  assert.equal(r.vSemantics, V_SEMANTICS.TICK); assert.equal(r.form, 'tick_4_approx_60000ms')
  const [A, B, D] = r.bars
  assert.deepEqual([A.t, A.o, A.h, A.l, A.c, A.n, A.durMs, A.speed, A.v], [M0, 100, 100.3, 99.9, 99.9, 4, 4000, 1, 1])
  assert.deepEqual([B.n, B.durMs, B.speed, B.v], [4, 0, null, null])
  assert.deepEqual([D.t, D.n, D.speed], [M0 + 30_000, 4, 1.333])
  assert.deepEqual(r.invalid, [{ t: M0 + 20_000, reason: INVALID.GAP, n: 2 }])
  assert.deepEqual(r.segments.map(s => s.length), [2, 1])
  assert.equal(r.open.n, 1); assert.equal(r.dropped.repeat, 1); assert.equal(r.dropped.gap, 1)
  // A silence past the bound marks the bar that follows it.
  const s = tickBars([q(M0, 100000), q(M0 + 1000, 100100), q(M0 + 2_000_000, 100200), q(M0 + 2_001_000, 100300)], { n: 2, maxSilenceMs: 900_000 })
  assert.deepEqual(s.invalid.map(i => i.reason), [INVALID.SILENCE]); assert.equal(s.bars.length, 1)
  // A gap arriving right AFTER a complete bar (nothing in progress) still breaks the run: a zero-tick boundary marker.
  const between = tickBars([q(M0, 100000), q(M0 + 1000, 100100), { gapMarker: true }, q(M0 + 5000, 100200), q(M0 + 6000, 100300)], { n: 2 })
  assert.equal(between.bars.length, 2); assert.deepEqual(between.invalid, [{ t: M0 + 1000, reason: INVALID.GAP, n: 0 }]); assert.deepEqual(between.segments.map(s => s.length), [1, 1])
  assert.throws(() => tickBars([], { n: 0 }), RangeError); assert.throws(() => timeBars([], { barMs: 0 }), RangeError)
})

test('nominalTickCount: the median ticks per complete bucket; partial and gap buckets left out; null on a stream with no complete bucket', () => {
  const quotes = []
  // minute 0 partial (starts at +30s) with 9 ticks; minutes 1..4 with 3, 5, 7, 20 ticks; minute 5 open with 1.
  for (let i = 0; i < 9; i++) quotes.push(q(M0 + 30_000 + i * 1000, 100000 + i))
  const per = [3, 5, 7, 20]
  per.forEach((c, m) => { for (let i = 0; i < c; i++) quotes.push(q(M0 + (m + 1) * 60_000 + i * 100, 100100 + i)) })
  quotes.push(q(M0 + 5 * 60_000, 100500))
  const r = nominalTickCount(quotes, { nominalMs: 60_000 })
  assert.deepEqual(r, { n: 6, buckets: 4, medianTicks: 6, nominalMs: 60_000, minTicks: 3, maxTicks: 20 })
  assert.equal(nominalTickCount([q(M0 + 30_000, 100000)], { nominalMs: 60_000 }).n, null)
  // The chosen n then yields bars of about a minute on the same stream.
  const tb = tickBars(quotes, { n: r.n, nominalMs: 60_000 })
  assert.ok(tb.bars.length >= 4)
})

test('refusedByDesignFloor: a bar shorter than the strategy\'s floor is refused by design, said so; no floor means no verdict', () => {
  assert.deepEqual(refusedByDesignFloor(15_000, 3_600_000), { refused: true, reason: 'refused by design floor: 15000ms bar under the strategy\'s 3600000ms floor' })
  assert.deepEqual(refusedByDesignFloor(3_600_000, 3_600_000), { refused: false, reason: null })
  assert.equal(refusedByDesignFloor(15_000, null), null)
})
