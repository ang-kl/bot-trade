import test from 'node:test'
import assert from 'node:assert/strict'
import { amendBookStop, freshBookProtection } from './book-stop-amend.js'

test('fresh target survives the stop ratchet and an existing tighter stop is never lowered', async () => {
  let broker = { positionId: '7', stopLoss: 90, takeProfit: 140, tradeData: { tradeSide: 1 } }
  const sent = []
  const deps = { readPosition: async () => broker, amend: async (_c, args) => { sent.push(args); broker = { ...broker, ...args }; return { ok: true } } }
  const result = await amendBookStop({}, { positionId: '7', stopLoss: 100, side: 'long' }, deps)
  assert.equal(result.protection.verified, true)
  assert.equal(result.protection.confirmation, 'amend_readback')
  assert.equal(freshBookProtection(result.protection), true)
  assert.equal(sent[0].takeProfit, 140)
  assert.equal((await amendBookStop({}, { positionId: '7', stopLoss: 95, side: 'long' }, deps)).unchanged, true)
  assert.equal(sent.length, 1)
})

test('already tighter means a dated broker snapshot, with no amendment or amendment claim', async () => {
  let clock = 100_000, reads = 0, amends = 0
  const result = await amendBookStop({}, { positionId: '7', stopLoss: 100, side: 'long' }, {
    now: () => clock, clock: () => clock,
    readPosition: async () => { reads++; clock += 100; return { positionId: '7', stopLoss: 105, takeProfit: 140, tradeData: { tradeSide: 1 } } },
    amend: async () => { amends++ },
  })
  assert.equal(reads, 1)
  assert.equal(amends, 0)
  assert.equal(result.unchanged, true)
  assert.equal(result.protection.confirmation, 'already_tighter_snapshot')
  assert.equal(result.protection.checkedAtMs, 100_100)
  assert.equal(result.protection.readDurationMs, 100)
  assert.equal(freshBookProtection(result.protection, clock), true)
  assert.equal(freshBookProtection(result.protection, clock + 5001), false)
  assert.equal(freshBookProtection(result.protection, clock - 1), false)
})

test('slow initial reads cannot amend or certify an already tighter stop', async () => {
  for (const standing of [90, 105]) {
    let clock = 100_000, amends = 0
    await assert.rejects(amendBookStop({}, { positionId: '7', stopLoss: 100, side: 'long' }, {
      now: () => clock, clock: () => clock,
      readPosition: async () => { clock += 5001; return { positionId: '7', stopLoss: standing, takeProfit: 140, tradeData: { tradeSide: 1 } } },
      amend: async () => { amends++ },
    }), /freshness limit/)
    assert.equal(amends, 0)
  }
})

test('an accepted amendment with a slow confirmation cannot advance the book', async () => {
  let clock = 100_000, amends = 0
  await assert.rejects(amendBookStop({}, { positionId: '7', stopLoss: 100, side: 'long' }, {
    now: () => clock, clock: () => clock,
    readPosition: async () => { clock += amends ? 5001 : 100; return { positionId: '7', stopLoss: amends ? 100 : 90, takeProfit: 140, tradeData: { tradeSide: 1 } } },
    amend: async () => { amends++; return { ok: true } },
  }), /freshness limit/)
  assert.equal(amends, 1)
})

test('a pending broker read times out and its late answer cannot trigger an amendment', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resolveRead, amends = 0
  const pending = amendBookStop({}, { positionId: '7', stopLoss: 100, side: 'long' }, {
    readPosition: () => new Promise(resolve => { resolveRead = resolve }),
    amend: async () => { amends++ },
  })
  const rejected = assert.rejects(pending, /read deadline exceeded/)
  await Promise.resolve()
  t.mock.timers.tick(5000)
  await rejected
  resolveRead({ positionId: '7', stopLoss: 90, takeProfit: 140, tradeData: { tradeSide: 1 } })
  await Promise.resolve()
  assert.equal(amends, 0)
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
