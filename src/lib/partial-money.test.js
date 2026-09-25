import { describe, it, expect } from 'vitest'
import { pricedNote, partialTitle, moneyGap, ledgerMoneyNote } from './partial-money.js'

describe('partial money labels', () => {
  it('names the priced count only when some closes have no P&L', () => {
    expect(pricedNote(2, 4)).toBe('2 of 4 priced')
    expect(pricedNote(4, 4)).toBeNull()
    expect(pricedNote(0, 0)).toBeNull()
    expect(pricedNote(null, 4)).toBeNull()
    expect(pricedNote(0, 3)).toBe('0 of 3 priced')
  })
  it('never claims a bound: an unpriced close may be a gain or a loss', () => {
    const title = partialTitle(449, 461)
    expect(title).toContain('449')
    expect(title).toContain('12 of 461')
    expect(title).toContain('not known in either direction')
    for (const s of [pricedNote(449, 461), title, ledgerMoneyNote({ net: -18392.97, trades: 461, pricedTrades: 449 }).text]) {
      expect(s).not.toMatch(/[≥≤]|at least|at most|floor/i)
    }
  })
  it('gives the true reason a figure is absent', () => {
    expect(moneyGap({ state: 'unavailable', n: null, pnl: null }).key).toBe('report')
    expect(moneyGap(null).key).toBe('report')
    expect(moneyGap({ state: 'observed', n: 461, pricedN: 449, pnl: null, moneyState: 'unverified_cross_account_units' }).key).toBe('not_pooled')
    expect(moneyGap({ state: 'observed', n: 2, pricedN: 0, pnl: null, moneyState: 'unavailable' })).toMatchObject({ key: 'no_pnl', long: 'none of its 2 closes has a recorded P&L' })
    expect(moneyGap({ state: 'observed', n: 2, pricedN: 2, pnl: 3 })).toBeNull()
    expect(moneyGap({ state: 'verified_zero', n: 0, pricedN: 0, pnl: 0 })).toBeNull()
    for (const s of ['report', 'not_pooled', 'no_pnl']) expect(JSON.stringify(moneyGap({ state: s === 'report' ? 'unavailable' : 'observed', n: 3, pricedN: 0, pnl: null, moneyState: s === 'not_pooled' ? 'unverified_cross_account_units' : 'unavailable' }))).not.toContain('no closed trades')
  })
  it('labels ledger rows: partial with its count, unpriced, not pooled, whole, empty', () => {
    expect(ledgerMoneyNote({ net: -5.32, trades: 4, pricedTrades: 2, moneyState: 'partial_recorded_account_units' }))
      .toMatchObject({ key: 'partial', text: 'partial · 2 of 4 priced' })
    expect(ledgerMoneyNote({ net: null, trades: 2, pricedTrades: 0, moneyState: 'unavailable' })).toMatchObject({ key: 'no_pnl', text: '0 of 2 priced' })
    expect(ledgerMoneyNote({ net: null, trades: 1315, pricedTrades: 1293, moneyState: 'unverified_cross_account_units' })).toMatchObject({ key: 'not_pooled', text: 'not pooled' })
    expect(ledgerMoneyNote({ net: 10, trades: 3, pricedTrades: 3, moneyState: 'recorded_account_units' })).toBeNull()
    expect(ledgerMoneyNote({ net: 0, trades: 0, pricedTrades: 0 })).toBeNull()
    expect(ledgerMoneyNote(null)).toBeNull()
  })
})
