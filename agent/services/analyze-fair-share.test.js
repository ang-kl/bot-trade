// node --test agent/services/analyze-fair-share.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fairShareSlots, markAnalyzed, starvedStrategies, fairShareLine, LAST_ANALYZED_KEY,
} from './analyze-fair-share.js'

const NOW = Date.parse('2026-08-05T06:00:00.000Z')
const ago = (min) => new Date(NOW - min * 60_000).toISOString()

// The production batch, reduced: conviction saturated at 9-10, the loud three
// crowding out vp_value even though vp_value scores highest.
const BATCH = [
  { symbol: 'GER40', strategy: 'vwap_trend', confidence: 10 },
  { symbol: 'NAS100', strategy: 'vwap_trend', confidence: 10 },
  { symbol: 'USDHKD', strategy: 'vwap_trend', confidence: 10 },
  { symbol: 'DOW.US', strategy: 'fib_confluence', confidence: 10 },
  { symbol: 'JPYX', strategy: 'fib_confluence', confidence: 10 },
  { symbol: 'AUDUSD', strategy: 'fib_confluence', confidence: 10 },
  { symbol: 'TSLA.US', strategy: 'rsi2_reversion', confidence: 9 },
  { symbol: 'NATGAS', strategy: 'vp_value', confidence: 10 },
]
const HOT = BATCH.map(s => s.symbol)

test('THE BUG, reproduced: pure best-first starves the strategy that scores highest', () => {
  // Old behaviour = rank by conviction, tie-break alphabetically. vp_value's
  // NATGAS is a 10 — tied with five others — and loses on name order.
  const oldOrder = [...HOT].sort((a, b) => {
    const c = (s) => BATCH.find(x => x.symbol === s).confidence
    return c(b) !== c(a) ? c(b) - c(a) : a.localeCompare(b)
  }).slice(0, 3)
  assert.ok(!oldOrder.includes('NATGAS'), 'precondition: the old rule drops vp_value')
  const strategiesReached = new Set(oldOrder.map(s => BATCH.find(x => x.symbol === s).strategy))
  assert.ok(strategiesReached.size < 4, 'and it reaches fewer strategies than there are slots')
})

test('fair share gives a never-analysed strategy a turn on the first cycle', () => {
  const { picked, byStrategy } = fairShareSlots(BATCH, HOT, {
    slots: 3,
    lastAnalyzed: { vwap_trend: ago(1), fib_confluence: ago(2), rsi2_reversion: ago(3) },
    now: NOW,
  })
  assert.ok(picked.includes('NATGAS'), 'vp_value has never run — it must sort to the front')
  assert.equal(byStrategy[0].strategy, 'vp_value')
  assert.equal(byStrategy[0].waitedMs, null, 'never is not "waited 0ms"')
})

test('one slot per strategy — three slots never go to the same strategy twice', () => {
  const { picked } = fairShareSlots(BATCH, HOT, { slots: 3, now: NOW })
  const strats = picked.map(s => BATCH.find(x => x.symbol === s).strategy)
  assert.equal(new Set(strats).size, 3, 'three slots, three different strategies')
})

test('hungriest first: the longest-waiting strategy leads', () => {
  const { byStrategy } = fairShareSlots(BATCH, HOT, {
    slots: 4,
    lastAnalyzed: {
      vwap_trend: ago(1), fib_confluence: ago(90), rsi2_reversion: ago(5), vp_value: ago(30),
    },
    now: NOW,
  })
  assert.deepEqual(byStrategy.map(b => b.strategy),
    ['fib_confluence', 'vp_value', 'rsi2_reversion', 'vwap_trend'])
  assert.equal(byStrategy[0].waitedMs, 90 * 60_000)
})

test('a cold start is still BEST-first, not alphabetical', () => {
  // Nothing analysed yet: every strategy ties at "never", so conviction breaks
  // it. rsi2_reversion is the only 9 and must come last of the four.
  const { byStrategy } = fairShareSlots(BATCH, HOT, { slots: 4, lastAnalyzed: {}, now: NOW })
  assert.equal(byStrategy[3].strategy, 'rsi2_reversion')
  assert.ok(byStrategy.slice(0, 3).every(b => b.conviction === 10))
})

test('the loud strategies still get most of the slots over time', () => {
  // vwap_trend and fib_confluence appear in every batch; vp_value in one in
  // four. Fair share must not invert that — it only guarantees a turn.
  let last = {}
  const tally = {}
  for (let cycle = 0; cycle < 20; cycle++) {
    const batch = cycle % 4 === 0 ? BATCH : BATCH.filter(s => s.strategy !== 'vp_value')
    const { picked, byStrategy } = fairShareSlots(batch, batch.map(s => s.symbol), {
      slots: 2, lastAnalyzed: last, now: NOW + cycle * 60_000,
    })
    for (const s of picked) {
      const k = batch.find(x => x.symbol === s).strategy
      tally[k] = (tally[k] || 0) + 1
    }
    last = markAnalyzed(last, byStrategy.map(b => b.strategy), new Date(NOW + cycle * 60_000).toISOString())
  }
  assert.ok(tally.vp_value >= 3, `vp_value must get turns, got ${tally.vp_value}`)
  assert.ok(tally.vwap_trend > tally.vp_value, 'but the strategy present every cycle still leads')
})

test('spare slots fall back to best-first, so nothing is wasted', () => {
  // Two strategies present, four slots: each gets one, then the best of the
  // rest fills the remainder.
  const small = BATCH.filter(s => s.strategy === 'vwap_trend' || s.strategy === 'rsi2_reversion')
  const { picked } = fairShareSlots(small, small.map(s => s.symbol), { slots: 4, now: NOW })
  assert.equal(picked.length, 4)
  assert.equal(new Set(picked).size, 4, 'no symbol picked twice')
})

test('never picks more than the cap, and survives an empty batch', () => {
  assert.deepEqual(fairShareSlots(BATCH, HOT, { slots: 0 }).picked, [])
  assert.deepEqual(fairShareSlots([], [], { slots: 3 }).picked, [])
  assert.deepEqual(fairShareSlots(BATCH, [], { slots: 3 }).picked, [])
  assert.equal(fairShareSlots(BATCH, HOT, { slots: 2, now: NOW }).picked.length, 2)
})

test('a hot symbol with no scan row is ignored rather than crashing the cycle', () => {
  const { picked } = fairShareSlots(BATCH, [...HOT, 'GHOST'], { slots: 9, now: NOW })
  assert.ok(!picked.includes('GHOST'))
})

test('an unlabelled scan competes as its own bucket, it does not join another strategy', () => {
  const batch = [...BATCH, { symbol: 'MYSTERY', confidence: 10 }]
  const { byStrategy } = fairShareSlots(batch, batch.map(s => s.symbol), { slots: 9, now: NOW })
  assert.ok(byStrategy.some(b => b.strategy === '(unlabelled)'))
})

test('a malformed last-analysed timestamp reads as NEVER, not as the epoch', () => {
  // Date.parse('nonsense') is NaN. Treated as 0 it would sort first, which is
  // the safe direction — a bad clock grants a turn rather than withholding one.
  const { byStrategy } = fairShareSlots(BATCH, HOT, {
    slots: 1, lastAnalyzed: { vp_value: 'nonsense', vwap_trend: ago(1), fib_confluence: ago(1), rsi2_reversion: ago(1) }, now: NOW,
  })
  assert.equal(byStrategy[0].strategy, 'vp_value')
  assert.equal(byStrategy[0].waitedMs, null)
})

test('markAnalyzed stamps only what ran, and does not mutate its input', () => {
  const before = { vwap_trend: ago(10) }
  const after = markAnalyzed(before, ['vp_value'], ago(0))
  assert.equal(before.vp_value, undefined, 'input untouched')
  assert.equal(after.vp_value, ago(0))
  assert.equal(after.vwap_trend, ago(10), 'other strategies keep their clock')
})

test('starvedStrategies names the NEVER case first — the alarm that would not otherwise fire', () => {
  const s = starvedStrategies(
    { vwap_trend: ago(5), fib_confluence: ago(600) },
    ['vwap_trend', 'fib_confluence', 'vp_value', 'cup_handle'],
    { staleMin: 240, now: NOW },
  )
  assert.deepEqual(s.map(x => x.strategy), ['cup_handle', 'vp_value', 'fib_confluence'])
  assert.equal(s[0].never, true)
  assert.equal(s[0].waitedMin, null)
  assert.equal(s[2].waitedMin, 600)
})

test('fairShareLine reads as one sentence and survives an empty result', () => {
  const res = fairShareSlots(BATCH, HOT, { slots: 2, lastAnalyzed: { vwap_trend: ago(45) }, now: NOW })
  assert.match(fairShareLine(res), /first turn|waited \d+m/)
  assert.equal(fairShareLine(null), null)
  assert.equal(fairShareLine({ byStrategy: [] }), null)
})

test('the state key is stable — a rename would silently reset every clock', () => {
  assert.equal(LAST_ANALYZED_KEY, 'strategy_last_analyzed_json')
})
