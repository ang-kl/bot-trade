// node --test agent/services/profit-keeper.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { decideProfitKeeper, loadProfitKeeperConfig, DEFAULT_PROFIT_KEEPER } from './profit-keeper.js'

const CFG = { on: true, scope: 'external', armProfitUsd: 50, givebackPct: 40, takeProfitUsd: null }

// The NatGas scenario: SELL 1 lot (unitsPerLot 100 → $100 per 1.00 move... use
// real cTrader scale: lotSize 10000 units → unitsPerLot 100).
const NATGAS = { side: 'short', entry: 2.8795, lots: 1, unitsPerLot: 100, symbol: 'NATGAS', digits: 3 }

test('below arm threshold: peak tracked, no action', () => {
  const out = decideProfitKeeper(CFG, { ...NATGAS, price: 2.85, peak: 0, currentSl: 2.918 })
  // short from 2.8795 → 2.85 = +0.0295 × 100 = $2.95 profit
  assert.equal(out.profitUsd, 2.95)
  assert.equal(out.newPeak, 2.95)
  assert.equal(out.action, null)
})

test('armed: SL ratchets to lock (1 - giveback) of peak — the good-NatGas-day case', () => {
  // Price ran to 2.75 → profit (2.8795-2.75)×100 = $12.95... use bigger move:
  // 2.50 → $37.95; still below 50. Use 2.30 → $57.95 ≥ arm.
  const out = decideProfitKeeper(CFG, { ...NATGAS, price: 2.30, peak: 0, currentSl: 2.918 })
  assert.equal(out.newPeak, 57.95)
  assert.ok(out.action?.sl != null, `expected SL ratchet, got ${JSON.stringify(out.action)}`)
  // lock = 57.95 × 0.6 = 34.77 → SL at entry - 34.77/100 = 2.8795 - 0.3477 = 2.5318
  assert.ok(Math.abs(out.action.sl - 2.532) < 0.001, `got ${out.action.sl}`)
  assert.ok(out.action.sl < NATGAS.entry, 'short lock SL must sit below entry (in profit)')
})

test('ratchet is monotonic: never loosens an existing tighter SL', () => {
  // peak $80 → lock $48 → SL target 2.8795 - 0.48 = 2.3995 (profit $57.95 > lock, no close)
  const out = decideProfitKeeper(CFG, { ...NATGAS, price: 2.30, peak: 80, currentSl: 2.45 })
  assert.ok(out.action?.sl != null && Math.abs(out.action.sl - 2.3995) < 0.001, `got ${JSON.stringify(out.action)}`)
  // Current SL already tighter (lower, for a short) than the lock target → no action.
  const out2 = decideProfitKeeper(CFG, { ...NATGAS, price: 2.30, peak: 80, currentSl: 2.35 })
  assert.equal(out2.action, null)
})

test('giveback close: profit retraced past the lock — the bad-NatGas-day case', () => {
  // Peak was $60 (armed); lock = $36. Price back to 2.879 → profit $0.05 ≤ 36 → CLOSE.
  const out = decideProfitKeeper(CFG, { ...NATGAS, price: 2.879, peak: 60, currentSl: 2.918 })
  assert.ok(out.action?.close, `expected close, got ${JSON.stringify(out.action)}`)
  assert.match(out.action.reason, /giveback/)
})

test('takeProfitUsd closes outright at the target', () => {
  const cfg = { ...CFG, takeProfitUsd: 55 }
  const out = decideProfitKeeper(cfg, { ...NATGAS, price: 2.30, peak: 0, currentSl: null })
  assert.ok(out.action?.close)
  assert.match(out.action.reason, /take_profit_usd/)
})

test('long side mirrors: lock SL sits above entry', () => {
  const out = decideProfitKeeper(CFG, {
    side: 'long', entry: 1.1000, price: 1.1100, lots: 1, unitsPerLot: 1000,
    symbol: 'GBPUSD', peak: 0, currentSl: 1.0900, digits: 5,
  })
  // profit = 0.01 × 1000 = $10 < 50 → no action yet
  assert.equal(out.action, null)
  const out2 = decideProfitKeeper(CFG, {
    side: 'BUY', entry: 1.1000, price: 1.1600, lots: 1, unitsPerLot: 1000,
    symbol: 'GBPUSD', peak: 0, currentSl: 1.0900, digits: 5,
  })
  // profit $60 → lock $36 → SL = 1.1000 + 36/1000 = 1.1360, above entry
  assert.ok(Math.abs(out2.action.sl - 1.136) < 1e-9, `got ${out2.action?.sl}`)
})

test('USD-base pair converts quote-ccy profit via price', () => {
  // USDJPY short 1 lot (unitsPerLot 1000): entry 148 → 146: 2 JPY × 1000 = ¥2000 ≈ $13.70
  const out = decideProfitKeeper(CFG, {
    side: 'short', entry: 148, price: 146, lots: 1, unitsPerLot: 1000,
    symbol: 'USDJPY', peak: 0, currentSl: null, digits: 3,
  })
  assert.ok(Math.abs(out.profitUsd - 2000 / 146) < 0.01, `got ${out.profitUsd}`)
})

test('cross with no USD leg is skipped, never guessed', () => {
  const out = decideProfitKeeper(CFG, {
    side: 'long', entry: 160, price: 170, lots: 1, unitsPerLot: 1000,
    symbol: 'EURJPY', peak: 5, currentSl: null, digits: 3,
  })
  assert.equal(out.action, null)
  assert.equal(out.profitUsd, null)
})

test('off by default; config loads with defaults and merges saved values', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadProfitKeeperConfig(db), DEFAULT_PROFIT_KEEPER)
  assert.equal(DEFAULT_PROFIT_KEEPER.on, false)
  setState(db, 'profit_keeper_json', JSON.stringify({ on: true, armProfitUsd: 75 }))
  const cfg = loadProfitKeeperConfig(db)
  assert.equal(cfg.on, true)
  assert.equal(cfg.armProfitUsd, 75)
  assert.equal(cfg.givebackPct, 40) // default preserved
  const off = decideProfitKeeper({ ...CFG, on: false }, { ...NATGAS, price: 2.30, peak: 0, currentSl: null })
  assert.equal(off.action, null)
})
