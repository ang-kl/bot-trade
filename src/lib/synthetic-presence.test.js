// NEW-1 (integrated plan 26-09-2026): a page opened with ?synthetic=<tag>
// sends the tag on every presence ping, for the whole life of the tab.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { syntheticPresenceTag, clientPingQuery, sendClientPing } from './agent-api.js'

function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
  }
}

describe('syntheticPresenceTag', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', memoryStorage()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads the flag from the URL and keeps it for the tab after the query is gone', () => {
    expect(syntheticPresenceTag('?synthetic=trace')).toBe('trace')
    expect(syntheticPresenceTag('')).toBe('trace')
    expect(syntheticPresenceTag('?foo=1')).toBe('trace')
  })

  it('an ordinary page load carries no tag', () => {
    expect(syntheticPresenceTag('')).toBe(null)
    expect(syntheticPresenceTag('?page=desk')).toBe(null)
  })

  it('ignores negative or malformed flags', () => {
    for (const q of ['?synthetic=', '?synthetic=false', '?synthetic=0', '?synthetic=a%20b', `?synthetic=${'x'.repeat(33)}`]) {
      expect(syntheticPresenceTag(q), q).toBe(null)
    }
  })
})

describe('clientPingQuery', () => {
  const ping = { tab: 'tab_1', tz: 'Asia/Singapore', page: '/desk', hidden: false, idle: false, closed: false, loc: null }
  it('carries synthetic when the tab is a harness load', () => {
    expect(clientPingQuery({ ...ping, synthetic: 'trace' }).get('synthetic')).toBe('trace')
  })
  it('an owner tab sends no synthetic field at all', () => {
    expect(clientPingQuery({ ...ping, synthetic: null }).has('synthetic')).toBe(false)
    expect(clientPingQuery({ ...ping, synthetic: null }).toString()).toBe('tab=tab_1&tz=Asia%2FSingapore&page=%2Fdesk&hidden=false&idle=false&closed=false')
  })
})

// Wiring test (checker nit 1, W1.1): pins that sendClientPing actually reads
// the tab's synthetic tag and puts it on the wire, not just that the two
// helper functions above behave correctly in isolation.
describe('sendClientPing (wiring)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('a harness tab\'s ping URL carries synthetic=trace', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k === 'agent_url' ? 'https://agent.example' : k === 'agent_secret' ? 'secret-value' : null),
    })
    // Load the tag onto the tab the way a harness page load does.
    syntheticPresenceTag('?synthetic=trace')
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ tabs: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchStub)

    await sendClientPing('/desk')

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const requestedUrl = fetchStub.mock.calls[0][0]
    expect(requestedUrl).toContain('synthetic=trace')
  })
})
