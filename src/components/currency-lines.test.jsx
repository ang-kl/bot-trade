import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { LedgerRow, MobileWindowCard, TodayHourlyBody, HeadlineCurrencyLines } from '../pages/Performance.jsx'
import { reportLedger, emptyPopulation, poolByCurrency, reportCurrency } from '../../agent/shared/performance-populations.js'
import { currencyGroups } from '../../agent/shared/balance-carry.js'
import { activityCurrencyLines, currencyLines, currencyLinesText, rollingSplits } from '../lib/currency-money.js'
import { activityEvidence, hourRowEvidence } from '../lib/hourly-activity.js'

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
  it('an all-accounts window whose closes are one account\'s names its currency, like its neighbours (checker nit 1)', () => {
    // Production 25-09: 4H and 12H read a bare "−135.36" while Yesterday read "SGD −5.41 · USD −1.57".
    const w = reportLedger(report([g('46130058', -135.36)]), 'all').windows[0]
    expect(w.net).toBe(-135.36)
    const row = renderToStaticMarkup(<table><tbody><LedgerRow w={w} nowMs={0} timeZone="UTC" /></tbody></table>)
    const card = renderToStaticMarkup(<MobileWindowCard w={w} timeZone="UTC" />)
    for (const html of [row, card]) {
      expect(html).toContain('USD -135.36')
      expect(html).not.toContain('in no currency')
    }
    // One account's own view is unchanged: its single figure, no code.
    const one = reportLedger(report([g('46130058', -135.36)]), '46130058').windows[0]
    expect(renderToStaticMarkup(<table><tbody><LedgerRow w={one} nowMs={0} timeZone="UTC" /></tbody></table>)).not.toContain('USD')
  })
})

// WEB-5 fix round (checker blocker 1): the page's two rolling memos take their
// split from rollingSplits. That mapping is exercised with a real all-accounts
// response in agent/services/hourly-activity.test.js and in
// src/lib/currency-money.test.js. What neither can see is the page handing
// the result on: the memos read hourly-activity only through an effect, and
// this suite renders with no DOM, so there is no injection point. Reading the
// source is the last resort for that wiring alone (CLAUDE.md failure modes #2
// and #4), with comments stripped so an explanatory comment cannot satisfy it.
describe('the rolling 24-hour card is wired to the per-currency helper', () => {
  const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const page = stripComments(readFileSync(new URL('../pages/Performance.jsx', import.meta.url), 'utf8'))
  const block = start => {
    const i = page.indexOf(start)
    expect(i).toBeGreaterThan(-1)
    const j = page.indexOf('\n  const ', i + start.length)
    return page.slice(i, j < 0 ? undefined : j)
  }
  it('the headline memo and every hour row carry the helper\'s split, and both headlines render it first', () => {
    expect(block('const today = useMemo(')).toMatch(/\bsplit:\s*rollingSplits\(openings\)\.today\b/)
    const hourly = block('const todayHourly = useMemo(')
    const hours = hourly.match(/const (\w+) = rollingSplits\(openings,\s*slots\)\.hours\b/)
    expect(hours).not.toBeNull()
    expect(hourly).toMatch(/slots\.map\(\(s,\s*i\)\s*=>/)
    expect(hourly).toMatch(new RegExp(`\\bsplit:\\s*${hours[1]}\\[i\\]`))
    // V3 WEB-5m: the same row also takes WEB-3's observed balances from the
    // server (hourRowEvidence); the merge keeps both on every hour.
    expect(hourly).toMatch(/slots\.map\(\(s,\s*i\)\s*=>\s*\(\{\s*\.\.\.s,\s*\.\.\.hourRowEvidence\(openings,\s*s\),\s*split:/)
    expect(page.match(/today\.split \? <HeadlineCurrencyLines split=\{today\.split\} \/>/g)?.length).toBe(2)
  })
})

// V3 WEB-5m (the WEB-3 / WEB-5 / WEB-7 merge). The All view with two recorded
// currencies, built through the shared code the server runs (reportLedger with
// its carry, poolByCurrency, currencyGroups) and the browser's own evidence
// check: every place WEB-5 draws recorded money shows one figure per currency
// and no combined total, next to WEB-3's per-currency balances.
// USD: 11 +20 (FX) and 22 -5 (stock) = +15; SGD: 33 +7 (FX). A combined net
// would read 22.00, a combined FX cell 27.00, combined carries 1,550 / 1,572,
// a combined floating -3.50.
describe('the All view with two currencies: two per-currency figures and no combined total wherever WEB-5 draws money', () => {
  const HOUR = 3600_000, T = Date.UTC(2026, 8, 25, 14)
  const recorded = { 11: { currency: 'USD' }, 22: { currency: 'USD' }, 33: { currency: 'SGD' } }
  const currencyOf = id => reportCurrency({ currencyByAccount: recorded }, id)
  const obs = (value, currency) => ({ status: 'observed', value, currency, at: T - 60_000, source: 'broker_trader' })
  const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const combined = ['22.00', '27.00', '1,550', '1,572', '-3.50']
  const noCombined = html => { for (const x of combined) expect(html, `combined total ${x}`).not.toContain(x) }
  const signedText = v => `${v > 0 ? '+' : ''}${v.toFixed(2)}`

  const w = reportLedger({ status: 'complete', lastCloseByAccount: {}, markets: ['fx', 'stock'], currencyByAccount: recorded,
    balanceEdges: { status: 'complete', maxAgeMs: 900_000,
      accounts: ['11', '22', '33'].map(accountId => ({ accountId, historyStartsAt: T - 30 * HOUR })),
      windows: { '1h': { 11: { in: obs(1000, 'USD'), out: obs(1020, 'USD') }, 22: { in: obs(500, 'USD'), out: obs(495, 'USD') },
        33: { in: obs(50, 'SGD'), out: obs(57, 'SGD') } } } },
    windows: [{ key: '1h', label: '1H', from: T - HOUR, to: T, ledger: true, groups: [g('11', 20), g('22', -5, { market: 'stock' }), g('33', 7)] }] }, 'all').windows[0]

  it('timeframe ledger: the desktop row (net, market cells, expanded detail), the phone card and the copied text', () => {
    expect(w.net).toBeNull(); expect(w.carryIn).toBeNull(); expect(w.carryOut).toBeNull()
    const row = plain(renderToStaticMarkup(<table><tbody><LedgerRow w={w} forceOpen nowMs={T} timeZone="UTC" /></tbody></table>))
    const card = plain(renderToStaticMarkup(<MobileWindowCard w={w} timeZone="UTC" />))
    for (const html of [row, card]) {
      expect(html).toContain('SGD +7.00'); expect(html).toContain('USD +15.00')
      // WEB-3's carry beside it, per currency too.
      expect(html).toContain('SGD 50.00'); expect(html).toContain('USD 1,500.00')
      expect(html).toContain('SGD 57.00'); expect(html).toContain('USD 1,515.00')
      noCombined(html)
    }
    // The FX market cell and the expanded FX line: SGD and USD apart.
    expect(row).toContain('USD +20.00')
    expect(row).toContain('SGD +7.00 · USD +20.00')
    // The stock cell is one account's, named in its currency (checker nit 1).
    expect(row).toContain('USD -5.00')
    // The copied ledger line is this same text (ledgerToText calls it).
    expect(currencyLinesText(currencyLines(w), signedText)).toBe('SGD +7.00 · USD +15.00')
  })

  it('rolling 24 hours: the hour row, the headline and the copied text, from a validated all-accounts response', () => {
    const from = T - 24 * HOUR
    const amounts = [['11', 20], ['22', -5], ['33', 7]].map(([accountId, recordedNet]) => ({ accountId, currency: currencyOf(accountId), recordedNet, closedN: 1, pricedN: 1 }))
    const balance = {
      open: currencyGroups(['11', '22', '33'].map((id, i) => ({ accountId: id, currency: currencyOf(id), storedFrom: from, evidence: obs([1000, 500, 50][i], currencyOf(id)) }))),
      close: currencyGroups(['11', '22', '33'].map((id, i) => ({ accountId: id, currency: currencyOf(id), storedFrom: from, evidence: obs([1020, 495, 57][i], currencyOf(id)) }))),
      floating: currencyGroups(['11', '22', '33'].map((id, i) => ({ accountId: id, currency: currencyOf(id), storedFrom: from, evidence: obs([-3, -2, 1.5][i], currencyOf(id)) }))),
    }
    const rows = Array.from({ length: 24 }, (_, i) => {
      const mine = i === 23 ? amounts : []
      return { from: from + i * HOUR, to: from + (i + 1) * HOUR, openedN: 0, legacyN: 0, adoptedN: 0,
        closedN: mine.length, pricedN: mine.length, wins: mine.filter(a => a.recordedNet > 0).length, net: mine.length ? null : 0,
        moneyByAccount: mine, ...poolByCurrency(mine, currencyOf), balance: i === 23 ? balance : null }
    })
    const response = { source: 'local_trade_ledger', accountId: 'all', from, to: T, generatedAt: new Date(T).toISOString(), observedThrough: T,
      openedN: 0, legacyN: 0, adoptedN: 0, unknownTimeN: 0, unknownTimeLegacyN: 0, unknownTimeAdoptedN: 0,
      activityVersion: 1, rows, closedN: 3, pricedN: 3, wins: 2, unknownCloseTimeN: 0, moneyByAccount: amounts, net: null,
      ...poolByCurrency(amounts, currencyOf) }
    const openings = activityEvidence(response, { accountId: 'all', to: T, nowMs: T })
    expect(openings).not.toBeNull()
    // The page's own mapping: WEB-3's evidence and WEB-5's split on one row.
    const slot = { from: T - HOUR, to: T }
    const { today, hours } = rollingSplits(openings, [slot])
    const row = { ...slot, at: T, isLive: false, showDate: false, ...hourRowEvidence(openings, slot), split: hours[0] }
    const body = plain(renderToStaticMarkup(<TodayHourlyBody rows={[row]} />))
    expect(body).toContain('SGD +7.00'); expect(body).toContain('USD +15.00')
    expect(body).toContain('SGD 50.00'); expect(body).toContain('USD 1,500.00')
    expect(body).toContain('SGD 57.00'); expect(body).toContain('USD 1,515.00')
    expect(body).toContain('(SGD +1.50 · USD -5.00 float)')
    noCombined(body)
    const head = plain(renderToStaticMarkup(<span><HeadlineCurrencyLines split={today} /></span>))
    expect(head).toContain('SGD +7.00'); expect(head).toContain('USD +15.00')
    noCombined(head)
    expect(currencyLinesText(today, signedText)).toBe('SGD +7.00 · USD +15.00')
    expect(currencyLinesText(hours[0], signedText)).toBe('SGD +7.00 · USD +15.00')
  })
})
