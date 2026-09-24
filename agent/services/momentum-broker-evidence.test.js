import test from 'node:test'
import assert from 'node:assert/strict'
import { partialPositionEvidence, partialQuoteEvidence, partialClosingEvidence } from './momentum-broker-evidence.js'

const identity = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' }
const now = 1790264000000
const context = { identity, positionId: '33', side: 'BUY', entry: 100, closeVolume: 2600, attemptedAtMs: now - 100, nowMs: now, maxAgeMs: 5000 }
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
