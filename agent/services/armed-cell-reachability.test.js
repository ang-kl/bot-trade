// node --test agent/services/armed-cell-reachability.test.js
//
// The diagnostic for armed symbol×timeframe cells no scan can ever produce.
// The production case is the fixture: the matrix arms 3d/12h/8h, the
// scanner's ladder is 1mo/1w/1d/4h/1h/30m/15m/5m plus the stored
// `autotrade_timeframes` ([4h,1d,5m,1h,30m] in production), so those cells
// are armed, never scanned, and unable to trade under any setup.
//
// CLAUDE.md, "a guard whose trigger can never fire": the input that makes
// this report non-empty is the arming matrix measured in production on
// 86db230, and it is the first fixture below.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import stateRouter from '../routes/state.js'
import { scanTimeframeLadder } from './fib-strategy.js'
import {
  unreachableArmedCells,
  readArmedCellReachability,
  armedCellBootLine,
  nearestScannable,
} from './armed-cell-reachability.js'

// Production, 16-09-2026, `autotrade_scope = 'armed'` on 86db230.
const PROD_MATRIX = {
  GER40: ['3d'],
  'HON.US': ['4h'],
  JPN225: ['12h', '8h'],
  US2000: ['12h', '8h'],
}
const PROD_LIST = ['4h', '1d', '5m', '1h', '30m']

const prod = (over = {}) => unreachableArmedCells({
  matrix: PROD_MATRIX, extraTimeframes: PROD_LIST, armedList: PROD_LIST, scope: 'armed', ...over,
})

// ---------------------------------------------------------------------------
// The production case
// ---------------------------------------------------------------------------

test('the production matrix reports GER40, JPN225 and US2000 as armed only on timeframes the scan never produces', () => {
  const r = prod()
  assert.deepEqual(r.strandedSymbols, ['GER40', 'JPN225', 'US2000'])
  assert.deepEqual(r.cells, [
    { symbol: 'GER40', timeframe: '3d' },
    { symbol: 'JPN225', timeframe: '12h' },
    { symbol: 'JPN225', timeframe: '8h' },
    { symbol: 'US2000', timeframe: '12h' },
    { symbol: 'US2000', timeframe: '8h' },
  ])
  // "possibly none" — these three have no armed timeframe left that scans.
  for (const s of r.symbols) assert.deepEqual(s.scannableArmed, [])
})

test("HON.US is NOT reported: it is armed on 4h, which the ladder DOES produce", () => {
  // It appears in PR-M's pre-filter log because that pass returned no 4h row,
  // which is an episodic miss, not a misconfiguration. Reporting it here
  // would put a line in the report that names no decision — the failure this
  // whole module is trying not to become.
  const r = prod()
  assert.ok(!r.strandedSymbols.includes('HON.US'))
  assert.ok(!r.partialSymbols.includes('HON.US'))
  assert.ok(!r.cells.some(c => c.symbol === 'HON.US'))
  assert.ok(r.ladder.includes('4h'))
})

test('a symbol the matrix does not name is not reported', () => {
  const r = prod()
  assert.ok(!r.symbols.some(s => s.symbol === 'EURUSD'))
  assert.equal(r.matrixSymbols, 4)
})

test('a symbol with one unreachable and one scannable armed timeframe is reported as partial, not stranded', () => {
  const r = unreachableArmedCells({
    matrix: { US30: ['12h', '1d'] }, extraTimeframes: PROD_LIST, armedList: PROD_LIST, scope: 'armed',
  })
  assert.deepEqual(r.strandedSymbols, [])
  assert.deepEqual(r.partialSymbols, ['US30'])
  assert.deepEqual(r.symbols[0].unreachable, ['12h'])
  assert.deepEqual(r.symbols[0].scannableArmed, ['1d'])
})

// ---------------------------------------------------------------------------
// The remedy has to be usable
// ---------------------------------------------------------------------------

test('every timeframe the remedy offers to re-arm onto is genuinely scannable', () => {
  const r = prod()
  const ladder = new Set(scanTimeframeLadder(PROD_LIST))
  for (const s of r.symbols) {
    assert.ok(s.remedy.rearmOnto.length > 0)
    for (const tf of s.remedy.rearmOnto) assert.ok(ladder.has(tf), `${tf} is not in the scan ladder`)
    for (const n of s.remedy.nearest) {
      assert.ok(ladder.has(n.nearestScannable), `${n.timeframe} → ${n.nearestScannable} is not scannable`)
    }
  }
  // Nearest by duration RATIO: 12h is nearer 1d (×2) than 4h (×3); 8h is
  // nearer 4h (×2) than 1d (×3); 3d is nearer 1w (×2.33) than 1d (×3).
  const near = Object.fromEntries(r.symbols.flatMap(s => s.remedy.nearest.map(n => [n.timeframe, n.nearestScannable])))
  assert.deepEqual(near, { '3d': '1w', '12h': '1d', '8h': '4h' })
})

test('the ladder addition that would fix every listed symbol is stated once, longest first', () => {
  const r = prod()
  assert.deepEqual(r.ladderAdditionThatFixesAll, ['3d', '12h', '8h'])
  // And adding them really does clear the report — the remedy is checkable,
  // not a suggestion.
  const after = unreachableArmedCells({
    matrix: PROD_MATRIX,
    extraTimeframes: [...PROD_LIST, ...r.ladderAdditionThatFixesAll],
    armedList: PROD_LIST, scope: 'armed',
  })
  assert.deepEqual(after.cells, [])
  assert.equal(armedCellBootLine(after), null)
})

test('a timeframe the parser cannot read is offered as a re-arm only — never as a ladder addition that would not work', () => {
  const r = unreachableArmedCells({
    matrix: { WTI: ['banana', '3d'] }, extraTimeframes: PROD_LIST, armedList: PROD_LIST, scope: 'armed',
  })
  const remedy = r.symbols[0].remedy
  assert.deepEqual(remedy.addToAutotradeTimeframes, ['3d'])
  assert.deepEqual(remedy.unaddable, ['banana'])
  // scanSymbolFib drops unreadable labels from its own set, so listing
  // 'banana' as an addition would be a remedy that does not remedy.
  assert.ok(!scanTimeframeLadder(['banana']).includes('banana'))
  assert.equal(remedy.nearest.find(n => n.timeframe === 'banana').nearestScannable, null)
})

test('nearestScannable returns null rather than inventing a neighbour for an unreadable timeframe', () => {
  assert.equal(nearestScannable('banana', ['1d', '4h']), null)
  assert.equal(nearestScannable('12h', []), null)
})

// ---------------------------------------------------------------------------
// Silence, scope, and bad data
// ---------------------------------------------------------------------------

test('the report is empty and the boot line silent when every armed cell is scannable', () => {
  const r = unreachableArmedCells({
    matrix: { EURUSD: ['1d', '4h'], GER40: ['1h'] }, extraTimeframes: PROD_LIST, armedList: PROD_LIST, scope: 'armed',
  })
  assert.deepEqual(r.cells, [])
  assert.deepEqual(r.symbols, [])
  assert.deepEqual(r.listOnlyUnreachable, [])
  assert.equal(armedCellBootLine(r), null)
})

test('the finding is flagged latent under scope all, and the boot line stays silent there', () => {
  const r = prod({ scope: 'all' })
  assert.equal(r.scope, 'all')
  assert.equal(r.activeUnderScope, false)
  assert.match(r.note, /latent/)
  // The cells are still computed and served — only the shouting is scoped.
  assert.equal(r.cells.length, 5)
  assert.equal(armedCellBootLine(r), null)
  // An absent scope is 'all', not 'armed'.
  assert.equal(unreachableArmedCells({ matrix: PROD_MATRIX, extraTimeframes: PROD_LIST }).activeUnderScope, false)
})

test('an empty, absent, array or non-object matrix yields no per-symbol cells and never throws', () => {
  for (const matrix of [null, undefined, {}, [], ['GER40'], 'GER40', 42]) {
    const r = unreachableArmedCells({ matrix, extraTimeframes: PROD_LIST, armedList: PROD_LIST, scope: 'armed' })
    assert.equal(r.matrixUsable, false, `matrix ${JSON.stringify(matrix) ?? 'undefined'}`)
    assert.deepEqual(r.cells, [])
    assert.deepEqual(r.symbols, [])
  }
})

test('a matrix entry that is not an array, or carries non-string timeframes, is counted as malformed rather than crashing', () => {
  const r = unreachableArmedCells({
    matrix: { GER40: '3d', JPN225: ['12h', 3, ''], EURUSD: ['1d'] },
    extraTimeframes: PROD_LIST, armedList: PROD_LIST, scope: 'armed',
  })
  assert.equal(r.malformedEntries, 2)
  assert.deepEqual(r.strandedSymbols, ['JPN225'])
  assert.deepEqual(r.symbols[0].unreachable, ['12h'])
})

test('timeframes in the arming list that the ladder never produces are reported separately, because they gate every unnamed symbol', () => {
  // The clean-install shape: nothing stored, so the scan ladder is the base
  // eight while armedTimeframes() falls back to the full default list.
  const r = unreachableArmedCells({
    matrix: null, extraTimeframes: [],
    armedList: ['1w', '4d', '3d', '1d', '12h', '8h', '4h', '1h', '30m', '15m', '10m', '5m', '2m'],
    scope: 'armed',
  })
  assert.deepEqual(r.listOnlyUnreachable, ['4d', '3d', '12h', '8h', '10m', '2m'])
  assert.match(armedCellBootLine(r), /autotrade_timeframes carries 4d,3d,12h,8h,10m,2m/)
})

// ---------------------------------------------------------------------------
// The boot line
// ---------------------------------------------------------------------------

test('the boot line names the count, the symbols, their unreachable cells and the two fixes', () => {
  const line = armedCellBootLine(prod())
  assert.equal(
    line,
    '[boot] armed cells: 3 symbol(s) armed only on timeframes the scan never produces ' +
    '(GER40 3d; JPN225 12h,8h; US2000 12h,8h) — fix: re-arm onto one of ' +
    '1mo,1w,1d,4h,1h,30m,15m,5m, or add 3d,12h,8h to autotrade_timeframes ' +
    '(GET /state/armed-cell-reachability)',
  )
})

test('the boot line caps the symbols it names and says how many more there are', () => {
  const matrix = {}
  for (let i = 0; i < 11; i += 1) matrix[`SYM${String(i).padStart(2, '0')}`] = ['3d']
  const line = armedCellBootLine(unreachableArmedCells({ matrix, extraTimeframes: PROD_LIST, armedList: PROD_LIST, scope: 'armed' }))
  assert.match(line, /11 symbol\(s\) armed only/)
  assert.match(line, /\+3 more/)
  assert.ok(!line.includes('SYM08'))
})

test('the boot line separates stranded symbols from partly-unreachable ones', () => {
  const line = armedCellBootLine(unreachableArmedCells({
    matrix: { GER40: ['3d'], US30: ['12h', '1d'] }, extraTimeframes: PROD_LIST, armedList: PROD_LIST, scope: 'armed',
  }))
  assert.match(line, /1 symbol\(s\) armed only on timeframes the scan never produces \(GER40 3d\)/)
  assert.match(line, /1 symbol\(s\) with some unreachable armed cells but a scannable one left \(US30 12h\)/)
})

// ---------------------------------------------------------------------------
// The wiring. A repair nothing calls is dead (CLAUDE.md failure mode #4).
// ---------------------------------------------------------------------------

test('readArmedCellReachability reads the real state keys and the SCANNER ladder, not the stored list', () => {
  const db = initDB(':memory:')
  setState(db, 'autotrade_scope', 'armed')
  setState(db, 'autotrade_matrix_json', JSON.stringify(PROD_MATRIX))
  setState(db, 'autotrade_timeframes', JSON.stringify(PROD_LIST))
  const r = readArmedCellReachability(db, getState)
  assert.equal(r.scope, 'armed')
  assert.equal(r.activeUnderScope, true)
  assert.deepEqual(r.strandedSymbols, ['GER40', 'JPN225', 'US2000'])
  assert.deepEqual(r.storedTimeframes, PROD_LIST)
  // 1mo and 1w are in the SCANNER's ladder and NOT in the stored list. A
  // reader that only consulted the stored list would call them unreachable.
  setState(db, 'autotrade_matrix_json', JSON.stringify({ XAUUSD: ['1mo', '1w'] }))
  const only = readArmedCellReachability(db, getState)
  assert.deepEqual(only.cells, [])
  assert.ok(only.ladder.includes('1mo') && only.ladder.includes('1w'))
})

test('readArmedCellReachability survives a corrupt matrix and a corrupt timeframe list', () => {
  const db = initDB(':memory:')
  setState(db, 'autotrade_scope', 'armed')
  setState(db, 'autotrade_matrix_json', '{not json')
  setState(db, 'autotrade_timeframes', '{not json')
  const r = readArmedCellReachability(db, getState)
  assert.equal(r.matrixUsable, false)
  assert.deepEqual(r.storedTimeframes, [])
  // A corrupt list means the SCAN gets the base ladder while ARMING falls
  // back to the full default — the asymmetry that created the defect, and it
  // is visible in the report rather than smoothed over.
  assert.deepEqual(r.listOnlyUnreachable, ['4d', '3d', '12h', '8h', '10m', '2m'])
})

test('GET /state/armed-cell-reachability serves the report for the production state', async () => {
  const db = initDB(':memory:')
  setState(db, 'autotrade_scope', 'armed')
  setState(db, 'autotrade_matrix_json', JSON.stringify(PROD_MATRIX))
  setState(db, 'autotrade_timeframes', JSON.stringify(PROD_LIST))
  const app = express()
  app.use('/state', stateRouter(db))
  const s = app.listen(0)
  try {
    const port = s.address().port
    const r = await fetch(`http://127.0.0.1:${port}/state/armed-cell-reachability`).then(x => x.json())
    assert.equal(r.error, undefined)
    assert.equal(r.scope, 'armed')
    assert.equal(r.activeUnderScope, true)
    assert.deepEqual(r.strandedSymbols, ['GER40', 'JPN225', 'US2000'])
    assert.deepEqual(r.ladderAdditionThatFixesAll, ['3d', '12h', '8h'])
    assert.ok(!r.symbols.some(x => x.symbol === 'HON.US'))
    assert.ok(r.symbols.every(x => x.remedy.rearmOnto.length && x.remedy.nearest.length))
  } finally { s.close() }
})

test('the boot report is wired into index.js', () => {
  // Source-text, and a last resort: the call sits at module top level in a
  // 1,100-line entry point that opens a database and a live broker socket on
  // import, so there is no injection point to exercise. It pins the call
  // site, which is invisible from this module and which a refactor drops in
  // silence (CLAUDE.md failure mode #4).
  const src = stripComments(new URL('../index.js', import.meta.url))
  assert.match(src, /armed-cell-reachability\.js/)
  assert.match(src, /armedCellBootLine\(\s*readArmedCellReachability\(db,\s*getState\)\s*\)/)
})

test('the scanner builds its scan set from the same exported ladder the diagnostic reads', () => {
  // The whole defect is a second copy of the timeframe list. If scanSymbolFib
  // ever stops calling scanTimeframeLadder, the diagnostic starts reporting
  // against a ladder the scanner no longer uses — silently correct-looking
  // and wrong, which is this repo's recurring shape.
  const src = stripComments(new URL('./fib-strategy.js', import.meta.url))
  assert.match(src, /const scanTfs = scanTimeframeLadder\(opts\.extraTimeframes\)/)
  // And there is exactly ONE literal of the base ladder in the repo's scan path.
  assert.equal((src.match(/'1mo', '1w', '1d', '4h'/g) || []).length, 1)
})

// Comments are stripped before any source assertion: a test that passes by
// matching its own explanatory prose proves nothing (CLAUDE.md failure
// mode #2 — `amend-preserves-tp.test.js` went green with the payload deleted).
function stripComments(url) {
  return readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}
