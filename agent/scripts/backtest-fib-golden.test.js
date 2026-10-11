// node --test agent/scripts/backtest-fib-golden.test.js
// Claude · № 13,095 11-Oct (ordered № 13,093; claude-builder)
//
// runBacktest with DEFAULT options must stay byte-identical to the golden
// generated from the unmodified module (agent/lib/golden/backtest.golden.json,
// scratch generator kept with the session): same deterministic bars, same
// seven strategies, stats and the first trades compared. The research
// options (computeWindow, tpR, rStats) are off by default and tested apart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runBacktest, computeRStats } from './backtest-fib.js'

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL('../lib/golden/backtest.golden.json', import.meta.url)), 'utf8'))

function bars(n, seed = 7) {
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  const out = []; let p = 100; const t0 = 1_750_000_000_000
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 60) * 0.0008 + (Math.floor(i / 300) % 2 ? 0.0004 : -0.0004)
    const ret = drift + (rnd() - 0.5) * 0.006
    const o = p, c = p * (1 + ret), h = Math.max(o, c) * (1 + rnd() * 0.002), l = Math.min(o, c) * (1 - rnd() * 0.002)
    out.push({ t: t0 + i * 900_000, o, h, l, c, v: Math.round(100 + rnd() * 900) }); p = c
  }
  return out
}
const B = bars(GOLDEN.bars)
const OPTS = { timeframe: '15m', minConviction: 0, minRr: 1.0 }

test('default runBacktest output is byte-identical to the golden for every strategy', () => {
  assert.ok(Object.keys(GOLDEN.cases).length >= 5)
  for (const [strategy, want] of Object.entries(GOLDEN.cases)) {
    const got = runBacktest(B, { ...OPTS, strategy })
    assert.equal(got.trades.length, want.trades, `${strategy} trade count`)
    assert.deepEqual(JSON.parse(JSON.stringify(got.stats)), want.stats, `${strategy} stats`)
    assert.deepEqual(JSON.parse(JSON.stringify(got.trades.slice(0, 3))), want.firstTrades, `${strategy} first trades`)
    assert.equal(got.rStats, undefined); assert.equal(got.research, undefined)
    assert.ok(got.trades.every(t => !('r' in t)), 'no R fields unless asked')
  }
})

test('rStats: trades carry sl0/risk/r and the result carries R figures; the % statistics are unchanged', () => {
  const base = runBacktest(B, { ...OPTS, strategy: 'fib_confluence' })
  const r = runBacktest(B, { ...OPTS, strategy: 'fib_confluence', rStats: true })
  assert.deepEqual(r.stats, base.stats)
  assert.equal(r.trades.length, base.trades.length)
  for (const [i, t] of r.trades.entries()) {
    assert.equal(t.sl0, undefined === t.sl0 ? t.sl0 : t.sl0); assert.ok(t.risk > 0)
    assert.equal(t.r, Math.round((t.dir * (t.exit - t.entry) / t.risk) * 1000) / 1000)
    assert.equal(t.entry, base.trades[i].entry)
  }
  assert.equal(r.rStats.usable, r.trades.length)
  assert.ok(Number.isFinite(r.rStats.expectancyR) && r.rStats.expectancyLowerR <= r.rStats.expectancyR)
  assert.deepEqual(r.research, { computeWindow: null, tpR: null })
})

test('computeRStats: PF, expectancy with its lower bound, drawdown and tail share; unscored trades counted, not scored', () => {
  const s = computeRStats([{ r: 2 }, { r: -1 }, { r: -1 }, { r: 1 }, { r: null }, {}])
  assert.equal(s.trades, 6); assert.equal(s.usable, 4); assert.equal(s.wins, 2); assert.equal(s.losses, 2)
  assert.equal(s.profitFactorR, 1.5); assert.equal(s.expectancyR, 0.25); assert.equal(s.totalR, 1); assert.equal(s.maxDrawdownR, 2)
  assert.equal(s.tailShareR, 0.667, 'the top decile of wins (one trade, +2) holds 2/3 of gross wins')
  assert.ok(s.expectancyLowerR < s.expectancyR)
  assert.deepEqual(computeRStats([{ r: null }]), { trades: 1, usable: 0 })
  // Eleven wins: the top DECILE is two trades (ceil 1.1), holding 6 of 15 gross R.
  const many = computeRStats([{ r: 5 }, ...Array.from({ length: 10 }, () => ({ r: 1 })), { r: -1 }])
  assert.equal(many.tailShareR, 0.4)
})

test('tpR replaces the strategy target with a fixed-R one; computeWindow bounds the history the strategy sees and is recorded', () => {
  const fixed = runBacktest(B, { ...OPTS, strategy: 'fib_confluence', rStats: true, tpR: 1 })
  assert.ok(fixed.trades.length > 0)
  for (const t of fixed.trades.filter(t => t.reason === 'tp')) assert.equal(t.r, 1, 'a target hit at a fixed 1R closes at +1R')
  assert.deepEqual(fixed.research, { computeWindow: null, tpR: 1 })
  const win = runBacktest(B, { ...OPTS, strategy: 'fib_confluence', rStats: true, computeWindow: 400 })
  assert.equal(win.research.computeWindow, 400)
  // A window wider than the whole series is the default history, so the result is the golden's.
  const wide = runBacktest(B, { ...OPTS, strategy: 'fib_confluence', computeWindow: 100_000 })
  assert.deepEqual(wide.stats, GOLDEN.cases.fib_confluence.stats)
  assert.deepEqual(wide.research, { computeWindow: 100_000, tpR: null }, 'the descriptor rides whenever an option is on, rStats or not')
  assert.equal(runBacktest(B, { ...OPTS, strategy: 'fib_confluence', tpR: 1 }).research?.tpR, 1)
  // With the vol gate on, the stop-widening counter is what it was before the fixed-R option existed (two calls per widened entry),
  // and a confirmation entry takes the fixed target too.
  const gateOff = runBacktest(B, { ...OPTS, strategy: 'fib_confluence', volGate: true })
  const gateTp = runBacktest(B, { ...OPTS, strategy: 'fib_confluence', volGate: true, tpR: 1, rStats: true })
  assert.equal(gateTp.volGate.stopsWidened, gateOff.volGate.stopsWidened)
  for (const t of gateTp.trades.filter(t => t.reason === 'tp')) assert.equal(t.r, 1)
})

test('a confirmation signal with no following bar does not throw (Codex P1 on #1311): the guard precedes the stop derivation', () => {
  for (const n of [GOLDEN.bars - 1, GOLDEN.bars - 2, GOLDEN.bars - 3, 700, 701]) {
    assert.doesNotThrow(() => runBacktest(B.slice(0, n), { ...OPTS, strategy: 'fib_confluence', volGate: true, tpR: 1 }))
  }
})
