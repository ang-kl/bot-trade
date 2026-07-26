// node --test agent/services/held-prices.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshHeldPrices, midPrice } from './held-prices.js'
import { selectScanBatch } from './fib-strategy.js'

// ---- cheap price refresh ---------------------------------------------------

const map = { EURUSD: 1, XAUUSD: 2, GBPUSD: 3 }

test('midPrice: mean of bid/ask, tolerant of one side', () => {
  assert.equal(midPrice({ bid: 1.0, ask: 1.2 }), 1.1)
  assert.equal(midPrice({ bid: 1.0 }), 1.0)
  assert.equal(midPrice({ ask: 2.0 }), 2.0)
  assert.equal(midPrice(null), null)
  assert.equal(midPrice({}), null)
})

test('refreshHeldPrices: mid per held symbol via injected spot', async () => {
  const quotes = { 1: { bid: 1.10, ask: 1.12 }, 2: { bid: 2000, ask: 2002 } }
  const prices = await refreshHeldPrices({}, map, ['EURUSD', 'XAUUSD'], { getSpot: async (id) => quotes[id] })
  assert.deepEqual(prices, { EURUSD: 1.11, XAUUSD: 2001 })
})

test('refreshHeldPrices: a failed quote just drops that symbol, never throws', async () => {
  const prices = await refreshHeldPrices({}, map, ['EURUSD', 'GBPUSD'], {
    getSpot: async (id) => { if (id === 3) throw new Error('quote timeout'); return { bid: 1.1, ask: 1.1 } },
  })
  assert.deepEqual(prices, { EURUSD: 1.1 }) // GBPUSD dropped, no throw
})

test('refreshHeldPrices: unknown symbol id is skipped', async () => {
  const prices = await refreshHeldPrices({}, map, ['NOPE'], { getSpot: async () => ({ bid: 1, ask: 1 }) })
  assert.deepEqual(prices, {})
})

// ---- scan batch selection (the decouple that stops crowding) ---------------

const syms = (n) => Array.from({ length: n }, (_, i) => ({ symbol: `S${i}` }))

test('held symbols never crowd out new-setup coverage', () => {
  // 60 symbols, 25 held, batchSize 15 — the OLD logic would scan 25 held and
  // rotate ZERO fresh (frozen coverage). Now: 15 fresh candidates, and the
  // cursor advances by 15 through the 35 non-held so the rest get covered next.
  const held = Array.from({ length: 25 }, (_, i) => `S${i}`) // S0..S24 held
  const { batch, nextCursor } = selectScanBatch(syms(60), { heldSymbols: held, batchSize: 15, cursor: 0 })
  assert.equal(batch.length, 15, 'a full fresh batch every run')
  assert.ok(batch.every(b => !held.includes(b.symbol)), 'no held symbol in the heavy scan')
  assert.equal(nextCursor, 15, 'cursor advanced by the fresh count')
})

test('cursor rotates through the whole non-held list and wraps', () => {
  const s = syms(10)
  const r1 = selectScanBatch(s, { batchSize: 4, cursor: 0 })
  assert.deepEqual(r1.batch.map(b => b.symbol), ['S0', 'S1', 'S2', 'S3'])
  assert.equal(r1.nextCursor, 4)
  const r2 = selectScanBatch(s, { batchSize: 4, cursor: r1.nextCursor })
  assert.deepEqual(r2.batch.map(b => b.symbol), ['S4', 'S5', 'S6', 'S7'])
  const r3 = selectScanBatch(s, { batchSize: 4, cursor: r2.nextCursor })
  assert.deepEqual(r3.batch.map(b => b.symbol), ['S8', 'S9', 'S0', 'S1']) // wraps
})

test('all symbols held → empty heavy batch, no crash', () => {
  const r = selectScanBatch(syms(3), { heldSymbols: ['S0', 'S1', 'S2'], batchSize: 15 })
  assert.deepEqual(r.batch, [])
  assert.equal(r.nextCursor, 0)
  assert.equal(r.restCount, 0)
})

// ---- spike-priority boost (owner: "when market volume spike, check
// immediately") — a flagged symbol jumps the rotation queue -------------

test('prioritySpikeSymbols: empty list is a pure no-op, identical to before', () => {
  const s = syms(10)
  const withEmpty = selectScanBatch(s, { batchSize: 4, cursor: 3, prioritySpikeSymbols: [] })
  const without = selectScanBatch(s, { batchSize: 4, cursor: 3 })
  assert.deepEqual(withEmpty, without)
})

test('prioritySpikeSymbols: a flagged symbol jumps to the front of the batch', () => {
  const s = syms(10) // S0..S9, cursor 0 would normally start at S0
  const r = selectScanBatch(s, { batchSize: 4, cursor: 0, prioritySpikeSymbols: ['S7'] })
  assert.deepEqual(r.batch.map(b => b.symbol), ['S7', 'S0', 'S1', 'S2'], 'spiked symbol first, rotation fills the rest')
})

test('prioritySpikeSymbols: capped at batchSize — a spike burst cannot crowd out rotation entirely', () => {
  const s = syms(10)
  const r = selectScanBatch(s, { batchSize: 3, cursor: 0, prioritySpikeSymbols: ['S1', 'S2', 'S3', 'S4', 'S5'] })
  assert.equal(r.batch.length, 3)
  assert.deepEqual(r.batch.map(b => b.symbol), ['S1', 'S2', 'S3'], 'only the first batchSize spiked symbols ride this round')
})

test('prioritySpikeSymbols: held symbols are still excluded even if also flagged as spiking', () => {
  const s = syms(5)
  const r = selectScanBatch(s, { heldSymbols: ['S1'], batchSize: 4, cursor: 0, prioritySpikeSymbols: ['S1', 'S2'] })
  assert.ok(!r.batch.some(b => b.symbol === 'S1'), 'held symbol never enters the heavy batch, spike flag or not')
  assert.equal(r.batch[0].symbol, 'S2', 'the non-held spike flag still jumps the queue')
})

test('prioritySpikeSymbols: cursor still advances correctly through the rotation pool, excluding boosted symbols', () => {
  const s = syms(10)
  const r1 = selectScanBatch(s, { batchSize: 4, cursor: 0, prioritySpikeSymbols: ['S5'] })
  assert.deepEqual(r1.batch.map(b => b.symbol), ['S5', 'S0', 'S1', 'S2'])
  assert.equal(r1.nextCursor, 3, 'cursor advanced by the 3 rotation slots actually consumed, over the 9-symbol pool (S5 removed)')
  const r2 = selectScanBatch(s, { batchSize: 4, cursor: r1.nextCursor })
  assert.deepEqual(r2.batch.map(b => b.symbol), ['S3', 'S4', 'S5', 'S6'], 'next run resumes rotation over the FULL list once the flag is gone')
})
