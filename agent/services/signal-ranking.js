// ---------------------------------------------------------------------------
// agent/services/signal-ranking.js — spend scarce position slots on the BEST
// signals, not the earliest-scanning ones.
//
// The loop scans the whole watchlist but only dispatches a few hot candidates
// per cycle, and the risk gate caps concurrent positions (owner set this to
// 25). The hot list was taken in SCAN/ROTATION order — so with slots scarce,
// the 25 held could be mediocre setups that merely scanned first, while
// stronger signals later in the rotation hit the max-positions veto and were
// turned away. First-come, not best-first.
//
// This ranks hot candidates so the dispatched few (and therefore the slots
// that fill) go to the strongest signals:
//   1. conviction (the live signal's own quality) — descending
//   2. a symbol with a positive BACKTEST edge on record — first
//   3. symbol name — only to make ties deterministic
// Pure and side-effect free so it is trivially testable.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{symbol:string, confidence?:number}>} scans  this cycle's scans
 * @param {string[]} hotSymbols  the symbols already filtered as "hot"
 * @param {{ provenEdgeSymbols?: Set<string> }} [opts]
 * @returns {string[]} hotSymbols reordered best-first
 */
export function rankHotSymbols(scans, hotSymbols, { provenEdgeSymbols = new Set() } = {}) {
  const byName = new Map((scans || []).map(s => [s.symbol, s]))
  const conv = (sym) => Number(byName.get(sym)?.confidence) || 0
  const proven = (sym) => (provenEdgeSymbols.has(sym) ? 1 : 0)
  return [...(hotSymbols || [])].sort((a, b) => {
    if (conv(b) !== conv(a)) return conv(b) - conv(a)          // strongest signal first
    if (proven(b) !== proven(a)) return proven(b) - proven(a)  // proven edge breaks ties
    return String(a).localeCompare(String(b))                  // deterministic
  })
}

/**
 * Symbols that have a positive backtest combo on record, from the stored
 * baseline ({ combos: [{ symbol, profitFactor, trades }] }). Used as the
 * tie-break above. Returns an empty Set when no baseline is stored.
 */
export function provenEdgeSymbolsFrom(baseline) {
  const out = new Set()
  const combos = baseline && Array.isArray(baseline.combos) ? baseline.combos : []
  for (const c of combos) {
    if (c && c.symbol && (Number(c.profitFactor) > 1) && (Number(c.trades) > 0)) out.add(c.symbol)
  }
  return out
}
