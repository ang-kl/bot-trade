import { describe, it, expect } from 'vitest'
import { currentAccountTotals, currentTotalsByCurrency } from './current-account-totals.js'
describe('current totals preserve complete currency scope', () => {
  const a = { accountId: '11', currency: 'USD', balance: 100, equity: 105, openPnl: 5, freeMargin: 104 }
  const b = { ...a, accountId: '22', balance: 0, equity: 0, openPnl: 0, freeMargin: 0 }
  it('includes funded and zero accounts', () => expect(currentAccountTotals({ accounts: [a, b] })).toMatchObject({ balance: 100, equity: 105, openPnl: 5, accounts: 2 }))
  it('does not pass off partial or mixed money as a total', () => {
    expect(currentAccountTotals({ accounts: [a, { ...b, equity: null }] }).equity).toBeNull()
    expect(currentAccountTotals({ accounts: [a, { ...b, currency: 'SGD' }] }).balance).toBeNull()
    expect(currentAccountTotals(null).balance).toBeNull()
  })
  it('keeps an individual scope independent', () => expect(currentAccountTotals({ accounts: [a, b] }, '22').balance).toBe(0))
})
describe('current floating per currency for the all-accounts view (V3 WEB-3)', () => {
  const usd = { accountId: '11', currency: 'USD', balance: 100, equity: 95, openPnl: -5 }
  // The recorded deposit currency, as reportCurrency reads it from the
  // populations report (V3 WEB-3m: the one currency source).
  const recorded = id => ({ 11: 'USD', 22: 'USD', 33: 'SGD' })[id] ?? null
  it('subtotals each currency and never adds currencies together', () => {
    const r = currentTotalsByCurrency({ accounts: [usd, { ...usd, accountId: '22', openPnl: 2 }, { accountId: '33', currency: 'SGD', balance: 50, equity: 51.7, openPnl: 1.7 }] }, 'all', recorded)
    expect(r.groups.map(g => [g.currency, g.openPnl, g.accounts])).toEqual([['SGD', 1.7, 1], ['USD', -3, 2]])
  })
  it('a currency with an account missing its reading has no subtotal; an account with no recorded currency is counted apart', () => {
    const r = currentTotalsByCurrency({ accounts: [usd, { ...usd, accountId: '22', openPnl: null }, { accountId: '44', currency: 'USD', openPnl: 9 }] }, 'all', recorded)
    expect(r.groups).toEqual([expect.objectContaining({ currency: 'USD', openPnl: null, withOpenPnl: 1, accounts: 2, missingOpenPnl: ['22'] })])
    expect(r.unknownCurrencyAccounts).toBe(1)
    expect(r.unknownAccounts).toEqual(['44'])
  })
  it('the recorded currency decides the group; a reading in another currency is never added to it or to its own', () => {
    // 22 is recorded USD but its current reading says SGD: grouped by the
    // reading it would have made SGD 1.7 + 2 = 3.7 (a cross-currency sum).
    const r = currentTotalsByCurrency({ accounts: [usd, { ...usd, accountId: '22', currency: 'SGD', openPnl: 2 }, { accountId: '33', currency: 'SGD', openPnl: 1.7 }] }, 'all', recorded)
    expect(r.groups.map(g => [g.currency, g.openPnl, g.accounts])).toEqual([['SGD', 1.7, 1], ['USD', null, 2]])
    expect(r.groups[1].missingOpenPnl).toEqual(['22'])
  })
  it('without the recorded currencies nothing is subtotalled (no second reader)', () => {
    const r = currentTotalsByCurrency({ accounts: [usd] })
    expect(r.groups).toEqual([])
    expect(r.unknownAccounts).toEqual(['11'])
  })
})
