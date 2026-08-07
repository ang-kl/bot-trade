// concentrate-plan.test.js
//
// The claims under test are the ones that would be expensive to get wrong on a
// live account: that the open-position blocker is reported BEFORE the watchlist
// change, that the campaign anchors to the equity passed in rather than any
// figure written into the repo, and that an unreadable input leaves the
// campaign unarmed rather than half-armed.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONCENTRATE_SYMBOLS, CONCENTRATE_STRATEGIES, DROP_REASONS,
  watchlistPlan, campaignFor, entryBlocker, concentratePlan,
} from './concentrate-plan.js'
import { campaignConfig } from './campaign-stop.js'
import { STRATEGY_KEYS } from './strategies.js'

// The watchlist as the owner sent it on 07-08, verbatim.
const OWNER_LIST = [
  'US2000', 'LHX.US', 'FRA40', 'WHEAT', 'CORN', 'COTTON', 'SUGAR', 'COFFEE',
  'COCOA', 'COPPER', 'NATGAS', 'XPDUSD', 'XPTUSD', 'XAUUSD', 'GER40', 'JPN225',
  'NAS100', 'US30', 'NZDCAD', 'AUDCAD', 'GBPAUD', 'EURCAD', 'EURAUD', 'EURJPY',
]

test('the target list is twenty distinct symbols', () => {
  assert.equal(CONCENTRATE_SYMBOLS.length, 20)
  assert.equal(new Set(CONCENTRATE_SYMBOLS.map(s => s.symbol)).size, 20)
  // Every entry carries the property it was bought for. A symbol with no `why`
  // is a symbol nobody can later argue with.
  for (const s of CONCENTRATE_SYMBOLS) assert.ok(s.why && s.group, `${s.symbol} needs group + why`)
})

test('every proposed strategy is a real registry key', () => {
  // A typo here would intersect to nothing and silently stop the account
  // trading — the same failure /actions/symbols already validates against.
  for (const k of CONCENTRATE_STRATEGIES) {
    assert.ok(STRATEGY_KEYS.includes(k), `${k} is not in the strategy registry`)
  }
  assert.equal(CONCENTRATE_STRATEGIES.length, 3)
})

test("the owner's list diffs to six keeps and eighteen removals", () => {
  const p = watchlistPlan(OWNER_LIST)
  assert.deepEqual(p.keep.sort(), ['EURJPY', 'GER40', 'JPN225', 'NAS100', 'US30', 'XAUUSD'])
  assert.equal(p.remove.length, 18)
  assert.equal(p.add.length, 14)
  // Every removal names a reason. "Removed 18 symbols" is not reviewable.
  for (const r of p.remove) assert.ok(r.why.length > 10, `${r.symbol} removed with no reason`)
})

test('all seven FX majors are additions — the gap that motivated the review', () => {
  const added = new Set(watchlistPlan(OWNER_LIST).add.map(s => s.symbol))
  for (const m of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD']) {
    assert.ok(added.has(m), `${m} should be added — no major was on the list`)
  }
})

test('both stored watchlist shapes are understood', () => {
  // Bare strings and {symbol,enabled} objects are BOTH live in the database.
  // A plan that only read one would report every held symbol as an addition
  // and then "replace" the list with a copy of itself minus everything.
  const asObjects = OWNER_LIST.map(symbol => ({ symbol, enabled: true, maxVolume: 0.1 }))
  assert.deepEqual(watchlistPlan(asObjects).keep.sort(), watchlistPlan(OWNER_LIST).keep.sort())
  // Case and whitespace come from hand-rolled calls; they must not fork a symbol.
  assert.deepEqual(watchlistPlan([' xauusd ']).keep, ['XAUUSD'])
})

test('an empty or malformed current list is an all-add, not a crash', () => {
  for (const bad of [null, undefined, 'nonsense', [], [null, {}, { symbol: '' }]]) {
    const p = watchlistPlan(bad)
    assert.equal(p.add.length, 20)
    assert.equal(p.remove.length, 0)
  }
})

test('a symbol with no written reason is still removed, and says so plainly', () => {
  const p = watchlistPlan(['ZZZZZ'])
  assert.equal(p.remove[0].symbol, 'ZZZZZ')
  assert.equal(p.remove[0].why, 'not in the concentrate-to-prove twenty')
  // The written reasons cover exactly the owner's list, nothing invented.
  for (const s of Object.keys(DROP_REASONS)) assert.ok(OWNER_LIST.includes(s), `${s} is not on the owner's list`)
})

test('the campaign anchors to the equity PASSED IN, never to a figure in the repo', () => {
  // The proposal and campaign-stop.test.js both say 46,073. The account reads
  // 45,418.81. This is the assertion that keeps the stale number out.
  const c = campaignFor(45_418.81, { startAt: '2026-08-07T00:00:00Z' })
  assert.equal(c.startEquity, 45_418.81)
  assert.equal(c.maxDrawdownPct, 0.08)
  assert.equal(c.label, 'concentrate-to-prove')
  // And it must survive the arming rules it will actually be read through.
  assert.equal(campaignConfig(c).armed, true)
})

test('an unreadable input leaves the campaign null rather than half-built', () => {
  const at = '2026-08-07T00:00:00Z'
  assert.equal(campaignFor(null, { startAt: at }), null)
  assert.equal(campaignFor(0, { startAt: at }), null)
  assert.equal(campaignFor('forty-five thousand', { startAt: at }), null)
  assert.equal(campaignFor(45_418.81, { startAt: null }), null, 'no start time is no anchor')
  assert.equal(campaignFor(45_418.81, { startAt: at, pct: 0 }), null)
  assert.equal(campaignFor(45_418.81, { startAt: at, pct: 1 }), null)
})

test('the blocker fires AT the cap, matching the risk gate >=', () => {
  assert.equal(entryBlocker({ openPositions: 4, maxOpenPositions: 5 }).blocked, false)
  const at = entryBlocker({ openPositions: 5, maxOpenPositions: 5 })
  assert.equal(at.blocked, true)
  assert.equal(at.mustClose, 1, 'at the cap, one must go to make room for one')
})

test("the live case — 7 open against a cap of 5 — asks for three closes", () => {
  const b = entryBlocker({ openPositions: 7, maxOpenPositions: 5 })
  assert.equal(b.blocked, true)
  assert.equal(b.mustClose, 3)
  assert.match(b.reason, /max_positions=7\/5/)
  assert.match(b.reason, /Nothing else in this plan takes effect until that is done\./)
})

test('an unknown position count is not read as "not blocked"', () => {
  const b = entryBlocker({ openPositions: null, maxOpenPositions: 5 })
  assert.equal(b.blocked, null, 'null, not false — silence is not a clear cap')
  assert.match(b.reason, /unreadable/)
})

test('the whole plan, on the live numbers', () => {
  const p = concentratePlan({
    current: OWNER_LIST,
    equity: 45_418.81,
    openPositions: 7,
    maxOpenPositions: 5,
    startAt: '2026-08-07T00:00:00Z',
  })
  assert.equal(p.campaign.startEquity, 45_418.81)
  assert.equal(p.budgetUsd, 3_633.5, '8% of the real balance')
  assert.equal(p.blocker.mustClose, 3)
  assert.equal(p.watchlist.remove.length, 18)
  assert.deepEqual(p.strategies, [...CONCENTRATE_STRATEGIES])
  // The blocker must reach the warnings — a plan that reported a clean
  // watchlist swap while every entry was vetoed would be actively misleading.
  assert.ok(p.warnings.some(w => /max_positions=7\/5/.test(w)))
})

test('an unarmable campaign is named in the warnings, not silently skipped', () => {
  const p = concentratePlan({
    current: OWNER_LIST, equity: null, openPositions: 2,
    maxOpenPositions: 5, startAt: '2026-08-07T00:00:00Z',
  })
  assert.equal(p.campaign, null)
  assert.equal(p.budgetUsd, null)
  assert.ok(p.warnings.some(w => /campaign NOT armed/.test(w)))
})

test('applying the plan twice is a no-op, and says so', () => {
  const p = concentratePlan({
    current: CONCENTRATE_SYMBOLS.map(s => s.symbol),
    equity: 45_418.81, openPositions: 1, maxOpenPositions: 5,
    startAt: '2026-08-07T00:00:00Z',
  })
  assert.equal(p.watchlist.add.length, 0)
  assert.equal(p.watchlist.remove.length, 0)
  assert.ok(p.warnings.some(w => /already matches the target/.test(w)))
})
