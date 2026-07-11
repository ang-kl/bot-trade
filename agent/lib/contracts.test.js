// node --test agent/lib/contracts.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  contractSize,
  usdLossPerLot,
  notionalUsd,
  tierForBalance,
  TIERS,
} from './contracts.js'

// contractSize -----------------------------------------------------------

test('contractSize — gold = 100 oz/lot', () => {
  assert.equal(contractSize('XAUUSD'), 100)
})

test('contractSize — silver = 5000 oz/lot', () => {
  assert.equal(contractSize('XAGUSD'), 5000)
})

test('contractSize — natgas + cocoa have commodity sizes', () => {
  assert.equal(contractSize('NATGAS'), 10000)
  assert.equal(contractSize('COCOA'), 10)
})

test('contractSize — FX major defaults to 100k', () => {
  assert.equal(contractSize('EURUSD'), 100_000)
  assert.equal(contractSize('GBPJPY'), 100_000)
})

test('contractSize — indices default to 1', () => {
  assert.equal(contractSize('US30'), 1)
  assert.equal(contractSize('NAS100'), 1)
})

test('contractSize — crypto = 1/lot', () => {
  assert.equal(contractSize('BTCUSD'), 1)
  assert.equal(contractSize('ETHUSD'), 1)
})

test('contractSize — unknown short symbol returns 1', () => {
  assert.equal(contractSize('BLOB'), 1)
  assert.equal(contractSize(''), 1)
  assert.equal(contractSize(null), 1)
})

test('contractSize — case-insensitive', () => {
  assert.equal(contractSize('xauusd'), 100)
  assert.equal(contractSize('EurUsd'), 100_000)
})

// usdLossPerLot ----------------------------------------------------------

test('usdLossPerLot — EURUSD 30 pip = $300/lot', () => {
  assert.equal(usdLossPerLot('EURUSD', 0.003), 300)
})

test('usdLossPerLot — XAUUSD $5 move = $500/lot', () => {
  assert.equal(usdLossPerLot('XAUUSD', 5), 500)
})

test('usdLossPerLot — negative distance treated as absolute', () => {
  assert.equal(usdLossPerLot('EURUSD', -0.003), 300)
})

test('usdLossPerLot — USDJPY converts quote-ccy loss to USD via price', () => {
  // 0.50 JPY distance × 100k = ¥50,000 → at 147.50, $338.98/lot — NOT $50,000
  const out = usdLossPerLot('USDJPY', 0.5, 147.5)
  assert.ok(Math.abs(out - 50000 / 147.5) < 0.01, `got ${out}`)
})

test('usdLossPerLot — USDCHF converts via price', () => {
  // 30 pip × 100k = 300 CHF → at 0.90, $333.33/lot
  const out = usdLossPerLot('USDCHF', 0.003, 0.9)
  assert.ok(Math.abs(out - 300 / 0.9) < 0.01, `got ${out}`)
})

test('usdLossPerLot — USD-base without a price is unknown (NaN), not mis-sized', () => {
  assert.ok(Number.isNaN(usdLossPerLot('USDJPY', 0.5)))
  assert.ok(Number.isNaN(usdLossPerLot('USDJPY', 0.5, 0)))
})

test('usdLossPerLot — cross with no USD leg is unknown (NaN)', () => {
  assert.ok(Number.isNaN(usdLossPerLot('EURJPY', 0.5, 160)))
  assert.ok(Number.isNaN(usdLossPerLot('EURGBP', 0.003, 0.85)))
})

test('usdLossPerLot — USD-quoted unaffected by price argument', () => {
  assert.equal(usdLossPerLot('EURUSD', 0.003, 1.1), 300)
  assert.equal(usdLossPerLot('NAS100', 50, 20000), 50)
})

// notionalUsd -----------------------------------------------------------

test('notionalUsd — EURUSD 0.01 lot at 1.10 = $1100', () => {
  assert.equal(notionalUsd('EURUSD', 0.01, 1.10), 1100)
})

test('notionalUsd — XAUUSD 0.01 lot at $2400 = $2400', () => {
  assert.equal(notionalUsd('XAUUSD', 0.01, 2400), 2400)
})

test('notionalUsd — BTCUSD 0.01 lot at $50k = $500', () => {
  assert.equal(notionalUsd('BTCUSD', 0.01, 50000), 500)
})

test('notionalUsd — US30 0.5 lot at 40000 = $20000', () => {
  assert.equal(notionalUsd('US30', 0.5, 40000), 20000)
})

test('notionalUsd — NATGAS 0.01 lot at $2.50 = $250', () => {
  // 0.01 × 10000 × 2.50 = $250
  assert.equal(notionalUsd('NATGAS', 0.01, 2.50), 250)
})

test('notionalUsd — USDJPY 0.1 lot = $10,000 (base is USD, no price term)', () => {
  // Previously 0.1 × 100k × 147.5 = "¥1.475M read as USD" — 147× overstated.
  assert.equal(notionalUsd('USDJPY', 0.1, 147.5), 10_000)
})

test('notionalUsd — cross falls back to quote-ccy approximation', () => {
  assert.equal(notionalUsd('EURGBP', 0.1, 0.85), 8500)
})

// Tier resolution --------------------------------------------------------

test('tierForBalance — $200 → micro', () => {
  assert.equal(tierForBalance(200).name, 'micro')
})

test('tierForBalance — $500 → micro (inclusive upper bound)', () => {
  assert.equal(tierForBalance(500).name, 'micro')
})

test('tierForBalance — $501 → small', () => {
  assert.equal(tierForBalance(501).name, 'small')
})

test('tierForBalance — $2000 → small', () => {
  assert.equal(tierForBalance(2000).name, 'small')
})

test('tierForBalance — $5000 → standard', () => {
  assert.equal(tierForBalance(5000).name, 'standard')
})

test('tierForBalance — $100000 → full', () => {
  assert.equal(tierForBalance(100_000).name, 'full')
})

test('tierForBalance — malformed → 0 → micro', () => {
  assert.equal(tierForBalance('garbage').name, 'micro')
  assert.equal(tierForBalance(null).name, 'micro')
})

test('TIERS exported with expected shape', () => {
  assert.ok(Array.isArray(TIERS))
  assert.ok(TIERS.length >= 4)
  for (const t of TIERS) {
    assert.ok(typeof t.name === 'string')
    assert.ok(typeof t.maxBalance === 'number')
    assert.ok(typeof t.note === 'string')
  }
})
