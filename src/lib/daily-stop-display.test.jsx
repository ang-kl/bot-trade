// npx vitest run src/lib/daily-stop-display.test.jsx
//
// WEB-2 (8,989-A row 4): the cards print the daily stop the risk engine
// enforces and loss-cap used from the server's measured reading — never
// balance × dailyLossPct, never a dash that passes for "no stop".
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { dailyStopView, dailyStopWords, cardStopFields } from './daily-stop-display.js'
import { aggregateAccounts } from './perf-aggregate.js'
import PerfAccountScope from '../components/PerfAccountScope.jsx'
import { DataFeed } from '../components/PerfMacroSections.jsx'

const money = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const signed = (n) => (n >= 0 ? '+' : '') + money(n)
const palette = { P_GL: '#fff', P_GBD: '#ccc', P_MU: '#888', P_SB: '#666', P_UP: '#06c', P_DN: '#c00', P_ACC: '#c60', P_EDG: '#eee', P_WRN: '#e90' }

// Shapes of GET /state/account-overview accounts[].dailyStop.
const TIER = {
  status: 'in_force', capUsd: 1200.17, currency: 'USD', binding: 'pct',
  explain: '% cap USD 1200.17 — the $150.00 flat cap is out of force while the balance tier rule is on',
  balanceUsed: 30004.36, balanceKey: 'acct:46130058:account_balance_usd', estimatedStopoutUsd: null, unitsNote: null,
  lossCapUsed: { status: 'measured', pct: 10, consumed: 120.5, realisedLoss: 70, floatingLoss: 50.5, reason: null },
}
const SGD = {
  status: 'in_force', capUsd: 200, currency: 'USD', binding: 'floor', explain: 'the USD 200.00 floor binds',
  unitsNote: "The risk engine compares this USD-configured cap with this account's SGD P&L; units question H-P2-4 is open and nothing here converts it.",
  lossCapUsed: { status: 'not_comparable', pct: null, consumed: null, realisedLoss: 0, floatingLoss: 0, reason: 'units' },
}
const FLOAT_UNREAD = { ...TIER, lossCapUsed: { status: 'not_read', pct: 10, consumed: 120.5, realisedLoss: 70, floatingLoss: null, reason: 'the floating P&L is not a complete, fresh broker reading' } }

// Built the way Performance.jsx builds a card: cardStopFields over the
// account's own overview row, which also carries balance and dailyLossPct.
const card = (id, name, ds, extra = {}) => ({
  id, name, ccy: extra.ccy || 'USD', isLive: false, bal: 30004.36, day: 0, gw: 0, gl: 0, n30: null,
  equity: null, live: null, hasToday: false, moneyVerified: false, currentMoneyVerified: true,
  ...cardStopFields({ accountId: id, balance: 30004.36, dailyLossPct: 0.03, dailyStop: ds }, palette),
})

describe('dailyStopView', () => {
  it('takes the engine cap and the measured percentage as given', () => {
    const v = dailyStopView(TIER)
    expect(v).toMatchObject({ capState: 'in_force', cap: 1200.17, capCcy: 'USD', used: 10, usedState: 'measured', capLoss: 120.5 })
    expect(v.title).toMatch(/risk engine enforces: USD 1200\.17 per FX day/)
    expect(v.title).toMatch(/Realised loss today: 70\.00/)
    expect(v.title).toMatch(/Floating loss now: 50\.50/)
  })

  it('a missing or malformed reading is "not read" — never zero, never a borrowed number', () => {
    for (const bad of [undefined, null, {}, { status: 'weird', capUsd: 5 }, { status: 'in_force', capUsd: 'x' }]) {
      const v = dailyStopView(bad)
      expect(v.capState).toBe('not_read')
      expect(v.cap).toBe(null)
      expect(v.used).toBe(null)
      expect(v.usedState).toBe('not_read')
      expect(dailyStopWords(v, money)).toEqual({ stop: 'not read', used: 'not read', day: '' })
    }
  })

  it('a percentage the server did not mark measured is not shown, even if a number rides along', () => {
    const v = dailyStopView(FLOAT_UNREAD)
    expect(v.used).toBe(null)
    expect(v.capLoss).toBe(null)
    expect(v.usedState).toBe('not_read')
    expect(v.title).toMatch(/Loss-cap used not shown: the floating P&L/)
  })

  it('an uncapped account says the checks are off', () => {
    const v = dailyStopView({ status: 'uncapped', capUsd: null, currency: 'USD', lossCapUsed: { status: 'uncapped' } })
    expect(dailyStopWords(v, money)).toEqual({ stop: 'off (both checks off)', used: '—', day: '' })
  })
})

describe('cardStopFields — what a Performance card carries', () => {
  it('the cap is the engine reading, not balance × dailyLossPct from the same row', () => {
    const f = cardStopFields({ balance: 30004.36, dailyLossPct: 0.03, dailyStop: TIER }, palette)
    expect(f.cap).toBe(1200.17)
    expect(f.cap).not.toBeCloseTo(900.13, 1)
    expect(f).toMatchObject({ used: 10, capState: 'in_force', capCcy: 'USD', usedState: 'measured', capLoss: 120.5, usedCol: palette.P_ACC })
  })

  it('a row with a balance and a dailyLossPct but no engine reading is "not read" — no fallback to the old formula', () => {
    const f = cardStopFields({ balance: 30004.36, dailyLossPct: 0.03 }, palette)
    expect(f.cap).toBe(null)
    expect(f.capState).toBe('not_read')
    expect(f.used).toBe(null)
    expect(f.usedCol).toBe(palette.P_MU)
    expect(cardStopFields(undefined, palette).capState).toBe('not_read')
  })
})

describe('dailyStopWords', () => {
  it('prints the cap in its own currency with the FX-day anchor', () => {
    expect(dailyStopWords(dailyStopView(TIER), money)).toEqual({ stop: '−1,200 USD', used: '10%', day: ' (FX day)' })
  })

  it('a non-USD account keeps the USD cap and says the percentage is not comparable', () => {
    expect(dailyStopWords(dailyStopView(SGD), money)).toEqual({ stop: '−200 USD', used: 'not comparable', day: ' (FX day)' })
  })
})

describe('the cards render the engine reading', () => {
  const cards = [
    card('46130058', 'Demo · 5203012', TIER),
    card('42993489', 'Live · 1251247', SGD, { ccy: 'SGD' }),
    card('43069009', 'Live · 1251443', undefined),
  ]

  it('PerfAccountScope: −1,200 USD on the tier account, not the old −900; SGD flagged; unread says so', () => {
    const html = renderToStaticMarkup(<PerfAccountScope acctCards={cards} palette={palette} money={money} signed={signed} scope="all" onScopeChange={() => {}} />)
    expect(html).toMatch(/daily stop <span[^>]*>−1,200 USD<\/span> \(FX day\) · loss-cap used <span[^>]*>10%<\/span>/)
    expect(html).not.toMatch(/−900/)
    expect(html).toMatch(/−200 USD<\/span> \(FX day\) · loss-cap used <span[^>]*>not comparable<\/span>/)
    expect(html).toMatch(/daily stop <span[^>]*>not read<\/span> · loss-cap used <span[^>]*>not read<\/span>/)
    // The unit question is on the SGD card's tooltip, where the number is.
    expect(html).toMatch(/H-P2-4/)
  })

  it('PerfAccountScope detail panel names the cap and its currency', () => {
    const html = renderToStaticMarkup(<PerfAccountScope acctCards={cards} palette={palette} money={money} signed={signed} scope="46130058" onScopeChange={() => {}} />)
    expect(html).toMatch(/10% of −1,200 USD/)
  })

  it('DataFeed names the stop in force for the scoped account, and defers to the cards for the portfolio', () => {
    const one = renderToStaticMarkup(<DataFeed dailyStop={dailyStopView(TIER)} />)
    expect(one).toMatch(/daily stop −1,200 USD \(FX day\)/)
    expect(one).not.toMatch(/3%\/day/)
    expect(renderToStaticMarkup(<DataFeed />)).toMatch(/daily stop per account — see the account cards/)
    expect(renderToStaticMarkup(<DataFeed dailyStop={dailyStopView(undefined)} />)).toMatch(/daily stop not read/)
  })
})

describe('aggregateAccounts with engine readings', () => {
  it('Σ capLoss ÷ Σ cap when every card is measured, in the cap currency', () => {
    const a = card('1', 'A', TIER), b = card('2', 'B', { ...TIER, capUsd: 200, lossCapUsed: { status: 'measured', pct: 50, consumed: 100 } })
    const g = aggregateAccounts([{ ...a, moneyVerified: true, ccy: 'USD' }, { ...b, moneyVerified: true, ccy: 'USD' }]).groups[0]
    expect(g.cap).toBeCloseTo(1400.17, 6)
    expect(g.capCcy).toBe('USD')
    expect(g.capLoss).toBeCloseTo(220.5, 6)
    expect(g.usedPct).toBe(16) // 220.5 / 1,400.17 = 15.7%
    expect(g.usedState).toBe('measured')
  })

  it('one unread or non-comparable account withholds the group percentage and says why', () => {
    const measured = { ...card('1', 'A', TIER), moneyVerified: true, ccy: 'USD' }
    const unread = aggregateAccounts([measured, { ...card('2', 'B', FLOAT_UNREAD), moneyVerified: true, ccy: 'USD' }]).groups[0]
    expect(unread.usedPct).toBe(null)
    expect(unread.usedState).toBe('not_read')
    const sgd = aggregateAccounts([{ ...card('3', 'C', SGD), moneyVerified: true, ccy: 'SGD' }]).groups[0]
    expect(sgd.usedPct).toBe(null)
    expect(sgd.usedState).toBe('not_comparable')
  })

  it('stops in different currencies are not added', () => {
    const g = aggregateAccounts([
      { id: '1', ccy: 'X', cap: 100, capCcy: 'USD', capLoss: 10, moneyVerified: true },
      { id: '2', ccy: 'X', cap: 100, capCcy: 'SGD', capLoss: 10, moneyVerified: true },
    ]).groups[0]
    expect(g.cap).toBe(null)
    expect(g.usedPct).toBe(null)
  })
})
