// node --test agent/loop-confluence-filters.test.js
//
// PR-F (owner principle 6, "UI switches are logic-built, not for show").
// Tune's RSI / VWAP / FVG confluence switches write fib_*_filter. The plan
// (docs/owner-principles-plan-2026-09-11.md §3.5) recorded them as honoured
// by the manual routes only — "agent/loop.js never reads them". Measured
// against HEAD that claim is wrong: the loop reads them through ONE chain,
//
//   fib_<x>_filter = 'true'            (Tune switch, /actions/fib-<x>-filter)
//     → scanFilterOptions()            annotate mode when the trade cell is on
//     → runFibScan → computeFibSignal  filters_failed: ['<x>'] on the signal
//     → tradeStageGate()               refuses the dispatch, names the filter
//
// and every link of that chain lives in a different file, so a refactor can
// drop one silently and the switch turns decorative without a test going
// red. This file pins the chain end to end on the REAL functions with an
// in-memory DB, and pins the two loop.js call sites by comment-stripped
// source (failure mode #4: a repair that nothing calls).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from './db.js'
import { scanFilterOptions, tradeStageGate, setStage } from './services/stage-matrix.js'
import { computeFibSignal } from './services/fib-strategy.js'

const HOUR = 3_600_000
// Same fixture as fib-filter-annotate.test.js: decline to a fractal low,
// rally, shallow retrace. The last close sits far ABOVE the leg-anchored
// VWAP, so the VWAP filter fails for the long bias it produces.
function buildRetraceBars() {
  const bars = []
  const t0 = Date.UTC(2026, 0, 5)
  const push = (i, p) => bars.push({ t: t0 + i * HOUR, o: p + 0.1, h: p + 0.3, l: p - 0.4, c: p, v: 100 })
  for (let i = 0; i <= 15; i++) push(i, 96.4 - 0.4 * i + 0.4)
  bars[15] = { ...bars[15], l: 90, c: 90.4 }
  for (let i = 16; i <= 30; i++) push(i, 90 + (20 / 15) * (i - 15))
  for (let i = 31; i <= 39; i++) push(i, 110 - 0.5 * (i - 30))
  return bars
}

function freshDb() {
  const db = initDB(':memory:')
  const io = { getState, setState }
  // The fib fade must be trade-armed, else the gate refuses on the strategy
  // cell and the filter is never the reason — which would prove nothing.
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true }, io)
  // RSI is trade-armed BY DEFAULT (kill naked fib); pin it OFF so the only
  // filter under test is the one each case switches.
  setState(db, 'fib_rsi_filter', 'false')
  setState(db, 'fib_fvg_filter', 'false')
  return db
}

// The loop path, reduced to the exact calls loop.js makes with the DB it
// reads: scanFilterOptions → computeFibSignal(opts) → tradeStageGate.
function loopVerdict(db, bars) {
  const opts = scanFilterOptions(db, getState)
  const signal = computeFibSignal(bars, '1h', { pendingSetup: true, ...opts })
  assert.ok(signal, 'the fixture must produce a candidate — a null here tests nothing')
  const gate = tradeStageGate(db, getState, { strategy: 'fib_618_fade', filtersFailed: signal?.filters_failed || [] })
  return { opts, signal, gate }
}

test('VWAP switch OFF: the loop chain admits the candidate', () => {
  const db = freshDb()
  setState(db, 'fib_vwap_filter', 'false')
  const { opts, signal, gate } = loopVerdict(db, buildRetraceBars())
  assert.equal(opts.vwapFilter, null, 'switch off → the scan does not run the VWAP check at all')
  assert.deepEqual(signal.filters_failed, [])
  assert.equal(gate.ok, true, gate.reason)
})

test('VWAP switch ON (Tune → /actions/fib-vwap-filter): the same candidate is REFUSED by the loop chain, naming the filter', () => {
  const db = freshDb()
  setState(db, 'fib_vwap_filter', 'true')
  const { opts, signal, gate } = loopVerdict(db, buildRetraceBars())
  assert.deepEqual(opts.vwapFilter, { mode: 'annotate' }, 'trade cell on + scan cell off → annotate, so the scan still analyses the conviction')
  assert.deepEqual(signal.filters_failed, ['vwap'], 'the failure rides on the signal for the trade gate')
  assert.equal(gate.ok, false, 'the trade gate must refuse')
  assert.match(gate.reason, /VWAP filter failed at scan and is armed for Auto Trade & Open/)
})

test('RSI switch ON with an RSI that disagrees with the fade: refused; OFF: admitted (the default-armed filter)', () => {
  const db = freshDb()
  setState(db, 'fib_vwap_filter', 'false')
  const bars = buildRetraceBars()
  // RSI after a 15-bar rally sits well above longMax 45 → fails for the long
  // bias. If a future fixture change made it pass, the ON case would admit
  // and this assertion would say so instead of silently agreeing.
  setState(db, 'fib_rsi_filter', 'true')
  const on = loopVerdict(db, bars)
  assert.deepEqual(on.signal.filters_failed, ['rsi'])
  assert.equal(on.gate.ok, false)
  assert.match(on.gate.reason, /RSI filter/)
  setState(db, 'fib_rsi_filter', 'false')
  const off = loopVerdict(db, bars)
  assert.equal(off.gate.ok, true, off.gate.reason)
})

test('loop.js wires the chain: scanFilterOptions feeds runFibScan and filters_failed feeds the per-account tradeStageGate (comment-stripped source pin)', () => {
  const src = readFileSync(new URL('./loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
  // The filters are read from the DB once per scan…
  assert.match(src, /const stageFilterOpts = scanFilterOptions\(db, getState\)/, 'the loop must read the filter switches through scanFilterOptions')
  // …and spread into the scanner's options (this is the link the plan said
  // was missing; deleting `...stageFilterOpts,` here is the mutation that
  // must turn this red).
  assert.match(src, /runFibScan\(ctraderCreds, symbolMap, symbols, \{[^}]*\.\.\.stageFilterOpts,/, 'runFibScan must receive the filter options')
  // The per-account gate reads the failure list off the signal.
  const gateCalls = src.match(/tradeStageGate\(db, getState, \{[\s\S]*?\}\)/g) || []
  assert.ok(gateCalls.length >= 1, 'the per-account trade gate must be called from the loop')
  assert.ok(gateCalls.every(c => /filtersFailed: signal\?\.filters_failed \|\| \[\]/.test(c)), 'every tradeStageGate call must pass signal.filters_failed')
})
