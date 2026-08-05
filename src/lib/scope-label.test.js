// npx vitest run src/lib/scope-label.test.js
import { describe, it, expect } from 'vitest'
import { accountLabel, findAccount, scopeLabel, scopeDiffers, LABEL_DIGITS } from './scope-label.js'

const ACCOUNTS = [
  { account_id: '42993489', trader_login: '1251247', is_live: 1 },
  { account_id: '43097342', trader_login: '5067353', is_live: 0 },
  { account_id: '46979908', trader_login: '5268549', is_live: 0 },
]

describe('accountLabel', () => {
  it('names an account the way the owner recognises it', () => {
    expect(accountLabel(ACCOUNTS[0])).toBe('Live · 1247')
    expect(accountLabel(ACCOUNTS[1])).toBe('Demo · 7353')
  })

  it('accepts either key shape, because the app carries both', () => {
    expect(accountLabel({ accountId: '1', traderLogin: '5203012', isLive: false })).toBe('Demo · 3012')
  })

  it('a login shorter than the tail is shown whole, not padded', () => {
    expect(accountLabel({ trader_login: '77', is_live: 0 })).toBe('Demo · 77')
    expect(LABEL_DIGITS).toBe(4)
  })

  it('with no login it shows the FULL account id — not a lookalike 4-digit tail', () => {
    // Trimming an internal id to four digits would produce something that
    // reads exactly like a broker login and is not one.
    expect(accountLabel({ account_id: '46130058', is_live: 0 })).toBe('Demo · 46130058')
  })

  it('returns null rather than a half-label when there is nothing to name', () => {
    expect(accountLabel(null)).toBe(null)
    expect(accountLabel({})).toBe(null)
    expect(accountLabel({ account_id: '' })).toBe(null)
  })
})

describe('findAccount', () => {
  it('matches across string/number id shapes', () => {
    expect(findAccount(ACCOUNTS, 43097342)?.trader_login).toBe('5067353')
    expect(findAccount(ACCOUNTS, '43097342')?.trader_login).toBe('5067353')
  })
  it('never treats a null scope as a lookup', () => {
    expect(findAccount(ACCOUNTS, null)).toBe(null)
    expect(findAccount(ACCOUNTS, '')).toBe(null)
    expect(findAccount(null, '43097342')).toBe(null)
  })
})

describe('scopeLabel — three states, and the third is the point', () => {
  it('an account scope names the account', () => {
    const s = scopeLabel('43097342', ACCOUNTS)
    expect(s.kind).toBe('account')
    expect(s.text).toBe('Demo · 7353')
    expect(s.title).toContain('43097342')
  })

  it('all means aggregated, and says so', () => {
    for (const v of ['all', null, undefined, '']) {
      const s = scopeLabel(v, ACCOUNTS)
      expect(s.kind).toBe('all')
      expect(s.text).toBe('All accounts')
    }
  })

  it('GLOBAL is its own state — silence used to mean either "everywhere" or "unlabelled"', () => {
    const s = scopeLabel('global', ACCOUNTS)
    expect(s.kind).toBe('global')
    expect(s.text).toBe('Global')
    expect(s.title).toMatch(/every account/)
  })

  it('an id not in the registry shows the ID, never an invented name', () => {
    const s = scopeLabel('99999999', ACCOUNTS)
    expect(s.kind).toBe('unknown')
    expect(s.text).toBe('Account 99999999')
    expect(s.title).toMatch(/not found/)
  })

  it('an empty roster degrades to the id rather than to "All accounts"', () => {
    // The dangerous failure: a card scoped to one account reading as the
    // aggregate because its roster fetch had not landed yet.
    const s = scopeLabel('43097342', [])
    expect(s.kind).toBe('unknown')
    expect(s.text).toContain('43097342')
  })
})

describe('scopeDiffers — a pinned card must be visible, not silent', () => {
  it('spots the screenshot case: one card on 8549 while the page is on 7353', () => {
    expect(scopeDiffers('46979908', '43097342')).toBe(true)
  })
  it('same scope does not differ, in either id shape', () => {
    expect(scopeDiffers('43097342', 43097342)).toBe(false)
  })
  it('null and "all" are the same scope', () => {
    expect(scopeDiffers(null, 'all')).toBe(false)
    expect(scopeDiffers('all', undefined)).toBe(false)
  })
  it('GLOBAL never differs — it is not on the same axis as the page scope', () => {
    expect(scopeDiffers('global', '43097342')).toBe(false)
    expect(scopeDiffers('global', 'all')).toBe(false)
  })
})
