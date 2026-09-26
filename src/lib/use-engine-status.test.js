// S1a: engineRowFor's readiness join must survive BOTH shapes GET
// /state/tick-readiness answers — the roster form `{ accounts: [...] }`
// and the `?account=` narrowed single record with no `accounts` field at
// all (agent/services/tick-readiness.js: tickReadinessView vs
// tickReadinessFor). The join goes through the row's OWN routingAccountId,
// never a tail-4 substring, so it cannot join account A's row to account B's
// readiness merely because their suffixes are shared.
import { describe, it, test, expect, afterEach, vi } from 'vitest'
import { engineRowFor } from './use-engine-status.js'

// Checker BLOCKER 1 (W1.4 fix round): with the viewed-account lens on,
// /state/tick-readiness must still answer for EVERY account, not just the
// one being viewed — the lens narrows every other /state read, but this
// panel shows the whole roster regardless of which account is being traded.
// A bare `/state/tick-readiness` would be narrowed by agent-api.js's
// withViewedAccount; `?account=all` is explicit and wins over the lens
// (viewed-account.test.js already pins that mechanism generically — this
// test pins that use-engine-status.js actually SENDS that explicit form,
// and that all 3 rows come back joined with their own readiness).
const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./agent-api.js', () => ({
  agentGet: mocks.get, agentConfigured: () => true, pageAsleep: () => false,
}))
afterEach(() => { mocks.get.mockReset() })

test('refreshEngineStatus asks for every account (?account=all), so all 3 rows show their readiness even with the lens on another account', async () => {
  const enginesReply = { accounts: [
    { accountId: '…9908', routingAccountId: '46979908', effectiveEntryMode: 'TIME_BASED' },
    { accountId: '…3489', routingAccountId: '42993489', effectiveEntryMode: 'TIME_BASED' },
    { accountId: '…0058', routingAccountId: '46130058', effectiveEntryMode: 'TIME_BASED' },
  ] }
  // The roster shape tick-readiness answers for `?account=all` — as it would
  // for the viewed account's OWN id too, which is exactly the case this
  // guards against: the lens must not narrow this call to one such record.
  const readinessReply = { accounts: [
    { accountId: '…9908', routingAccountId: '46979908', ready: true },
    { accountId: '…3489', routingAccountId: '42993489', ready: false, blockedReasons: ['x'] },
    { accountId: '…0058', routingAccountId: '46130058', ready: true },
  ] }
  mocks.get.mockImplementation(path => {
    if (path === '/state/entry-engines') return Promise.resolve(enginesReply)
    if (path === '/state/tick-readiness?account=all') return Promise.resolve(readinessReply)
    // Anything narrowed to one account (the lens applied) or unqualified is
    // wrong here and must not be what the panel joins against.
    return Promise.reject(new Error(`unexpected read: ${path}`))
  })
  const { refreshEngineStatus } = await import('./use-engine-status.js')
  await refreshEngineStatus()
  // The fix itself: the fetch must carry the explicit override, not the
  // bare path a lens would narrow.
  expect(mocks.get).toHaveBeenCalledWith('/state/tick-readiness?account=all')
  const calls = new Set(mocks.get.mock.calls.map(c => c[0]))
  expect(calls.has('/state/tick-readiness')).toBe(false)
  // And the roster answer that call gets back joins correctly for all 3
  // rows, each to its OWN readiness record — not one row shadowing another
  // via the tail-4 fallback (engineRowFor's `find`) once there are several
  // candidates in the readiness roster.
  const snap = { engines: enginesReply, readiness: readinessReply }
  for (const [id, ready] of [['46979908', true], ['42993489', false], ['46130058', true]]) {
    const joined = engineRowFor(snap, id)
    expect(joined).not.toBe(null)
    expect(joined.readiness?.ready).toBe(ready)
  }
})

function engines(accounts) { return { engines: { accounts } } }
const row = (id, o = {}) => ({ accountId: `…${id.slice(-4)}`, routingAccountId: id, effectiveEntryMode: 'TIME_BASED', ...o })

describe('engineRowFor', () => {
  it('joins readiness from the roster shape by exact identity', () => {
    const snap = { ...engines([row('46979908')]), readiness: { accounts: [{ accountId: '…9908', routingAccountId: '46979908', ready: true }] } }
    expect(engineRowFor(snap, '46979908').readiness.ready).toBe(true)
  })

  it('joins readiness from the narrowed single-record shape when it is this account', () => {
    const snap = { ...engines([row('46979908')]), readiness: { accountId: '…9908', routingAccountId: '46979908', ready: false, blockedReasons: ['x'] } }
    const joined = engineRowFor(snap, '46979908')
    expect(joined.readiness.ready).toBe(false)
    expect(joined.readiness.blockedReasons).toEqual(['x'])
  })

  it('reads null — no record — when the narrowed answer is for a different account, rather than crashing or matching by suffix', () => {
    const snap = { ...engines([row('46979908')]), readiness: { accountId: '…3489', routingAccountId: '42993489', ready: true } }
    expect(engineRowFor(snap, '46979908').readiness).toBe(null)
  })

  it('returns null for an unknown account and does not throw on a missing readiness answer', () => {
    const snap = engines([row('46979908')])
    expect(engineRowFor(snap, '46979908').readiness).toBe(null)
    expect(engineRowFor({ engines: null }, '46979908')).toBe(null)
    expect(engineRowFor(snap, null)).toBe(null)
  })
})
