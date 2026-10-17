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

test('THE AUDIT FINDING: a 30-minute cap closes at the price at its expiry, mid-move', () => {
  // 60% of real postmortems classify time_cap. This is that, replayed.
  // #84 (Claude · № 15,375 17-Oct): the cap ends at minute 30, the first
  // bar's close — the price then is 100.2. It used to close one bar late, at
  // the second bar's close (100.4, +0.4R).
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(30, 100.2, 100.6, 100.1, 100.4)]
  const r = replayExit(bars, LONG, { name: 'cap_30m', timeCapMin: 30 })
  assert.equal(r.reason, 'time_cap')
  assert.equal(r.exitPrice, 100.2)
  assert.equal(r.rMultiple, 0.2, 'closed at +0.2R against a 1.6R target')
})

test('the same trade with NO cap reaches the target', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(30, 100.2, 100.6, 100.1, 100.4), bar(75, 100.4, 101.7, 100.3, 101.6)]
  const r = replayExit(bars, LONG, { name: 'no_cap' })
  assert.equal(r.reason, 'target')
  assert.equal(r.rMultiple, 1.6)
  assert.equal(r.heldMin, 75)
})

test('a target reached in the bar AFTER the cap expired does not count: the cap closed first (#84)', () => {
  // Until #84 the clock was checked last against bar OPEN times, so this
  // target (minute 30 onward) counted although the cap ended at minute 30.
  const bars = [bar(0, 100, 100.2, 99.9, 100.1), bar(30, 100.1, 101.7, 100, 100.2)]
  const r = replayExit(bars, LONG, { name: 'cap_30m', timeCapMin: 30 })
  assert.equal(r.reason, 'time_cap')
  assert.equal(r.exitPrice, 100.1)
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

// ---------------------------------------------------------------------------
// #84 — the time cap at its real expiry (Claude · № 15,375 17-Oct; owner:
// "Build #84, merge when green", rule "Exact at boundary, approx inside";
// Codex round 2 on #1403). Self-derived fixtures: the price at an expiry that
// falls on a bar boundary is that bar's close (or the next open after a gap);
// inside a bar it is unknown, so that bar's close stands in unless the bar
// also touches a level the rule acts on.
// ---------------------------------------------------------------------------

test('#84: a cap ending exactly at a bar close exits at THAT close, not the next bar\'s open', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(30, 100.3, 100.6, 100.25, 100.4)]
  // Two bars prove no bar size (one spacing may be a gap): the caller says 30 min.
  const r = replayExit(bars, { ...LONG, barMs: 30 * MIN }, { timeCapMin: 30 })
  assert.equal(r.reason, 'time_cap'); assert.equal(r.exitPrice, 100.2)
  // Stamped at the expiry, not the bar's open (Codex round 1 on #1404).
  assert.equal(r.exitAtMs, t0 + 30 * MIN); assert.equal(r.heldMin, 30)
})

test('#84: a cap ending inside a bar that touches nothing exits at that bar\'s close, flagged', () => {
  // Hourly bars; the 90-minute cap ends inside the second bar. The third bar
  // reaches the target — after the cap, so it no longer counts.
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 100.2, 100.5, 100.1, 100.4), bar(120, 100.4, 101.8, 100.3, 101.7)]
  const r = replayExit(bars, LONG, { timeCapMin: 90 })
  assert.equal(r.reason, 'time_cap'); assert.equal(r.exitPrice, 100.4); assert.equal(r.capInsideBar, true)
  assert.equal(r.heldMin, 90, 'stamped at the expiry (Codex round 1 on #1404)')
  assert.equal(replayExit(bars, LONG, {}).reason, 'target', 'without the cap the target is reached')
})

test('#84: a cap ending inside a bar that touches the target, the stop or the partial level is ambiguous', () => {
  const tgt = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 100.2, 101.7, 100.1, 100.4), bar(120, 100.4, 100.5, 100.3, 100.4)]
  const r1 = replayExit(tgt, LONG, { timeCapMin: 90 })
  assert.equal(r1.ok, false); assert.equal(r1.ambiguous, true); assert.match(r1.reason, /stop or the target/)
  const stp = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 100.2, 100.5, 98.9, 100.4), bar(120, 100.4, 100.5, 100.3, 100.4)]
  assert.equal(replayExit(stp, LONG, { timeCapMin: 90 }).ambiguous, true)
  const part = [bar(0, 100, 100.2, 99.9, 100.1), bar(60, 100.1, 100.5, 100.05, 100.4), bar(120, 100.4, 100.5, 100.3, 100.4)]
  const r3 = replayExit(part, LONG, { timeCapMin: 90, partialAtR: 0.3 })
  assert.equal(r3.ambiguous, true); assert.match(r3.reason, /partial level/)
  assert.equal(replayExit(part, LONG, { timeCapMin: 90 }).reason, 'time_cap', 'the same bar without a partial rule is a plain cap')
})

test('#84: a cap that expired inside the skipped entry bar is ambiguous, not scored at a later bar', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 100.2, 100.5, 100.1, 100.4)]
  const r = replayExit(bars, { ...LONG, openedAtMs: t0 + 10 * MIN, barMs: 60 * MIN }, { timeCapMin: 30 })
  assert.equal(r.ok, false); assert.equal(r.ambiguous, true); assert.match(r.reason, /entry bar/)
})

test('#84: a cap that expired in a gap between bars exits at the next bar\'s open', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 100.2, 100.5, 100.1, 100.4), bar(120, 100.4, 100.5, 100.3, 100.45), bar(360, 100.6, 100.9, 100.5, 100.8)]
  const r = replayExit(bars, LONG, { timeCapMin: 200 })
  assert.equal(r.reason, 'time_cap'); assert.equal(r.exitPrice, 100.6); assert.equal(r.exitAtMs, t0 + 360 * MIN)
})

test('#84: the short side mirrors the boundary exit', () => {
  const bars = [bar(0, 100, 100.1, 99.7, 99.8), bar(30, 99.8, 99.9, 99.5, 99.6)]
  const r = replayExit(bars, SHORT, { timeCapMin: 30 })
  assert.equal(r.reason, 'time_cap'); assert.equal(r.exitPrice, 99.8); assert.equal(r.rMultiple, 0.2)
})

// Codex round 1 on #1404: a bar that OPENS through a level reached it before
// the expiry inside it — order, not ambiguity. Self-derived fixtures.
test('#84: the expiry bar opens through the stop → stop; through the target → target (not ambiguous)', () => {
  const stp = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 98.8, 99.0, 98.5, 98.9), bar(120, 98.9, 99, 98.8, 98.9)]
  const r1 = replayExit(stp, LONG, { timeCapMin: 90 })
  assert.equal(r1.reason, 'stop'); assert.equal(r1.rMultiple, -1)
  const tgt = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 101.7, 101.9, 101.5, 101.6), bar(120, 101.6, 101.7, 101.5, 101.6)]
  assert.equal(replayExit(tgt, LONG, { timeCapMin: 90 }).reason, 'target')
  const sShort = [bar(0, 100, 100.1, 99.7, 99.8), bar(60, 101.2, 101.4, 101, 101.3), bar(120, 101.3, 101.4, 101.2, 101.3)]
  assert.equal(replayExit(sShort, SHORT, { timeCapMin: 90 }).reason, 'stop', 'short mirror')
})

test('#84: the expiry bar opens past the partial level → partial banked, then the cap closes the rest at the expiry', () => {
  const bars = [bar(0, 100, 100.2, 99.9, 100.1), bar(60, 100.35, 100.5, 100.3, 100.4), bar(120, 100.4, 100.5, 100.3, 100.4)]
  const r = replayExit(bars, LONG, { timeCapMin: 90, partialAtR: 0.3 })
  assert.equal(r.reason, 'time_cap'); assert.equal(r.capInsideBar, true)
  assert.equal(r.partial.r, 0.3); assert.equal(r.runnerR, 0.4)
  assert.equal(r.rMultiple, 0.35, 'half at +0.3R, half at the close +0.4R')
})

// Codex round 2 on #1404: a lone spacing may be a gap, not a bar.
test('#84: two bars six hours apart prove no bar size — the cap is ambiguous unless the caller says the timeframe', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(360, 100.5, 100.6, 100.4, 100.5)]
  const r = replayExit(bars, LONG, { timeCapMin: 90 })
  assert.equal(r.ok, false); assert.equal(r.ambiguous, true); assert.match(r.reason, /bar size is unknown/)
  const h = replayExit(bars, { ...LONG, barMs: 60 * MIN }, { timeCapMin: 90 })
  assert.equal(h.reason, 'time_cap'); assert.equal(h.exitPrice, 100.5, 'hourly bars: the expiry fell in the gap → the 06:00 open')
})

test('#84: without a caller timeframe the bar size is the smallest spacing seen at least twice (a gap is ignored)', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 100.2, 100.5, 100.1, 100.4), bar(120, 100.4, 100.5, 100.3, 100.45), bar(420, 100.6, 100.9, 100.5, 100.8)]
  const r = replayExit(bars, LONG, { timeCapMin: 200 })
  assert.equal(r.reason, 'time_cap'); assert.equal(r.exitPrice, 100.6, 'hourly from the repeated spacing; the expiry fell in the gap')
})

// Codex round 3 on #1404: the skipped entry bar still bounds where the cap expired.
test('#84: a cap expiring in a gap after the entry bar closes exits at the next open; inside the entry bar it stays ambiguous', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(360, 100.5, 100.6, 100.4, 100.5)]
  const trade = { ...LONG, openedAtMs: t0 + 30 * MIN, barMs: 60 * MIN }
  const gap = replayExit(bars, trade, { timeCapMin: 90 })
  assert.equal(gap.reason, 'time_cap'); assert.equal(gap.exitPrice, 100.5, 'expiry 02:00 is after the 00:00 bar closed → the 06:00 open')
  const inside = replayExit(bars, trade, { timeCapMin: 20 })
  assert.equal(inside.ambiguous, true); assert.match(inside.reason, /entry bar/)
})

// Claude · № 15,451 17-Oct (#86, Codex round 4 on #1404; claude-builder): a
// bar that OPENS through one level reached it first, even when the same bar
// later touches the other level — order, not the dual-hit ambiguity.
// Self-derived fixtures (expected exits follow from the open's position).
test('#86: a bar opening through the stop that later reaches the target exits at the stop, not ambiguous', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 98.8, 101.7, 98.5, 101.6)]
  const r = replayExit(bars, LONG)
  assert.equal(r.ok, true); assert.equal(r.reason, 'stop'); assert.equal(r.rMultiple, -1)
  const s = [bar(0, 100, 100.1, 99.7, 99.8), bar(60, 101.2, 101.4, 98.3, 98.4)]
  const rs = replayExit(s, SHORT)
  assert.equal(rs.reason, 'stop', 'short mirror'); assert.equal(rs.rMultiple, -1)
})

test('#86: a bar opening through the target that later reaches the stop exits at the target', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 101.7, 101.9, 98.9, 99.0)]
  const r = replayExit(bars, LONG)
  assert.equal(r.ok, true); assert.equal(r.reason, 'target'); assert.equal(r.rMultiple, 1.6)
  const s = [bar(0, 100, 100.1, 99.7, 99.8), bar(60, 98.3, 101.1, 98.2, 100.9)]
  assert.equal(replayExit(s, SHORT).reason, 'target', 'short mirror')
})

test('#86: a moved stop opened through is stop_moved even when the bar reaches the target', () => {
  // Bar 1 peaks at +1.1R: break-even arms from bar 2. Bar 2 opens under 100.
  const bars = [bar(0, 100, 101.1, 99.9, 101.0), bar(60, 99.95, 101.7, 99.8, 101.6)]
  const r = replayExit(bars, LONG, { breakevenAtR: 1 })
  assert.equal(r.reason, 'stop_moved'); assert.equal(r.rMultiple, 0)
})

test('#86: both levels touched with the open between them stays ambiguous', () => {
  const bars = [bar(0, 100, 100.3, 99.9, 100.2), bar(60, 100.1, 101.7, 98.9, 100.5)]
  const r = replayExit(bars, LONG)
  assert.equal(r.ok, false); assert.equal(r.ambiguous, true); assert.match(r.reason, /both the stop and the target/)
})
