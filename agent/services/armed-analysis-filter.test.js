import test from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { armedScopeGate } from '../lib/timeframes.js'
import { bestOf, armedPredicate } from './fib-strategy.js'
import { initDB, setState } from '../db.js'
import {
  armedRowsFor,
  armedScopeActive,
  armedPickerFor,
  filterArmedCandidates,
  pickArmedSignal,
  resetArmedGateStats,
  takeArmedGateStats,
  recordAnalysis,
  recordArmedGateBlock,
  armedGateStats,
  armedGateWasteLine,
} from './armed-analysis-filter.js'

// The production shape, 16-09-2026: the matrix arms 3d/12h/8h for these
// symbols, the scanner's ladder is 1mo/1w/1d/4h/1h/30m/15m/5m plus whatever
// `autotrade_timeframes` adds (in production [4h,1d,5m,1h,30m]), so those
// armed cells are never scanned at all.
const MATRIX = {
  GBPUSD: ['3d'],
  GER40: ['3d'],
  JPN225: ['12h', '8h'],
  US30: ['12h', '4d', '1d', '1w', '3d'],
}
const LIST = ['4h', '1d', '5m', '1h', '30m']
// Strategies armed to TRADE (the stage matrix's Auto Trade & Open column),
// which is a different set from the strategies the scan computes.
const ARMED_STRATEGIES = ['vwap_trend', 'vp_value']

const row = (symbol, strategy, timeframe, confidence = 9, bias = 'long') =>
  ({ symbol, strategy, timeframe, confidence, bias })

test('a symbol whose scan produced no armed timeframe is dropped before the slots, with a reason', () => {
  const scans = [
    row('GBPUSD', 'vwap_trend', '1h', 7),
    row('GBPUSD', 'fib_confluence', '15m', 10),
    row('GER40', 'fib_confluence', '5m'),
    row('US30', 'vwap_trend', '30m'),
    row('US30', 'vp_value', '1d', 6),
  ]
  const { kept, dropped } = filterArmedCandidates(['GBPUSD', 'GER40', 'US30'], scans, { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })
  assert.deepEqual(kept, ['US30'], 'US30 keeps its slot — 1d is armed for it and the scan produced it')
  assert.deepEqual(dropped.map(d => d.symbol), ['GBPUSD', 'GER40'])
  // Never silently: the reason names what was scanned and why none of it is armed.
  assert.match(dropped[0].reason, /no scanned timeframe is armed/)
  assert.match(dropped[0].reason, /vwap_trend@1h/)
  assert.match(dropped[0].reason, /armed: 3d/)
  // The decision row can name one cell; it names the STRONGEST refused one,
  // not whichever sorted first (scan order is arbitrary).
  assert.equal(dropped[0].attribution.strategy, 'fib_confluence')
  assert.equal(dropped[0].attribution.timeframe, '15m')
  assert.equal(dropped[0].blocked.length, 2, 'and every refused cell is still carried')
})

test('the filter only ever removes, and only what armedScopeGate itself refuses', () => {
  const scans = [
    row('GBPUSD', 'vwap_trend', '1h'), row('US30', 'vp_value', '1d'),
    row('PEP.US', 'rsi2_reversion', '15m'), row('PEP.US', 'vwap_trend', '4h'),
  ]
  const pool = ['GBPUSD', 'US30', 'PEP.US']
  const { kept } = filterArmedCandidates(pool, scans, { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })
  assert.ok(kept.every(s => pool.includes(s)), 'nothing is invented')
  assert.deepEqual(kept, pool.filter(s => kept.includes(s)), 'surviving order is untouched')
  // Every kept symbol has a row the REAL gate admits — the filter cannot be
  // more permissive than the backstop it feeds.
  for (const sym of kept) {
    const ok = scans.filter(r => r.symbol === sym)
      .some(r => armedScopeGate({ symbol: sym, timeframe: r.timeframe, allowedTfs: LIST, matrix: MATRIX }).ok)
    assert.ok(ok, `${sym} was kept without an armed row`)
  }
})

test('matrix wins over the list, and the list gates symbols the matrix does not name', () => {
  // GBPUSD armed 3d by the matrix: 1d is on the LIST but must not save it.
  const onlyList = filterArmedCandidates(['GBPUSD'], [row('GBPUSD', 'vwap_trend', '1d')], { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })
  assert.deepEqual(onlyList.kept, [], 'the list cannot arm a timeframe the matrix did not give this symbol')
  const onMatrixTf = filterArmedCandidates(['GBPUSD'], [row('GBPUSD', 'vwap_trend', '3d')], { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })
  assert.deepEqual(onMatrixTf.kept, ['GBPUSD'], '3d is armed by the matrix though the list lacks it')
  // PEP.US is not in the matrix, so the list decides.
  const listed = filterArmedCandidates(['PEP.US'], [row('PEP.US', 'vwap_trend', '4h')], { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })
  assert.deepEqual(listed.kept, ['PEP.US'])
  const unlisted = filterArmedCandidates(['PEP.US'], [row('PEP.US', 'vwap_trend', '15m')], { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })
  assert.deepEqual(unlisted.kept, [], '15m is in neither the matrix nor the list')
  // No usable matrix: the list gates everything.
  const noMatrix = filterArmedCandidates(['GBPUSD'], [row('GBPUSD', 'vwap_trend', '1d')], { scope: 'armed', allowedTfs: LIST, matrix: null })
  assert.deepEqual(noMatrix.kept, ['GBPUSD'])
})

test('a symbol the scan says nothing usable about keeps its slot', () => {
  const scans = [row('AUDUSD', null, null, 0, 'skip'), row('OTHER', 'vwap_trend', '1h')]
  const { kept, dropped } = filterArmedCandidates(['AUDUSD', 'NZDUSD'], scans, { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })
  assert.deepEqual(kept, ['AUDUSD', 'NZDUSD'], 'skip rows and absent symbols are not this filter\'s to refuse')
  assert.deepEqual(dropped, [])
})

test('the slot is spent on an armed timeframe even when a louder strategy signals on an unarmed one', () => {
  // US30, exactly as production: 30m at conviction 10 beat 1d at 7 every pass.
  const thirtyM = { strategy: 'vwap_trend', timeframe: '30m', conviction: 10 }
  const oneD = { strategy: 'vp_value', timeframe: '1d', conviction: 7 }
  const picked = pickArmedSignal([thirtyM, oneD], { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX })
  assert.equal(picked.signal, oneD)
  assert.match(picked.reason, /armed timeframe 1d/)
  // And the gate that used to discard the pass now passes it — the SAME gate,
  // unchanged, on a different cell.
  assert.equal(armedScopeGate({ symbol: 'US30', timeframe: '30m', allowedTfs: LIST, matrix: MATRIX }).ok, false,
    'the blocked cell is still blocked')
  assert.equal(armedScopeGate({ symbol: 'US30', timeframe: picked.signal.timeframe, allowedTfs: LIST, matrix: MATRIX }).ok, true)
})

test('the fair-share slot keeps its strategy when that strategy has an armed candidate that can trade', () => {
  const cands = [
    { strategy: 'vwap_trend', timeframe: '1d', conviction: 10 },
    { strategy: 'vp_value', timeframe: '1w', conviction: 4 },
  ]
  const picked = pickArmedSignal(cands, { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX, prefer: 'vp_value', armedStrategyKeys: ARMED_STRATEGIES })
  assert.equal(picked.signal.strategy, 'vp_value', 'a granted slot is not quietly handed to the loudest strategy')
  // A preferred strategy with nothing armed falls back to the best armed one.
  const noArmedPrefer = pickArmedSignal(
    [{ strategy: 'vwap_trend', timeframe: '1d', conviction: 3 }, { strategy: 'rsi2_reversion', timeframe: '5m', conviction: 10 }],
    { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX, prefer: 'rsi2_reversion', armedStrategyKeys: ARMED_STRATEGIES },
  )
  assert.equal(noArmedPrefer.signal.strategy, 'vwap_trend')
  // A preferred strategy that is NOT trade-armed does not win either: the
  // stage-matrix gate would block it and the slot would be waste again.
  const preferUnarmed = pickArmedSignal(
    [{ strategy: 'fib_confluence', timeframe: '1d', conviction: 10 }, { strategy: 'vwap_trend', timeframe: '1d', conviction: 2 }],
    { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX, prefer: 'fib_confluence', armedStrategyKeys: ARMED_STRATEGIES },
  )
  assert.equal(preferUnarmed.signal.strategy, 'vwap_trend', 'a granted slot cannot be spent on a strategy that cannot trade')
})

test('the picker ranks the way the scan does: armed STRATEGY first, then conviction — it cannot destroy a dispatch that would have traded', () => {
  // The checker's verified scenario, 16-09-2026. Before this PR the dispatch
  // was bestOf(signals, armedPredicate) → vwap_trend@1d → armed gate ok →
  // stage gate ok → a trade. A conviction-only pick would have handed the
  // slot to fib_confluence, which the stage gate blocks: a LOST TRADE, which
  // is strictly worse than the wasted slot this PR removes.
  const unarmedStrategyLouder = { strategy: 'fib_confluence', timeframe: '1d', conviction: 10 }
  const armedStrategyQuieter = { strategy: 'vwap_trend', timeframe: '1d', conviction: 7 }
  const cands = [unarmedStrategyLouder, armedStrategyQuieter]
  const picked = pickArmedSignal(cands, { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX, armedStrategyKeys: ARMED_STRATEGIES })
  assert.equal(picked.signal, armedStrategyQuieter, 'armed strategy beats an unarmed one, exactly as bestOf does')
  // And it IS bestOf's ordering, not a copy of it: the same inputs through
  // the scan's own ranker give the same winner.
  assert.equal(bestOf(cands, armedPredicate({ armedStrategyKeys: ARMED_STRATEGIES })), armedStrategyQuieter)
  // Within one preference tier conviction still decides.
  const bothArmed = [{ strategy: 'vwap_trend', timeframe: '1d', conviction: 6 }, { strategy: 'vp_value', timeframe: '1w', conviction: 9 }]
  assert.equal(pickArmedSignal(bothArmed, { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX, armedStrategyKeys: ARMED_STRATEGIES }).signal.strategy, 'vp_value')
  // With no armed-strategy list (backtest/legacy callers) it is pure conviction,
  // which is what fib-strategy.js does for the same input.
  assert.equal(pickArmedSignal(cands, { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX }).signal, unarmedStrategyLouder)
  assert.equal(bestOf(cands, armedPredicate({})), unarmedStrategyLouder)
})

test('no armed candidate → null, so the caller keeps its old choice and the backstop still refuses it', () => {
  const cands = [{ strategy: 'vwap_trend', timeframe: '1h', conviction: 10 }, { strategy: 'fib_confluence', timeframe: '15m', conviction: 9 }]
  assert.equal(pickArmedSignal(cands, { symbol: 'GBPUSD', allowedTfs: LIST, matrix: MATRIX }), null)
  assert.equal(pickArmedSignal([], { symbol: 'GBPUSD', allowedTfs: LIST, matrix: MATRIX }), null)
  // A candidate with no timeframe is never chosen and never throws.
  assert.equal(pickArmedSignal([{ strategy: 'x', conviction: 10 }], { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX }), null)
  const { blocked } = armedRowsFor([{ strategy: 'x', conviction: 10 }], { symbol: 'US30', allowedTfs: LIST, matrix: MATRIX })
  assert.match(blocked[0].reason, /no timeframe/)
})

test('1mo can never trade under scope armed, on any arming — it is not in any armed set', () => {
  // Noted 16-09-2026: `1mo` is in the scanner ladder but not in
  // DEFAULT_AUTOTRADE_TIMEFRAMES, so a 1mo analysis is always a spent slot
  // under scope 'armed'. The pre-filter is what stops it consuming one.
  const scans = [row('GER40', 'fib_confluence', '1mo')]
  assert.deepEqual(filterArmedCandidates(['GER40'], scans, { scope: 'armed', allowedTfs: LIST, matrix: MATRIX }).kept, [])
  assert.deepEqual(filterArmedCandidates(['XAUUSD'], [row('XAUUSD', 'fib_confluence', '1mo')], { scope: 'armed', allowedTfs: LIST, matrix: null }).kept, [])
})

test("scope 'all' (the default) is completely unaffected — nothing is dropped and nothing is re-picked", () => {
  const scans = [
    row('GBPUSD', 'vwap_trend', '1h'), row('GER40', 'fib_confluence', '5m'),
    row('US30', 'vwap_trend', '30m'), row('US30', 'vp_value', '1d', 6),
  ]
  const pool = ['GBPUSD', 'GER40', 'US30']
  for (const scope of ['all', undefined, null, '', 'ALL', 'anything-else']) {
    const r = filterArmedCandidates(pool, scans, { scope, allowedTfs: LIST, matrix: MATRIX })
    assert.deepEqual(r.kept, pool, `scope ${String(scope)} must drop nothing`)
    assert.deepEqual(r.dropped, [], `scope ${String(scope)} must report nothing`)
    const pick = armedPickerFor(scope, { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })
    assert.equal(pick('US30', 'vwap_trend', [{ strategy: 'vp_value', timeframe: '1d', conviction: 9 }]), null,
      `scope ${String(scope)} must leave the dispatched signal exactly as it was`)
    assert.equal(armedScopeActive(scope), false)
  }
  // ...and 'armed' is the one scope that does anything.
  assert.equal(armedScopeActive('armed'), true)
  assert.deepEqual(filterArmedCandidates(pool, scans, { scope: 'armed', allowedTfs: LIST, matrix: MATRIX }).kept, ['US30'])
  assert.equal(armedPickerFor('armed', { scope: 'armed', allowedTfs: LIST, matrix: MATRIX })('US30', null,
    [{ strategy: 'vwap_trend', timeframe: '30m', conviction: 10 }, { strategy: 'vp_value', timeframe: '1d', conviction: 6 }]).signal.timeframe, '1d')
})

test('the waste counter reports what the gate discarded, and says nothing when nothing was', () => {
  resetArmedGateStats()
  recordAnalysis(); recordAnalysis(); recordAnalysis()
  assert.equal(armedGateWasteLine(armedGateStats()), null, 'scope all discards nothing and prints nothing')
  recordArmedGateBlock({ symbol: 'GER40', timeframe: '5m', reason: '5m not armed for this symbol (armed: 3d)' })
  recordArmedGateBlock({ symbol: 'GBPUSD', timeframe: '1h', reason: '1h not armed for this symbol (armed: 3d)' })
  const line = armedGateWasteLine(armedGateStats())
  assert.match(line, /Armed gate waste: 2 of 3/)
  assert.match(line, /GER40 5m \(5m not armed/)
  assert.equal(armedGateStats().blocked, 2)
  resetArmedGateStats()
  assert.deepEqual(armedGateStats(), { analysed: 0, blocked: 0, detail: [] })
  // The detail list is capped; the count is not.
  for (let i = 0; i < 12; i++) recordArmedGateBlock({ symbol: `S${i}`, timeframe: '5m', reason: 'nope' })
  assert.equal(armedGateStats().blocked, 12)
  assert.equal(armedGateStats().detail.length, 8)
  assert.match(armedGateWasteLine(armedGateStats()), /\+4 more/)
  // A blocked count above the analysed count never prints a rate over 100%.
  resetArmedGateStats()
  recordArmedGateBlock({ symbol: 'X', timeframe: '5m', reason: 'nope' })
  const noDenom = armedGateWasteLine(armedGateStats())
  assert.doesNotMatch(noDenom, /1 of 0/)
  assert.match(noDenom, /denominator unavailable/)
  // take = read AND clear, so nothing counted is ever dropped unreported:
  // the pending-signals retry path increments between passes and its tally
  // shows up in the next line rather than being reset away unseen.
  resetArmedGateStats()
  recordAnalysis(); recordArmedGateBlock({ symbol: 'Y', timeframe: '5m', reason: 'nope' })
  const taken = takeArmedGateStats()
  assert.deepEqual([taken.analysed, taken.blocked], [1, 1])
  assert.deepEqual(armedGateStats(), { analysed: 0, blocked: 0, detail: [] }, 'taking clears the tally')
  recordAnalysis()
  assert.equal(armedGateStats().analysed, 1, 'and counting resumes from zero')
  resetArmedGateStats()
})

test('wiring pin: the loop pre-filters, picks armed, counts and prints — all only under scope armed', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /const autotradeScope = getState\(db, 'autotrade_scope'\) \|\| 'all'/, 'the scope is read once, defaulting to all')
  assert.match(loop, /filterArmedCandidates\(afterHorizon, scanResult\.scans, \{ scope: autotradeScope, allowedTfs: armedAllowedTfs, matrix: armedMatrix \}\)/, 'the pre-filter runs on the pool and is told the scope')
  assert.match(loop, /armedPickerFor\(autotradeScope, \{ allowedTfs: armedAllowedTfs, matrix: armedMatrix, armedStrategyKeys \}\)/, 'the picker is told the scope and the trade-armed strategies')
  assert.match(loop, /stage: 'armed_scope_prefilter', decision: 'skip'/, 'a dropped candidate leaves a decision row')
  assert.match(loop, /afterHorizon = armedPool\.kept[\s\S]{0,400}?const pool = afterHorizon/, 'the slot allocator is handed the filtered list')
  
  assert.match(loop, /const dispatched = armed\?\.signal \|\| fallback[\s\S]{0,200}?await dispatchSymbolSignal\(db, s, symbols, sym, dispatched\)/, 'the picked signal is the one dispatched')
  assert.match(loop, /if \(markLruAnalysed\) markLruAnalysed\(dispatchedStrategies\)/, 'the fair-share clock is stamped after dispatch, by what ran')
  assert.match(loop, /recordArmedGateBlock\(\{ symbol: sym, timeframe: synth\.timeframe, reason: scope\.reason \}\)/, 'the backstop gate feeds the counter')
  assert.match(loop, /recordAnalysis\(\)/, 'every completed analysis is the denominator')
  assert.match(loop, /const wasteLine = armedGateWasteLine\(takeArmedGateStats\(\)\)\s+if \(wasteLine\) log\(wasteLine\)/, 'the pass prints its waste rate and clears the tally')
  // NOTE: the backstop gate is NOT pinned here. The previous version of this
  // test claimed it was, with a regex that stayed green when the gate was
  // mutated to `if (false && !scope.ok)` — coverage that could not fail. The
  // real check is the behaviour test below, which calls dispatchSymbolSignal.
})

test('BEHAVIOUR: the backstop gate still disarms an analysis on an unarmed timeframe, and counts it', async () => {
  // The constraint this whole PR had to protect, exercised rather than
  // asserted about: scope 'armed', a symbol the matrix arms only on 3d, an
  // analysis that arrives on 1h. Goes red if the gate stops disarming
  // (`if (false && !scope.ok)`), if it stops counting, or if the pick/filter
  // work is ever allowed to substitute for it.
  const { dispatchSymbolSignal } = await import('../loop.js')
  const db = initDB(':memory:')
  setState(db, 'autotrade_scope', 'armed')
  setState(db, 'autotrade_matrix_json', JSON.stringify({ NATGAS: ['3d'] }))
  const s = { latestScanForSymbol: new Map(), insertAnalysis: { run: () => ({ lastInsertRowid: 1 }) } }
  const signal = { strategy: 'donchian_breakout', bias: 'long', direction_reason: 'x', conviction: 9, entry: 111.5, sl: 108, tp1: 121, tp2: 126, thesis: 't', timeframe: '1h' }
  const watch = [{ symbol: 'NATGAS', autoTradeThreshold: 8 }]

  resetArmedGateStats()
  const blockedRun = await dispatchSymbolSignal(db, s, watch, 'NATGAS', { ...signal })
  assert.equal(blockedRun.synth.auto_trade, false, 'an unarmed timeframe is DISARMED by the backstop gate')
  const after = armedGateStats()
  assert.equal(after.analysed, 1, 'the analysis was completed — the slot really was spent')
  assert.equal(after.blocked, 1, 'and the gate counted the discard')
  assert.match(after.detail[0].reason, /1h not armed for this symbol \(armed: 3d\)/)
  assert.equal(after.detail[0].symbol, 'NATGAS')

  // The armed cell on the same symbol survives the gate — so the assertion
  // above is about the gate's verdict, not about everything being refused.
  resetArmedGateStats()
  const armedRun = await dispatchSymbolSignal(db, s, watch, 'NATGAS', { ...signal, timeframe: '3d' })
  assert.equal(armedRun.synth.auto_trade, true, 'an armed timeframe is not disarmed')
  assert.equal(armedGateStats().blocked, 0)
  assert.equal(armedGateStats().analysed, 1)

  // Scope 'all': the same 1h analysis is never gated at all.
  resetArmedGateStats()
  setState(db, 'autotrade_scope', 'all')
  const allRun = await dispatchSymbolSignal(db, s, watch, 'NATGAS', { ...signal })
  assert.equal(allRun.synth.auto_trade, true, "scope 'all' does not consult the arming")
  assert.equal(armedGateStats().blocked, 0)
  resetArmedGateStats()
})
