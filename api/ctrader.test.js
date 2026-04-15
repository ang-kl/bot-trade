// Integration tests for api/ctrader.js
//
// Mocks the `ws` module with a fake WebSocket so we can drive cTrader's
// request/response protocol in-process. Each test seeds the `wsQueue`
// with the payloads the handler should receive for each outbound send(),
// then invokes the Vercel-style handler with a mock req/res pair.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Shared mock state (must be declared BEFORE the vi.mock factory runs) ──
const wsState = vi.hoisted(() => ({
  queue: [],                // FIFO of responses to emit after each send()
  instances: [],            // every FakeWebSocket constructed in the test
  failNextOpen: false,      // force the next ws to error on open
}))

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1
    constructor(url) {
      super()
      this.url = url
      this.readyState = 1
      wsState.instances.push(this)
      if (wsState.failNextOpen) {
        wsState.failNextOpen = false
        setImmediate(() => this.emit('error', new Error('boom')))
        return
      }
      setImmediate(() => this.emit('open'))
    }
    send(raw) {
      const msg = JSON.parse(raw)
      if (msg.payloadType === 51) return // heartbeat
      const next = wsState.queue.shift()
      if (next == null) return
      const arr = Array.isArray(next) ? next : [next]
      for (const r of arr) {
        setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(r))))
      }
    }
    close() {
      this.readyState = 3
      this.emit('close')
    }
  }

  return { default: FakeWebSocket, WebSocket: FakeWebSocket }
})

// Import under test — AFTER vi.mock so the mocked `ws` is in place.
const { default: handler } = await import('./ctrader.js')

// ── Test helpers ──
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

function makeReq({ method = 'POST', body = {}, query = {}, origin } = {}) {
  return { method, body, query, headers: origin ? { origin } : {} }
}

// Shorthand: queue one or more sequential FakeWebSocket responses.
function enqueue(...responses) { wsState.queue.push(...responses) }

// Happy-path auth pair — every non-auth-only action opens with these.
const APP_AUTH_OK = { payloadType: 2101, payload: {} }
const ACCOUNT_AUTH_OK = { payloadType: 2103, payload: {} }

beforeEach(() => {
  wsState.queue.length = 0
  wsState.instances.length = 0
  wsState.failNextOpen = false
  process.env.CTRADER_CLIENT_ID = 'test-id'
  process.env.CTRADER_CLIENT_SECRET = 'test-secret'
  vi.restoreAllMocks()
})

// ── OAuth (REST) ─────────────────────────────────────────────────────────
describe('auth-url', () => {
  it('returns an auth URL using the request origin', async () => {
    const req = makeReq({ method: 'GET', query: { action: 'auth-url' }, origin: 'https://example.app' })
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.redirectUri).toBe('https://example.app/link-up')
    expect(res.body.url).toContain('client_id=test-id')
    expect(res.body.url).toContain(encodeURIComponent('https://example.app/link-up'))
  })

  it('rejects when no Origin header is supplied', async () => {
    const req = makeReq({ method: 'GET', query: { action: 'auth-url' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/Origin/)
  })

  it('returns 500 when CTRADER_CLIENT_ID is not configured', async () => {
    delete process.env.CTRADER_CLIENT_ID
    const req = makeReq({ method: 'GET', query: { action: 'auth-url' }, origin: 'https://x.app' })
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(500)
    expect(res.body.error).toMatch(/CTRADER_CLIENT_ID/)
  })
})

describe('exchange-token / refresh-token', () => {
  it('exchanges an auth code for tokens', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 }),
    })
    const req = makeReq({ body: { action: 'exchange-token', code: 'c', redirectUri: 'r' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 })
  })

  it('surfaces broker errors from the token endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ errorCode: 'INVALID_GRANT', description: 'expired' }),
    })
    const req = makeReq({ body: { action: 'exchange-token', code: 'c', redirectUri: 'r' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('expired')
  })

  it('refreshes with refresh-token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ access_token: 'at2', expires_in: 3600 }),
    })
    const req = makeReq({ body: { action: 'refresh-token', refreshToken: 'old' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.accessToken).toBe('at2')
    // When broker omits a new refresh token, the old one is echoed back.
    expect(res.body.refreshToken).toBe('old')
  })
})

// ── Accounts / Deals / Symbols / Trendbars (WebSocket) ──────────────────
describe('accounts', () => {
  it('returns normalised account list after app-auth + get-accounts', async () => {
    enqueue(APP_AUTH_OK)
    enqueue({
      payloadType: 2150,
      payload: {
        ctidTraderAccount: [
          { ctidTraderAccountId: 1, traderLogin: 5203012, brokerTitleShort: 'Pep',
            isLive: false, balance: { amount: 177903 }, depositCurrency: 'USD' },
        ],
      },
    })
    const res = makeRes()
    await handler(makeReq({ body: { action: 'accounts', accessToken: 'tok' } }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.accounts).toHaveLength(1)
    expect(res.body.accounts[0]).toMatchObject({
      accountNumber: 5203012, balance: 1779.03, currency: 'USD', isLive: false,
    })
  })
})

describe('deals', () => {
  it('converts closed-position deals and threads a running balance', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({
      payloadType: 2134,
      payload: {
        deal: [
          { dealId: 1, symbolId: 1, tradeSide: 'BUY', filledVolume: 100,
            executionPrice: 1.23, executionTimestamp: 1_700_000_000_000,
            closePositionDetail: { entryPrice: 1.20, grossProfit: 300, commission: 50, swap: 10 } },
          { dealId: 2, symbolId: 1, tradeSide: 'SELL', filledVolume: 100,
            executionPrice: 1.30, executionTimestamp: 1_700_000_100_000,
            closePositionDetail: { entryPrice: 1.32, grossProfit: -200, commission: 50, swap: 0 } },
          { dealId: 3, symbolId: 1, tradeSide: 'BUY', filledVolume: 100 }, // no closePositionDetail → filtered
        ],
      },
    })
    const res = makeRes()
    await handler(makeReq({ body: { action: 'deals', accessToken: 't', accountId: 1 } }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.trades).toHaveLength(2)
    expect(res.body.trades[0].netProfit).toBeCloseTo(2.4, 2)
    expect(res.body.trades[0].runningBalance).toBeCloseTo(2.4, 2)
    expect(res.body.trades[1].runningBalance).toBeCloseTo(-0.1, 2)
  })
})

describe('symbols', () => {
  it('filters by case-insensitive query and returns total count', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({
      payloadType: 2115,
      payload: {
        symbol: [
          { symbolId: 1, symbolName: 'EURUSD', description: 'Euro vs US Dollar', enabled: true },
          { symbolId: 2, symbolName: 'JPN225', description: 'Japan 225 index', enabled: true },
          { symbolId: 3, symbolName: 'BTCUSD', description: 'Bitcoin', enabled: false },
        ],
      },
    })
    const res = makeRes()
    await handler(
      makeReq({ body: { action: 'symbols', accessToken: 't', accountId: 1, query: 'usd' } }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.totalCount).toBe(3)
    expect(res.body.symbols.map(s => s.name)).toEqual(['EURUSD', 'BTCUSD'])
  })
})

describe('trendbars', () => {
  it('converts point-scaled OHLC to real prices', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({
      payloadType: 2138,
      payload: {
        trendbar: [
          // low=123400000 → 1234.0. deltaHigh 500 → 1234.005. deltaClose 200 → 1234.002.
          { low: 123_400_000, deltaOpen: 100, deltaHigh: 500, deltaClose: 200, volume: 42,
            utcTimestampInMinutes: 28_333_333 },
        ],
      },
    })
    const res = makeRes()
    await handler(
      makeReq({ body: { action: 'trendbars', accessToken: 't', accountId: 1, symbolId: 1, timeframe: '1h' } }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.candles).toHaveLength(1)
    const c = res.body.candles[0]
    expect(c.l).toBeCloseTo(1234.0, 6)
    expect(c.h).toBeCloseTo(1234.005, 6)
    expect(c.o).toBeCloseTo(1234.001, 6)
    expect(c.c).toBeCloseTo(1234.002, 6)
    expect(c.v).toBe(42)
  })

  it('rejects unknown timeframes before touching the network', async () => {
    const res = makeRes()
    await handler(
      makeReq({ body: { action: 'trendbars', accessToken: 't', accountId: 1, symbolId: 1, timeframe: '2y' } }),
      res,
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/Unknown timeframe/)
    expect(wsState.instances).toHaveLength(0)
  })
})

// ── Place / Amend / Close — the risky actions ───────────────────────────
describe('place-order safety gates', () => {
  const baseBody = {
    action: 'place-order', accessToken: 't', accountId: 1, symbolId: 1,
    tradeSide: 'BUY', volume: 100, stopLossDistance: 10,
  }

  it('blocks live accounts without liveConfirm', async () => {
    const res = makeRes()
    await handler(makeReq({ body: { ...baseBody, isLive: true } }), res)
    expect(res.statusCode).toBe(403)
    expect(res.body.error).toMatch(/liveConfirm/)
    expect(wsState.instances).toHaveLength(0)
  })

  it('rejects non-positive volume', async () => {
    const res = makeRes()
    await handler(makeReq({ body: { ...baseBody, volume: 0 } }), res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/volume/)
  })

  it('rejects volume above the 100k cap', async () => {
    const res = makeRes()
    await handler(makeReq({ body: { ...baseBody, volume: 200_000 } }), res)
    expect(res.statusCode).toBe(400)
  })

  it('requires a stopLoss OR stopLossDistance', async () => {
    const res = makeRes()
    await handler(makeReq({ body: { ...baseBody, stopLossDistance: undefined } }), res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/stopLoss/)
  })

  it('rejects an invalid trade side', async () => {
    const res = makeRes()
    await handler(makeReq({ body: { ...baseBody, tradeSide: 'HOLD' } }), res)
    expect(res.statusCode).toBe(400)
  })

  it('requires a symbolId', async () => {
    const res = makeRes()
    await handler(makeReq({ body: { ...baseBody, symbolId: undefined } }), res)
    expect(res.statusCode).toBe(400)
  })

  it('requires limitPrice on a LIMIT order', async () => {
    const res = makeRes()
    await handler(makeReq({
      body: { ...baseBody, orderType: 'LIMIT', stopLoss: 60000, stopLossDistance: undefined },
    }), res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/limitPrice/)
  })
})

describe('place-order happy path', () => {
  it('returns executionPrice and positionId from the EXECUTION_EVENT', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({
      payloadType: 2126,
      payload: {
        executionType: 'ORDER_FILLED',
        deal: { dealId: 999, executionPrice: 67245.5, positionId: 42 },
        position: { positionId: 42 },
        order: {},
      },
    })
    const res = makeRes()
    await handler(makeReq({
      body: {
        action: 'place-order', accessToken: 't', accountId: 1, symbolId: 1,
        tradeSide: 'BUY', volume: 100, stopLossDistance: 500,
      },
    }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.executionPrice).toBe(67245.5)
    expect(res.body.positionId).toBe(42)
    expect(res.body.dealId).toBe(999)
  })

  it('ignores the placeholder 0 executionPrice from ORDER_ACCEPTED', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({
      payloadType: 2126,
      payload: {
        executionType: 'ORDER_ACCEPTED',
        deal: { dealId: 1, executionPrice: 0 },
        position: { positionId: 7, price: 1234.5 },
        order: { executionPrice: 0 },
      },
    })
    const res = makeRes()
    await handler(makeReq({
      body: {
        action: 'place-order', accessToken: 't', accountId: 1, symbolId: 1,
        tradeSide: 'SELL', volume: 100, stopLossDistance: 1,
      },
    }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.executionPrice).toBe(1234.5)
  })

  it('bubbles ORDER_ERROR_EVENT up as a 500 with the broker error message', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({
      payloadType: 2132,
      payload: { errorCode: 'NOT_ENOUGH_MONEY', description: 'insufficient margin', orderId: 3 },
    })
    const res = makeRes()
    await handler(makeReq({
      body: {
        action: 'place-order', accessToken: 't', accountId: 1, symbolId: 1,
        tradeSide: 'BUY', volume: 100, stopLossDistance: 1,
      },
    }), res)
    expect(res.statusCode).toBe(500)
    expect(res.body.error).toMatch(/NOT_ENOUGH_MONEY/)
  })
})

describe('amend-position', () => {
  it('requires at least one of stopLoss or takeProfit', async () => {
    const res = makeRes()
    await handler(makeReq({
      body: { action: 'amend-position', accessToken: 't', accountId: 1, positionId: 42 },
    }), res)
    expect(res.statusCode).toBe(400)
  })

  it('succeeds and echoes the new SL/TP levels', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({
      payloadType: 2126,
      payload: { executionType: 'POSITION_AMENDED', position: { stopLoss: 100, takeProfit: 200 } },
    })
    const res = makeRes()
    await handler(makeReq({
      body: { action: 'amend-position', accessToken: 't', accountId: 1, positionId: 42, stopLoss: 100 },
    }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.stopLoss).toBe(100)
    expect(res.body.takeProfit).toBe(200)
  })

  it('returns alreadyClosed when the position vanished before the amend', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({ payloadType: 2142, payload: { errorCode: 'POSITION_NOT_FOUND', description: 'gone' } })
    const res = makeRes()
    await handler(makeReq({
      body: { action: 'amend-position', accessToken: 't', accountId: 1, positionId: 42, stopLoss: 100 },
    }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.alreadyClosed).toBe(true)
    expect(res.body.success).toBe(false)
  })
})

describe('close-position', () => {
  it('requires positionId and volume', async () => {
    const r1 = makeRes()
    await handler(makeReq({ body: { action: 'close-position', accessToken: 't', accountId: 1, volume: 100 } }), r1)
    expect(r1.statusCode).toBe(400)

    const r2 = makeRes()
    await handler(makeReq({ body: { action: 'close-position', accessToken: 't', accountId: 1, positionId: 42 } }), r2)
    expect(r2.statusCode).toBe(400)
  })

  it('returns alreadyClosed (success:true) on POSITION_NOT_FOUND', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({ payloadType: 2142, payload: { errorCode: 'POSITION_NOT_FOUND', description: 'gone' } })
    const res = makeRes()
    await handler(makeReq({
      body: { action: 'close-position', accessToken: 't', accountId: 1, positionId: 42, volume: 100 },
    }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ success: true, alreadyClosed: true, positionId: 42 })
  })

  it('closes and returns the fill price', async () => {
    enqueue(APP_AUTH_OK)
    enqueue(ACCOUNT_AUTH_OK)
    enqueue({
      payloadType: 2126,
      payload: {
        executionType: 'ORDER_FILLED',
        deal: { dealId: 5, executionPrice: 68100,
                closePositionDetail: { grossProfit: 500, commission: 20, swap: 10 } },
        position: { positionId: 42 },
      },
    })
    const res = makeRes()
    await handler(makeReq({
      body: { action: 'close-position', accessToken: 't', accountId: 1, positionId: 42, volume: 100 },
    }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.closePrice).toBe(68100)
    expect(res.body.netProfit).toBeCloseTo(4.7, 2)
  })
})

// ── Misc ────────────────────────────────────────────────────────────────
describe('misc', () => {
  it('returns 400 for an unknown action', async () => {
    const res = makeRes()
    await handler(makeReq({ body: { action: 'teleport' } }), res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/Invalid action/)
  })

  it('rejects open-positions when credentials are missing', async () => {
    delete process.env.CTRADER_CLIENT_ID
    const res = makeRes()
    await handler(makeReq({ body: { action: 'open-positions', accessToken: 't', accountId: 1 } }), res)
    expect(res.statusCode).toBe(500)
    expect(res.body.error).toMatch(/credentials not configured/)
  })
})
