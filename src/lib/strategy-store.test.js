import { describe, it, expect } from 'vitest'
import {
  INITIAL_STATE,
  EMPTY_STATE,
  DEFAULT_WATCHLIST,
  WATCHLIST_CATEGORIES,
  SCHEMA_VERSION,
  STORAGE_KEY,
  BRIEFING_WINDOWS,
  SOURCE_OPTIONS,
  SUB_AGENTS,
  DEFAULT_AGENTS,
  reducer,
  sanitize,
  readStored,
  writeStored,
} from './strategy-store.js'

function makeStorage(initial = {}) {
  const store = { ...initial }
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
    _raw: store,
  }
}

describe('strategy-store constants', () => {
  it('exposes the expected briefing windows', () => {
    expect(BRIEFING_WINDOWS).toEqual(['morning', 'noon', 'adhoc'])
  })
  it('lists sub-agents matching DEFAULT_AGENTS keys', () => {
    expect(SUB_AGENTS.sort()).toEqual(Object.keys(DEFAULT_AGENTS).sort())
  })
  it('has reputable source options, no X/twitter', () => {
    expect(SOURCE_OPTIONS).toContain('osinet')
    expect(SOURCE_OPTIONS).not.toContain('twitter')
    expect(SOURCE_OPTIONS).not.toContain('x')
  })
})

describe('reducer: hydrate + unknown', () => {
  it('HYDRATE replaces state with payload', () => {
    const next = reducer(INITIAL_STATE, { type: 'HYDRATE', payload: { ...INITIAL_STATE, risk: { ...INITIAL_STATE.risk, armed: true } } })
    expect(next.risk.armed).toBe(true)
  })
  it('HYDRATE without payload is a no-op', () => {
    expect(reducer(INITIAL_STATE, { type: 'HYDRATE' })).toBe(INITIAL_STATE)
  })
  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL_STATE, { type: 'NOPE' })).toBe(INITIAL_STATE)
  })
})

describe('default watchlist seed', () => {
  it('ships more than 30 rows', () => {
    expect(DEFAULT_WATCHLIST.length).toBeGreaterThan(30)
  })
  it('seeds every row disabled so the user/agent picks what to trade', () => {
    expect(DEFAULT_WATCHLIST.every(w => w.enabled === false)).toBe(true)
  })
  it('every seed row uses a known category', () => {
    for (const w of DEFAULT_WATCHLIST) {
      expect(WATCHLIST_CATEGORIES).toContain(w.category)
    }
  })
  it('every seed row has a human-readable label', () => {
    for (const w of DEFAULT_WATCHLIST) {
      expect(typeof w.label).toBe('string')
      expect(w.label.length).toBeGreaterThan(0)
    }
  })
  it('INITIAL_STATE points at the default watchlist', () => {
    expect(INITIAL_STATE.watchlist).toBe(DEFAULT_WATCHLIST)
  })
  it('EMPTY_STATE has an empty watchlist', () => {
    expect(EMPTY_STATE.watchlist).toEqual([])
  })
  it('seed includes the canonical FX + crypto anchors', () => {
    const symbols = DEFAULT_WATCHLIST.map(w => w.symbol)
    expect(symbols).toEqual(expect.arrayContaining(['EURUSD', 'USDJPY', 'XAUUSD', 'BTCUSD', 'NAS100']))
  })
})

describe('reducer: cTrader', () => {
  it('sets access + refresh tokens', () => {
    const s = reducer(INITIAL_STATE, { type: 'CTRADER_SET_TOKENS', accessToken: 'abc', refreshToken: 'def' })
    expect(s.ctrader.accessToken).toBe('abc')
    expect(s.ctrader.refreshToken).toBe('def')
  })
  it('ignores non-string token fields', () => {
    const s = reducer(INITIAL_STATE, { type: 'CTRADER_SET_TOKENS', accessToken: 123 })
    expect(s.ctrader.accessToken).toBe('')
  })
  it('replaces accounts list', () => {
    const s = reducer(INITIAL_STATE, { type: 'CTRADER_SET_ACCOUNTS', accounts: [{ ctidTraderAccountId: 1 }] })
    expect(s.ctrader.accounts).toHaveLength(1)
  })
  it('coerces non-array accounts to empty list', () => {
    const s = reducer(INITIAL_STATE, { type: 'CTRADER_SET_ACCOUNTS', accounts: 'nope' })
    expect(s.ctrader.accounts).toEqual([])
  })
  it('links and unlinks an account', () => {
    const linked = reducer(INITIAL_STATE, { type: 'CTRADER_LINK_ACCOUNT', accountId: 42 })
    expect(linked.ctrader.linkedAccountId).toBe(42)
    const cleared = reducer(linked, { type: 'CTRADER_LINK_ACCOUNT' })
    expect(cleared.ctrader.linkedAccountId).toBeNull()
  })
})

describe('reducer: watchlist', () => {
  const seed = (...symbols) => symbols.reduce((s, sym) => reducer(s, { type: 'WATCHLIST_ADD', symbol: sym }), EMPTY_STATE)

  it('adds a symbol with default agents', () => {
    const s = reducer(EMPTY_STATE, { type: 'WATCHLIST_ADD', symbol: 'eurusd' })
    expect(s.watchlist).toEqual([{ symbol: 'EURUSD', enabled: true, agents: { ...DEFAULT_AGENTS } }])
  })
  it('stores optional label + category when provided', () => {
    const s = reducer(EMPTY_STATE, { type: 'WATCHLIST_ADD', symbol: 'NATGAS', label: 'Natural Gas', category: 'Futures' })
    expect(s.watchlist[0]).toMatchObject({ symbol: 'NATGAS', label: 'Natural Gas', category: 'Futures' })
  })
  it('rejects duplicates case-insensitively', () => {
    const s = seed('EURUSD')
    const after = reducer(s, { type: 'WATCHLIST_ADD', symbol: 'eurusd' })
    expect(after.watchlist).toHaveLength(1)
  })
  it('ignores blank symbols', () => {
    expect(reducer(EMPTY_STATE, { type: 'WATCHLIST_ADD', symbol: '   ' }).watchlist).toHaveLength(0)
  })
  it('removes a symbol', () => {
    const s = seed('EURUSD', 'GBPUSD')
    const after = reducer(s, { type: 'WATCHLIST_REMOVE', symbol: 'eurusd' })
    expect(after.watchlist.map(w => w.symbol)).toEqual(['GBPUSD'])
  })
  it('MOVE swaps neighbours within bounds', () => {
    const s = seed('A', 'B', 'C')
    const down = reducer(s, { type: 'WATCHLIST_MOVE', symbol: 'A', delta: 1 })
    expect(down.watchlist.map(w => w.symbol)).toEqual(['B', 'A', 'C'])
    const up = reducer(down, { type: 'WATCHLIST_MOVE', symbol: 'A', delta: -1 })
    expect(up.watchlist.map(w => w.symbol)).toEqual(['A', 'B', 'C'])
  })
  it('MOVE out-of-bounds is a no-op (returns same reference)', () => {
    const s = seed('A', 'B')
    expect(reducer(s, { type: 'WATCHLIST_MOVE', symbol: 'A', delta: -1 })).toBe(s)
    expect(reducer(s, { type: 'WATCHLIST_MOVE', symbol: 'B', delta: 1 })).toBe(s)
  })
  it('TOGGLE_ENABLED flips the enabled flag', () => {
    const s = seed('EURUSD')
    const off = reducer(s, { type: 'WATCHLIST_TOGGLE_ENABLED', symbol: 'EURUSD' })
    expect(off.watchlist[0].enabled).toBe(false)
    const on = reducer(off, { type: 'WATCHLIST_TOGGLE_ENABLED', symbol: 'EURUSD' })
    expect(on.watchlist[0].enabled).toBe(true)
  })
  it('TOGGLE_AGENT flips one agent on a symbol', () => {
    const s = seed('EURUSD')
    const off = reducer(s, { type: 'WATCHLIST_TOGGLE_AGENT', symbol: 'EURUSD', agent: 'news' })
    expect(off.watchlist[0].agents.news).toBe(false)
    expect(off.watchlist[0].agents.technical).toBe(true)
  })
  it('TOGGLE_AGENT rejects unknown agent names', () => {
    const s = seed('EURUSD')
    expect(reducer(s, { type: 'WATCHLIST_TOGGLE_AGENT', symbol: 'EURUSD', agent: 'psychic' })).toBe(s)
  })
})

describe('reducer: news (Market Rundown)', () => {
  it('sets the briefing window when valid', () => {
    const s = reducer(INITIAL_STATE, { type: 'NEWS_SET_WINDOW', window: 'noon' })
    expect(s.news.briefingWindow).toBe('noon')
  })
  it('rejects unknown briefing windows', () => {
    expect(reducer(INITIAL_STATE, { type: 'NEWS_SET_WINDOW', window: 'midnight' })).toBe(INITIAL_STATE)
  })
  it('toggles a known source on and off', () => {
    const s = reducer(INITIAL_STATE, { type: 'NEWS_TOGGLE_SOURCE', source: 'bloomberg' })
    expect(s.news.sources).toContain('bloomberg')
    const s2 = reducer(s, { type: 'NEWS_TOGGLE_SOURCE', source: 'bloomberg' })
    expect(s2.news.sources).not.toContain('bloomberg')
  })
  it('rejects unknown sources', () => {
    expect(reducer(INITIAL_STATE, { type: 'NEWS_TOGGLE_SOURCE', source: 'x' })).toBe(INITIAL_STATE)
  })
  it('stores a rundown with a timestamp', () => {
    const at = '2026-04-15T12:00:00.000Z'
    const s = reducer(INITIAL_STATE, { type: 'NEWS_SET_RUNDOWN', rundown: '# Rundown', at })
    expect(s.news.latestRundown).toBe('# Rundown')
    expect(s.news.lastGeneratedAt).toBe(at)
  })
  it('coerces non-string structure payload to null', () => {
    const s = reducer(INITIAL_STATE, { type: 'NEWS_SET_STRUCTURE', structure: 42 })
    expect(s.news.structure).toBeNull()
  })
})

describe('reducer: risk', () => {
  it('clamps per-trade pct into [0,100]', () => {
    expect(reducer(INITIAL_STATE, { type: 'RISK_SET', perTradePct: 500 }).risk.perTradePct).toBe(100)
    expect(reducer(INITIAL_STATE, { type: 'RISK_SET', perTradePct: -3 }).risk.perTradePct).toBe(0)
  })
  it('clamps max trades/day into [0,1000]', () => {
    expect(reducer(INITIAL_STATE, { type: 'RISK_SET', maxTradesPerDay: 9999 }).risk.maxTradesPerDay).toBe(1000)
  })
  it('non-finite values clamp to the floor', () => {
    expect(reducer(INITIAL_STATE, { type: 'RISK_SET', perTradePct: 'hi' }).risk.perTradePct).toBe(0)
  })
  it('toggles armed', () => {
    const armed = reducer(INITIAL_STATE, { type: 'RISK_TOGGLE_ARMED' })
    expect(armed.risk.armed).toBe(true)
    expect(reducer(armed, { type: 'RISK_TOGGLE_ARMED' }).risk.armed).toBe(false)
  })
})

describe('sanitize', () => {
  it('returns fallback when raw is not an object', () => {
    expect(sanitize(null)).toBe(INITIAL_STATE)
    expect(sanitize('foo')).toBe(INITIAL_STATE)
  })
  it('rebuilds watchlist from legacy shapes', () => {
    const raw = { watchlist: [{ symbol: 'eurusd', enabled: true, agents: { news: false } }, null, { symbol: 42 }] }
    const out = sanitize(raw)
    expect(out.watchlist).toEqual([
      { symbol: 'EURUSD', enabled: true, agents: { ...DEFAULT_AGENTS, news: false } },
    ])
  })
  it('coerces risk numerics and drops unknown sources', () => {
    const raw = { news: { briefingWindow: 'midnight', sources: ['osinet', 'x'] }, risk: { perTradePct: 999, dailyMaxLossPct: -5, maxTradesPerDay: 9999, armed: true } }
    const out = sanitize(raw)
    expect(out.news.briefingWindow).toBe('morning')
    expect(out.news.sources).toEqual(['osinet'])
    expect(out.risk).toEqual({ perTradePct: 100, dailyMaxLossPct: 0, maxTradesPerDay: 1000, armed: true })
  })
  it('migrates pre-v2 empty watchlist to the default seed', () => {
    // Simulates a returning visitor whose localStorage was persisted before
    // the default pool shipped.
    const raw = { watchlist: [], risk: { perTradePct: 2 } }
    const out = sanitize(raw)
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out.watchlist).toBe(DEFAULT_WATCHLIST)
  })
  it('preserves an intentional v2 empty watchlist', () => {
    // A user who already migrated and deliberately removed every row.
    const raw = { schemaVersion: SCHEMA_VERSION, watchlist: [] }
    const out = sanitize(raw)
    expect(out.watchlist).toEqual([])
  })
  it('stamps schemaVersion onto sanitized output', () => {
    const out = sanitize({ watchlist: [{ symbol: 'EURUSD', enabled: true }] })
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
  })
})

describe('readStored / writeStored', () => {
  it('writes and reads round-trip via storage double', () => {
    const storage = makeStorage()
    const s = reducer(INITIAL_STATE, { type: 'RISK_TOGGLE_ARMED' })
    expect(writeStored(storage, s)).toBe(true)
    expect(storage._raw[STORAGE_KEY]).toBeDefined()
    expect(readStored(storage).risk.armed).toBe(true)
  })
  it('readStored returns fallback when storage is empty', () => {
    expect(readStored(makeStorage())).toBe(INITIAL_STATE)
  })
  it('readStored returns fallback on malformed JSON', () => {
    const storage = makeStorage({ [STORAGE_KEY]: '{not json' })
    expect(readStored(storage)).toBe(INITIAL_STATE)
  })
  it('writeStored returns false when storage throws', () => {
    const storage = { setItem: () => { throw new Error('quota') } }
    expect(writeStored(storage, INITIAL_STATE)).toBe(false)
  })
})
