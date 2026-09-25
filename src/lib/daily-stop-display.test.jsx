// npx vitest run src/lib/daily-stop-display.test.jsx
//
// WEB-2 (8,989-A row 4): the cards print the daily stop the risk engine
// enforces and loss-cap used from the server's measured reading — never
// balance × dailyLossPct, never a dash that passes for "no stop".
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { dailyStopView, dailyStopWords, cardStopFields, feedDailyStopView, dailyStopDetail } from './daily-stop-display.js'
import { dataFeedCardScope } from './data-feed.js'
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

describe('dailyStopView — the rest of the same reading (WEB-9m)', () => {
  const READING = {
    ...TIER, remainingUsd: 1079.67, unitsComparable: true,
    engineBlock: { guard: 'campaign_stop', reason: 'campaign stop: equity below the campaign floor' },
  }
  it('carries why it binds, what is left, the block and the units flag — as given, nothing computed', () => {
    expect(dailyStopView(READING)).toMatchObject({
      binding: 'pct', explain: TIER.explain, remaining: 1079.67, unitsComparable: true,
      block: { guard: 'campaign_stop', reason: 'campaign stop: equity below the campaign floor' },
    })
  })
  it('the fields WEB-2 shipped are unchanged by the additions', () => {
    for (const ds of [TIER, SGD, FLOAT_UNREAD, READING, undefined, { status: 'uncapped', capUsd: null }]) {
      const v = dailyStopView(ds)
      const was = dailyStopView(ds && { ...ds, remainingUsd: undefined, engineBlock: undefined, unitsComparable: undefined, binding: undefined, explain: ds.explain })
      for (const k of ['capState', 'cap', 'capCcy', 'used', 'usedState', 'capLoss', 'unitsNote']) expect(v[k]).toEqual(was[k])
    }
  })
  it('a reading not in force carries no binding, remainder or explanation; an unread one no block', () => {
    const uncapped = dailyStopView({ status: 'uncapped', capUsd: null, explain: 'both daily checks are off — the day is uncapped', remainingUsd: null, engineBlock: { guard: 'unknown_daily_pnl', reason: 'x' } })
    expect(uncapped).toMatchObject({ binding: null, explain: null, remaining: null, block: { guard: 'unknown_daily_pnl', reason: 'x' } })
    const bad = dailyStopView({ status: 'weird', capUsd: 5, remainingUsd: 5, explain: 'x', engineBlock: { guard: 'daily_loss_limit_hit' } })
    expect(bad).toMatchObject({ capState: 'not_read', binding: null, explain: null, remaining: null, block: null })
  })
})

describe('feedDailyStopView', () => {
  const overview = { accounts: [{ accountId: '46130058', dailyStop: TIER }, { accountId: '42993489', dailyStop: SGD }] }
  it('is the scoped account\'s own row through dailyStopView — the view cardStopFields builds', () => {
    expect(feedDailyStopView(overview, '42993489')).toEqual(dailyStopView(SGD))
    expect(feedDailyStopView(overview, '46130058').cap).toBe(1200.17)
    // cardStopFields over the same row carries the same stop fields.
    const f = cardStopFields(overview.accounts[1], palette), v = feedDailyStopView(overview, '42993489')
    expect([f.cap, f.capCcy, f.capState, f.used, f.usedState, f.stopTitle]).toEqual([v.cap, v.capCcy, v.capState, v.used, v.usedState, v.title])
  })
  it('the portfolio has no single stop; an absent account or overview is "not read", never another account\'s', () => {
    expect(feedDailyStopView(overview, 'all')).toBeNull()
    expect(feedDailyStopView(overview, '99999999').capState).toBe('not_read')
    expect(feedDailyStopView(null, '46130058').capState).toBe('not_read')
    // accounts.account_id is TEXT; a numeric id still finds its own row.
    expect(feedDailyStopView({ accounts: [{ accountId: 46130058, dailyStop: TIER }] }, '46130058').cap).toBe(1200.17)
  })
})

describe('dailyStopDetail — the Data-feed line after the stop', () => {
  const USD = { ...TIER, remainingUsd: 1079.67, unitsComparable: true, engineBlock: null }
  it('the engine\'s reason and what is left today, in the cap\'s currency', () => {
    expect(dailyStopDetail(dailyStopView(USD), money)).toEqual({
      text: ` · ${TIER.explain} · 1,080 USD left today`, note: null,
    })
  })
  it('a non-USD account: no mixed-unit remainder, and the reading\'s own units note', () => {
    const d = dailyStopDetail(dailyStopView({ ...SGD, remainingUsd: 173.4, unitsComparable: false }), money)
    expect(d.text).toBe(' · the USD 200.00 floor binds · left today not comparable')
    expect(d.text).not.toContain('173')
    expect(d.note).toBe(SGD.unitsNote)
    // Currency not read (unitsComparable null) → not read, not a figure.
    expect(dailyStopDetail(dailyStopView({ ...USD, unitsComparable: null }), money).text).toContain('left today not read')
  })
  it('names the guard that blocks, so a campaign stop or unresolved P&L does not read as the daily stop', () => {
    const at = (guard) => dailyStopDetail(dailyStopView({ ...USD, engineBlock: { guard, reason: 'r' } }), money).text
    expect(at('daily_loss_limit_hit')).toContain('entries blocked now: the daily stop is hit')
    expect(at('campaign_stop')).toContain('entries blocked now by the campaign stop (not the daily stop)')
    expect(at('campaign_stop')).not.toContain('daily stop is hit')
    expect(at('unknown_daily_pnl')).toContain("entries blocked now: today's P&L is unresolved (not the daily stop)")
    expect(at('some_new_guard')).toContain('entries blocked now by some_new_guard')
    expect(at(null)).toContain('entries blocked now (guard not reported)')
    expect(dailyStopDetail(dailyStopView(USD), money).text).not.toContain('blocked')
  })
  it('nothing after an unread or uncapped stop but the engine\'s block; nothing at all without a view', () => {
    expect(dailyStopDetail(dailyStopView(undefined), money)).toEqual({ text: '', note: null })
    expect(dailyStopDetail(null, money)).toEqual({ text: '', note: null })
    expect(dailyStopDetail(dailyStopView({ status: 'uncapped', capUsd: null, engineBlock: { guard: 'campaign_stop' } }), money).text)
      .toBe(' · entries blocked now by the campaign stop (not the daily stop)')
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
    expect(renderToStaticMarkup(<DataFeed allAccounts />)).toMatch(/daily stop per account — see the account cards/)
    expect(renderToStaticMarkup(<DataFeed dailyStop={dailyStopView(undefined)} />)).toMatch(/daily stop not read/)
    // A single-account card with no reading at all is "not read" too — the
    // portfolio phrase is said only when the scope IS the portfolio (WEB-9m).
    expect(renderToStaticMarkup(<DataFeed />)).toMatch(/daily stop not read/)
    expect(renderToStaticMarkup(<DataFeed />)).not.toMatch(/per account/)
  })

  // WEB-9m (the WEB-2 / WEB-9 merge): the Data-feed card and the account
  // cards print ONE daily stop from ONE reading, so they cannot disagree.
  it('the Data-feed daily stop and the account card\'s come from the same reading — change it and both follow', () => {
    // The card's phrase sits in one span; the account card splits it over
    // two spans and ends it at "· loss-cap used".
    const pick = (text, re) => {
      const m = text.match(re)
      expect(m, `a daily-stop phrase matching ${re}`).not.toBeNull()
      return m[1]
    }
    const feedStop = (html) => pick(html, />daily stop ([^<]*)<\/span>/)
    const cardStop = (html) => pick(html.replace(/<[^>]+>/g, ''), /daily stop (.+?) · loss-cap used/)
    // risk-full carries daily-loss figures of its own; the page hands the
    // card its scoped props from them. None may become the card's stop.
    const riskFull = {
      risk: { scopedTo: '42993489', effective: { equityStopPct: 0.1 } },
      account: { accountId: '42993489', depositCurrency: 'SGD' },
      dailyPacing: { accountId: '42993489', capUsd: 150, binding: 'usd' },
      dailyCapEnforced: { status: 'computed', accountId: '42993489', capUsd: 987.65, binding: 'usd' },
    }
    const both = (overview, acct) => {
      // Exactly what Performance.jsx does: the card's view from
      // feedDailyStopView(overview, acct); each account card from
      // cardStopFields over the same account's overview row.
      const feed = renderToStaticMarkup(<DataFeed {...dataFeedCardScope({ acct, riskFull })} dailyStop={feedDailyStopView(overview, acct)} />)
      const row = overview.accounts.find(r => r.accountId === acct)
      const cards = renderToStaticMarkup(<PerfAccountScope acctCards={[card(acct, 'Live · 1251247', row.dailyStop)]} palette={palette} money={money} signed={signed} scope="all" onScopeChange={() => {}} />)
      return { feed: feedStop(feed), card: cardStop(cards), feedHtml: feed }
    }
    // Two accounts; the card is scoped to the SECOND, so a reader that took
    // the wrong row (or the first one) would show the tier account's −1,200.
    const overview = { accounts: [{ accountId: '46130058', dailyStop: TIER }, { accountId: '42993489', dailyStop: SGD }] }
    const a = both(overview, '42993489')
    expect(a.feed).toBe('−200 USD (FX day)')
    expect(a.card).toBe(a.feed)
    for (const other of ['987', '150', '1,200']) expect(a.feedHtml).not.toContain(other)

    // The engine's reading moves (the % check now binds above the floor):
    // both surfaces move with it, to the same words.
    const moved = { accounts: [overview.accounts[0], { accountId: '42993489', dailyStop: { ...SGD, capUsd: 431.9, binding: 'pct' } }] }
    const b = both(moved, '42993489')
    expect(b.feed).toBe('−432 USD (FX day)')
    expect(b.card).toBe(b.feed)

    // The reading goes missing: both say "not read" — neither falls back to
    // risk-full's figures or to balance × dailyLossPct.
    const gone = { accounts: [overview.accounts[0], { accountId: '42993489', dailyStop: undefined }] }
    const c = both(gone, '42993489')
    expect(c.feed).toBe('not read')
    expect(c.card).toBe(c.feed)
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
