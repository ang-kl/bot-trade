// ---------------------------------------------------------------------------
// agent/services/rsi2-seed.js — one-time, ADDITIVE boot seed that arms
// RSI-2 (rsi2_reversion) plus its backtested GO combos, so the proven edge
// starts trading without the owner hand-arming every symbol (move B).
//
// Runs exactly once, gated by the RSI2_SEED_FLAG agent_state key. Everything
// it does is additive and reversible:
//   · rsi2_reversion is APPENDED to enabled_strategies_json (existing armed
//     strategies, incl. the fib default, are preserved).
//   · the GO combos are UNIONed into autotrade_matrix_json ({SYM:[tfs]}) —
//     existing per-symbol arms are never removed, only extended.
//
// Footgun guard: the per-symbol matrix only GATES trades under the 'armed'
// autotrade scope (the default 'all' scope ignores it — see loop.js:482).
// Under 'armed' scope, INTRODUCING a matrix where none existed would flip the
// whole watchlist from TF-wide to "only these symbols". So when scope is
// 'armed' AND no matrix exists yet, we DON'T fabricate one — we arm the
// strategy only and record the note. In every other case (scope 'all', or a
// matrix already present) the union is safe.
//
// Nothing here forces a bad trade: RSI-2's 1h timeframe floor, the regime
// gate, the stage-matrix gate and the risk gate still veto every order. This
// only decides what is CONSIDERED, never what EXECUTES.
// ---------------------------------------------------------------------------

import { getState as dbGetState, setState as dbSetState } from '../db.js'

export const RSI2_SEED_FLAG = 'rsi2_go_seed_v1'

// Walk-forward GO combos (2026-07-21, RSI-2 across 24 symbols). PF cited
// where the strategy source records it (rsi2-reversion.js). Higher
// timeframes only — RSI-2 structurally loses below 1h, so 8h/4h here.
// "DOW" is the US30 index in this system's symbol naming (see correlation.js).
export const RSI2_GO_COMBOS = [
  { symbol: 'JPN225', tf: '8h' }, // PF 1.53
  { symbol: 'NATGAS', tf: '4h' }, // PF 1.41
  { symbol: 'CORN',   tf: '8h' }, // PF 1.52
  { symbol: 'GOOGL',  tf: '8h' },
  { symbol: 'US30',   tf: '4h' }, // "DOW"
]

/**
 * seedRsi2GoCombos(db, io?) → summary
 * Idempotent: after the first run the flag is set and later calls return
 * { skipped: 'already_seeded' }.
 */
export function seedRsi2GoCombos(db, io = {}) {
  const getState = io.getState || dbGetState
  const setState = io.setState || dbSetState

  if (getState(db, RSI2_SEED_FLAG)) return { skipped: 'already_seeded' }

  // 1) Trade-arm rsi2_reversion (append; preserve existing order/entries).
  let enabled
  try { enabled = JSON.parse(getState(db, 'enabled_strategies_json') || 'null') } catch { enabled = null }
  if (!Array.isArray(enabled)) enabled = ['fib_618_fade'] // materialise the documented default
  const addedStrategy = !enabled.includes('rsi2_reversion')
  if (addedStrategy) enabled = [...enabled, 'rsi2_reversion']

  // 2) Union the GO combos into the per-symbol matrix — but never fabricate a
  //    matrix under 'armed' scope (that would restrict the whole watchlist).
  let matrix
  try { matrix = JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { matrix = null }
  const hadMatrix = matrix && typeof matrix === 'object' && Object.keys(matrix).length > 0
  const scope = getState(db, 'autotrade_scope') || 'all'
  const wouldRestrict = scope === 'armed' && !hadMatrix

  const addedCombos = []
  let matrixSeeded = false
  let note = null
  if (wouldRestrict) {
    note = "armed scope with no matrix — left TF-wide; rsi2 armed strategy-only to avoid restricting the watchlist"
  } else {
    if (!matrix || typeof matrix !== 'object') matrix = {}
    for (const { symbol, tf } of RSI2_GO_COMBOS) {
      const key = symbol.toUpperCase()
      const tfs = Array.isArray(matrix[key]) ? matrix[key] : []
      if (!tfs.includes(tf)) { matrix[key] = [...tfs, tf]; addedCombos.push({ symbol: key, tf }) }
    }
    matrixSeeded = true
  }

  setState(db, 'enabled_strategies_json', JSON.stringify(enabled))
  if (matrixSeeded) setState(db, 'autotrade_matrix_json', JSON.stringify(matrix))
  setState(db, RSI2_SEED_FLAG, new Date().toISOString())

  return { seeded: true, addedStrategy, matrixSeeded, addedCombos, note, scope }
}
