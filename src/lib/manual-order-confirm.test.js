// SAFE-0a (integrated plan 26-09-2026): the manual-order confirm names the
// account the order will reach.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { manualOrderConfirmText } from './manual-order-confirm.js'

const base = { side: 'BUY', symbol: 'EURUSD', sl: '1.0800', tp: '1.0900' }

describe('manualOrderConfirmText — the confirm names the destination account', () => {
  it('carries the destination id as …last four, and the broker login when known', () => {
    const t = manualOrderConfirmText({ ...base, destination: { accountId: '46970949', traderLogin: '5123456' }, viewedAccountId: '46970949' })
    expect(t).toContain('…0949')
    expect(t).toContain('login 5123456')
    expect(t).toBe('Place a REAL BUY market order on EURUSD (SL 1.0800, TP 1.0900) on account …0949 (login 5123456)?')
    // Never the full internal id, never the environment (principle 1).
    expect(t).not.toContain('46970949')
    expect(t).not.toMatch(/LIVE|DEMO|live|demo/)
  })

  it('omits the login when the page does not have one', () => {
    const t = manualOrderConfirmText({ ...base, tp: '', destination: { accountId: '42993489' } })
    expect(t).toBe('Place a REAL BUY market order on EURUSD (SL 1.0800) on account …3489?')
  })

  it('says so plainly when the order goes to a different account than the one on screen', () => {
    const t = manualOrderConfirmText({ ...base, destination: { accountId: '46970949' }, viewedAccountId: '46970058' })
    expect(t).toContain('on account …0949')
    expect(t).toContain('NOT the account this page is showing (…0058)')
  })

  it('does not raise a mismatch for the portfolio view or an unknown view', () => {
    for (const v of ['all', null, '']) {
      expect(manualOrderConfirmText({ ...base, destination: { accountId: '46970949' }, viewedAccountId: v })).not.toContain('NOT the account')
    }
  })

  it('never invents an id it does not have', () => {
    for (const d of [null, {}, { accountId: null }, { accountId: '' }]) {
      const t = manualOrderConfirmText({ ...base, destination: d, viewedAccountId: '46970058' })
      expect(t).toContain('the primary broker account (its id is not reported to this page)')
      expect(t).not.toMatch(/…\d{4}/)
    }
  })
})

describe('Trade.jsx wiring — the order pad asks with the destination-naming confirm', () => {
  // Source scan as a last resort: placeOrder has no injection point. Comments
  // are stripped first (CLAUDE.md failure mode #2).
  const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('../pages/Trade.jsx', import.meta.url), 'utf8'))
  const start = src.indexOf('const placeOrder = async')
  const body = src.slice(start, src.indexOf("agentPost('/actions/manual-order'", start))

  // Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder): the pad now
  // routes to the account the page shows; the confirm is fed by that SAME
  // destination (padDestination) and the post carries it (manualOrderBody).
  it('placeOrder confirms with manualOrderConfirmText fed by the pad destination, and posts that destination', () => {
    expect(start).toBeGreaterThan(0)
    expect(body).toMatch(/window\.confirm\(manualOrderConfirmText\(/)
    expect(body).toMatch(/destination:\s*padDest\.accountId != null \? \{ accountId: padDest\.accountId/)
    expect(body).toMatch(/primary:\s*!padDest\.routed/)
    expect(body).toMatch(/check:\s*padCheckNow/)
    expect(body).not.toMatch(/window\.confirm\(`Place a REAL/)
    expect(src).toMatch(/agentPost\('\/actions\/manual-order', manualOrderBody\(\{ order, destination: padDest \}\)\)/)
    expect(src).toMatch(/const padDest = padDestination\(\{ viewedAccountId: viewedAccountId\(\), broker: health\?\.broker \?\? null \}\)/)
  })
})

describe('manualOrderConfirmText — primary routing and the checked size (Claude · № 12,955)', () => {
  it('names the primary account as primary when the order is not routed', () => {
    const t = manualOrderConfirmText({ ...base, destination: { accountId: '46970949' }, viewedAccountId: 'all', primary: true })
    expect(t).toBe('Place a REAL BUY market order on EURUSD (SL 1.0800, TP 1.0900) on the primary broker account, account …0949?')
  })

  it('states the size and money at risk when a check has run for these inputs', () => {
    const t = manualOrderConfirmText({ ...base, destination: { accountId: '46970949' }, viewedAccountId: '46970949', check: { volume: 0.14, moneyAtRisk: 140, currency: 'USD' } })
    expect(t).toBe('Place a REAL BUY market order on EURUSD (SL 1.0800, TP 1.0900) on account …0949? Checked: size 0.14 lots, money at risk USD 140.')
    const unknown = manualOrderConfirmText({ ...base, destination: { accountId: '46970949' }, check: { volume: 0.2, moneyAtRisk: null, currency: 'USD' } })
    expect(unknown).toContain('money at risk not known')
  })

  it('says nothing about size without a check — never a guessed figure', () => {
    for (const check of [null, undefined, { volume: null, moneyAtRisk: 5 }]) {
      expect(manualOrderConfirmText({ ...base, destination: { accountId: '46970949' }, check })).not.toContain('Checked:')
    }
  })
})
