import { afterEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./agent-api.js', () => ({ agentGet: mocks.get, agentConfigured: () => true }))
vi.mock('react', () => ({ useSyncExternalStore: (subscribe, snapshot) => { subscribe(() => {}); return snapshot() } }))
vi.mock('./selected-account.js', () => ({ writeSelection: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); mocks.get.mockReset() })

test('header currency follows the selected account, rejects late foreign reads and clears unknowns', async () => {
  vi.useFakeTimers()
  let selected = 11, balance = 100
  const reads = new Map()
  vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ selectedAccountId: selected,
    accounts: [{ accountId: selected, balance }] }) })
  mocks.get.mockImplementation(path => {
    if (path === '/state/accounts') return Promise.resolve({ selectedAccountId: selected })
    if (path === '/state/account-phases') return Promise.resolve({})
    return new Promise(resolve => reads.set(path, resolve))
  })
  const { useActiveAccount } = await import('./use-active-account.js')
  const settle = async () => { await Promise.resolve(); await Promise.resolve() }
  useActiveAccount(); await settle()
  expect(reads.has('/state/broker-cache?account=11')).toBe(true)
  reads.get('/state/broker-cache?account=11')({ snapshot: { account: { accountId: 11, currency: 'SGD', positions: [] } } })
  await settle(); expect(useActiveAccount().ccy).toBe('SGD')
  // Start another read, then switch before its response arrives.
  await vi.advanceTimersByTimeAsync(30000)
  const late = reads.get('/state/broker-cache?account=11')
  selected = 22; balance = 200
  await vi.advanceTimersByTimeAsync(2000)
  expect(useActiveAccount().ccy).toBe(null)
  late({ snapshot: { account: { accountId: 11, currency: 'SGD' } } })
  await settle(); expect(useActiveAccount().ccy).toBe(null)
  await vi.advanceTimersByTimeAsync(28000)
  reads.get('/state/broker-cache?account=22')({ snapshot: { account: { accountId: 22, currency: 'USD' } } })
  await settle(); expect(useActiveAccount().ccy).toBe('USD')
  await vi.advanceTimersByTimeAsync(30000)
  reads.get('/state/broker-cache?account=22')({ snapshot: { account: { accountId: 11, currency: 'SGD' } } })
  await settle(); expect(useActiveAccount().ccy).toBe(null)
  expect(mocks.get.mock.calls.every(([path]) => path !== '/state/broker-cache')).toBe(true)
})
