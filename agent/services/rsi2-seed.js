// ---------------------------------------------------------------------------
// agent/services/rsi2-seed.js — one-time, ADDITIVE boot seed that arms
// RSI-2 (rsi2_reversion) plus its REAL backtested GO combos, so the proven
// edge starts trading without the owner hand-arming every symbol (move B).
//
// The combos are NOT hardcoded — they are read from the owner's own
// backtest_baseline_json (the "Your edge — backtest baseline" table). We only
// seed combos that the owner's last RSI-2 backtest actually rated GO, using
// the REAL broker symbol names and timeframes. No fabricated numbers.
//
// Runs exactly once, gated by RSI2_SEED_FLAG. Everything is additive &
// reversible:
//   · rsi2_reversion is APPENDED to enabled_strategies_json (fib default and
//     any other armed strategies preserved).
//   · the GO combos are UNIONed into autotrade_matrix_json ({SYM:[tfs]}) —
//     existing per-symbol arms are never removed, only extended.
//
// Footgun guard: the per-symbol matrix only GATES trades under the 'armed'
// autotrade scope (default 'all' ignores it — loop.js:482). Introducing a
// matrix where none existed would, under 'armed' scope, flip the whole
// watchlist from TF-wide to "only these symbols". So when scope is 'armed'
// AND no matrix exists yet, we arm the strategy only.
//
// Nothing here forces a trade: RSI-2's 1h timeframe floor, the regime gate,
// the stage gate and the risk gate still veto every order. This decides what
// is CONSIDERED, never what EXECUTES.
// ---------------------------------------------------------------------------

import { getState as dbGetState, setState as dbSetState } from '../db.js'
import { tfMs } from '../lib/timeframes.js'

export const RSI2_SEED_FLAG = 'rsi2_go_seed_v1'
export const RSI2_KEY = 'rsi2_reversion'

// GO thresholds — mirror the "proven edge" bar Edge health uses (PF > 1 with
// trades), but stricter for auto-arming real money: a clear positive
// expectancy on a real sample, walk-forward not explicitly negative.
export const GO_PF = 1.5          // profit factor floor
export const GO_MIN_TRADES = 20   // enough closes to trust the number
export const GO_MAX = 12          // cap how many combos we auto-arm
const HOUR_MS = 3_600_000         // RSI-2's structural floor (1h)

/**
 * goCombosFromBaseline(baseline) → [{ symbol, tf }]
 * Pull the RSI-2 GO combos out of the owner's stored backtest baseline.
 * Returns [] when the baseline is absent or for another strategy.
 */
export function goCombosFromBaseline(baseline) {
  if (!baseline || baseline.strategy !== RSI2_KEY || !Array.isArray(baseline.combos)) return []
  return baseline.combos
    .filter(c => c && c.symbol && c.tf)
    .filter(c => (c.profitFactor ?? 0) >= GO_PF && (c.trades ?? 0) >= GO_MIN_TRADES)
    .filter(c => c.wfPositive !== false)               // walk-forward not a known fail
    .filter(c => (tfMs(c.tf) || 0) >= HOUR_MS)         // honour the 1h floor
    .sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))
    .slice(0, GO_MAX)
    .map(c => ({ symbol: String(c.symbol).toUpperCase(), tf: c.tf }))
}

/**
 * seedRsi2GoCombos(db, io?) → summary
 * Idempotent: after the first run the flag is set and later calls return
 * { skipped: 'already_seeded' }.
 */
export function seedRsi2GoCombos(db, io = {}) {
  const getState = io.getState || dbGetState
  const setState = io.setState || dbSetState

  if (getState(db, RSI2_SEED_FLAG)) return { skipped: 'already_seeded' }

  // GO combos come from the owner's real backtest baseline — never invented.
  let baseline = null
  try { baseline = JSON.parse(getState(db, 'backtest_baseline_json') || 'null') } catch { baseline = null }
  const combos = goCombosFromBaseline(baseline)

  // 1) Trade-arm rsi2_reversion (append; preserve existing order/entries).
  let enabled
  try { enabled = JSON.parse(getState(db, 'enabled_strategies_json') || 'null') } catch { enabled = null }
  if (!Array.isArray(enabled)) enabled = ['fib_618_fade'] // materialise the documented default
  const addedStrategy = !enabled.includes(RSI2_KEY)
  if (addedStrategy) enabled = [...enabled, RSI2_KEY]

  // 2) Union the GO combos into the per-symbol matrix — but never fabricate a
  //    matrix under 'armed' scope (that would restrict the whole watchlist),
  //    and never write an empty matrix (no baseline → nothing to seed).
  let matrix
  try { matrix = JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { matrix = null }
  const hadMatrix = matrix && typeof matrix === 'object' && Object.keys(matrix).length > 0
  const scope = getState(db, 'autotrade_scope') || 'all'
  const wouldRestrict = scope === 'armed' && !hadMatrix

  const addedCombos = []
  let matrixSeeded = false
  let note = null
  if (combos.length === 0) {
    note = baseline && baseline.strategy === RSI2_KEY
      ? 'backtest baseline has no RSI-2 combo clearing the GO bar — armed strategy-only'
      : 'no RSI-2 backtest baseline stored yet — armed strategy-only (run a backtest in Tune to auto-arm combos)'
  } else if (wouldRestrict) {
    note = 'armed scope with no matrix — left TF-wide; rsi2 armed strategy-only to avoid restricting the watchlist'
  } else {
    if (!matrix || typeof matrix !== 'object') matrix = {}
    for (const { symbol, tf } of combos) {
      const key = symbol.toUpperCase()
      const tfs = Array.isArray(matrix[key]) ? matrix[key] : []
      if (!tfs.includes(tf)) { matrix[key] = [...tfs, tf]; addedCombos.push({ symbol: key, tf }) }
    }
    matrixSeeded = addedCombos.length > 0
  }

  setState(db, 'enabled_strategies_json', JSON.stringify(enabled))
  if (matrixSeeded) setState(db, 'autotrade_matrix_json', JSON.stringify(matrix))
  setState(db, RSI2_SEED_FLAG, new Date().toISOString())

  return { seeded: true, addedStrategy, matrixSeeded, addedCombos, note, scope, consideredCombos: combos.length }
}
