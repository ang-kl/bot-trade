import { describe, it, expect } from 'vitest'
import { currencyLines, activityCurrencyLines, currencyLinesText, validActivitySplit, rollingSplits } from './currency-money.js'

// V3 WEB-5 (8,989-A rows 5 and 7): money per deposit currency, never summed.
const signed = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`)
const usd = { currency: 'USD', net: -4957.11, trades: 225, pricedTrades: 222, moneyState: 'partial_recorded_currency_units' }
const sgd = { currency: 'SGD', net: null, trades: 2, pricedTrades: 0, moneyState: 'unavailable' }

describe('per-currency money lines', () => {
  it('splits a window that has no single figure, one line per currency, with each line labelled', () => {
    const split = currencyLines({ trades: 229, net: null, byCurrency: [sgd, usd], unpooled: { trades: 2, pricedTrades: 2, accountIds: ['44', null] } })
    expect(split.lines.map(l => [l.currency, l.net])).toEqual([['SGD', null], ['USD', -4957.11]])
    expect(split.lines[0].note.text).toBe('0 of 2 priced')
    expect(split.lines[1].note.text).toBe('partial · 222 of 225 priced')
    expect(split.unpooled.text).toBe('2 closes in no currency')
    expect(split.unpooled.title).toBe('2 closes from account 44 (no recorded broker deposit currency) and rows with no account stamp: in no currency line, so their money is added to none.')
    const text = currencyLinesText(split, signed)
    expect(text).toBe('SGD — (0 of 2 priced) · USD -4957.11 (partial · 222 of 225 priced) · 2 closes in no currency')
    // Never one number across the two currencies.
    expect(text).not.toMatch(/-4957\.11.*total|4959/)
  })
  it('names the currency of a whole single figure only when every one of its closes is in that currency (checker nit 1)', () => {
    // Production 25-09, 4H in All accounts: one USD close, which read as a bare "−135.36".
    const one = { currency: 'USD', net: -135.36, trades: 1, pricedTrades: 1, moneyState: 'recorded_currency_units' }
    const split = currencyLines({ trades: 1, net: -135.36, byCurrency: [one], unpooled: { trades: 0, pricedTrades: 0, accountIds: [] } })
    expect(split.lines.map(l => [l.currency, l.net, l.note])).toEqual([['USD', -135.36, null]])
    expect(split.unpooled).toBeNull()
    expect(currencyLinesText(split, signed)).toBe('USD -135.36')
    // A partial single figure keeps its partial label on the currency line.
    expect(currencyLinesText(currencyLines({ trades: 225, net: -4957.11, byCurrency: [usd], unpooled: { trades: 0 } }), signed))
      .toBe('USD -4957.11 (partial · 222 of 225 priced)')
    // A figure that one currency line does not account for whole stays bare.
    expect(currencyLines({ trades: 3, net: 12, byCurrency: [usd] })).toBeNull()
    expect(currencyLines({ trades: 225, net: -4957.11, byCurrency: [usd], unpooled: { trades: 1 } })).toBeNull()
    expect(currencyLines({ trades: 227, net: 1, byCurrency: [sgd, usd] })).toBeNull()
    expect(currencyLines({ trades: 2, net: 1, byCurrency: [sgd] })).toBeNull()
  })
  it('does not split an empty window or a report without currencies', () => {
    expect(currencyLines({ trades: 0, net: 0, byCurrency: [] })).toBeNull()
    expect(currencyLines({ trades: 3, net: null, byCurrency: [] })).toBeNull()
    expect(currencyLines({ trades: 3, net: null })).toBeNull()
    expect(currencyLines(null)).toBeNull()
  })
  it('reads hourly-activity pools through the same rule', () => {
    const holder = { moneyByCurrency: [{ currency: 'SGD', recordedNet: -5.41, closedN: 1, pricedN: 1, moneyState: 'recorded_currency_units' },
      { currency: 'USD', recordedNet: -1.57, closedN: 1, pricedN: 1, moneyState: 'recorded_currency_units' }],
    unpooled: { closedN: 0, pricedN: 0, accountIds: [] } }
    const split = activityCurrencyLines(holder, { closedN: 2, net: null })
    expect(currencyLinesText(split, signed)).toBe('SGD -5.41 · USD -1.57')
    expect(split.unpooled).toBeNull()
    expect(activityCurrencyLines(holder, { closedN: 2, net: -6.98 })).toBeNull()
    expect(activityCurrencyLines({ moneyByAccount: [] }, { closedN: 2, net: null })).toBeNull()
    // One account's own scope keeps a whole figure bare; All accounts names its currency.
    const single = { moneyByCurrency: [{ currency: 'USD', recordedNet: 12, closedN: 2, pricedN: 2, moneyState: 'recorded_currency_units' }],
      unpooled: { closedN: 0, pricedN: 0, accountIds: [] } }
    expect(activityCurrencyLines(single, { closedN: 2, net: 12 })).toBeNull()
    expect(currencyLinesText(activityCurrencyLines(single, { closedN: 2, net: 12, allAccounts: true }), signed)).toBe('USD +12.00')
  })
  it('maps the rolling card from one activity response: the day, and each slot by its exact bounds', () => {
    const H = 3600_000
    const pools = (usd, sgd) => ({ moneyByCurrency: [
      { currency: 'SGD', recordedNet: sgd, closedN: 1, pricedN: 1, moneyState: 'recorded_currency_units' },
      { currency: 'USD', recordedNet: usd, closedN: 1, pricedN: 1, moneyState: 'recorded_currency_units' }],
    unpooled: { closedN: 0, pricedN: 0, accountIds: [] } })
    const openings = { accountId: 'all', closedN: 2, net: null, ...pools(-1.57, -5.41), rows: [
      { from: 0, to: H, closedN: 2, net: null, ...pools(-1.57, -5.41) },
      { from: H, to: 2 * H, closedN: 0, net: 0, moneyByCurrency: [], unpooled: { closedN: 0, pricedN: 0, accountIds: [] } }] }
    const { today, hours } = rollingSplits(openings, [{ from: H, to: 2 * H }, { from: 0, to: H }, { from: 0, to: 2 * H }])
    expect(currencyLinesText(today, signed)).toBe('SGD -5.41 · USD -1.57')
    // Aligned with the slots: an empty hour and a slot with no matching row have no lines.
    expect(hours.map(h => h && currencyLinesText(h, signed))).toEqual([null, 'SGD -5.41 · USD -1.57', null])
    expect(rollingSplits(openings)).toEqual({ today, hours: [] })
    expect(rollingSplits(undefined, [{ from: 0, to: H }])).toEqual({ today: null, hours: [null] })
  })
  it('accepts a split only when it is well formed and reconciles to the closes it splits', () => {
    const pools = [{ currency: 'USD', recordedNet: 15, closedN: 2, pricedN: 2 }]
    expect(validActivitySplit({}, 5)).toBe(true)
    expect(validActivitySplit({ moneyByCurrency: pools, unpooled: { closedN: 1, pricedN: 1, accountIds: [null] } }, 3)).toBe(true)
    expect(validActivitySplit({ moneyByCurrency: pools, unpooled: { closedN: 1, pricedN: 1, accountIds: [null] } }, 4)).toBe(false)
    expect(validActivitySplit({ moneyByCurrency: pools }, 2)).toBe(false)
    expect(validActivitySplit({ moneyByCurrency: [{ ...pools[0], currency: 'usd' }], unpooled: { closedN: 0, pricedN: 0 } }, 2)).toBe(false)
    expect(validActivitySplit({ moneyByCurrency: [{ ...pools[0], pricedN: 0 }], unpooled: { closedN: 0, pricedN: 0 } }, 2)).toBe(false)
    expect(validActivitySplit({ moneyByCurrency: [{ ...pools[0], recordedNet: Infinity }], unpooled: { closedN: 0, pricedN: 0 } }, 2)).toBe(false)
    expect(validActivitySplit({ moneyByCurrency: [pools[0], pools[0]], unpooled: { closedN: 0, pricedN: 0 } }, 4)).toBe(false)
  })
})
