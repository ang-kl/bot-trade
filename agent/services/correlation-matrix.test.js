// node --test agent/services/correlation-matrix.test.js
//
// Live-computed correlation (owner: "I want the live-computed version").
// Pure math (returns/pearson/matrix) + the stacked-bet veto, plus the
// fetch+store job against an injected bar fetcher.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  logReturns, pearson, buildCorrelationMatrix, liveCorrelationVeto,
  computeAndStoreMatrix, loadStoredMatrix, loadCorrelationMatrixConfig,
  loadPreviousMatrix, topPairs, correlationShifts,
  DEFAULT_CORRELATION_MATRIX,
} from './correlation-matrix.js'

const bars = (closes) => closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }))

test('logReturns: n-1 returns, skips non-positive closes', () => {
  assert.deepEqual(logReturns(bars([100, 100])).length, 1)
  assert.equal(logReturns(bars([100])).length, 0)
})

test('pearson: perfectly correlated = 1, perfectly inverse = -1', () => {
  // Alternating up/down so the RETURNS (not prices) are what's correlated.
  const rA = logReturns(bars([100, 102, 100, 102, 100])) // +,-,+,-
  const rB = logReturns(bars([100, 98, 100, 98, 100]))   // -,+,-,+ → inverse
  assert.ok(Math.abs(pearson(rA, rA) - 1) < 1e-9)
  assert.ok(pearson(rA, rB) < -0.9)
  assert.equal(pearson([1], [1]), null) // too short
})

test('buildCorrelationMatrix: symmetric, diagonal 1', () => {
  const r = {
    A: logReturns(bars([10, 11, 12, 13, 14])),
    B: logReturns(bars([20, 22, 24, 26, 28])), // moves with A
  }
  const { m } = buildCorrelationMatrix(r)
  assert.equal(m.A.A, 1)
  assert.ok(m.A.B > 0.9)
  assert.equal(m.A.B, m.B.A)
})

const CFG = { threshold: 0.7, maxCorrelated: 2, maxAgeMin: 90 }

test('liveCorrelationVeto: the 3rd same-direction highly-correlated position is blocked', () => {
  // Proposal long C, already long A and B, all pairwise ~+0.9.
  const matrix = {
    builtAt: new Date().toISOString(),
    m: {
      A: { A: 1, B: 0.9, C: 0.85 }, B: { A: 0.9, B: 1, C: 0.88 }, C: { A: 0.85, B: 0.88, C: 1 },
    },
  }
  const held = [{ symbol: 'A', side: 'BUY' }, { symbol: 'B', side: 'BUY' }]
  const v = liveCorrelationVeto(held, { symbol: 'C', side: 'BUY' }, matrix, CFG, Date.now())
  assert.ok(v)
  assert.equal(v.stacked.length, 2)
})

test('liveCorrelationVeto: opposite direction on a NEGATIVE correlation also stacks risk', () => {
  // A and B move inversely (r -0.9). Long A + short B is the SAME bet.
  const matrix = { builtAt: new Date().toISOString(), m: { A: { A: 1, B: -0.9, C: -0.85 }, B: { A: -0.9, B: 1, C: 0.8 }, C: { A: -0.85, B: 0.8, C: 1 } } }
  // held long A, long C (C corr with A is -0.85 → long/long eff -0.85, NOT stacked)
  // proposal SHORT B: vs A (r -0.9)×(-1)×(+1)=+0.9 stacked; vs C (r 0.8)×(-1)×dir(C=BUY +1) = -0.8 not stacked
  const held = [{ symbol: 'A', side: 'BUY' }, { symbol: 'C', side: 'BUY' }]
  const v = liveCorrelationVeto(held, { symbol: 'B', side: 'SELL' }, matrix, { ...CFG, maxCorrelated: 1 }, Date.now())
  assert.ok(v)
  assert.deepEqual(v.stacked.map(s => s.symbol), ['A'])
})

test('liveCorrelationVeto: a hedge (negative effective corr) is never counted', () => {
  const matrix = { builtAt: new Date().toISOString(), m: { A: { A: 1, B: 0.9 }, B: { A: 0.9, B: 1 } } }
  // Long A held; SHORT B proposed → eff = 0.9 × (-1) × (+1) = -0.9 → hedge.
  const v = liveCorrelationVeto([{ symbol: 'A', side: 'BUY' }], { symbol: 'B', side: 'SELL' }, matrix, { ...CFG, maxCorrelated: 1 }, Date.now())
  assert.equal(v, null)
})

test('liveCorrelationVeto: stale or missing matrix fails open', () => {
  const stale = { builtAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), m: { A: { A: 1, B: 0.9 }, B: { A: 0.9, B: 1 } } }
  assert.equal(liveCorrelationVeto([{ symbol: 'A', side: 'BUY' }], { symbol: 'B', side: 'BUY' }, stale, { ...CFG, maxCorrelated: 1 }, Date.now()), null)
  assert.equal(liveCorrelationVeto([{ symbol: 'A', side: 'BUY' }], { symbol: 'B', side: 'BUY' }, null, CFG, Date.now()), null)
})

test('computeAndStoreMatrix: fetches, correlates, stores; reloadable', async () => {
  const db = initDB(':memory:')
  const series = {
    EURUSD: [1.10, 1.11, 1.12, 1.13, 1.14, 1.15],
    GBPUSD: [1.25, 1.26, 1.27, 1.28, 1.29, 1.30], // moves with EURUSD
  }
  const out = await computeAndStoreMatrix(db, ['EURUSD', 'GBPUSD'], {
    fetchBars: async (sym) => bars(series[sym]),
  }, '2026-07-20T12:00:00Z')
  assert.equal(out.built, 2)
  const stored = loadStoredMatrix(db)
  assert.ok(stored.m.EURUSD.GBPUSD > 0.9)
  assert.equal(stored.builtAt, '2026-07-20T12:00:00Z')
})

test('computeAndStoreMatrix: off switch + insufficient data short-circuit', async () => {
  const db = initDB(':memory:')
  setState(db, 'correlation_matrix_json', JSON.stringify({ on: false }))
  assert.deepEqual(await computeAndStoreMatrix(db, ['A', 'B'], { fetchBars: async () => [] }, 'x'), { skipped: 'off' })
  setState(db, 'correlation_matrix_json', JSON.stringify({ on: true }))
  const out = await computeAndStoreMatrix(db, ['A', 'B'], { fetchBars: async () => bars([1]) }, 'x')
  assert.equal(out.skipped, 'insufficient data')
})

test('config: defaults + clamps', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadCorrelationMatrixConfig(db), DEFAULT_CORRELATION_MATRIX)
  setState(db, 'correlation_matrix_json', JSON.stringify({ threshold: 5, maxCorrelated: 99 }))
  const cfg = loadCorrelationMatrixConfig(db)
  assert.equal(cfg.threshold, 0.99)
  assert.equal(cfg.maxCorrelated, 10)
})

// ---------------------------------------------------------------------------
// Surfacing the matrix — owner 05-08-2026: "The correlation card doesn't
// update when market shifted." Half display gap, half a real one: nothing
// retained the previous matrix, so "shifted" was not a computable quantity.
// ---------------------------------------------------------------------------

test('topPairs lists each pair once, strongest first', () => {
  const m = {
    symbols: ['A', 'B', 'C'],
    m: {
      A: { A: 1, B: 0.92, C: -0.81 },
      B: { A: 0.92, B: 1, C: 0.10 },
      C: { A: -0.81, B: 0.10, C: 1 },
    },
  }
  const pairs = topPairs(m, { min: 0.5 })
  // A/B and A/C only — the mirror half and the self-pairs are noise on a card.
  assert.deepEqual(pairs, [{ a: 'A', b: 'B', r: 0.92 }, { a: 'A', b: 'C', r: -0.81 }])
  // Ranked by MAGNITUDE: a -0.81 is as much a stacked bet as a +0.81 when the
  // two positions face opposite ways.
  assert.equal(Math.abs(pairs[0].r) >= Math.abs(pairs[1].r), true)
  assert.deepEqual(topPairs(null), [])
  assert.equal(topPairs(m, { min: 0.5, limit: 1 }).length, 1)
})

const mat = (ab) => ({ symbols: ['A', 'B'], m: { A: { A: 1, B: ab }, B: { A: ab, B: 1 } } })

test('a pair that BECAME correlated is named, not left as two decimals', () => {
  const [s] = correlationShifts(mat(0.85), mat(0.20))
  assert.equal(s.was, 0.2)
  assert.equal(s.r, 0.85)
  assert.equal(s.delta, 0.65)
  assert.equal(s.became, true, 'positions that were diversified now stack')
  assert.equal(s.broke, false)
})

test('a hedge that stopped working is its own finding', () => {
  const [s] = correlationShifts(mat(0.15), mat(0.90))
  assert.equal(s.broke, true, 'the offset you were relying on has gone')
  assert.equal(s.became, false)
})

test('a SIGN FLIP is called out separately — it inverts every stacked position', () => {
  const [s] = correlationShifts(mat(-0.80), mat(0.85))
  assert.equal(s.flipped, true)
  assert.equal(s.delta, -1.65)
})

test('a pair that barely moved is not reported at all', () => {
  assert.deepEqual(correlationShifts(mat(0.86), mat(0.85)), [])
})

test('no previous matrix means no shifts — never a fabricated one', () => {
  // The first run after a deploy has nothing to compare against. Reporting
  // every pair as "became correlated" would cry wolf on every restart.
  assert.deepEqual(correlationShifts(mat(0.9), null), [])
  assert.deepEqual(correlationShifts(null, mat(0.9)), [])
})

test('shifts are ranked by how far they moved, and capped', () => {
  const big = { symbols: ['A', 'B', 'C'], m: { A: { A: 1, B: 0.9, C: 0.9 }, B: { A: 0.9, B: 1, C: 0.9 }, C: { A: 0.9, B: 0.9, C: 1 } } }
  const small = { symbols: ['A', 'B', 'C'], m: { A: { A: 1, B: 0.6, C: 0.0 }, B: { A: 0.6, B: 1, C: 0.3 }, C: { A: 0.0, B: 0.3, C: 1 } } }
  const out = correlationShifts(big, small)
  assert.equal(out[0].delta >= out[1].delta, true)
  assert.equal(correlationShifts(big, small, { limit: 1 }).length, 1)
})

test('computeAndStoreMatrix keeps the outgoing matrix so a shift is diffable', async () => {
  const db = initDB(':memory:')
  // Same bar shape the module reads, with real variance — a constant series
  // has zero stdev and correlates with nothing, which would store no matrix.
  const series = (n, seed) => bars(Array.from({ length: n },
    (_, i) => 100 + Math.sin((i + seed) / 3) * 5 + i * 0.1))
  const deps = { fetchBars: async (sym) => series(70, sym === 'A' ? 0 : 1) }

  await computeAndStoreMatrix(db, ['A', 'B'], deps, '2026-08-05T00:00:00.000Z')
  // Nothing to keep on the FIRST run — and that must not be an error.
  assert.equal(loadPreviousMatrix(db), null)
  const first = loadStoredMatrix(db)
  assert.equal(first.builtAt, '2026-08-05T00:00:00.000Z')

  await computeAndStoreMatrix(db, ['A', 'B'], deps, '2026-08-05T00:30:00.000Z')
  assert.equal(loadStoredMatrix(db).builtAt, '2026-08-05T00:30:00.000Z')
  assert.equal(loadPreviousMatrix(db).builtAt, '2026-08-05T00:00:00.000Z',
    'without this the previous reading is gone and "what shifted" cannot be computed')
})
