import { describe, it, expect, beforeEach, vi } from 'vitest'

// S3 — the view lens. These pin the two things that could go wrong quietly:
//   1. the lens leaking onto a money-moving route;
//   2. the lens NOT being applied, so a page shows one account's rows under
//      another account's heading — which is where this whole workstream began.

const CACHE = 'accounts_cache_v1'
const VIEW_KEY = 'viewed_account_id'

// vitest runs this repo in the `node` environment (vite.config.js), so web
// storage does not exist. Stubbed here rather than switching every test in the
// project to jsdom for the sake of four cases — a global environment change is
// a much larger blast radius than the thing being tested.
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
      { accountId: 111, isLive: false, traderLogin: 5067353 },
      { accountId: 222, isLive: false, traderLogin: 5203012 },
    ],
  }))
}

describe('the viewed-account lens', () => {
  beforeEach(() => {
    vi.resetModules()
    sessionStorage.clear()
    localStorage.clear()
  })

  it('with no override, the viewed account IS the traded account', async () => {
    setTraded(111)
    const { viewedAccountId, isViewingOther } = await import('./selected-account.js')
    expect(viewedAccountId()).toBe(111)
    expect(isViewingOther()).toBe(false)
  })

  it('an override changes what is viewed and never what is traded', async () => {
    setTraded(111)
    const m = await import('./selected-account.js')
    m.setViewedAccount(222)
    expect(m.viewedAccountId()).toBe(222)
    expect(m.isViewingOther()).toBe(true)
    // THE POINT OF THE WHOLE DESIGN: the traded account has not moved.
    expect(m.selectedAccountId()).toBe(111)
    expect(JSON.parse(sessionStorage.getItem(CACHE)).selectedAccountId).toBe(111)
  })

  it('clearing the override returns to following the traded account', async () => {
    setTraded(111)
    const m = await import('./selected-account.js')
    m.setViewedAccount(222)
    m.setViewedAccount(null)
    expect(m.viewedAccountId()).toBe(111)
    expect(m.isViewingOther()).toBe(false)
    expect(localStorage.getItem(VIEW_KEY)).toBeNull()
  })

  it('a switch notifies subscribers, so every page reloads instead of going stale', async () => {
    setTraded(111)
    const m = await import('./selected-account.js')
    const seen = []
    const off = m.onAccountSwitch(ev => seen.push(ev))
    m.setViewedAccount(222)
    off()
    expect(seen).toHaveLength(1)
    expect(seen[0].to).toBe(222)
    expect(seen[0].viewOnly).toBe(true)
  })
})

describe('withViewedAccount — the one wire-point', () => {
  // Imported ONCE. withViewedAccount reads storage live on every call, so a
  // module reset per case buys nothing and costs a re-transform of agent-api
  // (which is heavy enough to blow the 5s default timeout).
  let w
  beforeEach(async () => {
    sessionStorage.clear()
    localStorage.clear()
    if (!w) w = (await import('./agent-api.js')).__withViewedAccount
    setTraded(111)
  })

  const lensOn = async () => (await import('./selected-account.js')).setViewedAccount(222)

  it('appends nothing at rest — S3 is byte-for-byte the old behaviour by default', () => {
    expect(w('/state/trades')).toBe('/state/trades')
    expect(w('/state/risk-events?limit=200')).toBe('/state/risk-events?limit=200')
  })

  it('appends ?account= to /state reads while the lens is on', async () => {
    await lensOn()
    expect(w('/state/trades')).toBe('/state/trades?account=222')
    expect(w('/state/risk-events?limit=200')).toBe('/state/risk-events?limit=200&account=222')
  })

  it('NEVER touches /actions — the lens is a view, not an instruction', async () => {
    await lensOn()
    // These move money. An account picked in page chrome must not reach them.
    for (const p of ['/actions/close-all', '/actions/ctrader-select-account', '/actions/symbols']) {
      expect(w(p)).toBe(p)
    }
    expect(w('/health')).toBe('/health')
  })

  it('an explicit account= wins — the Accounts page compares accounts on purpose', async () => {
    await lensOn()
    expect(w('/state/trades?account=999')).toBe('/state/trades?account=999')
    expect(w('/state/trades?account=all')).toBe('/state/trades?account=all')
  })
})
