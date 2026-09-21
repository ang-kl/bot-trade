import { describe, it, expect } from 'vitest'
import { createBrokerViewGuard } from './broker-view.js'

describe('broker viewing scope', () => {
  it('rejects delayed foreign responses and an old A response after A -> B -> A', () => {
    let id = 11
    const capture = createBrokerViewGuard(() => id)
    const first = capture()
    expect(first.matches({ accountId: '11' })).toBe(true)
    expect(first.matches({ accountId: 22 })).toBe(false)
    expect(capture().changed).toBe(false)
    expect(first.current()).toBe(true)
    first.markLive()
    expect(capture().acceptsCache()).toBe(false)
    id = 22
    expect(first.current()).toBe(false)
    expect(capture().changed).toBe(true)
    id = 11
    const returned = capture()
    expect(returned.current()).toBe(true)
    expect(returned.acceptsCache()).toBe(true)
    expect(first.current()).toBe(false)
    id = 'all'
    expect(capture().single).toBe(false)
  })
})
