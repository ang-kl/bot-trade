import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LedgerRow, MobileWindowCard, TodayHourlyBody, HeadlineCurrencyLines } from '../pages/Performance.jsx'
import { reportLedger, emptyPopulation } from '../../agent/shared/performance-populations.js'
import { activityCurrencyLines } from '../lib/currency-money.js'

// V3 WEB-5 (8,989-A rows 5 and 7): what the all-accounts views render. The
// 25-09 production shapes: Last month ...058 USD -18,392.97 (449 of 461
// priced) and ...909 USD -4,957.11 (222 of 225), ...489 SGD 2 closes, none
// priced. The owner's default: each currency its own line, never one sum.
const g = (accountId, net, { market = 'fx', n = 1, pricedN = 1 } = {}) => ({ accountId, sym: 'X', market, strat: 's',
  stats: { ...emptyPopulation(), n, pricedN, net, gw: Math.max(0, net), gl: Math.max(0, -net) } })
const report = groups => ({ status: 'complete', lastCloseByAccount: {}, markets: ['fx', 'stock'],
  currencyByAccount: { 46130058: { currency: 'USD' }, 47790949: { currency: 'USD' }, 42993489: { currency: 'SGD' }, 43069009: { currency: null } },
  windows: [{ key: 'lastmonth', label: 'Last month', from: Date.UTC(2026, 7, 1), to: Date.UTC(2026, 8, 1), ledger: true, groups }] })
const lastMonth = () => reportLedger(report([
  g('46130058', -18392.97, { n: 461, pricedN: 449 }), g('47790949', -4957.11, { n: 225, pricedN: 222 }),
  g('42993489', 0, { market: 'stock', n: 2, pricedN: 0 }), g('43069009', 3, { n: 1, pricedN: 1 }),
]), 'all').windows[0]

describe('per-currency money in the all-accounts views', () => {
  it('a ledger row shows one line per currency, labelled, and no cross-currency or cross-unit total', () => {
    const w = lastMonth()
    expect(w.net).toBeNull()
    const row = renderToStaticMarkup(<table><tbody><LedgerRow w={w} nowMs={0} timeZone="UTC" /></tbody></table>)
    const card = renderToStaticMarkup(<MobileWindowCard w={w} timeZone="UTC" />)
    for (const html of [row, card]) {
      expect(html).toContain('USD -23,350.08')
      expect(html).toContain('partial · 671 of 686 priced')
      expect(html).toContain('SGD —')
      expect(html).toContain('0 of 2 priced')
      expect(html).toContain('1 close in no currency')
      // The old blanket label is gone once a currency split exists.
      expect(html).not.toContain('not pooled')
      // USD + the account with no currency (3) is not a sum anyone may show.
      expect(html).not.toContain('23,347.08')
    }
    // A currency line is coloured by its own sign.
    expect(row).toContain('var(--color-down)')
  })
  it('the market cells split the same way', () => {
    const w = lastMonth()
    const row = renderToStaticMarkup(<table><tbody><LedgerRow w={w} nowMs={0} timeZone="UTC" /></tbody></table>)
    // Once in the Net cell and once in the FX market cell.
    expect(row.split('USD -23,350.08').length - 1).toBe(2)
    // The stock cell: SGD with no priced close, once in the Net cell and once here.
    expect(row.split('SGD —').length - 1).toBe(2)
    expect(w.markets.stock.byCurrency.map(c => c.currency)).toEqual(['SGD'])
  })
  it('one account keeps its single figure', () => {
    const one = reportLedger(report([g('46130058', -18392.97, { n: 461, pricedN: 449 })]), '46130058').windows[0]
    const html = renderToStaticMarkup(<table><tbody><LedgerRow w={one} nowMs={0} timeZone="UTC" /></tbody></table>)
    expect(html).toContain('-18,392.97')
    expect(html).not.toContain('USD')
  })
  it('the rolling 24-hour card shows each currency in the hour and the headline, never one sum', () => {
    const hour = { closedN: 2, net: null, moneyByCurrency: [
      { currency: 'SGD', recordedNet: -5.41, closedN: 1, pricedN: 1, moneyState: 'recorded_currency_units', accountIds: ['42993489'] },
      { currency: 'USD', recordedNet: -1.57, closedN: 1, pricedN: 1, moneyState: 'recorded_currency_units', accountIds: ['46979908'] }],
    unpooled: { closedN: 0, pricedN: 0, accountIds: [] } }
    const split = activityCurrencyLines(hour, { closedN: hour.closedN, net: hour.net })
    const at = Date.UTC(2026, 8, 25, 12)
    const rows = [{ from: at - 3600_000, to: at, at, isLive: false, showDate: false, net: null, closedN: 2, split,
      openBal: null, closeBal: null, openedN: 0, unknownOpeningTimeN: 0, unknownCloseTimeN: 0, incompleteOpeningWindow: false }]
    const body = renderToStaticMarkup(<TodayHourlyBody rows={rows} />)
    expect(body).toContain('SGD -5.41')
    expect(body).toContain('USD -1.57')
    expect(body).not.toContain('-6.98')
    const head = renderToStaticMarkup(<span><HeadlineCurrencyLines split={split} /></span>)
    expect(head).toContain('SGD -5.41')
    expect(head).toContain('USD -1.57')
    expect(head).not.toContain('-6.98')
    // Without a split the hour still reads a dash, never a zero.
    const bare = renderToStaticMarkup(<TodayHourlyBody rows={[{ ...rows[0], split: null }]} />)
    expect(bare).not.toContain('SGD')
    expect(bare).toContain('—')
  })
})
