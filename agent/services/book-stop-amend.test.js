import test from 'node:test'
import assert from 'node:assert/strict'
import { amendBookStop } from './book-stop-amend.js'

test('fresh target survives the stop ratchet and an existing tighter stop is never lowered', async () => {
  let broker = { positionId: '7', stopLoss: 90, takeProfit: 140, tradeData: { tradeSide: 1 } }
  const sent = []
  const deps = { readPosition: async () => broker, amend: async (_c, args) => { sent.push(args); broker = { ...broker, ...args }; return { ok: true } } }
  const result = await amendBookStop({}, { positionId: '7', stopLoss: 100, side: 'long' }, deps)
  assert.equal(result.protection.verified, true)
  assert.equal(sent[0].takeProfit, 140)
  assert.equal((await amendBookStop({}, { positionId: '7', stopLoss: 95, side: 'long' }, deps)).unchanged, true)
  assert.equal(sent.length, 1)
})

test('a genuinely missing TP does not block an existing-policy SL improvement or invent a target', async () => {
  let broker = { positionId: '7', stopLoss: 110, tradeData: { tradeSide: 'SELL' } }
  const result = await amendBookStop({}, { positionId: '7', stopLoss: 105, side: 'short' }, {
    readPosition: async () => broker,
    amend: async (_c, args) => { assert.equal(args.takeProfit, null); broker = { ...broker, ...args }; return {} },
  })
  assert.equal(result.protection.stopLoss, 105)
  assert.equal(result.protection.takeProfit, null)
})

test('wrong identity, failed amendment and unconfirmed read-back never become verified updates', async () => {
  const row = { positionId: '7', stopLoss: 90, takeProfit: 140, tradeData: { tradeSide: 'BUY' } }
  const intent = { positionId: '7', stopLoss: 100, side: 'long' }
  let sends = 0
  await assert.rejects(amendBookStop({}, intent, { readPosition: async () => ({ ...row, positionId: '8' }), amend: async () => { sends++ } }), /identity/)
  assert.equal(sends, 0)
  await assert.rejects(amendBookStop({}, intent, { readPosition: async () => row, amend: async () => ({ error: 'TRADING_BAD_STOPS' }) }), /refused/)
  await assert.rejects(amendBookStop({}, intent, { readPosition: async () => row, amend: async () => ({ ok: true }) }), /not confirmed/)
})
