// npx vitest run src/lib/scope-fab.test.js
//
// The FAB's face is a claim about whose numbers the page is showing, made in
// nine characters. Every test here is about a way that claim could be wrong
// while still looking fine on screen.
import { describe, it, expect } from 'vitest'
import { fabFace, fabOptions, FAB_ALL } from './scope-fab.js'

const ACCOUNTS = [
  { account_id: '43097342', trader_login: '5067353', is_live: 0 },
  { account_id: '42993489', trader_login: '1251247', is_live: 1 },
  { account_id: '46979908', trader_login: '5268549', is_live: 0 },
]

describe('fabFace — readable at a glance, or honest about not knowing', () => {
  it('an account shows DEMO over the four digits the owner recognises', () => {
    expect(fabFace('43097342', ACCOUNTS)).toMatchObject({ kind: 'account', top: 'DEMO', bottom: '7353' })
  })

  it('the live account says the WORD LIVE — never colour alone', () => {
    // The owner reads red and green as one thing. If "which account" is
    // carried by hue, the most consequential row on the sheet is the one
    // they cannot distinguish.
    const f = fabFace('42993489', ACCOUNTS)
    expect(f.top).toBe('LIVE')
    expect(f.bottom).toBe('1247')
  })

  it('the aggregate scope says ALL, in every spelling the app uses', () => {
    for (const v of [FAB_ALL, null, undefined, '']) {
      expect(fabFace(v, ACCOUNTS)).toMatchObject({ top: 'ALL', bottom: 'ACCTS' })
    }
  })

  it('an unloaded roster does NOT read as "all accounts"', () => {
    // THE DANGEROUS FAILURE. The page is scoped to one account; the roster
    // fetch has not landed. Falling back to the ALL face would state, in the
    // one place the operator is meant to trust, that they are looking at the
    // whole book while they are looking at 7353.
    const f = fabFace('43097342', [])
    expect(f.kind).toBe('unknown')
    expect(f.top).toBe('ACCT')
    expect(f.bottom).toBe('?')
    expect(f.title).toContain('43097342')
  })

  it('an id absent from the registry never gets an invented name', () => {
    expect(fabFace('99999999', ACCOUNTS).kind).toBe('unknown')
  })

  it('every face fits the 56px pill — no field longer than five characters', () => {
    const faces = [fabFace('43097342', ACCOUNTS), fabFace('all', ACCOUNTS), fabFace('99999999', ACCOUNTS)]
    for (const f of faces) {
      expect(f.top.length).toBeLessThanOrEqual(5)
      expect(f.bottom.length).toBeLessThanOrEqual(5)
    }
  })

  it('a global scope falls in with ALL on the face and stays distinct in the title', () => {
    // 'global' is not on the FAB's axis, but if a page ever hands it over the
    // face must still say something true: you are not looking at one account.
    const f = fabFace('global', ACCOUNTS)
    expect(f.top).toBe('ALL')
    expect(f.title).toMatch(/every account/)
  })
})

describe('fabOptions — the sheet', () => {
  it('offers the aggregate first and the LIVE account last', () => {
    const opts = fabOptions(ACCOUNTS)
    expect(opts[0]).toMatchObject({ value: FAB_ALL, label: 'All accounts' })
    expect(opts.at(-1)).toMatchObject({ value: '42993489', live: true })
    // Demo rows keep the registry's own order between them.
    expect(opts.slice(1, 3).map(o => o.value)).toEqual(['43097342', '46979908'])
  })

  it('names each row the same way every other surface does', () => {
    expect(fabOptions(ACCOUNTS)[1].label).toBe('Demo 5067353 · 43097342')
  })

  it('marks which account the bot is actually TRADING — viewing is not arming', () => {
    const opts = fabOptions(ACCOUNTS, { tradedId: 43097342 })
    expect(opts.find(o => o.value === '43097342').traded).toBe(true)
    expect(opts.filter(o => o.traded)).toHaveLength(1)
  })

  it('still offers the aggregate when the roster is empty or broken', () => {
    for (const v of [[], null, undefined]) {
      expect(fabOptions(v)).toEqual([{ value: FAB_ALL, label: 'All accounts', live: false, traded: false }])
    }
  })

  it('drops rows with no id rather than emitting an unselectable option', () => {
    expect(fabOptions([{ trader_login: '5067353', is_live: 0 }])).toHaveLength(1)
  })
})
