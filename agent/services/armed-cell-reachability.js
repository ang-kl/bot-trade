// ---------------------------------------------------------------------------
// agent/services/armed-cell-reachability.js — WHICH ARMED CELLS NO SCAN CAN
// EVER PRODUCE. A diagnostic. It reports; it does not act.
//
// THE DEFECT, measured in production on 86db230 with `autotrade_scope =
// 'armed'` (Railway logs, 16-09-2026, the PR-M pre-filter line):
//
//   JPN225 armed 12h,8h · GER40 armed 3d · US2000 armed 12h,8h
//
// None of `3d`, `4d`, `12h`, `8h`, `10m`, `2m` is in the scanner's own
// timeframe ladder (`TIMEFRAMES` in fib-strategy.js). They reach the scan
// ONLY through `extraTimeframes`, which loop.js reads from the STORED
// `autotrade_timeframes` — in production `[4h,1d,5m,1h,30m]`. Meanwhile the
// arming side's `armedTimeframes()` falls back to the much fuller
// `DEFAULT_AUTOTRADE_TIMEFRAMES`, which DOES carry 3d/4d/12h/8h, and the
// autotrade matrix (written by the strategy autopilot, not by a human) arms
// cells out of that fuller set. Two lists meant to be the same drifted, and
// the cells in the gap are armed, never scanned, and therefore unable to
// trade under ANY setup — not "rarely", never.
//
// WHAT THIS IS NOT. It changes nothing about what is scanned, armed,
// analysed, dispatched or traded. `armedScopeGate` and `armedTimeframes`
// keep their owner-confirmed semantics (02-09-2026: the matrix wins over the
// list). Widening the scan ladder would change what can trade and costs scan
// compute across the whole watchlist — that is the owner's call, which is
// why point 4 of this module is a REMEDY FIELD rather than a fix.
//
// THE DISTINCTION THAT DECIDES EVERY VERDICT HERE, because the production
// log conflates them. PR-M's pre-filter line names a symbol when its scan
// produced no row on an armed timeframe THIS PASS. That is two different
// facts wearing one sentence:
//
//   (a) STRUCTURAL — the armed timeframe is not in the ladder at all, so no
//       pass can ever produce it. GER40 3d, JPN225 12h/8h, US2000 12h/8h.
//       Only a re-arm or a ladder change fixes it. THIS MODULE REPORTS (a).
//
//   (b) EPISODIC — the armed timeframe IS scanned, it just had no signal on
//       that pass. HON.US is armed 4h, and 4h is in the ladder AND in the
//       stored list; it appeared in that log only because the scan happened
//       to return 1mo/1h rows that pass. Nothing is misconfigured and there
//       is nothing to decide, so reporting it would be a false positive in
//       a report whose whole value is that every line demands an action.
//
// Reporting (b) here would make the count unactionable within a week. The
// test suite pins HON.US as NOT reported for exactly this reason.
//
// The ladder is READ FROM THE SCANNER, never re-typed: `scanTimeframeLadder`
// is the same function `scanSymbolFib` uses to build its own scan set. A
// second copy of that list is precisely how this defect was born.
// ---------------------------------------------------------------------------

import { tfMs, armedTimeframes } from '../lib/timeframes.js'
import { scanTimeframeLadder } from './fib-strategy.js'
import { shortHistory } from '../lib/bar-path-counters.js'
import { scanStageStrategies } from './stage-matrix.js'

/**
 * S-3 (26-09-2026): IMPOSSIBLE cells — strategy × symbol × timeframe cells no
 * fetch depth can feed, because the broker's WHOLE history for that symbol ×
 * timeframe is shorter than the strategy's own guard. Measured: BTCUSD 1mo
 * returns 190 bars when 450 are asked (its full history at this broker,
 * starting with the July 2010 bar — 2010-06-30T21:00Z is 1 July broker time,
 * not "~Nov 2010"; 190 bars against Jul 2010-Aug 2026's 194 months means at
 * least 4 months are missing inside the series), so ema_pullback (450) and
 * the cup pair (210) can never run there. This is a third kind of finding
 * beside (a) and (b) below: the timeframe IS scanned, and no pass will ever
 * produce it for THIS strategy.
 *
 * Only what has been OBSERVED is marked: `history` comes from the bar-path
 * counters, and only from an answer whose FIRST bar starts well after the
 * request window opened (bar-path-counters.js isHistoryLimited). "Fewer bars
 * than asked" alone is not history: the request is bounded by a time window,
 * so a symbol that closes at weekends (EURUSD 1h: ~328 of 451) returns fewer
 * bars with years of history behind it, and marking it here would be a fake
 * result. `got` counts the forming bar when there was one, so `got < need`
 * never over-reports. Pure.
 *
 * @param {Array<{symbol:string, timeframe:string, asked:number, got:number}>} history
 * @param {Array<{key:string, minBars?:number}>} strategies — the scan-staged set
 */
export function impossibleDepthCells(history, strategies) {
  const out = []
  for (const h of Array.isArray(history) ? history : []) {
    for (const s of Array.isArray(strategies) ? strategies : []) {
      const need = Number(s?.minBars) || 0
      if (need > 0 && Number(h.got) < need) {
        out.push({ strategy: s.key, symbol: h.symbol, timeframe: h.timeframe, need, history: Number(h.got), asked: Number(h.asked) })
      }
    }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol) || tfMs(b.timeframe) - tfMs(a.timeframe) || a.strategy.localeCompare(b.strategy))
}

const SYMBOL_CAP = 8

/** Non-empty strings only — a matrix entry of `3` can never match the gate's
 *  string `includes`, so it is malformed data, not a timeframe. */
const cleanTfs = (v) => (Array.isArray(v) ? v.filter(t => typeof t === 'string' && t.trim() !== '') : [])

/**
 * The ladder timeframe closest in DURATION to `tf`, by ratio rather than
 * difference — 12h sits between 4h and 1d, and 1d (×2) is nearer than 4h
 * (×3) in the only sense a trader means by "nearest timeframe". Null when
 * `tf` has no readable duration (nothing to be near to).
 */
export function nearestScannable(tf, ladder) {
  const ms = tfMs(tf)
  if (!(ms > 0) || !ladder?.length) return null
  let best = null
  let bestScore = Infinity
  for (const cand of ladder) {
    const cms = tfMs(cand)
    if (!(cms > 0)) continue
    const score = Math.abs(Math.log(cms / ms))
    if (score < bestScore) { bestScore = score; best = cand }
  }
  return best
}

/**
 * Every armed symbol×timeframe cell that no scan can ever produce.
 *
 * PURE. Nothing is read from a database and nothing is written anywhere;
 * `readArmedCellReachability` below is the one place that touches state.
 *
 * @param {object} p
 * @param {any}      p.matrix            `autotrade_matrix_json`, parsed ({SYM: [tf]}).
 * @param {string[]} p.extraTimeframes   the STORED `autotrade_timeframes`, as
 *   loop.js reads it for the scan (absent/corrupt ⇒ `[]`, NOT the default list
 *   — that asymmetry with `armedTimeframes()` is the defect itself).
 * @param {string[]} [p.armedList]       `armedTimeframes()`'s result, which gates
 *   only the symbols the matrix does not name.
 * @param {string}   [p.scope]           `autotrade_scope`; 'all' makes it all moot.
 * @param {string[]} [p.ladder]          override, for tests. Omitted ⇒ the
 *   scanner's own ladder, from `scanTimeframeLadder`.
 * @returns {object} report — see the shape assembled at the bottom.
 */
export function unreachableArmedCells({ matrix, extraTimeframes = [], armedList = null, scope = 'all', ladder = null }) {
  const extras = Array.isArray(extraTimeframes) ? extraTimeframes : []
  // The SCAN's real set, from the scanner's own function.
  const ladderList = Array.isArray(ladder) && ladder.length ? [...ladder] : scanTimeframeLadder(extras)
  const inLadder = new Set(ladderList)

  // Mirrors armedScopeGate's own `usable` test exactly: an array, a null, a
  // string or an empty object is NOT a matrix, and then the list gates
  // everything and there are no per-symbol cells to report.
  const matrixUsable = !!matrix && typeof matrix === 'object' && !Array.isArray(matrix) && Object.keys(matrix).length > 0

  const symbols = []
  const cells = []
  let malformed = 0
  if (matrixUsable) {
    for (const key of Object.keys(matrix).sort()) {
      const raw = matrix[key]
      if (!Array.isArray(raw)) { malformed += 1; continue }
      const armed = cleanTfs(raw)
      if (armed.length !== raw.length) malformed += 1
      if (!armed.length) continue
      const scannable = armed.filter(tf => inLadder.has(tf))
      const unreachable = armed.filter(tf => !inLadder.has(tf))
      if (!unreachable.length) continue
      for (const tf of unreachable) cells.push({ symbol: key, timeframe: tf })
      // A timeframe the parser cannot read (`tfMs` 0) is dropped by
      // scanSymbolFib's own filter, so adding it to the list would NOT make
      // it reachable. Saying "add 1banana" would be a remedy that does not
      // remedy — the two buckets are kept apart.
      const addable = unreachable.filter(tf => tfMs(tf) > 0)
      const unaddable = unreachable.filter(tf => !(tfMs(tf) > 0))
      symbols.push({
        symbol: key,
        armed,
        unreachable,
        scannableArmed: scannable,
        // The headline case: armed, and not one armed cell the scan can make.
        stranded: scannable.length === 0,
        remedy: {
          rearmOnto: [...ladderList],
          nearest: unreachable.map(tf => ({ timeframe: tf, nearestScannable: nearestScannable(tf, ladderList) })),
          addToAutotradeTimeframes: addable,
          unaddable,
        },
      })
    }
  }

  // The symbols the matrix does NOT name are gated by the list, so a list
  // entry outside the ladder is dead for all of them at once. On a clean
  // install with nothing stored this is the whole 3d/4d/12h/8h/10m/2m gap,
  // which is the drift itself sitting in plain sight.
  const effectiveArmedList = Array.isArray(armedList) ? armedList : []
  const listOnlyUnreachable = effectiveArmedList.filter(tf => !inLadder.has(tf))

  const stranded = symbols.filter(s => s.stranded)
  const partial = symbols.filter(s => !s.stranded)
  return {
    scope,
    // The whole finding is inert under scope 'all', where every scanned
    // timeframe is eligible and the matrix is not consulted for dispatch.
    activeUnderScope: String(scope ?? 'all') === 'armed',
    ladder: ladderList,
    storedTimeframes: [...extras],
    armedList: [...effectiveArmedList],
    matrixUsable,
    matrixSymbols: matrixUsable ? Object.keys(matrix).length : 0,
    malformedEntries: malformed,
    cells,
    symbols,
    strandedSymbols: stranded.map(s => s.symbol),
    partialSymbols: partial.map(s => s.symbol),
    listOnlyUnreachable,
    // One union, so the owner's decision is a single edit rather than a
    // per-symbol hunt. Adding these to `autotrade_timeframes` ALSO widens
    // what the list admits for matrix-less symbols — stated, not hidden.
    ladderAdditionThatFixesAll: [...new Set(symbols.flatMap(s => s.remedy.addToAutotradeTimeframes))].sort((a, b) => tfMs(b) - tfMs(a)),
    note: String(scope ?? 'all') === 'armed'
      ? 'Under scope \'armed\' these armed cells can never dispatch: the scan never produces them. Either re-arm the symbol onto a timeframe in `ladder`, or add the timeframe to `autotrade_timeframes` (which also widens the allow-list for symbols the matrix does not name).'
      : 'Scope is not \'armed\' — the arming matrix does not gate dispatch today, so this finding is latent. It bites the moment the scope is switched to \'armed\'.',
  }
}

/**
 * The state read, in ONE place. Each key is parsed exactly as its consumer
 * parses it, and the asymmetry is deliberate: `autotrade_timeframes` falls
 * back to `[]` here because that is what loop.js feeds the SCAN, while
 * `armedTimeframes()` falls back to the default list because that is what
 * gates ARMING. Making them agree here would hide the very gap being
 * measured.
 */
export function readArmedCellReachability(db, getStateFn) {
  const read = (k) => { try { return getStateFn(db, k) } catch { return null } }
  let matrix = null
  try { matrix = JSON.parse(read('autotrade_matrix_json') || 'null') } catch { matrix = null /* corrupt — the list gates */ }
  let extraTimeframes = []
  try {
    const parsed = JSON.parse(read('autotrade_timeframes') || '[]')
    if (Array.isArray(parsed)) extraTimeframes = parsed
  } catch { /* keep [] — exactly what loop.js does */ }
  const scope = read('autotrade_scope') || 'all'
  let armedList = []
  try { armedList = armedTimeframes(db, getStateFn) } catch { armedList = [] }
  const report = unreachableArmedCells({ matrix, extraTimeframes, armedList, scope })
  let strategies = []
  try { strategies = scanStageStrategies(db, getStateFn) } catch { strategies = [] }
  const history = shortHistory()
  report.impossible = {
    cells: impossibleDepthCells(history, strategies),
    observedShortHistories: history.length,
    note: history.length
      ? 'strategy × symbol × timeframe cells the broker\'s whole history cannot feed: the first bar it returned starts well after the request window opened, and the symbol holds fewer bars on that timeframe than the strategy\'s own guard. No depth setting fixes these; they are marked, not hidden. Short answers caused only by weekends or closures inside the request window are NOT listed (see /state/data-feed barPath.fetches.windowLimited). Observed since this agent started.'
      : 'not measured yet: no fetch since this agent started has shown the broker\'s history ending inside the request window, so no cell can be marked impossible (this is not evidence that none is). Answers short only because of weekends or closures are counted as windowLimited, not here.',
  }
  return report
}

/**
 * The `[boot]` line, or NULL when there is nothing to say — a clean install
 * must not print noise.
 *
 * SILENT UNDER SCOPE 'all' BY DESIGN. There, the matrix does not gate
 * dispatch and a fresh instance with no stored list would otherwise announce
 * the whole default-vs-ladder gap on every boot of an install where it
 * changes nothing. The route reports it under every scope, so the latent
 * case is still readable — it just is not shouted.
 */
export function armedCellBootLine(report) {
  if (!report || !report.activeUnderScope) return null
  const stranded = report.symbols.filter(s => s.stranded)
  const partial = report.symbols.filter(s => !s.stranded)
  if (!stranded.length && !partial.length && !report.listOnlyUnreachable.length) return null

  const parts = []
  if (stranded.length) {
    const shown = stranded.slice(0, SYMBOL_CAP).map(s => `${s.symbol} ${s.unreachable.join(',')}`).join('; ')
    const more = stranded.length > SYMBOL_CAP ? `; +${stranded.length - SYMBOL_CAP} more` : ''
    parts.push(`${stranded.length} symbol(s) armed only on timeframes the scan never produces (${shown}${more})`)
  }
  if (partial.length) {
    const shown = partial.slice(0, SYMBOL_CAP).map(s => `${s.symbol} ${s.unreachable.join(',')}`).join('; ')
    const more = partial.length > SYMBOL_CAP ? `; +${partial.length - SYMBOL_CAP} more` : ''
    parts.push(`${partial.length} symbol(s) with some unreachable armed cells but a scannable one left (${shown}${more})`)
  }
  if (report.listOnlyUnreachable.length) {
    parts.push(`autotrade_timeframes carries ${report.listOnlyUnreachable.join(',')}, which the scan never produces (gates every symbol the matrix does not name)`)
  }
  const fix = report.ladderAdditionThatFixesAll.length
    ? `re-arm onto one of ${report.ladder.join(',')}, or add ${report.ladderAdditionThatFixesAll.join(',')} to autotrade_timeframes`
    : `re-arm onto one of ${report.ladder.join(',')}`
  return `[boot] armed cells: ${parts.join(' · ')} — fix: ${fix} (GET /state/armed-cell-reachability)`
}
