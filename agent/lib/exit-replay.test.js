// node --test agent/lib/exit-replay.test.js
//
// Phase 7's measuring instrument. The tests that matter most here are the ones
// asserting it REFUSES to answer — an exit counterfactual that always produces
// a number is the easiest thing in this repo to build and the least worth
// having.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBars, replayExit, summariseReplay, DEFAULT_RULES } from './exit-replay.js'

const MIN = 60_000
const t0 = Date.parse('2026-08-03T20:00:00Z')
/** [t,o,h,l,c,v] — minute `m` after entry. */
const bar = (m, o, h, l, c) => [t0 + m * MIN, o, h, l, c, 0]
const LONG = { side: 'long', entry: 100, sl: 99, tp: 101.6, openedAtMs: t0 }   // risk 1.0, 1.6R target
const SHORT = { side: 'short', entry: 100, sl: 101, tp: 98.4, openedAtMs: t0 }

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('bars parse from a JSON string or an array, and malformed rows are counted', () => {
  const good = [bar(0, 100, 100.5, 99.8, 100.2)]
  assert.equal(parseBars(JSON.stringify(good)).bars.length, 1)
  assert.equal(parseBars(good).bars.length, 1)

  const mixed = parseBars([bar(0, 100, 100.5, 99.8, 100.2), [1, 2], null, [t0, 1, 'x', 1, 1, 0]])
  assert.equal(mixed.bars.length, 1)
  assert.equal(mixed.dropped, 3, 'dropped bars are counted, not silently swallowed')
})

test('a bar whose high is below its low is not a bar', () => {
  assert.equal(parseBars([[t0, 100, 98, 99, 99, 0]]).dropped, 1)
})

test('unparseable input yields no bars rather than throwing', () => {
  assert.deepEqual(parseBars('{not json'), { bars: [], dropped: 0 })
  assert.deepEqual(parseBars(null), { bars: [], dropped: 0 })
})

// ---------------------------------------------------------------------------
// THE REFUSALS
// ---------------------------------------------------------------------------

test('a bar touching BOTH stop and target is ambiguous — not resolved either way', () => {
  // The single most important test in this file. Every flattering backtest
  // resolves this case by assuming the favourable order.
  const bars = [bar(0, 100, 101.7, 98.9, 100)]   // spans the 1.6R target AND the stop
  const r = replayExit(bars, LONG, { name: 'as_traded' })
  assert.equal(r.ok, false)
  assert.equal(r.ambiguous, true)
  assert.match(r.reason, /intrabar order is not recorded/)
  assert.equal(r.rMultiple, undefined, 'no r-multiple may be reported for an unknowable outcome')
})

test('a rule still holding at the end of the window is truncated, never invented', () => {
  const bars = [bar(0, 100, 100.2, 99.9, 100.1), bar(1, 100.1, 100.3, 100, 100.2)]
  const r = replayExit(bars, LONG, { name: 'no_cap' })
  assert.equal(r.ok, false)
  assert.equal(r.truncated, true)
  assert.equal(r.exitPrice, undefined)
  assert.match(r.reason, /no exit is invented/)
})

test('a trade with no stop distance has no R and says so', () => {
  const r = replayExit([bar(0, 100, 101, 99, 100)], { side: 'long', entry: 100, sl: 100 }, {})
  assert.equal(r.ok, false)
  assert.match(r.reason, /stop distance is zero/)
})

test('missing levels or bars refuse rather than default', () => {
  assert.match(replayExit([bar(0, 1, 1, 1, 1)], { side: 'long', entry: null, sl: 99 }, {}).reason, /no entry or stop/)
  assert.match(replayExit([], LONG, {}).reason, /no bars stored/)
})

// ---------------------------------------------------------------------------
// Ordinary outcomes
// ---------------------------------------------------------------------------

test('a clean stop-out is -1R', () => {
  const r = replayExit([bar(0, 100, 100.2, 98.9, 99)], LONG, { name: 'as_traded' })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'stop')
  assert.equal(r.rMultiple, -1)
})

test('a clean target hit is the target R', () => {
  const r = replayExit([bar(0, 100, 100.4, 99.9, 100.3), bar(5, 100.3, 101.7, 100.2, 101.6)], LONG, { name: 'as_traded' })
  assert.equal(r.reason, 'target')
  assert.equal(r.rMultiple, 1.6)
  assert.equal(r.heldMin, 5)
})

test('short side is mirrored, not special-cased away', () => {
  assert.equal(replayExit([bar(0, 100, 101.2, 99.8, 101)], SHORT, {}).rMultiple, -1)
  assert.equal(replayExit([bar(0, 100, 100.1, 98.3, 98.4)], SHORT, {}).rMultiple, 1.6)
})

test('THE AUDIT FINDING: a 30-minute cap closes at the bar close, mid-move', () => {
  // 60% of real postmortems classify time_cap. This is that, replayed.
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(30, 100.2, 100.6, 100.1, 100.4)]
  const r = replayExit(bars, LONG, { name: 'cap_30m', timeCapMin: 30 })
  assert.equal(r.reason, 'time_cap')
  assert.equal(r.exitPrice, 100.4)
  assert.equal(r.rMultiple, 0.4, 'closed at +0.4R against a 1.6R target')
})

test('the same trade with NO cap reaches the target', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(30, 100.2, 100.6, 100.1, 100.4), bar(75, 100.4, 101.7, 100.3, 101.6)]
  const r = replayExit(bars, LONG, { name: 'no_cap' })
  assert.equal(r.reason, 'target')
  assert.equal(r.rMultiple, 1.6)
  assert.equal(r.heldMin, 75)
})

test('a target reached in the SAME bar the cap expires counts as the target', () => {
  // Stated as a deliberate convention in the code: the clock is checked last.
  const bars = [bar(0, 100, 100.2, 99.9, 100.1), bar(30, 100.1, 101.7, 100, 100.2)]
  const r = replayExit(bars, LONG, { name: 'cap_30m', timeCapMin: 30 })
  assert.equal(r.reason, 'target')
})

test('a lower target is reachable inside the same window', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(10, 100.2, 101.1, 100.1, 101)]
  assert.equal(replayExit(bars, LONG, { name: 'tp_1R', tpR: 1.0 }).reason, 'target')
  assert.equal(replayExit(bars, LONG, { name: 'tp_1R', tpR: 1.0 }).rMultiple, 1)
  assert.equal(replayExit(bars, LONG, { name: 'as_traded' }).truncated, true, 'while the 1.6R target is never reached')
})

test('bars before entry are context, not part of the trade', () => {
  const pre = [t0 - 10 * MIN, 100, 105, 95, 100, 0]   // would hit both levels
  const r = replayExit([pre, bar(0, 100, 100.2, 98.9, 99)], LONG, {})
  assert.equal(r.ok, true, 'the pre-entry bar must not create a false ambiguity')
  assert.equal(r.reason, 'stop')
  assert.equal(r.barsUsed, 1)
})

// ---------------------------------------------------------------------------
// Stop management
// ---------------------------------------------------------------------------

test('break-even at 1R turns a would-be loser into a scratch', () => {
  const bars = [
    bar(0, 100, 101.05, 99.9, 101),    // peaks past 1R, arms break-even
    bar(5, 101, 101.1, 98.8, 98.9),    // comes back through entry and the stop
  ]
  const plain = replayExit(bars, LONG, { name: 'as_traded' })
  assert.equal(plain.rMultiple, -1, 'without it, the original stop takes the full loss')

  const be = replayExit(bars, LONG, { name: 'be_at_1R', breakevenAtR: 1.0 })
  assert.equal(be.reason, 'stop_moved')
  assert.equal(be.rMultiple, 0)
})

test('break-even does NOT arm and fire inside one bar', () => {
  // Same intrabar-order problem as the ambiguous case; arming applies from the
  // next bar, so a single spike-and-reverse bar cannot manufacture a scratch.
  const bars = [bar(0, 100, 101.05, 98.9, 99)]
  assert.equal(replayExit(bars, LONG, { name: 'be_at_1R', breakevenAtR: 1.0 }).rMultiple, -1)
})

test('a 1R trail follows the peak and never loosens', () => {
  // No take profit on this one, or the 1.6R target fires before the trail can
  // be exercised — which is itself the correct precedence and is covered above.
  const runner = { side: 'long', entry: 100, sl: 99, tp: null, openedAtMs: t0 }
  const bars = [
    bar(0, 100, 102.5, 99.9, 102.4),   // peak 2.5R → stop trails to 1.5R
    bar(5, 102.4, 102.6, 101.4, 101.5),
  ]
  const r = replayExit(bars, runner, { name: 'trail_1R', trailR: 1.0 })
  assert.equal(r.reason, 'stop_moved')
  assert.equal(r.rMultiple, 1.5)
})

test('the trail ratchets — a lower later peak cannot loosen the stop', () => {
  const runner = { side: 'long', entry: 100, sl: 99, tp: null, openedAtMs: t0 }
  const bars = [
    bar(0, 100, 103, 99.9, 100.2),     // peak 3R → stop 2R
    bar(5, 100.2, 100.4, 100.1, 100.3), // a much lower peak
    bar(10, 100.3, 100.5, 101.9, 102),  // invalid (h<l) — dropped by parseBars
  ]
  const r = replayExit(bars.slice(0, 2), runner, { name: 'trail_1R', trailR: 1.0 })
  assert.equal(r.reason, 'stop_moved')
  assert.equal(r.rMultiple, 2, 'the stop stayed at the high-water 2R, it did not follow price down')
})

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('the summary excludes ambiguous and truncated trades AND counts them', () => {
  const s = summariseReplay([
    { ok: true, rMultiple: 1.6, heldMin: 40, reason: 'target' },
    { ok: true, rMultiple: -1, heldMin: 12, reason: 'stop' },
    { ok: true, rMultiple: 0.4, heldMin: 30, reason: 'time_cap' },
    { ok: false, ambiguous: true },
    { ok: false, truncated: true },
    { ok: false, reason: 'no bars stored' },
  ])
  assert.equal(s.n, 6)
  assert.equal(s.usable, 3, 'only the three resolved trades are scored')
  assert.equal(s.ambiguous, 1)
  assert.equal(s.truncated, 1)
  assert.equal(s.failed, 1)
  assert.equal(s.wins, 2)
  assert.equal(s.winRate, 66.7)
  assert.equal(s.profitFactor, 2)
  assert.equal(s.expectancyR, 0.333)
  assert.equal(s.totalR, 1)
  assert.equal(s.medianHoldMin, 30)
  assert.deepEqual(s.byReason, { target: 1, stop: 1, time_cap: 1 })
})

test('an all-ambiguous rule reports NOTHING, not a clean sweep', () => {
  const s = summariseReplay([{ ok: false, ambiguous: true }, { ok: false, ambiguous: true }])
  assert.equal(s.usable, 0)
  assert.equal(s.winRate, null, 'a rate over zero trades is unknown, not 0%')
  assert.equal(s.profitFactor, null)
  assert.equal(s.expectancyR, null)
  assert.equal(s.ambiguous, 2)
})

test('a rule that never lost reports no profit factor rather than infinity', () => {
  const s = summariseReplay([{ ok: true, rMultiple: 1.6, reason: 'target' }])
  assert.equal(s.profitFactor, null, 'infinity would sort above every real rule')
  assert.equal(s.winRate, 100)
})

test('an empty set is empty, not perfect', () => {
  const s = summariseReplay([])
  assert.equal(s.n, 0)
  assert.equal(s.winRate, null)
  assert.equal(s.totalR, 0)
})

test('the shipped rule set covers the audit question and names every rule', () => {
  const names = DEFAULT_RULES.map(r => r.name)
  assert.ok(names.includes('as_traded'))
  assert.ok(names.includes('cap_30m'), 'burn-in.js active regime')
  assert.ok(names.includes('no_cap'), 'the cap-vs-target question needs both ends')
  assert.ok(names.includes('tp_1R'), 'a target 30 minutes can actually reach')
  assert.equal(new Set(names).size, names.length, 'names must be unique — they key the report')
})
