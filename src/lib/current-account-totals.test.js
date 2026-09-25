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
  it('subtotals each currency and never adds currencies together', () => {
    const r = currentTotalsByCurrency({ accounts: [usd, { ...usd, accountId: '22', openPnl: 2 }, { accountId: '33', currency: 'SGD', balance: 50, equity: 51.7, openPnl: 1.7 }] })
    expect(r.groups.map(g => [g.currency, g.openPnl, g.accounts])).toEqual([['SGD', 1.7, 1], ['USD', -3, 2]])
  })
  it('a currency with an account missing its reading has no subtotal; an account with no currency is counted apart', () => {
    const r = currentTotalsByCurrency({ accounts: [usd, { ...usd, accountId: '22', openPnl: null }, { accountId: '44', currency: null, openPnl: 9 }] })
    expect(r.groups).toEqual([expect.objectContaining({ currency: 'USD', openPnl: null, withOpenPnl: 1, accounts: 2 })])
    expect(r.unknownCurrencyAccounts).toBe(1)
  })
})
