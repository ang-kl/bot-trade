// V3 WEB-4: the page is no longer the broker poller. The hook is run with its
// real defaults against a mocked agent-api, so ANY broker request it makes —
// directly or through broker-overview.js, which posts via agentPost — shows up
// here. The server's own minute read is agent/services/broker-readings.js.
import { afterEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), set: vi.fn(), cleanup: null }))
vi.mock('./agent-api.js', () => ({
  agentGet: mocks.get, agentPost: mocks.post, agentConfigured: () => true, pageAsleep: () => false,
  getAgentConn: () => ({ base: 'http://agent', secret: 'test' }),
}))
vi.mock('react', () => ({
  useState: initial => [initial, mocks.set],
  useEffect: effect => { mocks.cleanup = effect() },
}))
afterEach(() => { vi.useRealTimers(); vi.resetModules(); mocks.get.mockReset(); mocks.post.mockReset(); mocks.set.mockReset() })

test('the page reads the cached overview every 10 s and never asks the broker', async () => {
  vi.useFakeTimers()
  const report = { accounts: [{ accountId: '11' }], serverReadings: { status: 'success', fresh: true } }
  mocks.get.mockResolvedValue(report)
  const { useAccountOverview, OVERVIEW_POLL_MS } = await import('./use-account-overview.js')
  expect(OVERVIEW_POLL_MS).toBe(10_000)
  useAccountOverview()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(mocks.get.mock.calls.length).toBeGreaterThanOrEqual(30)
  expect(new Set(mocks.get.mock.calls.map(c => c[0]))).toEqual(new Set(['/state/account-overview']))
  expect(mocks.set).toHaveBeenLastCalledWith(report)
  const n = mocks.get.mock.calls.length
  mocks.cleanup()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.get.mock.calls.length).toBe(n)
  // A broker read reached through a dynamic import() resolves on real module
  // I/O, which fake timers never wait for; let real time pass before judging.
  vi.useRealTimers()
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(mocks.post).not.toHaveBeenCalled()
})

test('a failed or malformed overview read clears the report instead of keeping an old one', async () => {
  vi.useFakeTimers()
  const { startOverviewPolling } = await import('./use-account-overview.js')
  const seen = []
  let reply = Promise.reject(new Error('offline'))
  reply.catch(() => {})
  const stop = startOverviewPolling(r => seen.push(r), { get: () => reply, asleep: () => false, configured: () => true })
  await vi.advanceTimersByTimeAsync(0)
  reply = Promise.resolve({ accounts: 'not-a-list' })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(seen).toEqual([null, null])
  stop()
})
