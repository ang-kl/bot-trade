import { expect, it } from 'vitest'
import { createOverviewReader } from './broker-overview.js'
it('shares slow broker reads and completed results, but isolates credentials and expires', async () => {
  let now = 100, calls = 0, resolve
  const read = createOverviewReader(() => { calls++; return new Promise(r => { resolve = r }) }, { now: () => now })
  const a = read('operator-A'), b = read('operator-A')
  expect(a).toBe(b)
  await Promise.resolve(); expect(calls).toBe(1)
  now += 90000; expect(read('operator-A')).toBe(a)
  resolve({ ok: true, accounts: [{ accountId: '11' }, { accountId: '22' }] })
  expect((await a).accounts).toHaveLength(2)
  now += 59000; expect(read('operator-A')).toBe(a)
  const c = read('operator-B'); await Promise.resolve(); expect(calls).toBe(2)
  resolve({ ok: true, accounts: [] }); await c
  now += 1001; const d = read('operator-A'); await Promise.resolve(); expect(calls).toBe(3)
  resolve({ ok: true, accounts: [] }); await d
})
it('rejects a missing broker response without turning it into an empty account list', async () => {
  await expect(createOverviewReader(async () => ({ error: 'unavailable' }))('one')).rejects.toThrow('Broker snapshot unavailable')
})
