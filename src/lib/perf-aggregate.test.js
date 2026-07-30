// npx vitest run src/lib/perf-aggregate.test.js
//
// Owner (2026-07-30): "Do not calculate percentages by simply adding individual
// account percentages. Aggregate values using the correct underlying balances,
// limits, realised values and weighted calculations."
//
// The headline test is the loss-cap one: it uses the owner's OWN screenshot
// figures and shows that the naive mean is off by more than an order of
// magnitude. The second theme is currency — this cTrader ID holds SGD and USD
// accounts at once, and a single mixed total would be a fabricated number.
import { describe, it, expect } from 'vitest'
import { aggregateAccounts, scopeLabel, ALL_SCOPE } from './perf-aggregate.js'

// Straight from the owner's Performance screenshot, all one currency so the
// arithmetic is checkable by hand.
const CARDS = [
  { id: '42993489', name: 'Live · 1251247', ccy: 'USD', isLive: true, bal: 33.45, day: -0.44, gw: 0, gl: 0.44, n30: 915.6, cap: 1, used: 44, hasToday: true },
  { id: '43097342', name: 'Demo · 5067353', ccy: 'USD', isLive: false, bal: 1439.82, day: -19.90, gw: 0, gl: 19.90, n30: 896.1, cap: 43, used: 46, hasToday: true },
  { id: '46130058', name: 'Demo · 5203012', ccy: 'USD', isLive: false, bal: 51531.56, day: 190.21, gw: 518.43, gl: 328.22, n30: 1213.2, cap: 1546, used: 0, hasToday: true },
]

describe('loss-cap % is rebuilt from money, not averaged from percentages', () => {
  const agg = aggregateAccounts(CARDS)
  const g = agg.groups[0]

  it('sums the realised losses and the caps separately', () => {
    // losses today: 0.44 + 19.90 + 0 = 20.34 ; caps: 1 + 43 + 1546 = 1590
    expect(g.lossToday).toBeCloseTo(20.34, 6)
    expect(g.cap).toBe(1590)
    expect(g.usedPct).toBe(1) // 20.34 / 1590 = 1.28% → 1
  })

  it('and that is NOT what averaging the per-account percentages gives', () => {
    const naiveMean = Math.round((44 + 46 + 0) / 3)   // 30
    const naiveSum = 44 + 46 + 0                      // 90
    expect(g.usedPct).not.toBe(naiveMean)
    expect(g.usedPct).not.toBe(naiveSum)
    // Off by ~23x — a portfolio reported as a third of the way to its daily
    // stop when it has actually used barely one percent of it.
    expect(naiveMean / g.usedPct).toBeGreaterThan(20)
  })

  it('a day in profit uses none of the cap, it does not credit it back', () => {
    const profitable = aggregateAccounts([{ ...CARDS[2], day: 500, ccy: 'USD' }])
    expect(profitable.groups[0].lossToday).toBe(0)
    expect(profitable.groups[0].usedPct).toBe(0)
  })
})

describe('pace is derived from summed net, not averaged from per-account paces', () => {
  it('divides the summed 30d net by 30', () => {
    const g = aggregateAccounts(CARDS).groups[0]
    expect(g.n30).toBeCloseTo(915.6 + 896.1 + 1213.2, 6)
    expect(g.pace30d).toBeCloseTo((915.6 + 896.1 + 1213.2) / 30, 6)
  })

  it('reports null rather than 0 when no account has a 30d figure', () => {
    const g = aggregateAccounts(CARDS.map(c => ({ ...c, n30: null }))).groups[0]
    expect(g.n30).toBe(null)
    expect(g.pace30d).toBe(null)
  })
})

describe('mixed currencies are never summed into one number', () => {
  const MIXED = [
    { id: 'a', name: 'Live · 1251247', ccy: 'SGD', isLive: true, bal: 33.45, day: -0.44, cap: 1, hasToday: true },
    { id: 'b', name: 'Demo · 5203012', ccy: 'USD', isLive: false, bal: 51531.56, day: 190.21, cap: 1546, hasToday: true },
  ]
  const agg = aggregateAccounts(MIXED)

  it('groups per currency and flags the mix', () => {
    expect(agg.mixedCurrency).toBe(true)
    expect(agg.groups).toHaveLength(2)
    expect(agg.currencies.sort()).toEqual(['SGD', 'USD'])
  })

  it('no group contains another currency\'s money', () => {
    const sgd = agg.groups.find(g => g.ccy === 'SGD')
    const usd = agg.groups.find(g => g.ccy === 'USD')
    expect(sgd.bal).toBeCloseTo(33.45, 6)
    expect(usd.bal).toBeCloseTo(51531.56, 6)
    // 51,565.01 must appear nowhere.
    expect(agg.groups.some(g => Math.abs((g.bal ?? 0) - 51565.01) < 0.01)).toBe(false)
  })

  it('primary is the LARGEST group, and is not called a portfolio total', () => {
    expect(agg.primary.ccy).toBe('USD')
  })

  it('a single-currency portfolio is one group and reads like a normal total', () => {
    const one = aggregateAccounts(CARDS)
    expect(one.mixedCurrency).toBe(false)
    expect(one.groups).toHaveLength(1)
    expect(one.groups[0].bal).toBeCloseTo(33.45 + 1439.82 + 51531.56, 6)
  })
})

describe('counts and edge cases', () => {
  it('counts live, demo and OFF accounts', () => {
    const agg = aggregateAccounts([
      ...CARDS,
      { id: 'x', name: 'Demo · 5268549 · OFF', ccy: 'USD', isLive: false, bal: 540.5, dormantButHeld: true },
    ])
    expect(agg.accountCount).toBe(4)
    expect(agg.liveCount).toBe(1)
    expect(agg.demoCount).toBe(3)
    expect(agg.offCount).toBe(1)
  })

  it('an empty list is shaped, not a throw', () => {
    const agg = aggregateAccounts([])
    expect(agg.accountCount).toBe(0)
    expect(agg.groups).toEqual([])
    expect(agg.primary).toBe(null)
    expect(agg.mixedCurrency).toBe(false)
  })

  it('junk input does not throw', () => {
    for (const junk of [null, undefined, 'nope', 42]) {
      expect(() => aggregateAccounts(junk)).not.toThrow()
      expect(aggregateAccounts(junk).accountCount).toBe(0)
    }
  })

  it('a missing balance is absent, not zero — it must not drag a total down', () => {
    const g = aggregateAccounts([
      { id: 'a', ccy: 'USD', bal: 100 },
      { id: 'b', ccy: 'USD', bal: null },
    ]).groups[0]
    expect(g.bal).toBe(100)
    // And when NOTHING is known, null rather than a confident 0.
    expect(aggregateAccounts([{ id: 'c', ccy: 'USD', bal: null }]).groups[0].bal).toBe(null)
  })

  it('a zero cap cannot produce Infinity or NaN', () => {
    const g = aggregateAccounts([{ id: 'a', ccy: 'USD', bal: 10, day: -5, cap: 0 }]).groups[0]
    expect(g.usedPct).toBe(null)
  })

  it('usedPct is clamped at 100 — a blown cap reads 100%, not 400%', () => {
    const g = aggregateAccounts([{ id: 'a', ccy: 'USD', bal: 10, day: -40, cap: 10 }]).groups[0]
    expect(g.usedPct).toBe(100)
  })
})

describe('scopeLabel always states the scope without inference', () => {
  it('names the account count for ALL', () => {
    expect(scopeLabel(ALL_SCOPE, CARDS)).toBe('All accounts · consolidated across 3 accounts')
    expect(scopeLabel(ALL_SCOPE, [CARDS[0]])).toBe('All accounts · 1 account')
    expect(scopeLabel(ALL_SCOPE, [])).toBe('All accounts · consolidated across 0 accounts')
  })

  it('names the account for a single scope', () => {
    expect(scopeLabel('46130058', CARDS)).toBe('Demo · 5203012')
  })

  it('never renders a blank scope for an id it does not know', () => {
    expect(scopeLabel('99999999', CARDS)).toBe('Account 99999999')
  })
})
