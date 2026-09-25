// agent/services/tick-shadow-counterfactual.test.js — plan P2: the shadow
// book re-scored with the live stop floor (tick_firer.cpp:148-150) and the
// counter-trend filter as of each trade's entry. Report only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { shadowCounterfactual, shadowCounterfactualView, stopFloorWire, asOfTrendReader, splitStats, MAX_COUNTERFACTUAL_DAYS } from './tick-shadow-counterfactual.js'
import { trendReadingAt } from './direction-policy.js'
import { loadRegimeGateConfig } from './regime-gate.js'
import { portfolioStats } from './tick-shadow.js'

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

test('shadowCounterfactual: an explicit row limit is honoured, reported as truncated, and keeps the NEWEST rows in exit order', () => {
  const db = fixture()
  const r = shadowCounterfactual(db, { side: 'cpp_exec_demo', now: NOW, limit: 3 })
  assert.equal(r.rows, 3); assert.equal(r.truncated, true); assert.equal(r.truncation, 'the newest rows are kept')
  // rows 6, 7 and 8 exit last (exit_ms = entry + 60 s + seq): 6 and 7 kept (+2 R net), 8 removed by both
  assert.equal(r.population.trades, 3); assert.equal(r.population.netR, 1)
  assert.deepEqual(r.removedBy, { stopFloor: 0, counterTrend: 0, both: 1 })
})

/** A database whose prepared statements count the regime reads and the gate-config reads. */
function counting(db) {
  const counts = { regimeReads: 0, gateReads: 0 }
  const wrap = (st, kind) => new Proxy(st, {
    get(t, prop) {
      const v = t[prop]
      if (typeof v !== 'function') return v
      if (prop === 'get' || prop === 'all' || prop === 'iterate') {
        return (...a) => { if (kind === 'regime') counts.regimeReads++; else if (a[0] === 'regime_gate_json') counts.gateReads++; return v.apply(t, a) }
      }
      return v.bind(t)
    },
  })
  const pdb = new Proxy(db, {
    get(t, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          const st = t.prepare(sql)
          if (/\bFROM regimes\b/.test(sql)) return wrap(st, 'regime')
          if (/\bFROM agent_state\b/.test(sql)) return wrap(st, 'state')
          return st
        }
      }
      const v = t[prop]
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  return { pdb, counts }
}

test('asOfTrendReader answers exactly as trendReadingAt, row for row — every gate shape, ties, stale gaps, before the first row', () => {
  const db = initDB(':memory:')
  const ins = db.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)')
  const dirs = ['long', 'short', 'flat', null]
  let k = 0
  for (let m = 0; m < 3 * 24 * 60; m += 37) {
    if (m > 20 * 60 && m < 26 * 60) continue          // a six-hour gap: past the 240-minute bound
    ins.run('EURUSD', 'trending', dirs[k++ % 4], fmt(T0 + m * 60_000))
  }
  ins.run('EURUSD', 'trending', 'long', fmt(T0 + 600 * 60_000))    // a tie on a stamp: two rows, the later id
  ins.run('EURUSD', 'trending', 'short', fmt(T0 + 600 * 60_000))
  const asOfs = []
  for (let ms = T0 - 3_600_000; ms < T0 + 3 * 86_400_000 + 3_600_000; ms += 7 * 60_000 + 13_457) asOfs.push(ms)
  asOfs.push(T0 + 600 * 60_000, T0 + 600 * 60_000 + 999, T0 + 599 * 60_000 + 59_999)
  const shapes = [{ on: true, maxRegimeAgeMin: 240 }, { on: true, maxRegimeAgeMin: 30 }, { on: true, maxRegimeAgeMin: 0 }, { on: true }, { on: false }]
  let compared = 0, nonNull = 0
  for (const shape of shapes) {
    setState(db, 'regime_gate_json', JSON.stringify(shape))
    const r = asOfTrendReader(db, { gate: loadRegimeGateConfig(db), minAsOfMs: Math.min(...asOfs), maxAsOfMs: Math.max(...asOfs) })
    for (const ms of asOfs) {
      const want = trendReadingAt(db, 'EURUSD', ms)
      assert.equal(r.reading('EURUSD', ms), want, `${JSON.stringify(shape)} at ${new Date(ms).toISOString()}`)
      compared++; if (want != null) nonNull++
    }
    assert.equal(r.reading('GBPUSD', T0), trendReadingAt(db, 'GBPUSD', T0))
  }
  assert.ok(compared > 2000 && nonNull > 500, `${compared} compared, ${nonNull} with a reading — the comparison is not vacuous`)
})

test('splitStats counts kept/removed exactly as portfolioStats does, without the bootstrap', () => {
  const rows = [
    { net_r: 2, reason: 'target', exit_ms: 1 }, { net_r: -1, reason: 'stop', exit_ms: 2 }, { net_r: 0, reason: 'reset', exit_ms: 3 },
    { net_r: 1.5, reason: 'target', exit_ms: 4 }, { net_r: null, reason: 'lost_restart', exit_ms: 5 }, { net_r: 'x', reason: 'stop', exit_ms: 6 },
    { net_r: -0.25, reason: 'stop', exit_ms: 7 },
  ]
  for (const set of [rows, rows.slice(0, 2), [], [rows[0]]]) {
    const light = splitStats(set), full = portfolioStats(set)
    for (const f of ['trades', 'wins', 'losses', 'winPct', 'netR', 'avgR', 'grossWinR', 'grossLossR', 'profitFactor', 'lost']) assert.deepEqual(light[f], full[f], f)
    assert.equal('expectancyLowerR' in light, false)
  }
})

test('bounded (PR #1086 blocker 3): 9,000 rows over 3 symbols — one gate read, regime reads ≤ symbols, no bootstrap on kept/removed', () => {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, XAUUSD: 3 }))
  setState(db, 'regime_gate_json', JSON.stringify({ on: true, maxRegimeAgeMin: 240 }))
  const start = NOW - 29 * 86_400_000
  const insR = db.prepare('INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, ?)')
  const insT = db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, entry, stop_distance, reason, entry_ms, exit_ms, gross_r, net_r)
                           VALUES ('cpp_exec_demo', 'b1', ?, ?, 'p1', ?, 100000, ?, ?, ?, ?, ?, ?)`)
  db.transaction(() => {
    for (const sym of ['EURUSD', 'GBPUSD', 'XAUUSD']) {
      for (let ms = start - 86_400_000; ms <= NOW; ms += 15 * 60_000) insR.run(sym, 'trending', (ms / 900_000) % 3 === 0 ? 'short' : 'long', fmt(ms))
    }
    for (let i = 0; i < 9000; i++) {
      const entry = start + i * 270_000
      const r = [2, -1, -1, 1.5][i % 4]
      insT.run(i + 1, (i % 3) + 1, i % 2 ? 'SELL' : 'BUY', i % 7 ? 200 : 10, r > 0 ? 'target' : 'stop', entry, entry + 60_000, r, r)
    }
  })()
  const { pdb, counts } = counting(db)
  const t0 = process.hrtime.bigint()
  const view = shadowCounterfactualView(pdb, { side: 'cpp_exec_demo', now: NOW })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const r = view.sides[0]
  assert.equal(r.rows, 9000); assert.equal(r.truncated, false)
  assert.equal(counts.gateReads, 1, 'the gate config is read once, not per row')
  assert.ok(counts.regimeReads <= 3, `${counts.regimeReads} regime reads for 3 symbols — per-row reads are the regression`)
  assert.equal(r.regimeQueries, 3)
  assert.ok(r.removedBy.counterTrend > 0 && r.removedBy.stopFloor > 0, 'both filters fired: the reads were not vacuous')
  assert.equal(r.kept.trades + r.removed.trades, 9000)
  assert.equal('expectancyLowerR' in r.kept, false); assert.equal('expectancyLowerR' in r.removed, false)
  assert.equal(typeof r.population.expectancyLowerR, 'number')
  assert.ok(ms < 5000, `9,000 rows took ${ms.toFixed(0)} ms`)
})

test('shadowCounterfactual: days is clamped to 30 (regimes are pruned at about that age)', () => {
  const db = fixture()
  const r = shadowCounterfactual(db, { side: 'cpp_exec_demo', now: NOW, days: 365 })
  assert.equal(MAX_COUNTERFACTUAL_DAYS, 30)
  assert.equal(r.days, 30); assert.equal(r.rows, 8, 'the 40-day-old row stays outside')
})

test('shadowCounterfactualView without an explicit now is memoised per database, side and window', () => {
  const db = fixture()
  const a = shadowCounterfactualView(db, { side: 'cpp_exec_demo' })
  const b = shadowCounterfactualView(db, { side: 'cpp_exec_demo' })
  assert.equal(a.memoised, false); assert.equal(b.memoised, true); assert.equal(b.computedAt, a.computedAt)
  assert.equal(shadowCounterfactualView(db, { side: 'cpp_exec' }).memoised, false, 'another side is its own entry')
  assert.equal(shadowCounterfactualView(fixture(), { side: 'cpp_exec_demo' }).memoised, false, 'another database is its own entry')
  assert.equal(shadowCounterfactualView(db, { side: 'cpp_exec_demo', now: NOW }).memoised, false, 'an explicit now is never memoised')
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
    assert.equal(one.sides.length, 1); assert.equal(one.days, 30, 'clamped to 30: regimes are pruned at about that age')
    assert.equal(one.sides[0].days, 30)
    const bad = await fetch(`${base}?side=nope`)
    assert.equal(bad.status, 400)
  } finally { s.close() }
})

test('the memoised view is dropped after a state write (regime-gate toggle)', async () => {
  const { invalidateStateCache } = await import('../lib/state-cache.js')
  const db = fixture()
  const a = shadowCounterfactualView(db, { side: 'cpp_exec_demo' })
  assert.equal(shadowCounterfactualView(db, { side: 'cpp_exec_demo' }).memoised, true)
  invalidateStateCache()
  const c = shadowCounterfactualView(db, { side: 'cpp_exec_demo' })
  assert.equal(c.memoised, false, 'RED if the memo survives a write: the view would report the old regime-gate setting')
  assert.ok(a)
})
