// npx vitest run src/components/account-chrome.test.jsx
//
// The chrome renders on every page, so its failure modes are global. These
// cover the two that matter: a loss must never read as a gain, and a missing
// figure must never read as a zero.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountChrome, { ChromeRow } from './AccountChrome.jsx'
import { accountLabel, money, amount, armState, drawdownText, dayText } from '../lib/account-chrome-format.js'

const ROW = {
  accountId: '46130058', login: '5203012', isLive: false, enabled: true, armed: true,
  currency: 'USD', flag: '🇺🇸', balance: 50201.33, openPositions: 3,
  drawdown: { pnl: -1200, cap: 4016.1, stopPct: 0.08, spent: 0.2988, headroom: 2816.1, tripped: false, unknownCount: 0, trustworthy: true },
  day: { trades: 7, wins: 3, losses: 4, profit: 980.1, loss: 1204.55, unknown: 0 },
}

describe('the chrome line', () => {
  it('renders every field the owner asked for', () => {
    const html = renderToStaticMarkup(<ChromeRow row={ROW} />)
    expect(html).toContain('5203012 · 46130058')   // Login # · ID #
    expect(html).toContain('🇺🇸')                    // currency flag
    expect(html).toContain('50,201.33')            // balance
    expect(html).toContain('ARMED')                // armed state
    expect(html).toContain('/ 8.0%')               // drawdown against the stop
    expect(html).toContain('7 trades')             // 24h count
    expect(html).toContain('1,204.55')             // Loss
    expect(html).toContain('980.10')               // Profit
  })

  it('shows the loss with a minus and the profit without', () => {
    const html = renderToStaticMarkup(<ChromeRow row={ROW} />)
    expect(html).toContain('Loss −1,204.55')
    expect(html).toContain('Profit 980.10')
    expect(html).not.toContain('Profit −')
  })

  it('the compact variant drops the 24h pair and keeps the drawdown', () => {
    const html = renderToStaticMarkup(<ChromeRow row={ROW} compact />)
    expect(html).toContain('/ 8.0%')
    expect(html).not.toContain('Loss')
  })

  it('renders nothing rather than an error strip when there is no data', () => {
    expect(renderToStaticMarkup(<ChromeRow row={null} />)).toBe('')
    expect(renderToStaticMarkup(<AccountChrome />)).toBe('')
  })
})

describe('drawdown text', () => {
  it('reads directly against the configured stop', () => {
    // 29.88% of a 8% allowance spent = 2.4% of balance down.
    expect(drawdownText(ROW.drawdown, 'USD').text).toBe('−2.4% / 8.0%')
  })

  it('escalates tone as the allowance is spent', () => {
    const at = (spent) => drawdownText({ ...ROW.drawdown, spent, pnl: -1 }, 'USD').tone
    expect(at(0.2)).toBe('muted')
    expect(at(0.6)).toBe('warn')
    expect(at(0.9)).toBe('down')
  })

  it('says STOPPED when the stop already fired', () => {
    const d = drawdownText({ ...ROW.drawdown, tripped: true }, 'USD')
    expect(d.text).toContain('STOPPED')
    expect(d.tone).toBe('down')
  })

  it('a missing cap is a dash, never a reassuring zero', () => {
    const d = drawdownText({ ...ROW.drawdown, cap: null }, 'USD')
    expect(d.text).toBe('— / 8.0%')
    expect(d.title).toMatch(/No usable cap/)
  })

  it('an unresolved trade marks the figure as a floor', () => {
    const d = drawdownText({ ...ROW.drawdown, trustworthy: false, unknownCount: 2 }, 'USD')
    expect(d.title).toMatch(/at least this: 2 closed trade/)
  })
})

describe('arm state', () => {
  it('distinguishes armed, manage-only and the armed-but-not-watched case', () => {
    expect(armState({ armed: true, enabled: true }).label).toBe('ARMED')
    expect(armState({ armed: false, enabled: true }).label).toBe('MANAGE-ONLY')
    // Not a contradiction to paper over — enabled and armed are different
    // facts, and an account in this state is worth naming.
    expect(armState({ armed: true, enabled: false }).label).toBe('ARMED · OFF')
    expect(armState({ armed: false, enabled: false }).label).toBe('DISARMED')
  })
})

describe('formatters refuse to invent', () => {
  it('null money and null amounts are dashes', () => {
    expect(money(null, 'USD')).toBe('—')
    expect(money(NaN, 'USD')).toBe('—')
    expect(amount(null)).toBe('—')
  })

  it('an unrecognised currency still renders the number', () => {
    expect(money(12.5, 'NOT_A_CURRENCY')).toContain('12.50')
  })

  it('a row with no login falls back to the id rather than a blank', () => {
    expect(accountLabel({ accountId: '46130058' })).toBe('46130058')
    expect(accountLabel({})).toBe('—')
  })

  it('the day tooltip names the window, because it differs from the drawdown window', () => {
    expect(dayText(ROW.day).title).toMatch(/last 24 hours/)
    expect(dayText(ROW.day).title).toMatch(/FX day/)
  })
})
