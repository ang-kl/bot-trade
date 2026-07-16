// ---------------------------------------------------------------------------
// agent/scripts/backtest-parity.mjs — JS↔C++ backtest parity harness.
//
// Generates 5 seeded synthetic 1h series (mulberry32 PRNG, 600 bars each:
// random walk with regime shifts + volume), runs the JS runBacktest +
// walkForward (source of truth) and the C++ sidecar in --backtest CLI mode
// on identical inputs, and diffs the results:
//   - trade COUNT: exact
//   - per-trade reason/entryT/exitT/dir: exact
//   - per-trade entry/exit/pnlPct + stat floats: |a-b| <= 1e-9
//   - stats subset (ported fields only): trades/wins/losses/winRatePct/
//     profitFactor/totalProfitPct/maxDrawdownPct
//   - wf: segments (same fields), active/positive exact, worstMddPct epsilon
//
// Usage:  node agent/scripts/backtest-parity.mjs [path/to/cpp-exec]
// Exits 0 on full parity, 1 with a readable diff otherwise, 2 if the binary
// is missing.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runBacktest, walkForward } from './backtest-fib.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
export const DEFAULT_BINARY = path.join(REPO_ROOT, 'cpp-exec', 'bin', 'cpp-exec')

const EPS = 1e-9
const SEEDS = [1, 2, 3, 4, 5]
const ENTRY_MODES = ['close', 'touch']
const TIMEFRAME = '1h'
const TF_MINUTES = 60
const MIN_CONVICTION = 8

// mulberry32 — tiny deterministic PRNG (same core as backtest-fib.js's
// bootstrap sampler, reused here so series are reproducible everywhere).
function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Synthetic 1h OHLCV series: a random walk whose drift flips sign every
 * ~60-90 bars (regime shifts) so real swing legs form (impulse up, fade
 * down) — that shape is what makes computeFibSignal fire. Tuned so the JS
 * engine produces >= 1 trade on >= 2 of the 5 seeds.
 */
export function genBars(seed, n = 600) {
  const rand = mulberry32(seed)
  const bars = []
  const t0 = 1700000000000 // fixed epoch base; 1h spacing
  let price = 100
  let drift = 0.28          // % per bar while trending
  let barsToFlip = 60 + Math.floor(rand() * 30)
  for (let i = 0; i < n; i++) {
    if (--barsToFlip <= 0) {
      drift = -drift
      barsToFlip = 60 + Math.floor(rand() * 30)
    }
    const noise = (rand() - 0.5) * 0.5      // % noise
    const o = price
    const c = o * (1 + (drift + noise) / 100)
    const wickUp = rand() * 0.15 / 100
    const wickDn = rand() * 0.15 / 100
    const h = Math.max(o, c) * (1 + wickUp)
    const l = Math.min(o, c) * (1 - wickDn)
    const v = 100 + Math.floor(rand() * 900)
    bars.push({ t: t0 + i * 3_600_000, o, h, l, c, v })
    price = c
  }
  return bars
}

/** Pick out ONLY the stat fields the C++ port carries (v1 contract). */
function portedStats(stats) {
  if (!stats || stats.trades === 0) return { trades: 0 }
  return {
    trades: stats.trades,
    wins: stats.wins,
    losses: stats.losses,
    winRatePct: stats.winRatePct,
    profitFactor: stats.profitFactor,
    totalProfitPct: stats.totalProfitPct,
    maxDrawdownPct: stats.maxDrawdownPct,
  }
}

function nearlyEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  return Math.abs(a - b) <= EPS
}

/** Diff one JS-vs-C++ result pair; returns array of human-readable problems. */
function diffResults(js, cpp, label) {
  const problems = []
  const p = msg => problems.push(`[${label}] ${msg}`)

  // trades — count exact
  const jt = js.trades, ct = cpp.trades || []
  if (jt.length !== ct.length) {
    p(`trade count mismatch: js=${jt.length} cpp=${ct.length}`)
  } else {
    for (let i = 0; i < jt.length; i++) {
      const a = jt[i], b = ct[i]
      for (const f of ['dir', 'entryT', 'exitT', 'reason']) {
        if (a[f] !== b[f]) p(`trade[${i}].${f}: js=${a[f]} cpp=${b[f]} (exact)`)
      }
      for (const f of ['entry', 'exit', 'pnlPct']) {
        if (!nearlyEqual(a[f], b[f])) p(`trade[${i}].${f}: js=${a[f]} cpp=${b[f]} (eps ${EPS})`)
      }
    }
  }

  // stats — ported subset
  const js_ = portedStats(js.stats), cs = cpp.stats || {}
  for (const f of ['trades', 'wins', 'losses']) {
    if ((js_[f] ?? 0) !== (cs[f] ?? 0)) p(`stats.${f}: js=${js_[f]} cpp=${cs[f]} (exact)`)
  }
  for (const f of ['winRatePct', 'profitFactor', 'totalProfitPct', 'maxDrawdownPct']) {
    if (f in js_ && !nearlyEqual(js_[f], cs[f])) p(`stats.${f}: js=${js_[f]} cpp=${cs[f]} (eps ${EPS})`)
  }

  // wf
  const jw = js.wf, cw = cpp.wf || {}
  for (const f of ['active', 'positive']) {
    if (jw[f] !== cw[f]) p(`wf.${f}: js=${jw[f]} cpp=${cw[f]} (exact)`)
  }
  if (!nearlyEqual(jw.worstMddPct, cw.worstMddPct)) p(`wf.worstMddPct: js=${jw.worstMddPct} cpp=${cw.worstMddPct}`)
  const jsegs = jw.segments, csegs = cw.segments || []
  if (jsegs.length !== csegs.length) {
    p(`wf.segments length: js=${jsegs.length} cpp=${csegs.length}`)
  } else {
    for (let k = 0; k < jsegs.length; k++) {
      if (jsegs[k].trades !== (csegs[k].trades ?? -1)) p(`wf.seg[${k}].trades: js=${jsegs[k].trades} cpp=${csegs[k].trades}`)
      for (const f of ['totalProfitPct', 'maxDrawdownPct']) {
        if (!nearlyEqual(jsegs[k][f], csegs[k][f])) p(`wf.seg[${k}].${f}: js=${jsegs[k][f]} cpp=${csegs[k][f]}`)
      }
    }
  }
  return problems
}

function runCpp(binary, bars, entryMode) {
  const payload = JSON.stringify({
    bars: bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]),
    timeframe: TIMEFRAME,
    tfMinutes: TF_MINUTES,
    capMinutes: null,
    entryMode,
    minConviction: MIN_CONVICTION,
  })
  const r = spawnSync(binary, ['--backtest'], { input: payload, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`spawn failed: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`cpp exited ${r.status}: ${(r.stderr || '').slice(0, 500)}`)
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`cpp stdout is not JSON: ${r.stdout.slice(0, 300)}`)
  }
}

export function runParity(binary = DEFAULT_BINARY) {
  if (!existsSync(binary)) {
    console.error(`cpp binary not found at ${binary} — build cpp-exec first (make -C cpp-exec)`)
    return 2
  }

  let allProblems = []
  const counts = []
  for (const seed of SEEDS) {
    const bars = genBars(seed)
    for (const entryMode of ENTRY_MODES) {
      const opts = { timeframe: TIMEFRAME, entryMode, minConviction: MIN_CONVICTION }
      const js = runBacktest(bars, opts)
      const wf = walkForward(bars, opts, 4)
      const label = `seed=${seed} mode=${entryMode}`
      counts.push({ seed, entryMode, jsTrades: js.trades.length })
      let cpp
      try {
        cpp = runCpp(binary, bars, entryMode)
      } catch (err) {
        allProblems.push(`[${label}] ${err.message}`)
        continue
      }
      allProblems = allProblems.concat(diffResults({ ...js, wf }, cpp, label))
    }
  }

  console.log('per-seed JS trade counts:')
  for (const c of counts) console.log(`  seed=${c.seed} mode=${c.entryMode} trades=${c.jsTrades}`)
  const seedsWithTrades = new Set(counts.filter(c => c.jsTrades > 0).map(c => c.seed))
  console.log(`seeds with >=1 JS trade: ${seedsWithTrades.size}/5`)
  if (seedsWithTrades.size < 2) {
    console.error('GENERATOR TOO QUIET: fewer than 2 seeds produce trades — retune drift/vol')
    return 1
  }

  if (allProblems.length) {
    console.error(`\nPARITY FAIL — ${allProblems.length} mismatch(es):`)
    for (const m of allProblems) console.error('  ' + m)
    return 1
  }
  console.log('\nPARITY OK — all seeds × entry modes match (exact ints, 1e-9 floats)')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runParity(process.argv[2] || DEFAULT_BINARY))
}
