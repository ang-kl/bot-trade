// node --test agent/services/profit-keeper.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { decideProfitKeeper, loadProfitKeeperConfig, atrFromBars, DEFAULT_PROFIT_KEEPER, runProfitKeeper, clearAtrCache, readAtrCache, writeAtrCache, swingTrailLevel } from './profit-keeper.js'
import { recentPositionEvents } from './position-events.js'

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

// ---- structure trailing (aligned plan §2.5.4) ------------------------------
//
// Short NatGas from 2.8795, peak $60 → peak price 2.2795, ATR 0.05.
// Chandelier (2.5 ATR) sits at 2.4045. Every fixture below keeps bar ranges
// under 2 × ATR so the spike detector stays out of the way.
const swingBars = (highs) => highs.map(h => ({ h, l: h - 0.02, c: h - 0.01 }))

test('swingTrailLevel: the most recent CONFIRMED pivot, buffered and bounded', () => {
  // pivot high 2.44 at index 2 — two lower highs on each side
  const bars = swingBars([2.30, 2.38, 2.44, 2.38, 2.30, 2.29, 2.28])
  const lvl = swingTrailLevel(bars, { dir: -1, pivotBars: 2, atr: 0.05, bufferAtrMult: 0.25, price: 2.30 })
  assert.ok(Math.abs(lvl - 2.4525) < 1e-9, `got ${lvl}`)

  // the bound wins when structure sits too far from the peak
  const bounded = swingTrailLevel(bars, {
    dir: -1, pivotBars: 2, atr: 0.05, bufferAtrMult: 0.25, price: 2.30,
    maxAtrMult: 1, peakPrice: 2.2795,
  })
  assert.ok(Math.abs(bounded - 2.3295) < 1e-9, `got ${bounded}`)

  // a pivot needs confirmation on BOTH sides: a still-forming high at the
  // right edge is not a pivot, and a monotone series has none at all
  assert.equal(swingTrailLevel(swingBars([2.20, 2.22, 2.24, 2.26, 2.28]), { dir: -1, pivotBars: 2, price: 2.10 }), null)
  assert.equal(swingTrailLevel(swingBars([2.30, 2.40]), { dir: -1, pivotBars: 2, price: 2.10 }), null)

  // longs mirror it: pivot LOW, buffered downward
  const longBars = [2.40, 2.32, 2.26, 2.32, 2.40, 2.41, 2.42].map(l => ({ l, h: l + 0.02, c: l + 0.01 }))
  const longLvl = swingTrailLevel(longBars, { dir: 1, pivotBars: 2, atr: 0.05, bufferAtrMult: 0.25, price: 2.45 })
  assert.ok(Math.abs(longLvl - 2.2475) < 1e-9, `got ${longLvl}`)
})

test('structure trail survives the pullback that the Chandelier would have closed', () => {
  const bars = swingBars([2.30, 2.38, 2.44, 2.38, 2.30, 2.29, 2.28])
  // price 2.42 is through the 2.4045 Chandelier but short of the 2.4525 swing
  const structure = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.42, peak: 60, currentSl: null, atr: 0.05, balance: 50_000, bars,
  })
  assert.ok(!structure.action?.close, `expected survival, got ${JSON.stringify(structure.action)}`)
  assert.ok(Math.abs(structure.action.sl - 2.4525) < 0.001, `got ${structure.action?.sl}`)
  assert.equal(structure.action.structure, true)
  // the C++ ratchet must be handed the distance that actually applies
  assert.ok(Math.abs(structure.trail.distance - (2.4525 - 2.2795)) < 1e-9)

  // same bar, structure trailing off → the old behaviour closes it
  const chandelier = decideProfitKeeper({ ...ADAPTIVE, structureTrailEnabled: false }, {
    ...NATGAS, price: 2.42, peak: 60, currentSl: null, atr: 0.05, balance: 50_000, bars,
  })
  assert.ok(chandelier.action?.close, 'the Chandelier still exits here')
  assert.match(chandelier.action.reason, /chandelier/)
})

test('structure trail still ratchets, still bounded, still yields to a spike', () => {
  // A nearer swing (2.35 + buffer = 2.3625) tightens PAST the Chandelier.
  const near = swingBars([2.20, 2.28, 2.35, 2.28, 2.20, 2.19, 2.18])
  const tight = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: null, atr: 0.05, balance: 50_000, bars: near,
  })
  assert.ok(Math.abs(tight.action.sl - 2.3625) < 0.001, `got ${tight.action?.sl}`)

  // tighten-only is unchanged: an existing stop already tighter stays put
  const held = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.34, atr: 0.05, balance: 50_000, bars: near,
  })
  assert.equal(held.action, null)

  // giveback stays bounded even when the only swing is miles away
  const far = swingBars([2.30, 2.50, 2.90, 2.50, 2.30, 2.29, 2.28])
  const bounded = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: null, atr: 0.05, balance: 50_000, bars: far,
  })
  assert.ok(Math.abs(bounded.action.sl - (2.2795 + 4 * 0.05)) < 0.001, `got ${bounded.action?.sl}`)

  // a spike says the peak IS the move — the 1-ATR spike trail wins over structure
  const spiky = swingBars([2.30, 2.38, 2.44, 2.38, 2.30, 2.29, 2.28])
  spiky[spiky.length - 1] = { h: 2.40, l: 2.25, c: 2.30 } // range 0.15 ≥ 2 × ATR
  const out = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: null, atr: 0.05, balance: 50_000, bars: spiky,
  })
  assert.ok(Math.abs(out.action.sl - (2.2795 + 0.05)) < 0.001, `got ${out.action?.sl}`)
  assert.equal(out.action.spike, true)
  assert.equal(out.action.structure, undefined)
})

test('arming is 1.2 ATR-values (plan §2.5.4 "≥ +1.2R" in the unit this module has)', () => {
  assert.equal(DEFAULT_PROFIT_KEEPER.armAtrMult, 1.2)
  // 1 lot × 100 units × ATR 0.50 = $50 of ATR-value → arms at $60, not $50.
  // Balance floor set to 0 so the ATR arm is the only gate under test.
  const cfg = { ...ADAPTIVE, armAtrMult: 1.2, armBalancePct: 0, trailAtrMult: 2.5, structureTrailEnabled: false }
  const at1R = decideProfitKeeper(cfg, {
    ...NATGAS, price: 2.3795, peak: 0, currentSl: null, atr: 0.50, balance: 50_000,
  })
  assert.equal(at1R.profitUsd, 50)
  assert.equal(at1R.action, null, '1.0 ATR-value no longer arms')
  const at12R = decideProfitKeeper(cfg, {
    ...NATGAS, price: 2.2795, peak: 0, currentSl: null, atr: 0.50, balance: 50_000,
  })
  assert.equal(at12R.profitUsd, 60)
  assert.ok(at12R.action?.sl != null, '1.2 ATR-values arms')
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

// ---- per-position opt-out (owner: "checkbox that allow/stop bot to
// manage after open position") --------------------------------------------

const CREDS = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }

function mkKeeperDb({ keeperOptOut = 0 } = {}) {
  const db = initDB(':memory:')
  setState(db, 'profit_keeper_json', JSON.stringify({ on: true, scope: 'external', mode: 'fixed', armProfitUsd: 50, givebackPct: 40 }))
  db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status) VALUES ('NATGAS', 'SELL', '9001', 'open')`).run()
  const tradeId = db.prepare(`SELECT id FROM trades WHERE ctrader_position_id = '9001'`).get().id
  db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, status, source, trade_id, keeper_opt_out)
    VALUES ('NATGAS', 'short', 2.8795, 2.918, 'active', 'external', ?, ?)
  `).run(tradeId, keeperOptOut)
  return db
}

function keeperDeps() {
  return {
    exec: {
      reconcile: async () => ({
        position: [{ positionId: 9001, price: 2.8795, stopLoss: 2.918, tradeData: { symbolId: 1, volume: 10000, tradeSide: 2 } }],
      }),
    },
    ws: {
      wsGetLastCloses: async () => ({ 1: 2.30 }), // deep in profit → would arm if considered
      wsGetTrendbarsBatch: async () => ({}),
    },
    sizing: { getVolumeMeta: async () => ({ lotSize: 10000, digits: 3 }) },
    notify: () => {},
  }
}

test('keeper_opt_out excludes one position even though it is in scope', async () => {
  const db = mkKeeperDb({ keeperOptOut: 1 })
  const out = await runProfitKeeper(db, CREDS, keeperDeps())
  assert.equal(out.checked, 0, 'the opted-out position must never reach the decision step')
})

test('without opt-out, the same position IS considered (sanity check the fixture)', async () => {
  const db = mkKeeperDb({ keeperOptOut: 0 })
  const out = await runProfitKeeper(db, CREDS, keeperDeps())
  assert.equal(out.checked, 1)
})

test('on by default; explicit off still wins; config merges saved values', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadProfitKeeperConfig(db), DEFAULT_PROFIT_KEEPER)
  assert.equal(DEFAULT_PROFIT_KEEPER.on, true)
  // unconfigured → managed
  assert.equal(loadProfitKeeperConfig(db).on, true)
  // owner disarms → the stored value wins (fully hands-off)
  setState(db, 'profit_keeper_json', JSON.stringify({ on: false }))
  assert.equal(loadProfitKeeperConfig(db).on, false)
  // saved partial config merges over defaults
  setState(db, 'profit_keeper_json', JSON.stringify({ on: true, armProfitUsd: 75 }))
  const cfg = loadProfitKeeperConfig(db)
  assert.equal(cfg.on, true)
  assert.equal(cfg.armProfitUsd, 75)
  assert.equal(cfg.givebackPct, 40) // default preserved
  const off = decideProfitKeeper({ ...CFG, on: false }, { ...NATGAS, price: 2.30, peak: 0, currentSl: null })
  assert.equal(off.action, null)
})

// ---- spike-aware tightening (owner, 2026-07-24: EUSTX50 vertical spike) ----

test('adaptive spike: a recent wide-range bar tightens the trail to spikeTrailAtrMult', () => {
  // ATR 0.05 → spike threshold 2×ATR = 0.10 range. Peak $60 → peak price
  // 2.2795. Normal trail 2.5×0.05 → SL 2.4045; spike trail 1×0.05 → 2.3295.
  const spikeBar = { h: 2.45, l: 2.30, c: 2.31 } // range 0.15 ≥ 0.10
  const out = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.918, atr: 0.05, balance: 50_000,
    bars: [{ h: 2.50, l: 2.47, c: 2.48 }, spikeBar],
  })
  assert.ok(Math.abs(out.action.sl - 2.33) < 0.001, `got ${out.action?.sl}`)
  assert.equal(out.action.spike, true)
})

test('adaptive spike: quiet bars keep the normal 2.5×ATR trail', () => {
  const out = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.918, atr: 0.05, balance: 50_000,
    bars: [{ h: 2.32, l: 2.29, c: 2.30 }, { h: 2.31, l: 2.28, c: 2.30 }],
  })
  assert.ok(Math.abs(out.action.sl - 2.405) < 0.001, `got ${out.action?.sl}`)
  assert.equal(out.action.spike, undefined)
})

test('adaptive spike: spikeTightenEnabled=false ignores the spike', () => {
  const out = decideProfitKeeper({ ...ADAPTIVE, spikeTightenEnabled: false }, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.918, atr: 0.05, balance: 50_000,
    bars: [{ h: 2.45, l: 2.30, c: 2.31 }],
  })
  assert.ok(Math.abs(out.action.sl - 2.405) < 0.001, `got ${out.action?.sl}`)
})

test('adaptive spike: ratchet-only survives — an already-tighter SL stays put', () => {
  const out = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.32, atr: 0.05, balance: 50_000,
    bars: [{ h: 2.45, l: 2.30, c: 2.31 }],
  })
  assert.equal(out.action, null)
})

// ---- option 4: trail-spec handoff to the C++ tick ratchet ------------------

test('decide exposes trail {distance, peakPrice} when adaptive-armed', () => {
  const out = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.30, peak: 60, currentSl: 2.918, atr: 0.05, balance: 50_000,
  })
  // trail distance 2.5×0.05; peak price = entry - peak$/(lots×units) = 2.2795
  assert.ok(Math.abs(out.trail.distance - 0.125) < 1e-12)
  assert.ok(Math.abs(out.trail.peakPrice - 2.2795) < 1e-12)
  // Not armed → no trail exposed.
  const cold = decideProfitKeeper(ADAPTIVE, {
    ...NATGAS, price: 2.86, peak: 0, currentSl: null, atr: 0.05, balance: 50_000,
  })
  assert.equal(cold.trail, undefined)
})

test('runProfitKeeper pushes armed trail specs to the sidecar (full replace)', async () => {
  const db = mkKeeperDb()
  setState(db, 'profit_keeper_json', JSON.stringify({
    on: true, scope: 'external', mode: 'adaptive', atrTimeframe: '1h', atrPeriod: 14,
    armAtrMult: 1, armBalancePct: 0, trailAtrMult: 2.5, spikeTightenEnabled: false,
  }))
  const bars = Array.from({ length: 30 }, () => ({ h: 2.35, l: 2.30, c: 2.32 })) // ATR 0.05
  let pushed = null
  const deps = keeperDeps()
  deps.ws.wsGetTrendbarsBatch = async () => ({ '1h': bars })
  deps.exec.amendPosition = async () => ({})
  deps.exec.pushTrailConfig = async (_creds, specs) => { pushed = specs; return true }
  const out = await runProfitKeeper(db, CREDS, deps)
  assert.equal(out.checked, 1)
  assert.ok(Array.isArray(pushed) && pushed.length === 1, `expected one spec, got ${JSON.stringify(pushed)}`)
  const s = pushed[0]
  assert.equal(s.positionId, 9001)
  assert.equal(s.symbolId, 1)
  assert.equal(s.dir, -1) // short
  assert.ok(Math.abs(s.trailDistance - 0.125) < 1e-12)
  assert.equal(s.digits, 3)
  assert.equal(out.trailPushed, 1)
})

test('runProfitKeeper pushes an EMPTY set when nothing is armed (clears stale trails)', async () => {
  const db = mkKeeperDb() // fixed mode fixture — no adaptive trail
  let pushed = null
  const deps = keeperDeps()
  deps.exec.amendPosition = async () => ({})
  deps.exec.pushTrailConfig = async (_creds, specs) => { pushed = specs; return true }
  await runProfitKeeper(db, CREDS, deps)
  assert.ok(Array.isArray(pushed) && pushed.length === 0)
})

// ---- P10: journal what the C++ TrailEngine actually ratcheted -------------

test('runProfitKeeper journals a NEW trail-status SL as a position_event, and only once', async () => {
  const db = mkKeeperDb()
  const deps = keeperDeps()
  deps.exec.amendPosition = async () => ({})
  deps.exec.pushTrailConfig = async () => true
  deps.exec.getTrailStatus = async () => ({
    enabled: true,
    positions: [{ positionId: 9001, symbolId: 1, lastSl: 2.7 }],
  })
  await runProfitKeeper(db, CREDS, deps)
  const rows = recentPositionEvents(db, { positionId: '9001' })
  const trailRows = rows.filter(r => r.kind === 'trail_tightened')
  assert.equal(trailRows.length, 1)
  assert.equal(trailRows[0].to_value, 2.7)
  assert.equal(trailRows[0].source, 'cpp_trail_engine')

  // Second pass with the SAME lastSl — no new event (the diff must be a no-op).
  await runProfitKeeper(db, CREDS, deps)
  const rows2 = recentPositionEvents(db, { positionId: '9001' })
  assert.equal(rows2.filter(r => r.kind === 'trail_tightened').length, 1)
})

test('runProfitKeeper never throws when getTrailStatus is unavailable or disabled', async () => {
  const db = mkKeeperDb()
  const deps = keeperDeps()
  deps.exec.amendPosition = async () => ({})
  deps.exec.pushTrailConfig = async () => true
  const out = await runProfitKeeper(db, CREDS, deps) // no getTrailStatus on deps.exec at all
  assert.equal(out.errors.length, 0)

  deps.exec.getTrailStatus = async () => ({ enabled: false })
  const out2 = await runProfitKeeper(db, CREDS, deps)
  assert.equal(out2.errors.length, 0)
  assert.equal(recentPositionEvents(db, { positionId: '9001' }).filter(r => r.kind === 'trail_tightened').length, 0)
})

// ---------------------------------------------------------------------------
// §70.6 follow-up: the ATR fetch used to BOUND TICK RESPONSE.
//
// The pass is single-flighted, so the cheap rules — chandelier breach,
// takeProfitUsd, giveback, all of which need only a price already in hand —
// queued behind one WS round-trip per symbol, run one after another. The
// answers are unchanged; the waiting is not.
// ---------------------------------------------------------------------------

test('an ATR is cached for exactly one bar of its own timeframe, no longer', () => {
  clearAtrCache()
  const t0 = 1_000_000
  writeAtrCache(7, '1h', { atr: 0.5, bars: [] }, t0)
  assert.equal(readAtrCache(7, '1h', t0 + 59 * 60_000)?.atr, 0.5, 'still the same bar')
  assert.equal(readAtrCache(7, '1h', t0 + 3_600_000), null, 'the bar closed; recompute')
})

test('a 5m ATR expires in five minutes, not an hour', () => {
  // The TTL is the data\'s own period, not a guess at "long enough".
  clearAtrCache()
  const t0 = 2_000_000
  writeAtrCache(9, '5m', { atr: 1.2, bars: [] }, t0)
  assert.ok(readAtrCache(9, '5m', t0 + 299_000))
  assert.equal(readAtrCache(9, '5m', t0 + 300_000), null)
})

test('an unrecognised timeframe is never served from cache', () => {
  // One extra fetch beats an ATR held past the data that produced it.
  clearAtrCache()
  writeAtrCache(1, '3h', { atr: 1, bars: [] }, 0)
  assert.equal(readAtrCache(1, '3h', 1), null)
})

test('the cache is bounded and evicts the OLDEST, not everything', () => {
  // A full flush would make every symbol refetch at once — the burst the
  // concurrency cap exists to avoid.
  clearAtrCache()
  for (let i = 0; i < 520; i++) writeAtrCache(i, '1h', { atr: i, bars: [] }, 1000 + i)
  assert.ok(readAtrCache(519, '1h', 1600), 'the newest survives')
  assert.equal(readAtrCache(0, '1h', 1600), null, 'the oldest was evicted')
})

test('symbols are independent — one cached entry does not answer for another', () => {
  clearAtrCache()
  writeAtrCache(11, '1h', { atr: 0.9, bars: [] }, 0)
  assert.equal(readAtrCache(12, '1h', 0), null)
})
