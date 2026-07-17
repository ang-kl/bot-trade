// node --test agent/services/burn-in.test.js
//
// Micro-quant burn-in: dynamic per-symbol operating timeframe from live
// volume/condition (pickPlan), pacing toward targetTrades within the window
// (pacePlan), pinned min size through the REAL autoTrade path, gated by the
// master switches, throttled by volume-scaled per-symbol cooldowns.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { runBurnIn, loadBurnInConfig, DEFAULT_BURN_IN, pickPlan, pacePlan } from './burn-in.js'

const CREDS = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }
const DAY = 86_400_000

// 40 rising closed bars around 100 with configurable volumes.
function bars(vol = () => 100) {
  const out = []
  for (let i = 0; i < 40; i++) {
    const p = 100 + i * 0.1
    out.push({ t: i * 60_000, o: p, h: p + 0.2, l: p - 0.2, c: p + 0.05, v: vol(i) })
  }
  return out
}

function mkDb({ on = true, watch = ['EURUSD', 'GBPUSD'], autotrade = true, startedAt = null, sizeMode } = {}) {
  const db = initDB(':memory:')
  setState(db, 'burn_in_json', JSON.stringify({ on, startedAt, ...(sizeMode ? { sizeMode } : {}) }))
  setState(db, 'autotrade_enabled', autotrade ? 'true' : 'false')
  setState(db, 'autopilot_symbols_json', JSON.stringify(watch.map(s => ({ symbol: s, enabled: true }))))
  setState(db, 'symbol_id_map', JSON.stringify(Object.fromEntries(watch.map((s, i) => [s, i + 1]))))
  return db
}

// All plan TFs get the same fixture; 1m volume flat → relVol ≈ 1 → 'active'
// regime → 15m plan, unless overridden.
function deps(placed, { oneMinVol } = {}) {
  return {
    autoTrade: async (_db, symbol, synth, wItem) => {
      placed.push({ symbol, synth, wItem })
      return { side: synth.consensus_bias === 'short' ? 'SELL' : 'BUY', executionPrice: synth.entry }
    },
    wsGetTrendbarsBatch: async () => ({
      '1m': bars(oneMinVol ?? (() => 100)),
      '5m': bars(), '15m': bars(), '30m': bars(), '1h': bars(),
    }),
    risk: { loadRiskConfig: () => ({ minSLDistancePct: 0.0015 }) },
    isSymbolMarketOpen: () => ({ open: true }), // tests run at arbitrary wall-clock times
    now: () => 1_000_000_000_000,
  }
}

// ---- pickPlan: the market-condition policy ---------------------------------

test('pickPlan: hot tape → 5m micro; active → 15m; trending-quiet → 1h; dead → 30m', () => {
  assert.equal(pickPlan({ relVol: 2.0, atrPct5m: 0.001, atrPct1h: 0.002, mom1hPct: 0 }).tf, '5m')
  assert.equal(pickPlan({ relVol: 1.1, atrPct5m: 0.0001, atrPct1h: 0.001, mom1hPct: 0 }).tf, '15m')
  assert.equal(pickPlan({ relVol: 0.4, atrPct5m: 0.0001, atrPct1h: 0.003, mom1hPct: 0.002 }).tf, '1h')
  assert.equal(pickPlan({ relVol: 0.4, atrPct5m: 0.0001, atrPct1h: 0.0005, mom1hPct: 0 }).tf, '30m')
})

test('pickPlan: caps and cooldowns shrink as the tape heats up', () => {
  const hot = pickPlan({ relVol: 2, atrPct5m: 0.001 })
  const dead = pickPlan({ relVol: 0.3, atrPct5m: 0, atrPct1h: 0, mom1hPct: 0 })
  assert.ok(hot.capMin < dead.capMin)
  assert.ok(hot.cooldownMin < dead.cooldownMin)
  // hot volume but a flat 5m tape must NOT micro-scalp
  assert.notEqual(pickPlan({ relVol: 2, atrPct5m: 0.0001 }).tf, '5m')
})

// ---- pacePlan: steering toward the target ----------------------------------

test('pacePlan: behind schedule → more per cycle + shorter cooldowns', () => {
  const base = { targetTrades: 200, windowMs: 2 * DAY, baseMaxPerCycle: 4 }
  // 1 day elapsed → expected 100
  const way = pacePlan({ ...base, elapsedMs: DAY, completed: 50 })
  assert.deepEqual([way.maxPerCycle, way.cooldownScale, way.expected], [7, 0.4, 100])
  const bit = pacePlan({ ...base, elapsedMs: DAY, completed: 95 })
  assert.deepEqual([bit.maxPerCycle, bit.cooldownScale], [5, 0.8])
  const onPace = pacePlan({ ...base, elapsedMs: DAY, completed: 100 })
  assert.deepEqual([onPace.maxPerCycle, onPace.cooldownScale], [4, 1])
  const ahead = pacePlan({ ...base, elapsedMs: DAY, completed: 130 })
  assert.deepEqual([ahead.maxPerCycle, ahead.cooldownScale], [2, 1.5])
})

test('pacePlan: no target/window → base pacing untouched', () => {
  assert.deepEqual(pacePlan({ baseMaxPerCycle: 4 }), { maxPerCycle: 4, cooldownScale: 1, expected: 0 })
})

// ---- config ---------------------------------------------------------------

test('defaults are safe: off, 0.01 lots, 200-in-2d target; clamps hold', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadBurnInConfig(db), DEFAULT_BURN_IN)
  setState(db, 'burn_in_json', JSON.stringify({ on: true, lots: 5, targetTrades: 9999, windowDays: 99 }))
  const cfg = loadBurnInConfig(db)
  assert.equal(cfg.lots, 0.05)
  assert.equal(cfg.targetTrades, 500)
  assert.equal(cfg.windowDays, 7)
})

// ---- runBurnIn -------------------------------------------------------------

test('off / autotrade-off / no creds → skipped, nothing placed', async () => {
  const placed = []
  assert.equal((await runBurnIn(mkDb({ on: false }), CREDS, deps(placed))).skipped, 'off')
  assert.equal((await runBurnIn(mkDb({ autotrade: false }), CREDS, deps(placed))).skipped, 'autotrade off')
  assert.equal((await runBurnIn(mkDb({}), { ready: false }, deps(placed))).skipped, 'no creds')
  assert.equal(placed.length, 0)
})

test('fixed size mode pins burn-in lots via maxVolume', async () => {
  const db = mkDb({ watch: ['EURUSD'], sizeMode: 'fixed' })
  const placed = []
  await runBurnIn(db, CREDS, deps(placed))
  assert.equal(placed.length, 1)
  assert.equal(placed[0].wItem.maxVolume, 0.01, 'size pinned to burn-in lots')
})

test('places auto-sized trades (default) on the PLAN timeframe with the plan time cap', async () => {
  const db = mkDb({})
  const placed = []
  const out = await runBurnIn(db, CREDS, deps(placed))
  assert.equal(out.placed, 2)
  for (const p of placed) {
    assert.equal(p.wItem.maxVolume, null, 'auto mode → uncapped risk-based sizing')
    assert.equal(p.synth.source, 'burnin')
    assert.equal(p.synth.strategy, 'burnin')
    // flat 1m volume → relVol ≈ 1 → 'active' regime → 15m plan, 30m cap
    assert.equal(p.synth.timeframe, '15m')
    assert.equal(p.synth.time_cap_minutes, 30)
    assert.equal(p.synth.consensus_bias, 'long') // rising fixture
    const rr = Math.abs(p.synth.tp1 - p.synth.entry) / Math.abs(p.synth.entry - p.synth.sl)
    assert.ok(Math.abs(rr - 1.6) < 1e-9)
  }
})

test('hot 1m volume switches the plan to 5m micro-scalps', async () => {
  const db = mkDb({ watch: ['EURUSD'] })
  const placed = []
  // last closed 1m bar 3× the average volume → relVol 3 → hot regime
  const d = deps(placed, { oneMinVol: (i) => (i === 38 ? 300 : 100) })
  await runBurnIn(db, CREDS, d)
  assert.equal(placed.length, 1)
  assert.equal(placed[0].synth.timeframe, '5m')
  assert.equal(placed[0].synth.time_cap_minutes, 12)
})

test('volume-scaled cooldown: an attempted symbol is not retried next cycle', async () => {
  const db = mkDb({ watch: ['EURUSD'] })
  const placed = []
  const d = deps(placed)
  await runBurnIn(db, CREDS, d)
  assert.equal(placed.length, 1)
  const again = await runBurnIn(db, CREDS, d) // same now() — inside cooldown
  assert.equal(again.placed, 0)
  assert.equal(placed.length, 1)
  assert.ok(getState(db, 'burn_in_last_json').includes('EURUSD'))
})

test('pacing: behind schedule raises the per-cycle cap; completed counts from startedAt', async () => {
  const startedAt = new Date(1_000_000_000_000 - DAY).toISOString() // armed 1 day ago
  const db = mkDb({ watch: ['A1USD', 'B1USD', 'C1USD', 'D1USD', 'E1USD', 'F1USD', 'G1USD', 'H1USD'], startedAt })
  // zero completed burn-in trades → deficit 100 → mpc 4+3=7
  const placed = []
  const out = await runBurnIn(db, CREDS, deps(placed))
  assert.equal(out.expected, 100)
  assert.equal(out.maxPerCycle, 7)
  assert.equal(out.placed, 7)
})

test('closed-market symbols are filtered BEFORE any attempt (no veto spam)', async () => {
  const db = mkDb({ watch: ['CORNX1', 'EURUSD'] })
  const placed = []
  const d = deps(placed)
  d.isSymbolMarketOpen = (s) => (s === 'CORNX1' ? { open: false, reason: 'exchange closed' } : { open: true })
  const out = await runBurnIn(db, CREDS, d)
  assert.equal(out.placed, 1)
  assert.ok(!placed.some(p => p.symbol === 'CORNX1'), 'closed market never reaches autoTrade')
})

test('symbols with an open bot position are skipped', async () => {
  const db = mkDb({ watch: ['A1USD', 'B1USD', 'C1USD'] })
  db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, status) VALUES ('A1USD', 'BUY', 1, 'active')`).run()
  const placed = []
  await runBurnIn(db, CREDS, deps(placed))
  assert.ok(!placed.some(p => p.symbol === 'A1USD'))
  assert.equal(placed.length, 2)
})
