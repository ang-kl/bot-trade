import test from 'node:test'
import assert from 'node:assert/strict'
import { partialPositionEvidence, partialQuoteEvidence, partialClosingEvidence, partialAcceptedEvidence,
  partialPositionPresence, partialDealHistoryEvidence, matchClosingDeal, closingDealsSince, classifyCloseFailure } from './momentum-broker-evidence.js'

const identity = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' }
const now = 1790264000000
// T2: the closing decoder compares the deal's entry with the plan's in ticks,
// so its context carries the plan's digits (the manager and rank exit pass them).
const context = { identity, positionId: '33', side: 'BUY', entry: 100, digits: 2, closeVolume: 2600, attemptedAtMs: now - 100, nowMs: now, maxAgeMs: 5000 }
const position = { positionId: '33', positionStatus: 'POSITION_STATUS_OPEN', price: 100, stopLoss: 95, takeProfit: 140.4,
  tradeData: { symbolId: '22', tradeSide: 'BUY', volume: 10000 } }
const event = { ctidTraderAccountId: '11', executionType: 'ORDER_FILLED', deal: {
  dealId: '44', orderId: '55', positionId: '33', symbolId: '22', dealStatus: 'FILLED',
  tradeSide: 'SELL', volume: 2600, filledVolume: 2600, executionTimestamp: now - 10,
  executionPrice: 130.4, closePositionDetail: { entryPrice: 100, closedVolume: 2600 },
} }

test('position evidence requires account envelope, unique position and exact instrument on both hosts', () => {
  for (const host of ['demo.ctraderapi.com', 'live.ctraderapi.com']) {
    const c = { ...context, identity: { ...identity, host } }
    const p = partialPositionEvidence({ ctidTraderAccountId: '11', position: [position] }, c)
    assert.equal(p.accountId, '11'); assert.equal(p.volume, 10000); assert.equal(p.side, 'BUY')
  }
  for (const raw of [{ position: [position] }, { ctidTraderAccountId: '12', position: [position] },
    { ctidTraderAccountId: '11', position: [position, position] },
    { ctidTraderAccountId: '11', position: [{ ...position, tradeData: { ...position.tradeData, symbolId: '23' } }] }]) {
    assert.equal(partialPositionEvidence(raw, context), null)
  }
})

test('initial subscription receipt cannot make a stale broker quote fresh', () => {
  const raw = { ctidTraderAccountId: '11', symbolId: '22', bid: 13040000, ask: 13060000, timestamp: now - 200 }
  const q = partialQuoteEvidence(raw, context)
  assert.equal(q.bid, 130.4); assert.equal(q.observedAtMs, now - 200); assert.equal(q.receivedAtMs, now)
  for (const patch of [{ timestamp: undefined }, { timestamp: now - 5001 }, { timestamp: now + 1 },
    { ctidTraderAccountId: '12' }, { symbolId: '23' }, { bid: null }, { ask: '13060000' }]) {
    assert.equal(partialQuoteEvidence({ ...raw, ...patch }, context), null)
  }
})

test('closing receipt proves account, position, direction, filled volume and this attempt time', () => {
  const r = partialClosingEvidence(event, context)
  assert.equal(r.dealId, '44'); assert.equal(r.closedVolume, 2600); assert.equal(r.executedAtMs, now - 10)
  for (const patch of [{ positionId: '34' }, { symbolId: '23' }, { tradeSide: 'BUY' },
    { dealStatus: 'REJECTED' }, { filledVolume: 2500 }, { executionTimestamp: now - 1000 },
    { executionTimestamp: now + 1 }, { closePositionDetail: null },
    { closePositionDetail: { entryPrice: 99, closedVolume: 2600 } }]) {
    assert.equal(partialClosingEvidence({ ...event, deal: { ...event.deal, ...patch } }, context), null)
  }
  for (const patch of [{ ctidTraderAccountId: '12' }, { executionType: 'ORDER_ACCEPTED' }, { alreadyClosed: true }]) {
    assert.equal(partialClosingEvidence({ ...event, ...patch }, context), null)
  }
})

// T2 (left for T2 by T1): the deal's entry and the plan's are one grid price
// written by different producers, compared in ticks; a tick away, or no
// digits to compare with, proves nothing.
test('closing receipt compares the entry in ticks at the plan\'s digits', () => {
  const at = entryPrice => ({ ...event, deal: { ...event.deal, closePositionDetail: { entryPrice, closedVolume: 2600 } } })
  assert.equal(partialClosingEvidence(at(100.00000000000001), context).dealId, '44')
  assert.equal(partialClosingEvidence(at(99.99999999999999), context).dealId, '44')
  assert.equal(partialClosingEvidence(at(100.01), context), null)
  const { digits: _omitted, ...noDigits } = context
  assert.equal(partialClosingEvidence(event, noDigits), null)
})

test('an ORDER_ACCEPTED close proves only its order id, for this account, position, side and volume', () => {
  const accepted = { ctidTraderAccountId: '11', executionType: 'ORDER_ACCEPTED',
    order: { orderId: 77, positionId: 33, closingOrder: true, tradeData: { symbolId: 22, tradeSide: 'SELL', volume: 2600 } } }
  for (const shape of [accepted, { ...accepted, executionType: 2 }, { ...accepted, order: { orderId: '77', positionId: '33' } },
    { ...accepted, order: { orderId: 77 }, position: { positionId: 33 } }]) {
    const a = partialAcceptedEvidence(shape, context)
    assert.equal(a.orderId, '77'); assert.equal(a.orderAccepted, true); assert.equal(a.accountId, '11')
  }
  for (const bad of [{ ctidTraderAccountId: '12' }, { executionType: 'ORDER_FILLED' }, { alreadyClosed: true },
    { order: { ...accepted.order, orderId: null } }, { order: { ...accepted.order, positionId: 34 } },
    { order: { ...accepted.order, tradeData: { ...accepted.order.tradeData, volume: 2500 } } },
    { order: { ...accepted.order, tradeData: { ...accepted.order.tradeData, tradeSide: 'BUY' } } },
    { order: { ...accepted.order, tradeData: { ...accepted.order.tradeData, symbolId: 23 } } }]) {
    assert.equal(partialAcceptedEvidence({ ...accepted, ...bad }, context), null, JSON.stringify(bad))
  }
})

test('presence: an account-scoped list without the id proves absence; anything ambiguous proves nothing', () => {
  const absent = partialPositionPresence({ ctidTraderAccountId: '11', position: [{ ...position, positionId: '34' }] }, context)
  assert.equal(absent.absent, true); assert.equal(absent.positionId, '33'); assert.equal(absent.observedAtMs, now)
  const unprotected = partialPositionPresence({ ctidTraderAccountId: '11', position: [{ ...position, takeProfit: 0, tradeData: { ...position.tradeData, volume: 7400 } }] }, context)
  assert.equal(unprotected.absent, false); assert.equal(unprotected.volume, 7400); assert.equal(unprotected.takeProfit, null)
  for (const raw of [{ position: [] }, { ctidTraderAccountId: '12', position: [] }, { ctidTraderAccountId: '11' },
    { ctidTraderAccountId: '11', position: [position, position] }]) {
    assert.equal(partialPositionPresence(raw, context), null, JSON.stringify(raw))
  }
})

test('deal history: complete, account-scoped pages only; matching needs the order id and exactly one deal', () => {
  const closing = { ...event.deal, dealId: 44, orderId: 55, executionTimestamp: now - 50 }
  const page = extra => ({ ctidTraderAccountId: '11', deal: [{ dealId: 1, orderId: 2, positionId: 33, symbolId: 22, tradeSide: 'BUY',
    dealStatus: 2, volume: 10000, filledVolume: 10000, executionPrice: 100, executionTimestamp: now - 9000 }, closing], hasMore: false, ...extra })
  const h = partialDealHistoryEvidence(page(), context)
  assert.equal(h.closing.length, 1, 'the opening deal is not a closing deal')
  const want = { orderId: '55', side: 'BUY', entry: 100, digits: 2, closeVolume: 2600, attemptedAtMs: now - 100, nowMs: now }
  const found = matchClosingDeal(h, want)
  assert.equal(found.count, 1); assert.equal(found.receipt.dealId, '44'); assert.equal(found.receipt.source, 'deal_history')
  assert.equal(matchClosingDeal(h, { ...want, orderId: '56' }).count, 0)
  assert.equal(matchClosingDeal(h, { ...want, orderId: null }).count, 0, 'no order id, no attribution')
  assert.equal(matchClosingDeal(h, { ...want, closeVolume: 2500 }).count, 0)
  assert.equal(matchClosingDeal(partialDealHistoryEvidence(page({ deal: [closing, { ...closing, dealId: 45 }] }), context), want).count, 2)
  assert.deepEqual(closingDealsSince(h, now - 100).map(d => d.dealId), ['44'])
  assert.deepEqual(closingDealsSince(h, now + 10_000).map(d => d.dealId), [])
  for (const bad of [{ hasMore: true }, { hasMore: undefined }, { ctidTraderAccountId: '12' }, { deal: {} }, { errorCode: 'X' }]) {
    assert.equal(partialDealHistoryEvidence(page(bad), context), null, JSON.stringify(bad))
  }
})

test('a failed close is classified by what it proves', () => {
  const json = (code, description = 'd') => Error(JSON.stringify({ description, errorCode: code }))
  const cases = [
    [Object.assign(Error('partial broker identity changed'), { notSent: true }), 'not_sent'],
    [json('NOT_CONNECTED', 'websocket is not connected'), 'not_sent'],
    [json('guard_no_account'), 'not_sent'],
    [Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'not_sent'],
    [json('CH_ACCESS_TOKEN_INVALID'), 'not_sent'],
    // The production shape (/state/momentum-account, 24-09 21:05 UTC).
    [json('MARKET_CLOSED', 'Trading is not available: Market is closed.'), 'rejected'],
    [Error('cTrader order rejected: TRADING_BAD_VOLUME — volume'), 'rejected'],
    [json('POSITION_NOT_FOUND'), 'already_closed'],
    [Error('POSITION_NOT_FOUND: position 1000 unknown'), 'already_closed'],
    [json('TIMEOUT', 'no payloadType 2126 within 20000ms'), 'ambiguous'],
    [json('DISCONNECTED'), 'ambiguous'], [json('SEND_FAILED'), 'ambiguous'],
    [Error('cTrader WS timeout after 20000ms — expecting 2126 after sending 2111'), 'ambiguous'],
    [Error('The operation was aborted due to timeout'), 'ambiguous'],
    [Object.assign(Error('socket'), { cause: { code: 'ECONNRESET' } }), 'ambiguous'],
    [Error('broker request deadline exceeded'), 'ambiguous'],
  ]
  for (const [error, kind] of cases) assert.equal(classifyCloseFailure(error).kind, kind, error.message)
  assert.equal(classifyCloseFailure(json('MARKET_CLOSED')).code, 'MARKET_CLOSED')
})
