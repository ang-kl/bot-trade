import { describe, it, expect } from 'vitest'
import { currentAccountTotals, currentTotalsByCurrency, liveFloatingByCurrency } from './current-account-totals.js'
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
// V3 WEB-3m fix round (checker B2): what the page calls for the live floating
// subtotal. The currency is read from the populations report inside the
// helper, so a call site that grouped by the overview row's own currency
// cannot come back without this going red.
describe('live floating subtotal on All: the populations report decides the currency', () => {
  // 22's current broker reading says USD, but its RECORDED deposit currency is
  // SGD. Grouped by the overview rows it would be USD -5 + 2 = -3 and SGD 1.7.
  const overview = { accounts: [
    { accountId: '11', currency: 'USD', openPnl: -5 },
    { accountId: '22', currency: 'USD', openPnl: 2 },
    { accountId: '33', currency: 'SGD', openPnl: 1.7 },
  ] }
  const report = { currencyByAccount: { 11: { currency: 'USD' }, 22: { currency: 'SGD' }, 33: { currency: 'SGD' } } }
  it('groups by currencyByAccount, never by the reading; the disagreeing account holds its recorded currency open', () => {
    const r = liveFloatingByCurrency(overview, report, 'all', null)
    expect(r.groups.map(g => [g.currency, g.openPnl, g.accounts])).toEqual([['SGD', null, 2], ['USD', -5, 1]])
    expect(r.groups[0].missingOpenPnl).toEqual(['22'])
    expect(r.unknownCurrencyAccounts).toBe(0)
  })
  it('an account the report records no currency for is in no subtotal, whatever its reading says', () => {
    const r = liveFloatingByCurrency(overview, { currencyByAccount: { 11: { currency: 'USD' }, 33: { currency: 'SGD' } } }, 'all', null)
    expect(r.groups.map(g => [g.currency, g.openPnl])).toEqual([['SGD', 1.7], ['USD', -5]])
    expect(r.unknownAccounts).toEqual(['22'])
    // No report yet: nothing is subtotalled (never a guess from the readings).
    expect(liveFloatingByCurrency(overview, null, 'all', null).groups).toEqual([])
  })
  it('only on All and only where no single figure exists', () => {
    expect(liveFloatingByCurrency(overview, report, '11', null)).toBeNull()
    expect(liveFloatingByCurrency(overview, report, 'all', 4.2)).toBeNull()
  })
})
