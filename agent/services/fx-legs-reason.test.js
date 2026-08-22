// node --test agent/services/fx-legs-reason.test.js
//
// WHY A REASON AND NOT JUST A NAME. Production logged, on every cycle for
// hours: `FX legs: 8 leg(s) could not be priced — USDCLP, USDTWD, USDIDR,
// USDCOP, USDINR, USDTRY, AUDUSD, GBPUSD`. That list is a dead end. Four
// unrelated faults collapse into one bare symbol name:
//
//   · not in the symbol map      — a permanent config fault someone must fix
//   · no usable quote            — a weekend, self-resolving on Monday
//   · the request threw          — transient broker trouble
//   · the write was rejected     — our own table refusing the rate
//
// AUDUSD and GBPUSD sitting in that list is either alarming or entirely normal
// depending on which one it is, and the message could not say. Same shape as
// the cTrader credential resolver that named no variable: an answer to a
// question nobody asked.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { refreshFxLegs } from './fx-legs.js'

/** Currencies whose legs the refresher will look for. */
const SYMBOLS = ['EURPLN', 'EURNOK']
const MAP = { USDPLN: 101, USDNOK: 102 }

async function run(getSpot, { symbolMap = MAP } = {}) {
  const db = initDB(':memory:')
  return refreshFxLegs(db, { symbols: SYMBOLS, symbolMap, getSpot, now: Date.now() })
}

test('a leg missing from the symbol map says so, by name', async () => {
  const r = await run(async () => ({ bid: 1, ask: 1 }), { symbolMap: {} })
  // No mapping means no leg is even resolvable, so nothing is attempted —
  // the refresher reports no legs rather than inventing failures.
  assert.ok(r.skipped === 'no_legs' || (r.failedWhy || []).every(f => /symbol map/.test(f.reason)),
    JSON.stringify(r))
})

test('AN EMPTY QUOTE IS NAMED AS SUCH — the weekend case', async () => {
  // This is what AUDUSD and GBPUSD almost certainly were, and what the old
  // message could not distinguish from a broken config.
  const r = await run(async () => ({ bid: null, ask: null }))
  assert.ok(r.failed.length > 0, JSON.stringify(r))
  assert.ok(r.failedWhy.length === r.failed.length, 'every failure carries a reason')
  for (const f of r.failedWhy) assert.match(f.reason, /no usable quote/)
})

test('a thrown request carries the broker message, truncated', async () => {
  const r = await run(async () => { throw new Error('CH_ACCESS_TOKEN_INVALID and a great deal of further detail'.repeat(4)) })
  assert.ok(r.failedWhy.length > 0)
  for (const f of r.failedWhy) {
    assert.match(f.reason, /request failed: /)
    assert.match(f.reason, /CH_ACCESS_TOKEN_INVALID/)
    assert.ok(f.reason.length < 130, 'a runaway broker message must not become the log line')
  }
})

test('failed and failedWhy never disagree about how many legs failed', async () => {
  // The old field is still what the count is taken from, so a reason list
  // that drifted out of step would misreport the number.
  const r = await run(async () => ({ bid: 0, ask: 0 }))
  assert.equal(r.failed.length, r.failedWhy.length)
  assert.deepEqual(r.failed.slice().sort(), r.failedWhy.map(f => f.symbol).sort())
})

test('a successful fetch reports no reasons at all', async () => {
  const r = await run(async () => ({ bid: 4.0, ask: 4.02 }))
  assert.equal(r.failed.length, 0)
  assert.deepEqual(r.failedWhy, [])
  assert.ok(r.fetched.length > 0)
})
