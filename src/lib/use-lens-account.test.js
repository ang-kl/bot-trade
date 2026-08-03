// The sidebar lens as a page DEFAULT.
//
// Owner, 03-08-2026: "If I change the viewing lens in the side bar … it isn't
// wire to the rest of the page … pages like Risk, Trade, Performance will
// prioritise to this new change as default."
//
// These test the pure decisions the hook makes, without React: what scope a
// page STARTS on, and what it moves to on a switch. The hook itself is four
// lines of useState/useEffect around exactly this.
import { describe, it, expect, beforeEach } from 'vitest'

// vitest runs this repo in the `node` environment, so web storage is stubbed
// (same approach as viewed-account.test.js — a jsdom switch for four cases is
// a far larger blast radius than the thing under test).
const CACHE = 'accounts_cache_v1'
function memStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  }
}
globalThis.sessionStorage = memStorage()
globalThis.localStorage = memStorage()

function setTraded(id) {
  sessionStorage.setItem(CACHE, JSON.stringify({
    selectedAccountId: id,
    accounts: [
      { accountId: 46130058, isLive: false, traderLogin: 5203012 },
      { accountId: 47790949, isLive: false, traderLogin: 5306502 },
    ],
  }))
}

/** What useLensAccount computes for its initial state. */
const initial = (viewed, fallback = 'all') => (viewed == null ? fallback : String(viewed))

describe('a page takes its starting scope from the lens', () => {
  let m
  beforeEach(async () => {
    sessionStorage.clear()
    localStorage.clear()
    if (!m) m = await import('./selected-account.js')
  })

  it('with no lens, the page starts on the TRADED account, not on all', () => {
    setTraded(46130058)
    expect(initial(m.viewedAccountId())).toBe('46130058')
  })

  it('with the lens on another account, the page starts THERE', () => {
    setTraded(46130058)
    m.setViewedAccount(47790949)
    expect(initial(m.viewedAccountId())).toBe('47790949')
    // …and the bot is still trading the first one. This is the whole design.
    expect(m.selectedAccountId()).toBe(46130058)
  })

  it('falls back only when there is no account at all', () => {
    expect(initial(m.viewedAccountId())).toBe('all')
  })

  it('a switch carries the id the page must move to', () => {
    setTraded(46130058)
    const seen = []
    const off = m.onAccountSwitch(ev => seen.push(ev))
    m.setViewedAccount(47790949)
    off()
    expect(seen).toHaveLength(1)
    expect(String(seen[0].to)).toBe('47790949')
    // view-only: nothing was sent to the agent.
    expect(seen[0].viewOnly).toBe(true)
  })

  it('clearing the lens moves the page back to the traded account', () => {
    setTraded(46130058)
    m.setViewedAccount(47790949)
    const seen = []
    const off = m.onAccountSwitch(ev => seen.push(ev))
    m.setViewedAccount(null)
    off()
    expect(String(seen[0].to)).toBe('46130058')
    expect(initial(m.viewedAccountId())).toBe('46130058')
  })
})
