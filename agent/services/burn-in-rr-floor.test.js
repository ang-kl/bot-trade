// node --test agent/services/burn-in-rr-floor.test.js
//
// THE COLLISION THIS PINS (measured 22-08-2026). Burn-in exists to
// manufacture a clean sample: pinned 0.01-lot orders through the FULL risk
// gate, origin-stamped, postmortem-able. Its target was hardcoded
// `slDist * 1.6 // RR 1.6 clears the minRR 1.5 gate` — written when 1.5 WAS
// the gate. The gate is now HARD_MIN_RR 3.0 plus an account-wide expectancy
// clause demanding ~3.4-3.6 at the measured win rate, so arming burn-in
// produced nothing but `bad_rr 1.60<3` vetoes: the instrument built to
// generate clean data was the one guaranteed to generate none.
//
// The fix asks the gate what it will demand (risk.js effectiveRrFloor, built
// from the SAME functions the gate runs) instead of remembering an answer.
// Most of this file therefore tests that the two cannot disagree.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { effectiveRrFloor, HARD_MIN_RR, expectancyVerdict } from './risk.js'
import { runBurnIn, RR_HEADROOM } from './burn-in.js'

// ---- effectiveRrFloor: the three layers ------------------------------------

test('a thin sample leaves the static hard floor — expectancy fails open', () => {
  const db = initDB(':memory:')
  assert.equal(effectiveRrFloor(db, 'A', 'burnin'), HARD_MIN_RR)
})

/** Seed `wins`+`losses` closed trades (±100 each) on one account, recent. */
function seed(db, acct, wins, losses) {
  const ins = db.prepare(
    "INSERT INTO trades (symbol, side, status, account_id, net_pnl, closed_at) VALUES ('EURUSD','long','closed',?,?,datetime('now','-1 day'))")
  for (let i = 0; i < wins; i++) ins.run(acct, 100)
  for (let i = 0; i < losses; i++) ins.run(acct, -100)
}

test('THE PRODUCTION SHAPE: a ~25% win rate raises the floor to what the gate will demand', () => {
  // 6 wins / 18 losses = W 0.25 → need = (0.15 + 0.75) / 0.25 = 3.6.
  // This is the demand the expectancy veto quotes; a burn-in target at
  // exactly 3.0 would clear the static floor and die on this clause instead.
  const db = initDB(':memory:')
  seed(db, 'A', 6, 18)
  const floor = effectiveRrFloor(db, 'A', 'burnin')
  assert.equal(floor, 3.6)
})

test('an owner minRR ABOVE the hard floor is honoured, not flattened to 3', () => {
  const db = initDB(':memory:')
  setState(db, 'risk_config_json', JSON.stringify({ minRR: 4.2, minExpectancyR: 0.15 }))
  assert.equal(effectiveRrFloor(db, 'A', 'burnin'), 4.2)
})

test('a strategy floor BELOW the hard floor is overridden — rsi2 still gets 3', () => {
  // The documented cost of HARD_MIN_RR (risk.js:65): the declared 1.0 does
  // not survive. If this ever changes, it changes in risk.js, and this test
  // moves with it because both read the same function.
  const db = initDB(':memory:')
  assert.equal(effectiveRrFloor(db, 'A', 'rsi2_reversion'), HARD_MIN_RR)
})

test('every layer only ever raises: floor >= hard floor for any inputs', () => {
  const db = initDB(':memory:')
  seed(db, 'A', 19, 1) // 95% win rate → need ≈ 0.34, far below the hard floor
  assert.ok(effectiveRrFloor(db, 'A', 'burnin') >= HARD_MIN_RR)
})

test('the floor it returns actually SATISFIES the expectancy verdict it came from', () => {
  // The consistency property that makes divergence impossible: a target at
  // floor + headroom must pass the exact clause the gate runs.
  const db = initDB(':memory:')
  seed(db, 'A', 6, 18)
  const floor = effectiveRrFloor(db, 'A', 'burnin')
  const stats = { trades: 24, winRate: 0.25 }
  const ev = expectancyVerdict(stats, floor + RR_HEADROOM, { minE: 0.15 })
  assert.equal(ev.ok, true, JSON.stringify(ev))
})

// ---- runBurnIn: the synth is built floor-aware -----------------------------

const DAY = 86_400_000
function bars() {
  const out = []
  for (let i = 0; i < 40; i++) {
    const p = 100 + i * 0.1
    out.push({ t: i * 60_000, o: p, h: p + 0.2, l: p - 0.2, c: p + 0.05, v: 100 })
  }
  return out
}
function mkDb() {
  const db = initDB(':memory:')
  setState(db, 'burn_in_json', JSON.stringify({ on: true }))
  setState(db, 'autotrade_enabled', 'true')
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true }]))
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  return db
}
const CREDS = { ready: true, accountId: 'A' }
function deps(placed, riskMod) {
  return {
    autoTrade: async (_db, symbol, synth, wItem) => { placed.push({ symbol, synth, wItem }); return { ok: true } },
    wsGetTrendbarsBatch: async () => ({ '1m': bars(), '5m': bars(), '15m': bars(), '30m': bars(), '1h': bars() }),
    ...(riskMod ? { risk: riskMod } : {}),
    isSymbolMarketOpen: () => ({ open: true }),
    now: () => 1_000_000_000_000,
  }
}
const rrOf = (p) => Math.abs(p.synth.tp1 - p.synth.entry) / Math.abs(p.synth.entry - p.synth.sl)

test('with the REAL risk module, the target tracks the account\'s measured demand', async () => {
  // Same 25%-win seed → floor 3.6 → target 3.65×SL. The proposer follows the
  // gate wherever the win rate moves it, headroom included.
  const db = mkDb()
  seed(db, 'A', 6, 18)
  const placed = []
  const out = await runBurnIn(db, CREDS, deps(placed)) // deps.risk absent → real ./risk.js
  assert.ok(placed.length > 0, JSON.stringify(out))
  for (const p of placed) assert.ok(Math.abs(rrOf(p) - 3.65) < 1e-9, `got ${rrOf(p)}`)
})

test('a risk stub WITHOUT effectiveRrFloor still clears the hard floor, never 1.6', async () => {
  // The fallback path: older stubs (and a hypothetical broken import) must
  // fail toward a target the real gate would accept, not toward the dead 1.6.
  const db = mkDb()
  const placed = []
  await runBurnIn(db, CREDS, deps(placed, { loadRiskConfig: () => ({ minSLDistancePct: 0.0015 }) }))
  assert.ok(placed.length > 0)
  for (const p of placed) assert.ok(Math.abs(rrOf(p) - (3 + RR_HEADROOM)) < 1e-9, `got ${rrOf(p)}`)
})

test('THE DEAD CONSTANT IS GONE: no burn-in target can sit below the hard floor', async () => {
  const db = mkDb()
  const placed = []
  await runBurnIn(db, CREDS, deps(placed))
  for (const p of placed) assert.ok(rrOf(p) >= HARD_MIN_RR, `target ${rrOf(p)} would be vetoed on arrival`)
})
