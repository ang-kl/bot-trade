// ARMED SCOPE, CONSULTED BEFORE THE SLOT IS SPENT — not after.
//
// THE MEASUREMENT (production, 16-09-2026 05:40–06:08 UTC, Railway logs,
// `autotrade_scope = 'armed'`): 38 of ~60 completed analyses were thrown away
// by the backstop gate in loop.js — the one that runs AFTER synthesis, where
// `armedScopeGate` sees `synth.timeframe` for the first time. The loop has
// three analysis slots per pass, so about two thirds of the analysis budget
// went to symbol×timeframe cells that could not trade under the current
// arming no matter how good the setup. GER40 produced `long (9/10) rr=3.29`
// six times in those 28 minutes and was discarded six times, on 5m, while its
// armed set was ['3d'].
//
// WHY IT REPEATS RATHER THAN SCATTERS. The scan already knows about arming —
// `scanSymbolFib` takes `preferredTfs` and, WITHIN one strategy, a candidate
// on a preferred (armed) timeframe beats a candidate on any other. But the
// symbol's dispatched signal is chosen by `bestOf`, which ranks by
// armed-STRATEGY then conviction and does not look at the timeframe at all.
// So a louder strategy on an unarmed timeframe takes the symbol every pass,
// deterministically, and the same names recur in the discard list.
//
// TWO DISTINCT CASES, and they need different answers:
//
//   (a) The symbol HAS a scanned row on an armed timeframe (US30 armed
//       12h,4d,1d,1w,3d and analysed on 30m; 1d and 1w are scanned). Nothing
//       is missing — the wrong row was picked. `pickArmedSignal` picks an
//       armed one instead, preferring the strategy the fair-share allocator
//       granted the slot to, so the slot still serves that strategy.
//
//   (b) The symbol has NO scanned row on any armed timeframe (GBPUSD armed
//       ['3d'], GER40 armed ['3d'], JPN225 armed ['12h','8h']). 3d, 4d, 12h
//       and 8h are NOT in the scanner's timeframe ladder — they reach it only
//       via `extraTimeframes`, which is the stored `autotrade_timeframes`
//       list, and in production that list is [4h,1d,5m,1h,30m]. So these
//       cells are armed by the matrix and never scanned, and no choice of row
//       can save them. `filterArmedCandidates` drops the symbol BEFORE the
//       slots are handed out, with a reason, so the slot goes to a candidate
//       that can actually trade. Nothing here invents a timeframe or fabricates
//       bars: it only ever chooses among rows the scan really produced.
//
// WHAT THIS IS NOT. It does not weaken the backstop gate and it cannot let a
// blocked symbol×timeframe through — every verdict here comes from the same
// `armedScopeGate`, whose semantics are owner-confirmed (02-09-2026: the
// matrix wins over the list). Under the default scope 'all' both entry points
// are the identity — the pool is returned untouched and the picker returns
// null for everything, so the loop dispatches exactly what it dispatched
// before. That check lives in here, where a test can call it, rather than as
// an `if` in the loop that only a source-text assertion could pin.
//
// Pure and side-effect free, except for the counters at the bottom, which
// exist so the waste rate is a printed number rather than log archaeology.

import { armedScopeGate } from '../lib/timeframes.js'
import { bestOf, armedPredicate } from './fib-strategy.js'

const tfOf = (r) => (r && typeof r.timeframe === 'string' ? r.timeframe : null)
const convOf = (r) => Number(r?.conviction ?? r?.confidence ?? 0) || 0

/**
 * Split one symbol's scanned rows into those the armed gate admits and those
 * it refuses. `rows` may be scan rows or signal objects — only `timeframe`
 * (and `strategy`/`conviction`, for reporting) is read.
 *
 * @param {Array<{timeframe?: string|null, strategy?: string|null}>} rows
 * @param {{symbol: string, allowedTfs: string[], matrix: any}} p
 * @returns {{armed: Array, blocked: Array<{timeframe: string|null, strategy: string|null, conviction: number, reason: string}>}}
 */
export function armedRowsFor(rows, { symbol, allowedTfs, matrix }) {
  const armed = []
  const blocked = []
  for (const r of rows || []) {
    const timeframe = tfOf(r)
    if (!timeframe) {
      blocked.push({ timeframe: null, strategy: r?.strategy ?? null, conviction: convOf(r), reason: 'row carries no timeframe' })
      continue
    }
    const verdict = armedScopeGate({ symbol, timeframe, allowedTfs, matrix })
    if (verdict.ok) armed.push(r)
    else blocked.push({ timeframe, strategy: r?.strategy ?? null, conviction: convOf(r), reason: verdict.reason })
  }
  return { armed, blocked }
}

/**
 * True only for the scope this whole module exists for. The default scope is
 * 'all', where every scanned timeframe is already eligible — the check lives
 * HERE, behind the functions the loop calls, so it is exercised by tests
 * rather than only visible as an `if` in a five-thousand-line file.
 */
export function armedScopeActive(scope) { return String(scope ?? 'all') === 'armed' }

/**
 * Drop candidate symbols that cannot trade on ANY timeframe the scan produced
 * for them. Only ever removes; the order of what survives is untouched.
 *
 * Under any scope but 'armed' this is the identity — nothing dropped, nothing
 * to report. An absent scope is INERT, not armed: a caller that forgot to say
 * loses the saving, never the symbol.
 *
 * A symbol with no usable rows at all (every row a `skip`, or the symbol
 * absent from the scan) is KEPT — this filter answers "armed or not", and a
 * symbol it knows nothing about is not its to refuse.
 *
 * @param {string[]} pool candidate symbols, best-first
 * @param {Array<{symbol: string, timeframe?: string|null, strategy?: string|null, bias?: string}>} scans
 * @param {{scope?: string, allowedTfs: string[], matrix: any}} p
 * @returns {{kept: string[], dropped: Array<{symbol: string, blocked: Array, attribution: any, reason: string}>}}
 */
export function filterArmedCandidates(pool, scans, { scope = 'all', allowedTfs, matrix }) {
  if (!armedScopeActive(scope)) return { kept: [...(pool || [])], dropped: [] }
  const bySym = new Map()
  for (const sc of scans || []) {
    if (!sc || sc.bias === 'skip' || !tfOf(sc)) continue
    const key = String(sc.symbol)
    if (!bySym.has(key)) bySym.set(key, [])
    bySym.get(key).push(sc)
  }
  const kept = []
  const dropped = []
  for (const sym of pool || []) {
    const rows = bySym.get(String(sym)) || []
    if (!rows.length) { kept.push(sym); continue }
    const { armed, blocked } = armedRowsFor(rows, { symbol: sym, allowedTfs, matrix })
    if (armed.length) { kept.push(sym); continue }
    // The decision row can name only one cell, and scan order is arbitrary
    // (checker, 16-09-2026: attributing to blocked[0] picked whichever row
    // sorted first). Name the STRONGEST refused cell — the one whose loss an
    // operator would ask about — while the reason string carries them all.
    const attribution = blocked.reduce((a, b) => (b.conviction > a.conviction ? b : a), blocked[0])
    dropped.push({
      symbol: sym,
      blocked,
      attribution,
      reason: `no scanned timeframe is armed for this symbol (scanned ${blocked.map(b => `${b.strategy || '?'}@${b.timeframe || '?'}`).join(', ')}; ${attribution?.reason || 'not armed'})`,
    })
  }
  return { kept, dropped }
}

/**
 * Choose which of a symbol's scanned signals spends the slot, under scope
 * 'armed'. Returns null when none of them is on an armed timeframe — the
 * caller then keeps whatever it would have dispatched anyway and the backstop
 * gate in loop.js refuses it, exactly as before.
 *
 * THE RANKING IS THE SCAN'S OWN, NARROWED — NOT A SECOND ONE (checker,
 * 16-09-2026). The choice this replaces was `bestOf(signals,
 * armedPredicate(opts))` in fib-strategy.js: **armed STRATEGY beats unarmed,
 * then conviction**. A first draft here ranked by conviction alone, which
 * could hand the slot to a scan-staged-but-not-trade-armed strategy on an
 * armed timeframe — the stage-matrix gate in loop.js then blocks it and the
 * slot is guaranteed waste, the very failure this file exists to remove, and
 * worse, it can DESTROY a dispatch that would have traded (US30 with
 * fib_confluence@1d conviction 10 unarmed against vwap_trend@1d conviction 7
 * armed: the old code traded, that draft did not). So the same `bestOf` and
 * the same `armedPredicate` are imported and applied to the armed-timeframe
 * subset. A second ranking that drifts from the first is its own defect.
 *
 * `prefer` is the strategy the fair-share allocator granted this slot to. It
 * wins only if its armed-timeframe candidate is ALSO trade-armed — preferring
 * a strategy that cannot trade is the same waste by another name.
 *
 * @param {Array<{strategy?: string|null, timeframe?: string|null, conviction?: number}>} candidates
 * @param {{symbol: string, allowedTfs: string[], matrix: any, prefer?: string|null, armedStrategyKeys?: string[]|Set<string>|null}} p
 * @returns {{signal: any, reason: string}|null}
 */
export function pickArmedSignal(candidates, { symbol, allowedTfs, matrix, prefer = null, armedStrategyKeys = null }) {
  const list = (candidates || []).filter(Boolean)
  const { armed } = armedRowsFor(list, { symbol, allowedTfs, matrix })
  if (!armed.length) return null
  // Exactly the predicate the scan ranks with; empty/absent → every strategy
  // counts as armed, which is what fib-strategy.js does for its own callers.
  const isArmedStrategy = armedPredicate({ armedStrategyKeys })
  if (prefer) {
    const own = armed.find(c => c.strategy === prefer)
    if (own && isArmedStrategy(own)) {
      return { signal: own, reason: `armed timeframe ${own.timeframe} for the slot's strategy ${prefer}` }
    }
  }
  const best = bestOf(armed, isArmedStrategy)
  if (!best) return null
  return { signal: best, reason: `armed timeframe ${best.timeframe} (${best.strategy || '?'}, conviction ${best.conviction ?? 0})` }
}

/**
 * The picker the analyze phase calls per symbol. Under any scope but 'armed'
 * it returns null for everything, so the caller dispatches exactly what it
 * dispatched before this change existed — the scope-'all' guarantee, as a
 * function that can be called in a test rather than an `if` that cannot.
 *
 * @param {string} scope
 * @param {{allowedTfs: string[], matrix: any, armedStrategyKeys?: string[]|Set<string>|null}} p
 * @returns {(symbol: string, prefer: string|null, candidates: any[]) => ({signal: any, reason: string}|null)}
 */
export function armedPickerFor(scope, { allowedTfs, matrix, armedStrategyKeys = null }) {
  if (!armedScopeActive(scope)) return () => null
  return (symbol, prefer, candidates) => pickArmedSignal(candidates, { symbol, allowedTfs, matrix, prefer, armedStrategyKeys })
}

// ---------------------------------------------------------------------------
// Counters. A guard nobody can read is a guard nobody maintains: the 38
// discarded analyses above were only visible by grepping 28 minutes of logs.
//
// TAKE-AND-RESET, NOT RESET-THEN-READ (checker, 16-09-2026). The loop reads
// these once per analyze phase with `takeArmedGateStats()`, which returns the
// tally and clears it. The earlier shape reset at the START of the phase, so
// analyses dispatched by the pending-signals retry LATER in the cycle — the
// other caller of dispatchSymbolSignal — incremented counters that were
// cleared before anyone read them: never reported anywhere, and able to leave
// a blocked count with no matching analysed count, which printed `2 of 0`.
// Taking instead of resetting means every counted analysis is reported in the
// next line, at worst one cycle late, and the denominator always covers the
// numerator.
// ---------------------------------------------------------------------------

const DETAIL_CAP = 8
let pass = { analysed: 0, blocked: 0, detail: [] }

export function resetArmedGateStats() { pass = { analysed: 0, blocked: 0, detail: [] } }

/** The tally since the last take, and clears it. What the loop calls. */
export function takeArmedGateStats() {
  const taken = armedGateStats()
  resetArmedGateStats()
  return taken
}

/** One completed analysis (the denominator). Counted under every scope. */
export function recordAnalysis() { pass.analysed += 1 }

/** One completed analysis thrown away by the armed backstop gate. */
export function recordArmedGateBlock({ symbol, timeframe, reason }) {
  pass.blocked += 1
  if (pass.detail.length < DETAIL_CAP) {
    pass.detail.push({ symbol: String(symbol), timeframe: timeframe ?? null, reason: reason || 'not armed' })
  }
}

export function armedGateStats() { return { analysed: pass.analysed, blocked: pass.blocked, detail: [...pass.detail] } }

/**
 * The summary line, or null when nothing was wasted — so scope 'all', where
 * this gate never fires, stays silent.
 */
export function armedGateWasteLine(stats) {
  const s = stats || armedGateStats()
  if (!s.blocked) return null
  const shown = s.detail.map(d => `${d.symbol} ${d.timeframe || '?'} (${d.reason})`).join(' · ')
  const more = s.blocked > s.detail.length ? ` · +${s.blocked - s.detail.length} more` : ''
  // A blocked count above the analysed count would print a rate over 100%,
  // which is a broken instrument reporting on a broken instrument. It cannot
  // happen through the loop (every block follows an analysis in the same
  // tally), so say the denominator is missing rather than invent one.
  const of = s.blocked <= s.analysed
    ? `${s.blocked} of ${s.analysed} completed analysis/analyses`
    : `${s.blocked} completed analysis/analyses (denominator unavailable — ${s.analysed} counted)`
  return `Armed gate waste: ${of} discarded by the armed scope gate — ${shown}${more}`
}
