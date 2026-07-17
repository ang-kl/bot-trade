// node --test agent/services/burn-in.test.js
//
// Burn-in mode: track-record trades at pinned min size through the REAL
// autoTrade path (injected here), gated by the master switches, throttled
// by a per-symbol cooldown, capped per cycle.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { runBurnIn, loadBurnInConfig, DEFAULT_BURN_IN } from './burn-in.js'

const CREDS = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }

// 30 closed hourly bars trending up (last close > previous) around 100.
function bars() {
  const out = []
  for (let i = 0; i < 30; i++) {
    const p = 100 + i * 0.1
    out.push({ t: i * 3_600_000, o: p, h: p + 0.2, l: p - 0.2, c: p + 0.05, v: 100 })
  }
  return out
}

function mkDb({ on = true, watch = ['EURUSD', 'GBPUSD'], autotrade = true } = {}) {
  const db = initDB(':memory:')
  setState(db, 'burn_in_json', JSON.stringify({ on }))
  setState(db, 'autotrade_enabled', autotrade ? 'true' : 'false')
  setState(db, 'autopilot_symbols_json', JSON.stringify(watch.map(s => ({ symbol: s, enabled: true }))))
  setState(db, 'symbol_id_map', JSON.stringify(Object.fromEntries(watch.map((s, i) => [s, i + 1]))))
  return db
}

function deps(placed) {
  return {
    autoTrade: async (_db, symbol, synth, wItem) => {
      placed.push({ symbol, synth, wItem })
      return { side: synth.consensus_bias === 'short' ? 'SELL' : 'BUY', executionPrice: synth.entry }
    },
    wsGetTrendbarsBatch: async () => ({ '1h': bars() }),
    risk: { loadRiskConfig: () => ({ minSLDistancePct: 0.0015 }) },
    now: () => 1_000_000_000_000,
  }
}

test('defaults are safe: off, 0.01 lots, 20m cap; lots clamp at 0.05', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadBurnInConfig(db), DEFAULT_BURN_IN)
  setState(db, 'burn_in_json', JSON.stringify({ on: true, lots: 5, timeCapMinutes: 1 }))
  const cfg = loadBurnInConfig(db)
  assert.equal(cfg.lots, 0.05)   // never more than 0.05 — sample stays cheap
  assert.equal(cfg.timeCapMinutes, 5)
})

test('off / autotrade-off / no creds → skipped, nothing placed', async () => {
  const placed = []
  assert.equal((await runBurnIn(mkDb({ on: false }), CREDS, deps(placed))).skipped, 'off')
  assert.equal((await runBurnIn(mkDb({ autotrade: false }), CREDS, deps(placed))).skipped, 'autotrade off')
  assert.equal((await runBurnIn(mkDb({}), { ready: false }, deps(placed))).skipped, 'no creds')
  assert.equal(placed.length, 0)
})

test('places pinned-size momentum trades with tight time caps via autoTrade', async () => {
  const db = mkDb({})
  const placed = []
  const out = await runBurnIn(db, CREDS, deps(placed))
  assert.equal(out.placed, 2)
  for (const p of placed) {
    assert.equal(p.wItem.maxVolume, 0.01, 'size pinned to burn-in lots')
    assert.equal(p.synth.source, 'burnin')
    assert.equal(p.synth.strategy, 'burnin')
    assert.equal(p.synth.time_cap_minutes, 20)
    assert.equal(p.synth.consensus_bias, 'long') // rising fixture
    // RR 1.6 geometry: |tp-entry| / |entry-sl| ≈ 1.6
    const rr = Math.abs(p.synth.tp1 - p.synth.entry) / Math.abs(p.synth.entry - p.synth.sl)
    assert.ok(Math.abs(rr - 1.6) < 1e-9)
  }
})

test('cooldown: a symbol just attempted is not retried next cycle', async () => {
  const db = mkDb({ watch: ['EURUSD'] })
  const placed = []
  const d = deps(placed)
  await runBurnIn(db, CREDS, d)
  assert.equal(placed.length, 1)
  const again = await runBurnIn(db, CREDS, d) // same now() — inside cooldown
  assert.equal(again.skipped, 'nothing due')
  assert.equal(placed.length, 1)
  assert.ok(getState(db, 'burn_in_last_json').includes('EURUSD'))
})

test('symbols with an open bot position are skipped; maxPerCycle caps the batch', async () => {
  const db = mkDb({ watch: ['A1USD', 'B1USD', 'C1USD', 'D1USD', 'E1USD'] })
  db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, status) VALUES ('A1USD', 'BUY', 1, 'active')`).run()
  const placed = []
  const out = await runBurnIn(db, CREDS, deps(placed))
  assert.equal(out.placed, 3) // maxPerCycle default
  assert.ok(!placed.some(p => p.symbol === 'A1USD'))
})
