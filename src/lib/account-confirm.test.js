import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { accountConfirmText } from './account-confirm.js'

describe('accountConfirmText — one neutral confirm for every account (PR-B)', () => {
  it('names the last four digits and the balance when shown, never the environment', () => {
    const live = { accountId: '42993489', isLive: true, balance: 1234.5, baseCurrency: 'USD' }
    const demo = { accountId: '46979908', isLive: false, balance: 1234.5, baseCurrency: 'USD' }
    const t1 = accountConfirmText(live, 'the bot will trade it.')
    const t2 = accountConfirmText(demo, 'the bot will trade it.')
    expect(t1).toBe('Account …3489 (balance USD 1,234.50): the bot will trade it. Continue?')
    expect(t2).toBe('Account …9908 (balance USD 1,234.50): the bot will trade it. Continue?')
    expect(t1).not.toMatch(/LIVE|live|demo|DEMO|REAL money/)
    expect(t2).not.toMatch(/LIVE|live|demo|DEMO/)
    expect(t1).not.toContain('42993489')
  })
  it('omits the balance when the row has none', () => {
    expect(accountConfirmText({ account_id: '111' }, 'switch.')).toBe('Account …111: switch. Continue?')
    expect(accountConfirmText(null, 'switch.')).toBe('Account this account: switch. Continue?')
  })
  it('the three former "Type LIVE" prompts are gone from the components and the dropdown is not gated on the environment', () => {
    const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const f of ['../components/AccountSwitcher.jsx', '../pages/Connect.jsx', '../components/AccountPhaseSwitches.jsx']) {
      const src = strip(readFileSync(new URL(f, import.meta.url), 'utf8'))
      expect(src, f).not.toMatch(/Type LIVE|window\.prompt|confirmLive/)
      expect(src, f).toMatch(/confirmAccountAction|accountConfirmText/)
    }
    const phases = strip(readFileSync(new URL('../components/AccountPhaseSwitches.jsx', import.meta.url), 'utf8'))
    expect(phases).not.toMatch(/disabled=\{a\.isLive/)
  })
})
