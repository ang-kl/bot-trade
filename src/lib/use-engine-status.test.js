// S1a: engineRowFor's readiness join must survive BOTH shapes GET
// /state/tick-readiness answers — the roster form `{ accounts: [...] }`
// and the `?account=` narrowed single record with no `accounts` field at
// all (agent/services/tick-readiness.js: tickReadinessView vs
// tickReadinessFor). The join goes through the row's OWN routingAccountId,
// never a tail-4 substring, so it cannot join account A's row to account B's
// readiness merely because their suffixes are shared.
import { describe, it, expect } from 'vitest'
import { engineRowFor } from './use-engine-status.js'

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
