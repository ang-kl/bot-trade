// V3 WEB-3 (8,989-A rows 5 and 7): the rolling 24-hour table shows observed
// open/close balance and floating per hour, the ledger shows carry in / carry
// out, and the all-accounts view shows money per currency. A missing balance
// is labelled, never drawn as zero.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { TodayHourlyBody, LedgerRow, MobileWindowCard, LedgerBody, MobileLedgerDealNote, ledgerToText } from '../pages/Performance.jsx'
import { hourRowEvidence } from '../lib/hourly-activity.js'
import { currencyGroups, ledgerCarry } from '../../agent/shared/balance-carry.js'
import { currentTotalsByCurrency, liveFloatingByCurrency } from '../lib/current-account-totals.js'

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
  it('all accounts, live hour: a currency without a complete reading is marked on screen, and no figure is made for it', () => {
    const live = { ...past, isLive: true, balance: { open: currencyGroups([seen('USD', 300)]), close: currencyGroups([seen('USD', 301)]), floating: currencyGroups([]) } }
    // 22 has no current reading; 11 alone must not stand in for the USD subtotal.
    const groups = liveFloatingByCurrency({ accounts: [{ accountId: '11', currency: 'USD', openPnl: -164.9 }, { accountId: '22', currency: 'USD', openPnl: null },
      { accountId: '33', currency: 'SGD', openPnl: 1.7 }] }, { currencyByAccount: { 11: { currency: 'USD' }, 22: { currency: 'USD' }, 33: { currency: 'SGD' } } }, 'all', null)
    const html = text(renderToStaticMarkup(<TodayHourlyBody rows={[live]} floatingNow={null} floatingNowGroups={groups} />))
    expect(html).toContain('(SGD +1.70 float) · USD 1/2 read')
    expect(html).not.toContain('164.90')
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

// V3 WEB-8-m. The ledger as rendered: a deal-proven carry's tooltip names the
// close it was reported after (checker nit 4), and a failed read of the
// stored deal balances is stated in words in the cell's tooltip and the
// ledger's footnote (checker nit 3) — words, not colour.
describe('timeframe ledger: deal-proven carries and a failed deal read', () => {
  const D = 24 * H
  const recorded = id => ({ 11: 'USD' })[id]
  const win = (edges, key) => ({ key, label: key.toUpperCase(), from: new Date(NOW - 30 * D).toISOString(), to: new Date(NOW).toISOString(),
    trades: 0, net: 0, markets: {}, lastTradeAt: null, ...ledgerCarry(edges, key, '11', recorded) })
  it('a deal-proven carry says it was reported after the deal, not read at the edge', () => {
    const edges = { status: 'complete', maxAgeMs: 900000, dealBalances: 'read', accounts: [{ accountId: '11', historyStartsAt: START - 40 * D }],
      windows: { '30d': { 11: { in: { status: 'observed', value: 900, currency: 'USD', at: START - 10 * D, source: 'broker_deal' }, out: seen('USD', 1029).evidence } } } }
    const html = renderToStaticMarkup(<table><tbody><LedgerRow w={win(edges, '30d')} nowMs={NOW} timeZone="UTC" /></tbody></table>)
    expect(text(html)).toContain('900.00')
    expect(html).toContain('title="USD broker balance · reported after the deal at 12-09 17:26 UTC, held until the next stored event · broker_deal"')
    expect(html).not.toContain('read 12-09 17:26 UTC')
  })
  it('a failed deal read is named in the carry cell\'s tooltip and the ledger footnote', () => {
    const edges = { status: 'complete', maxAgeMs: 900000, dealBalances: 'deal_balance_read_failed', accounts: [{ accountId: '11', historyStartsAt: START }],
      windows: { '30d': { 11: { in: { ...before('USD').evidence, dealBalance: { status: 'unavailable', reason: 'deal_balance_read_failed' } }, out: seen('USD', 1029).evidence } } } }
    const w = win(edges, '30d')
    const row = renderToStaticMarkup(<table><tbody><LedgerRow w={w} nowMs={NOW} timeZone="UTC" /></tbody></table>)
    expect(text(row)).toContain('not stored before 22-09 17:26 UTC')
    expect(row).toContain('Deal balances unread for account 11')
    // V3 WEB-8b: marked ON SCREEN in the carry cell and on the phone card,
    // not only in the tooltip (WEB-3m's N4 precedent). Words, not colour.
    expect(text(row)).toContain('not stored before 22-09 17:26 UTC (deals unread)')
    expect(text(renderToStaticMarkup(<MobileWindowCard w={w} timeZone="UTC" />))).toContain('not stored before 22-09 17:26 UTC (deals unread) → ')
    const body = text(renderToStaticMarkup(<LedgerBody variant="card" windows={[w]} ledger={{ windows: [w] }} nowMs={NOW} timeZone="UTC" />))
    expect(body).toContain('Deal balances unread: the broker balances stored on deals and cashflows could not be read for this report (account 11)')
    // Deals read: no such sentence.
    const ok = win({ ...edges, dealBalances: 'read', windows: { '30d': { 11: { in: before('USD').evidence, out: seen('USD', 1029).evidence } } } }, '30d')
    expect(text(renderToStaticMarkup(<LedgerBody variant="card" windows={[ok]} ledger={{ windows: [ok] }} nowMs={NOW} timeZone="UTC" />))).not.toContain('Deal balances unread')
    // …and no on-screen mark either: the gap is the reads' own, nothing more.
    expect(text(renderToStaticMarkup(<table><tbody><LedgerRow w={ok} nowMs={NOW} timeZone="UTC" /></tbody></table>))).not.toContain('deals unread')
    expect(text(renderToStaticMarkup(<MobileWindowCard w={ok} timeZone="UTC" />))).not.toContain('deals unread')
  })
})

// V3 WEB-8b (failure mode #4). WEB-8-m wired the failed-deal note into the
// phone ledger (which has no footnote and no hover) and into copy-as-text,
// but only LedgerBody's footnote was pinned. Both are rendered here: the note
// appears when a deal read failed and is absent when it did not.
describe('timeframe ledger: the phone note and copy-as-text state a failed deal read', () => {
  const D = 24 * H
  const recorded = id => ({ 11: 'USD' })[id]
  const unread = { status: 'unavailable', reason: 'deal_balance_read_failed' }
  const edgesFor = (dealBalances, inEvidence) => ({ status: 'complete', maxAgeMs: 900000, dealBalances, accounts: [{ accountId: '11', historyStartsAt: START }],
    windows: { '30d': { 11: { in: inEvidence, out: seen('USD', 1029).evidence } } } })
  const win = edges => ({ key: '30d', label: '30D', from: new Date(NOW - 30 * D).toISOString(), to: new Date(NOW).toISOString(),
    trades: 0, net: 0, markets: {}, lastTradeAt: null, ...ledgerCarry(edges, '30d', '11', recorded) })
  const failed = win(edgesFor('deal_balance_read_failed', { ...before('USD').evidence, dealBalance: unread }))
  const oneAccount = win(edgesFor('read', { ...before('USD').evidence, dealBalance: unread }))
  const read = win(edgesFor('read', before('USD').evidence))
  const NOTE = 'Deal balances unread: the broker balances stored on deals and cashflows could not be read'

  it('the phone note renders above the cards when the read failed, naming the account, and nothing when it did not', () => {
    const html = renderToStaticMarkup(<MobileLedgerDealNote windows={[failed]} />)
    expect(html).toMatch(/^<p[^>]*>/)
    expect(text(html)).toContain(`${NOTE} for this report (account 11), so no carry edge was checked against them`)
    expect(text(html)).toContain('it is not zero and nothing is estimated')
    // Only this account's read failed (the report's deals were read).
    expect(text(renderToStaticMarkup(<MobileLedgerDealNote windows={[oneAccount]} />)))
      .toContain(`${NOTE} for account 11, so that account’s carry edges were not checked against them`)
    // Deals read: no element at all, not an empty paragraph.
    expect(renderToStaticMarkup(<MobileLedgerDealNote windows={[read]} />)).toBe('')
    expect(renderToStaticMarkup(<MobileLedgerDealNote windows={[]} />)).toBe('')
  })
  it('copy-as-text carries the on-screen mark on the carry and the note as its last line; neither when the deals were read', () => {
    const out = ledgerToText([failed]).split('\n')
    expect(out[0]).toBe('Timeframe ledger')
    expect(out[1]).toMatch(/^30D · carry not stored before 22-09 17:26 UTC \(deals unread\) → 1,029\.00 · /)
    expect(out).toHaveLength(3)
    expect(out[2]).toContain(`${NOTE} for this report (account 11)`)
    const clean = ledgerToText([read])
    expect(clean.split('\n')).toHaveLength(2)
    expect(clean).toContain('30D · carry not stored before 22-09 17:26 UTC → 1,029.00 · ')
    expect(clean).not.toContain('Deal balances unread')
    expect(clean).not.toContain('deals unread')
  })
  // The page hands both the same windows the cards and the table render. No
  // DOM here and the report arrives through an effect, so there is no
  // injection point: reading the source is the last resort for that wiring
  // alone (failure modes #2 and #4), with comments stripped first.
  it('the page renders the phone note above the phone cards and copies the ledger through ledgerToText (wiring)', () => {
    const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const page = strip(readFileSync(new URL('../pages/Performance.jsx', import.meta.url), 'utf8'))
    expect(page).toMatch(/const windows = useMemo\(\(\) => reportLedger\(populationReport, acct\)\.windows, \[populationReport, acct\]\)/)
    // The phone ledger screen: from its guard to the next screen's guard.
    const start = page.indexOf("{screen === 'ledger' && (")
    expect(start).toBeGreaterThan(-1)
    const phone = page.slice(start, page.indexOf('screen ===', start + 10))
    expect(phone).toMatch(/<MobileLedgerDealNote windows=\{windows\} \/>\s*\{windows\.map\(w => <MobileWindowCard /)
    expect(page.match(/<MobileLedgerDealNote /g)).toHaveLength(1)
    expect(page).toMatch(/<SectionTools id="ledger" title="Timeframe Ledger table" data=\{windows\} toText=\{ledgerToText\}/)
  })
})
