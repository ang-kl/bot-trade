// npx vitest run src/lib/scope-label.test.js
import { describe, it, expect } from 'vitest'
import { accountLabel, findAccount, scopeLabel, scopeDiffers } from './scope-label.js'

const ACCOUNTS = [
  { account_id: '42993489', trader_login: '1251247', is_live: 1 },
  { account_id: '43097342', trader_login: '5067353', is_live: 0 },
  { account_id: '46979908', trader_login: '5268549', is_live: 0 },
]

describe('accountLabel — BOTH numbers, always', () => {
  it('carries the login AND the account id', () => {
    // Owner, 05-08-2026: "All accounts listed must include the ID as I only
    // know the Account #". Every naming site in the app was
    // `traderLogin || accountId` — 39 of them — and since the broker login is
    // always present, the branch that showed the id never ran. The id was not
    // hard to find on screen; it was absent.
    expect(accountLabel(ACCOUNTS[0])).toBe('Live 1251247 · 42993489')
    expect(accountLabel(ACCOUNTS[1])).toBe('Demo 5067353 · 43097342')
  })

  it('never truncates either number', () => {
    // A 4-digit tail is not a value you can look up in a log line, a veto
    // reason, or an `?account=` query. Abbreviating an identifier deletes the
    // only thing it is for.
    const label = accountLabel(ACCOUNTS[2])
    expect(label).toContain('5268549')
    expect(label).toContain('46979908')
    expect(label).not.toMatch(/…|\.\.\./)
  })

  it('accepts either key shape, because the app carries both', () => {
    expect(accountLabel({ accountId: '46130058', traderLogin: '5203012', isLive: false }))
      .toBe('Demo 5203012 · 46130058')
  })

  it('degrades to whichever number exists, rather than to nothing', () => {
    expect(accountLabel({ account_id: '46130058', is_live: 0 })).toBe('Demo 46130058')
    expect(accountLabel({ trader_login: '5203012', is_live: 1 })).toBe('Live 5203012')
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
    expect(s.text).toBe('Demo 5067353 · 43097342')
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

// ---------------------------------------------------------------------------
// THE SWEEP, PINNED (owner, 05-08-2026)
//
// One shared formatter is only worth having if the call sites actually use it.
// The `traderLogin || accountId` idiom is what hid the account id on every
// screen — 39 occurrences, each individually reasonable, collectively a
// guarantee that the number the owner works from never appeared. A test that
// only checks the formatter would have passed the whole time.
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

describe('no surface may fall back to the id instead of showing it', () => {
  it('the login-OR-id idiom is gone from every source file', () => {
    const offenders = []
    for (const f of sourceFiles('src')) {
      const src = fs.readFileSync(f, 'utf8')
      src.split('\n').forEach((line, i) => {
        // `x.traderLogin || x.accountId` in any key shape, either operator.
        if (/\b([A-Za-z_$][\w$]*)\.(?:traderLogin|trader_login)\s*(?:\|\||\?\?)\s*\1\.(?:accountId|account_id)\b/.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(offenders, `use accountLabel/accountNumbers — the id must be shown, not used as a fallback:\n${offenders.join('\n')}`)
      .toEqual([])
  })
})
