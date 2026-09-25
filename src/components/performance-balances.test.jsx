// V3 WEB-3 (8,989-A rows 5 and 7): the rolling 24-hour table shows observed
// open/close balance and floating per hour, the ledger shows carry in / carry
// out, and the all-accounts view shows money per currency. A missing balance
// is labelled, never drawn as zero.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TodayHourlyBody, LedgerRow, MobileWindowCard } from '../pages/Performance.jsx'
import { hourRowEvidence } from '../lib/hourly-activity.js'
import { currencyGroups, ledgerCarry } from '../../agent/shared/balance-carry.js'
import { currentTotalsByCurrency } from '../lib/current-account-totals.js'

const START = Date.UTC(2026, 8, 22, 17, 26), NOW = Date.UTC(2026, 8, 25, 14, 0), H = 3600_000
const seen = (currency, value, at = NOW - H) => ({ accountId: currency === 'SGD' ? '33' : '11', currency, storedFrom: START,
  evidence: { status: 'observed', value, currency, at, source: 'broker_trader' } })
const before = currency => ({ accountId: '11', currency, storedFrom: START, evidence: { status: 'not_stored', reason: 'before_balance_history' } })
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('rolling 24 hours: balance and floating per hour', () => {
  const past = { from: NOW - 2 * H, to: NOW - H, at: NOW - H, isLive: false, net: 0, closedN: 0, openedN: 0,
    balance: { open: currencyGroups([seen('USD', 1028.5)]), close: currencyGroups([seen('USD', 1029.25)]),
      floating: currencyGroups([seen('USD', -2.25)]) } }
  it('an earlier hour shows its observed open and close balance and its last floating reading', () => {
    const html = text(renderToStaticMarkup(<TodayHourlyBody rows={[past]} />))
    expect(html).toContain('1,028.50')
    expect(html).toContain('1,029.25')
    expect(html).toContain('(-2.25 float)')
  })
  it('an edge before storage began is labelled with the date, never 0.00', () => {
    // Realised P&L 1.50 and close 5.00: the only place a 0.00 could come from
    // is the missing open balance.
    const row = { ...past, net: 1.5, closedN: 1, balance: { open: currencyGroups([before('USD')]), close: currencyGroups([seen('USD', 5)]), floating: currencyGroups([]) } }
    const html = text(renderToStaticMarkup(<TodayHourlyBody rows={[row]} />))
    expect(html).toContain('not stored before 22-09 17:26 UTC')
    expect(html).toContain('+1.50'); expect(html).toContain('5.00')
    expect(html).not.toContain('0.00')
  })
  it('all accounts: balances per currency and the live floating subtotal per currency', () => {
    const live = { ...past, isLive: true, balance: { open: currencyGroups([seen('USD', 300), seen('SGD', 50)]),
      close: currencyGroups([seen('USD', 301), seen('SGD', 51)]), floating: currencyGroups([]) } }
    const groups = currentTotalsByCurrency({ accounts: [{ accountId: '11', currency: 'USD', openPnl: -164.9 }, { accountId: '33', currency: 'SGD', openPnl: 1.7 }] },
      'all', id => ({ 11: 'USD', 33: 'SGD' })[id])
    const html = text(renderToStaticMarkup(<TodayHourlyBody rows={[live]} floatingNow={null} floatingNowGroups={groups} />))
    expect(html).toContain('SGD 50.00'); expect(html).toContain('USD 300.00')
    expect(html).toContain('(SGD +1.70 · USD -164.90 float)')
    expect(html).not.toContain('350.00')
  })
  it('the page takes the server\'s balance evidence onto each hour (wiring)', () => {
    const openings = { observedThrough: NOW, unknownTimeN: 0, unknownCloseTimeN: 0,
      rows: [{ from: past.from, to: past.to, net: 0, closedN: 0, openedN: 0, openBal: 1028.5, closeBal: 1029.25, balance: past.balance }] }
    const row = hourRowEvidence(openings, { from: past.from, to: past.to })
    expect(row.openBal).toBe(1028.5); expect(row.closeBal).toBe(1029.25)
    expect(row.balance).toBe(past.balance)
    expect(hourRowEvidence(null, { from: past.from, to: past.to })).toMatchObject({ openBal: null, closeBal: null, balance: null, net: null })
    // The fields the page mapped inline before WEB-3 keep their values.
    const live = hourRowEvidence({ ...openings, observedThrough: past.to - 1, unknownTimeN: 2, unknownCloseTimeN: 1,
      rows: [{ ...openings.rows[0], net: 4.5, closedN: 3, openedN: 5 }] }, { from: past.from, to: past.to })
    expect(live).toMatchObject({ net: 4.5, closedN: 3, openedN: 5, unknownOpeningTimeN: 2, unknownCloseTimeN: 1, incompleteOpeningWindow: true })
    expect(row.incompleteOpeningWindow).toBe(false)
  })
})

describe('timeframe ledger: carry in / carry out', () => {
  const edges = { status: 'complete', maxAgeMs: 900000,
    // No currency here: the server ships none on the edges (V3 WEB-3m); the
    // carry takes it from the report's currencyByAccount (reportCurrency).
    accounts: [{ accountId: '11', historyStartsAt: START }, { accountId: '33', historyStartsAt: START }],
    windows: { '12h': { 11: { in: seen('USD', 1018).evidence, out: seen('USD', 1029).evidence }, 33: { in: seen('SGD', 50).evidence, out: seen('SGD', 51).evidence } },
      '30d': { 11: { in: before('USD').evidence, out: seen('USD', 1029).evidence }, 33: { in: before('SGD').evidence, out: seen('SGD', 51).evidence } } } }
  const recorded = id => ({ 11: 'USD', 33: 'SGD' })[id]
  const win = (key, accountId) => ({ key, label: key.toUpperCase(), from: new Date(NOW - 12 * H).toISOString(), to: new Date(NOW).toISOString(),
    trades: 0, net: 0, markets: {}, lastTradeAt: null, ...ledgerCarry(edges, key, accountId, recorded) })
  it('one account: observed carries, and "not stored before" where the window starts before storage', () => {
    const html = text(renderToStaticMarkup(<table><tbody><LedgerRow w={win('12h', '11')} nowMs={NOW} timeZone="UTC" /><LedgerRow w={win('30d', '11')} nowMs={NOW} timeZone="UTC" /></tbody></table>))
    expect(html).toContain('1,018.00'); expect(html).toContain('1,029.00')
    expect(html).toContain('not stored before 22-09 17:26 UTC')
  })
  it('all accounts: carry per currency on the phone card, never one mixed total', () => {
    const html = text(renderToStaticMarkup(<MobileWindowCard w={win('12h', 'all')} timeZone="UTC" />))
    expect(html).toContain('SGD 50.00 · USD 1,018.00')
    expect(html).not.toContain('1,068')
  })
  // The WEB-3 / WEB-7 merge: one row carries the observed carry AND the
  // partial-money marking on its net, on desktop and phone.
  it('a partial net keeps WEB-7\'s "n of m priced" beside the observed carry', () => {
    const w = { ...win('12h', '11'), trades: 4, pricedTrades: 2, net: -5.32, winPct: 50, pf: 0.5, tp: 1, part: 0, sl: 1, manual: 0, edge: null,
      moneyState: 'partial_recorded_account_units' }
    for (const html of [text(renderToStaticMarkup(<table><tbody><LedgerRow w={w} nowMs={NOW} timeZone="UTC" /></tbody></table>)),
      text(renderToStaticMarkup(<MobileWindowCard w={w} timeZone="UTC" />))]) {
      expect(html).toContain('partial · 2 of 4 priced')
      expect(html).toContain('1,018.00'); expect(html).toContain('1,029.00')
    }
  })
})
