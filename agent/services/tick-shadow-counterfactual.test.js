// agent/services/tick-shadow-counterfactual.test.js — plan P2: the shadow
// book re-scored with the live stop floor (tick_firer.cpp:148-150) and the
// counter-trend filter as of each trade's entry. Report only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { shadowCounterfactual, stopFloorWire } from './tick-shadow-counterfactual.js'

const DEMO = '46979908'
const T0 = Date.parse('2026-09-20T12:00:00Z')
const NOW = T0 + 86_400_000
const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

function fixture() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  setState(db, 'symbol_id_map', JSON.stringify({ GBPUSD: 2, XAUUSD: 3 }))
  // the account's own map spells EURUSD in lower case: the regimes table is
  // upper case, so the lookup must upper-case or it reads no regime
  setState(db, accountSymbolMapKey(DEMO), JSON.stringify({ map: { eurusd: 1 } }))
  setState(db, 'regime_gate_json', JSON.stringify({ on: true, maxRegimeAgeMin: 240 }))
  // EURUSD: 'short' 5 min before the entries, and a LATER opposite 'long'
  // row 10 min after — a newest-row read would see 'long'
  db.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)').run('EURUSD', 'trending', 'short', fmt(T0 - 5 * 60_000))
  db.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)').run('EURUSD', 'trending', 'long', fmt(T0 + 10 * 60_000))
  let seq = 0
  const row = (symbolId, side, entry, stopDistance, netR, { entryMs = T0 } = {}) => {
    seq += 1
    db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, entry, stop_distance, reason, entry_ms, exit_ms, gross_r, net_r)
                VALUES ('cpp_exec_demo', 'b1', ?, ?, 'p1', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(seq, symbolId, side, entry, stopDistance, netR > 0 ? 'target' : 'stop', entryMs, entryMs + 60_000 + seq, netR, netR)
  }
  row(2, 'BUY', 100000, 10, -1)       // 1 below the floor (150)           → removed: stopFloor
  row(2, 'BUY', 100000, 150, 2)       // 2 exactly at the floor             → kept (a `<=` would remove it)
  row(2, 'BUY', 100100, 150, -1)      // 3 floor llround(150.15) = 150      → kept (an unrounded compare would remove it)
  row(1, 'BUY', 100000, 200, -1)      // 4 BUY into the as-of 'short'        → removed: counterTrend
  row(3, 'SELL', 100000, 200, 1)      // 5 XAUUSD, no regime row            → kept, noRegimeReading
  row(1, 'SELL', 100000, 200, -1)     // 6 SELL with the 'short'             → kept
  row(1, 'SELL', 100000, 300, 3)      // 7 SELL with the 'short'             → kept
  row(1, 'BUY', 100000, 10, -1)       // 8 both filters                      → removed: both
  row(1, 'BUY', 100000, 10, -1, { entryMs: T0 - 40 * 86_400_000 }) // outside the 30-day window
  return db
}

test('stopFloorWire copies tick_firer.cpp: llround(frac × entry), 0 when frac is not > 0', () => {
  assert.equal(stopFloorWire(0.0015, 100000), 150)
  assert.equal(stopFloorWire(0.0015, 100100), 150)
  assert.equal(stopFloorWire(0.0015, 100400), 151)
  assert.equal(stopFloorWire(0, 100000), 0)
})

test('shadowCounterfactual: each filter\'s removals, the boundary and rounding rows kept, the as-of reading, kept + removed = population', () => {
  const db = fixture()
  const r = shadowCounterfactual(db, { side: 'cpp_exec_demo', now: NOW })
  assert.equal(r.minStopFraction, 0.0015, 'read from agent/config/tick-entry.json')
  assert.deepEqual(r.regimeGate, { on: true, maxRegimeAgeMin: 240 })
  assert.equal(r.rows, 8); assert.equal(r.truncated, false)
  assert.deepEqual(r.removedBy, { stopFloor: 1, counterTrend: 1, both: 1 })
  assert.equal(r.noRegimeReading, 4, 'GBPUSD ×3 and XAUUSD have no regime row')
  assert.equal(r.population.trades, 8)
  assert.equal(r.kept.trades, 5); assert.equal(r.removed.trades, 3)
  assert.equal(r.kept.trades + r.removed.trades, r.population.trades); assert.equal(r.sumsToPopulation, true)
  assert.equal(r.kept.profitFactor, 3); assert.equal(r.kept.winPct, 60)
  assert.equal(r.removed.wins, 0); assert.equal(r.removed.netR, -3)
  assert.equal(r.population.profitFactor, 1.2)
  assert.ok(r.notRescored.some(s => s.startsWith('price_bound')))
  assert.ok(r.notRescored.includes('max_positions'))
})

test('shadowCounterfactual: the gate switched off means no reading — nothing removed for trend, all counted', () => {
  const db = fixture()
  setState(db, 'regime_gate_json', JSON.stringify({ on: false }))
  const r = shadowCounterfactual(db, { side: 'cpp_exec_demo', now: NOW })
  assert.deepEqual(r.removedBy, { stopFloor: 2, counterTrend: 0, both: 0 })
  assert.equal(r.noRegimeReading, 8)
})

test('shadowCounterfactual: an explicit row limit is honoured and reported as truncated', () => {
  const r = shadowCounterfactual(fixture(), { side: 'cpp_exec_demo', now: NOW, limit: 3 })
  assert.equal(r.rows, 3); assert.equal(r.truncated, true)
})

test('GET /state/tick-shadow-counterfactual: every side, one side, and a bad side is 400', async () => {
  const db = fixture()
  const { default: stateRouter } = await import('../routes/state.js')
  const app = express()
  app.use('/state', stateRouter(db))
  const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)) })
  try {
    const base = `http://127.0.0.1:${s.address().port}/state/tick-shadow-counterfactual`
    const all = await fetch(base).then(x => x.json())
    assert.deepEqual(all.sides.map(x => x.side), ['cpp_exec_demo', 'cpp_exec'])
    const one = await fetch(`${base}?side=cpp_exec_demo&days=3650`).then(x => x.json())
    assert.equal(one.sides.length, 1); assert.equal(one.days, 365)
    assert.equal(one.sides[0].population.trades, 9, 'the 40-day-old row is inside a 365-day window')
    const bad = await fetch(`${base}?side=nope`)
    assert.equal(bad.status, 400)
  } finally { s.close() }
})
