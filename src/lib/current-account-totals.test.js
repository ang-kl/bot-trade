import { describe, it, expect } from 'vitest'
import { currentAccountTotals } from './current-account-totals.js'
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
