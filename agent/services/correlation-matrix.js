// ---------------------------------------------------------------------------
// agent/services/correlation-matrix.js — LIVE-computed correlation.
//
// Owner: "I want the live-computed version." The curated clusters in
// correlation.js are a robust floor, but they can't see a correlation that
// isn't in the hand-written map (a new instrument, a regime where two
// normally-independent markets start moving together). This computes a
// rolling Pearson correlation matrix from recent bar returns across the
// symbols actually in play, stores it, and the risk gate uses it to block a
// proposal that would stack too many HIGHLY-correlated positions in the same
// directional-risk sense.
//
// Two positions stack risk when corr(returns) × dirA × dirB is strongly
// positive: same-direction on positively-correlated symbols, OR
// opposite-direction on negatively-correlated symbols — both are the same
// underlying bet. That signed product is the "effective correlation" the
// gate counts.
//
// Pure math (returns/pearson/matrix) is separated from the fetch+store job so
// it's testable without a broker. The compute job runs from the quant phase
// (~every 30 min); the matrix is cached in agent_state with a timestamp and
// treated as stale after `maxAgeMin`.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

export const DEFAULT_CORRELATION_MATRIX = {
  on: true,
  timeframe: '1h',    // bars to correlate on
  lookback: 60,       // number of returns in the window
  threshold: 0.7,     // |effective corr| at/above this = "highly correlated"
  maxCorrelated: 2,   // block when a proposal would make the Nth stacked bet
  maxAgeMin: 90,      // matrix older than this is ignored (fail open)
}

export function loadCorrelationMatrixConfig(db) {
  try {
    const p = JSON.parse(getState(db, 'correlation_matrix_json') || 'null')
    if (p && typeof p === 'object') {
      return {
        on: p.on !== false,
        timeframe: p.timeframe || DEFAULT_CORRELATION_MATRIX.timeframe,
        lookback: Math.min(300, Math.max(20, Math.round(Number(p.lookback) || DEFAULT_CORRELATION_MATRIX.lookback))),
        threshold: Math.min(0.99, Math.max(0.3, Number(p.threshold) || DEFAULT_CORRELATION_MATRIX.threshold)),
        maxCorrelated: Math.min(10, Math.max(1, Math.round(Number(p.maxCorrelated) || DEFAULT_CORRELATION_MATRIX.maxCorrelated))),
        maxAgeMin: Math.min(1440, Math.max(15, Math.round(Number(p.maxAgeMin) || DEFAULT_CORRELATION_MATRIX.maxAgeMin))),
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_CORRELATION_MATRIX }
}

/** Log returns from a bar series ({c} close). One fewer than the bar count. */
export function logReturns(bars) {
  const out = []
  for (let i = 1; i < (bars?.length || 0); i++) {
    const a = bars[i - 1].c, b = bars[i].c
    if (a > 0 && b > 0) out.push(Math.log(b / a))
  }
  return out
}

/** Pearson correlation over the overlapping tail of two return series. */
export function pearson(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  const x = a.slice(a.length - n), y = b.slice(b.length - n)
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
  const mx = mean(x), my = mean(y)
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  if (sxx <= 0 || syy <= 0) return null
  const r = sxy / Math.sqrt(sxx * syy)
  return Math.max(-1, Math.min(1, r))
}

/**
 * Pairwise correlation matrix from a { SYMBOL: returns[] } map.
 * @returns {{ symbols:string[], m: Record<string, Record<string, number>> }}
 */
export function buildCorrelationMatrix(returnsBySymbol) {
  const symbols = Object.keys(returnsBySymbol)
  const m = {}
  for (const a of symbols) {
    m[a] = {}
    for (const b of symbols) {
      m[a][b] = a === b ? 1 : (pearson(returnsBySymbol[a], returnsBySymbol[b]) ?? 0)
    }
  }
  return { symbols, m }
}

const dirOf = (side) => (side === 'short' || side === 'SELL' || side === 'sell') ? -1 : 1
const up = (s) => String(s || '').toUpperCase()

/**
 * Would `proposal` become the (maxCorrelated+1)th stacked bet against the
 * positions already held, per the LIVE matrix? Returns the offending set or
 * null. Fails open (null) when the matrix is missing/stale or the proposal's
 * symbol isn't in it.
 *
 * @param {Array<{symbol,side}>} positions
 * @param {{symbol,side}} proposal
 * @param {{ builtAt?:string, m:Record<string,Record<string,number>> }} matrix
 * @param {{threshold:number, maxCorrelated:number, maxAgeMin:number}} cfg
 * @param {number} nowMs
 */
export function liveCorrelationVeto(positions, proposal, matrix, cfg, nowMs) {
  if (!proposal || !matrix?.m) return null
  if (matrix.builtAt) {
    const age = nowMs - Date.parse(matrix.builtAt)
    if (Number.isFinite(age) && age > cfg.maxAgeMin * 60_000) return null // stale → fail open
  }
  const pSym = up(proposal.symbol)
  const row = matrix.m[pSym]
  if (!row) return null
  const pDir = dirOf(proposal.side)
  const stacked = []
  for (const held of positions || []) {
    const hSym = up(held.symbol)
    if (hSym === pSym) continue // duplicate_symbol gate owns that case
    const r = row[hSym]
    if (r == null) continue
    const eff = r * pDir * dirOf(held.side)
    if (eff >= cfg.threshold) stacked.push({ symbol: hSym, side: held.side, corr: Math.round(r * 100) / 100 })
  }
  if (stacked.length >= cfg.maxCorrelated) {
    return { symbol: pSym, threshold: cfg.threshold, stacked }
  }
  return null
}

/** Read the stored matrix, or null. */
export function loadStoredMatrix(db) {
  try {
    const p = JSON.parse(getState(db, 'correlation_matrix_data') || 'null')
    return p && p.m ? p : null
  } catch { return null }
}

/**
 * Compute + store the matrix for a set of symbols. deps.fetchBars(symbol) →
 * bars[] lets tests inject; production passes a trendbar-backed fetcher.
 * Bounded symbol count keeps the broker fetch sane.
 */
export async function computeAndStoreMatrix(db, symbols, deps, nowIso) {
  const cfg = loadCorrelationMatrixConfig(db)
  if (!cfg.on) return { skipped: 'off' }
  const uniq = [...new Set((symbols || []).map(up))].slice(0, deps.maxSymbols || 24)
  if (uniq.length < 2) return { skipped: 'need 2+ symbols' }

  const returnsBySymbol = {}
  for (const sym of uniq) {
    try {
      const bars = await deps.fetchBars(sym, cfg.timeframe, cfg.lookback + 1)
      const rets = logReturns(bars)
      if (rets.length >= 3) returnsBySymbol[sym] = rets
    } catch { /* skip a symbol that fails to fetch */ }
  }
  if (Object.keys(returnsBySymbol).length < 2) return { skipped: 'insufficient data' }

  const { symbols: syms, m } = buildCorrelationMatrix(returnsBySymbol)
  const payload = { builtAt: nowIso, timeframe: cfg.timeframe, lookback: cfg.lookback, symbols: syms, m }
  setState(db, 'correlation_matrix_data', JSON.stringify(payload))
  return { built: syms.length, builtAt: nowIso }
}
