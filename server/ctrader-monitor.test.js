// Integration tests for server/ctrader-monitor.js
//
// Exercises the public API of the in-memory position monitor: register →
// tick → close → purge. The underlying WebSocket is mocked so we can drive
// close-position attempts deterministically with vitest's fake timers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Shared mock state hoisted above the vi.mock factory.
const wsState = vi.hoisted(() => ({
  queue: [],          // FIFO of per-send responses
  onSend: null,       // optional per-test spy
  failNextOpen: false,
}))

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1
    constructor(url) {
      super()
      this.url = url
      this.readyState = 1
      if (wsState.failNextOpen) {
        wsState.failNextOpen = false
        setImmediate(() => this.emit('error', new Error('ws-boom')))
        return
      }
      setImmediate(() => this.emit('open'))
    }
    send(raw) {
      const msg = JSON.parse(raw)
      if (wsState.onSend) wsState.onSend(msg)
      const next = wsState.queue.shift()
      if (next == null) return
      const arr = Array.isArray(next) ? next : [next]
      for (const r of arr) {
        setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(r))))
      }
    }
    close() { this.readyState = 3; this.emit('close') }
  }
  return { default: FakeWebSocket, WebSocket: FakeWebSocket }
})

// Seed env vars BEFORE the module imports. ctrader-monitor captures
// CLIENT_ID/CLIENT_SECRET at module load, so setting them in beforeEach
// has no effect.
process.env.CTRADER_CLIENT_ID = 'test-id'
process.env.CTRADER_CLIENT_SECRET = 'test-secret'

const monitor = await import('./ctrader-monitor.js')

// Happy-path cTrader handshake + close-position execution event.
const APP_AUTH_OK = { payloadType: 2101, payload: {} }
const ACCOUNT_AUTH_OK = { payloadType: 2103, payload: {} }
const CLOSED_EVENT = {
  payloadType: 2126,
  payload: { executionType: 'ORDER_FILLED', deal: { dealId: 1 }, position: { positionId: 99 } },
}

function seedCloseHappyPath() {
  wsState.queue.push(APP_AUTH_OK, ACCOUNT_AUTH_OK, CLOSED_EVENT)
}

beforeEach(() => {
  process.env.CTRADER_CLIENT_ID = 'test-id'
  process.env.CTRADER_CLIENT_SECRET = 'test-secret'
  wsState.queue.length = 0
  wsState.onSend = null
  wsState.failNextOpen = false
  monitor.stopMonitor() // reset tracked map + interval between tests
  monitor.setMonitorEventHandler(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  monitor.stopMonitor()
})

describe('registerMonitor', () => {
  it('stores a monitoring record with clamped monitorMinutes', () => {
    const r = monitor.registerMonitor({
      positionId: 99, accountId: 1, accessToken: 't', volume: 100,
      symbol: 'BTCUSD', monitorMinutes: 5,
    })
    expect(r.status).toBe('monitoring')
    expect(r.remainingMs).toBeGreaterThan(0)
    expect(monitor.listMonitors()).toHaveLength(1)
    expect(monitor.getMonitor(99).symbol).toBe('BTCUSD')
  })

  it('clamps or defaults monitorMinutes', () => {
    // 0 is falsy → module falls back to the 60-minute default, then clamps.
    const zero = monitor.registerMonitor({ positionId: 1, accountId: 1, accessToken: 't', monitorMinutes: 0 })
    // Negative is truthy → Math.max(1, …) clamps to 1 minute.
    const neg  = monitor.registerMonitor({ positionId: 3, accountId: 1, accessToken: 't', monitorMinutes: -5 })
    // Huge values are clamped to the 1440-minute (24-hour) ceiling.
    const high = monitor.registerMonitor({ positionId: 2, accountId: 1, accessToken: 't', monitorMinutes: 99_999 })
    expect(zero.monitorUntil - Date.now()).toBeGreaterThan(59 * 60_000)
    expect(neg.monitorUntil - Date.now()).toBeLessThanOrEqual(60_000 + 50)
    expect(high.monitorUntil - Date.now()).toBeLessThanOrEqual(1440 * 60_000 + 50)
    expect(high.monitorUntil - Date.now()).toBeGreaterThan(1439 * 60_000)
  })

  it('rejects missing required fields', () => {
    expect(() => monitor.registerMonitor({ accountId: 1, accessToken: 't' })).toThrow(/positionId/)
    expect(() => monitor.registerMonitor({ positionId: 1, accessToken: 't' })).toThrow(/accountId/)
    expect(() => monitor.registerMonitor({ positionId: 1, accountId: 1 })).toThrow(/accessToken/)
  })
})

describe('cancelMonitor', () => {
  it('marks a monitoring record as cancelled', () => {
    monitor.registerMonitor({ positionId: 10, accountId: 1, accessToken: 't' })
    const r = monitor.cancelMonitor(10)
    expect(r).toEqual({ ok: true, status: 'cancelled' })
    expect(monitor.getMonitor(10).status).toBe('cancelled')
  })

  it('returns not-tracked when the id is unknown', () => {
    expect(monitor.cancelMonitor(404)).toEqual({ ok: false, reason: 'not-tracked' })
  })
})

describe('tick loop', () => {
  it('closes expired positions and emits events', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    const events = []
    monitor.setMonitorEventHandler((e) => events.push(e))
    monitor.registerMonitor({
      positionId: 99, accountId: 1, accessToken: 't', volume: 100,
      symbol: 'BTCUSD', monitorMinutes: 1,
    })
    seedCloseHappyPath()

    // Advance past the monitorUntil timestamp and through the 10s tick.
    await vi.advanceTimersByTimeAsync(61 * 1000)
    // Let the async close-position promise flush.
    vi.useRealTimers()
    await new Promise(r => setTimeout(r, 30))

    const rec = monitor.getMonitor(99)
    expect(rec.status).toBe('closed')
    expect(rec.closeReason).toBe('monitor-expired')
    const types = events.map(e => e.type)
    expect(types).toContain('ctrader-monitor-closing')
    expect(types).toContain('ctrader-monitor-closed')
  })

  it('marks the record failed when the broker rejects the close', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    monitor.registerMonitor({
      positionId: 42, accountId: 1, accessToken: 't', volume: 100,
      symbol: 'EURUSD', monitorMinutes: 1,
    })
    // App auth succeeds, account auth succeeds, close returns an ERROR_RES.
    wsState.queue.push(APP_AUTH_OK, ACCOUNT_AUTH_OK, {
      payloadType: 2142,
      payload: { errorCode: 'POSITION_NOT_FOUND', description: 'already closed' },
    })

    await vi.advanceTimersByTimeAsync(61 * 1000)
    vi.useRealTimers()
    await new Promise(r => setTimeout(r, 30))

    const rec = monitor.getMonitor(42)
    expect(rec.status).toBe('failed')
    expect(rec.closeReason).toMatch(/POSITION_NOT_FOUND/)
  })

  it('does not touch records whose monitorUntil has not elapsed', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    monitor.registerMonitor({
      positionId: 7, accountId: 1, accessToken: 't', volume: 100, monitorMinutes: 10,
    })

    // Advance 30s — only three ticks, nowhere near 10 minutes.
    await vi.advanceTimersByTimeAsync(30 * 1000)
    vi.useRealTimers()
    await new Promise(r => setTimeout(r, 10))

    expect(monitor.getMonitor(7).status).toBe('monitoring')
    // And no WebSocket should have been created.
    // (We assert by checking the queue is still pristine.)
    expect(wsState.queue).toHaveLength(0)
  })

  it('purges closed records older than 10 minutes', async () => {
    // Stay on fake timers the whole way so the setInterval loop stays alive
    // across the closure + purge phases.
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    monitor.registerMonitor({
      positionId: 99, accountId: 1, accessToken: 't', volume: 100, monitorMinutes: 1,
    })
    seedCloseHappyPath()

    // Advance past monitorUntil; the tick closes the position and sets
    // closedAt. advanceTimersByTimeAsync also drains pending microtasks and
    // setImmediate (vitest fakes both by default in v3).
    await vi.advanceTimersByTimeAsync(61 * 1000)
    expect(monitor.getMonitor(99).status).toBe('closed')

    // Now advance another 11 minutes — the next tick should purge it.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000)

    expect(monitor.getMonitor(99)).toBeNull()
    expect(monitor.listMonitors()).toHaveLength(0)
  })
})

describe('stopMonitor', () => {
  it('clears tracked records and halts the loop', () => {
    monitor.registerMonitor({ positionId: 1, accountId: 1, accessToken: 't' })
    monitor.registerMonitor({ positionId: 2, accountId: 1, accessToken: 't' })
    expect(monitor.listMonitors()).toHaveLength(2)
    monitor.stopMonitor()
    expect(monitor.listMonitors()).toHaveLength(0)
  })
})

describe('setMonitorEventHandler', () => {
  it('falls back to a no-op when a non-function is supplied', () => {
    expect(() => monitor.setMonitorEventHandler(null)).not.toThrow()
    expect(() => monitor.setMonitorEventHandler('not-a-fn')).not.toThrow()
  })
})
