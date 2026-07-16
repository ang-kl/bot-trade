// node --test agent/services/profit-keeper.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { decideProfitKeeper, loadProfitKeeperConfig, atrFromBars, DEFAULT_PROFIT_KEEPER } from './profit-keeper.js'

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

// ---- adaptive (ATR / balance) mode ----------------------------------------

const ADAPTIVE = {
  on: true, scope: 'external', mode: 'adaptive',
  atrTimeframe: '1h', atrPeriod: 14,
  armAtrMult: 1, armBalancePct: 0.1, trailAtrMult: 2.5, scaleOutFrac: 0,
  armProfitUsd: 50, givebackPct: 40, takeProfitUsd: null,
}

test('atrFromBars: Wilder smoothing on a known series; null when starved', () => {
  // Constant 1.0 true range → ATR must converge to exactly 1.0
  const bars = Array.from({ length: 30 }, (_, i) => ({ h: 101 + i * 0, l: 100, c: 100.5 }))
  assert.ok(Math.abs(atrFromBars(bars, 14) - 1.0) < 1e-9)
  assert.equal(atrFromBars(bars.slice(0, 10), 14), null)
  assert.equal(atrFromBars(null, 14), null)
})

test('adaptive: arm threshold is max(ATR value, balance floor)', () => {
  // NatGas short 1 lot, ATR 0.05 → ATR value = 0.05 × 100 = $5; balance floor
  // 0.1% of $50k = $50 → arm at $50 (floor wins). Profit $37.95 → not armed.
  const notArmed = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.50, peak: 0, currentSl: null, atr: 0.05, balance: 50_000,
  })
  assert.equal(notArmed.action, null)
  // Profit $57.95 ≥ $50 → armed → Chandelier SL appears
  const armed = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 0, currentSl: null, atr: 0.05, balance: 50_000,
  })
  assert.ok(armed.action?.sl != null, `expected trail, got ${JSON.stringify(armed.action)}`)
})

test('adaptive: Chandelier SL trails trailAtrMult × ATR behind the PEAK price', () => {
  // Short from 2.8795, peak $60 → peak price 2.8795 - 0.60 = 2.2795.
  // Trail = 2.5 × 0.05 = 0.125 → SL at 2.2795 + 0.125 = 2.4045.
  const out = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.918, atr: 0.05, balance: 50_000,
  })
  assert.ok(Math.abs(out.action.sl - 2.405) < 0.001, `got ${out.action?.sl}`)
  // Tighten-only: an existing SL already below the trail target stays.
  const out2 = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.35, atr: 0.05, balance: 50_000,
  })
  assert.equal(out2.action, null)
})

test('adaptive: price through the trail → close at market', () => {
  // Peak $60 → trail SL 2.4045; price back at 2.45 (beyond it for a short) → close.
  const out = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.45, peak: 60, currentSl: null, atr: 0.05, balance: 50_000,
  })
  assert.ok(out.action?.close, `expected close, got ${JSON.stringify(out.action)}`)
  assert.match(out.action.reason, /chandelier/)
})

test('adaptive: scale-out fires once at arm, then never again', () => {
  const cfg = { ...ADAPTIVE, scaleOutFrac: 0.5 }
  const first = decideProfitKeeper(cfg, {
    ...NATGAS, price: 2.30, peak: 0, currentSl: null, atr: 0.05, balance: 50_000, scaledOut: false,
  })
  assert.equal(first.action?.scaleOutFrac, 0.5)
  const again = decideProfitKeeper(cfg, {
    ...NATGAS, price: 2.28, peak: 60, currentSl: 2.41, atr: 0.05, balance: 50_000, scaledOut: true,
  })
  assert.equal(again.action?.scaleOutFrac, undefined)
})

test('adaptive without ATR data falls back to the fixed thresholds', () => {
  const out = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.918, atr: null, balance: 50_000,
  })
  // fixed path: peak 60 armed (≥ $50), profit 57.95 > lock 36 → dollar-lock SL
  assert.ok(out.action?.sl != null)
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
