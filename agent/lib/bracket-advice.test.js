import { test } from 'node:test'
import assert from 'node:assert'
import { describeBracketGap, bracketGapField } from './bracket-advice.js'

test('only bracket refusals produce advice', () => {
  assert.equal(bracketGapField('guard_naked_order: market order has no stop loss attached'), 'sl')
  assert.equal(bracketGapField('guard_no_target: market order has no take profit attached'), 'tp')
  assert.equal(bracketGapField('guard_halt: execution halted by kill switch'), null)
  assert.equal(bracketGapField('guard_volume_cap: order volume exceeds the configured max'), null)
  assert.equal(bracketGapField(undefined), null)
  assert.equal(describeBracketGap('guard_halt: execution halted by kill switch', { symbol: 'EURUSD' }), null)
})

test('a missing take profit names the symbol and suggests the R:R floor price', () => {
  // Long: entry 1.2000, stop 1.1900 → 100-pip risk. minRR 1.5 → TP 1.2150.
  const a = describeBracketGap('guard_no_target: market order has no take profit attached',
    { symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.19, strategy: 'manual', minRR: 1.5, digits: 5 })
  assert.equal(a.field, 'tp')
  assert.equal(a.symbol, 'EURUSD')
  assert.equal(a.suggestion, 1.215)
  assert.match(a.message, /EURUSD BUY has no take profit/)
  assert.match(a.message, /1\.215/)
})

test('a short suggests the take profit BELOW entry', () => {
  const a = describeBracketGap('guard_no_target: x',
    { symbol: 'GBPUSD', side: 'SELL', entry: 1.3, sl: 1.31, minRR: 2 })
  assert.equal(a.suggestion, 1.28)
})

test('direction comes from the stop, not the side label', () => {
  // An analysis execution whose side says BUY but whose stop sits ABOVE entry
  // is describing a short. Trusting `side` here would suggest a take profit on
  // the wrong side of the market — worse than suggesting nothing.
  const a = describeBracketGap('guard_no_target: x',
    { symbol: 'XAUUSD', side: 'BUY', entry: 2000, sl: 2010, minRR: 1.5 })
  assert.ok(a.suggestion < 2000, `expected a TP below entry, got ${a.suggestion}`)
})

test('the suggestion is rounded to the entry price precision', () => {
  const a = describeBracketGap('guard_no_target: x',
    { symbol: 'USDJPY', side: 'BUY', entry: 157.123, sl: 157.0, minRR: 1.5 })
  assert.equal(String(a.suggestion).split('.')[1].length <= 3, true, `got ${a.suggestion}`)
})

test('a per-strategy R:R floor overrides the config default', () => {
  // rsi2_reversion is 1.0R in strategies.js; the config default of 1.5 must not win.
  const a = describeBracketGap('guard_no_target: x',
    { symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.19, strategy: 'rsi2_reversion', minRR: 1.5 })
  assert.equal(a.suggestion, 1.21)
})

test('a missing stop names the symbol but suggests nothing', () => {
  // There is no defensible auto-stop without volatility context, and a stop the
  // system invented is the kind of number that looks deliberate in the ledger
  // later and was not. Name the gap, ask the trader.
  const a = describeBracketGap('guard_naked_order: market order has no stop loss attached',
    { symbol: 'BTCUSD', side: 'BUY', entry: 60000 })
  assert.equal(a.field, 'sl')
  assert.equal(a.suggestion, null)
  assert.match(a.message, /BTCUSD BUY has no stop loss/)
  assert.match(a.message, /Enter one to place this order/)
})

test('an unusable entry/stop still yields an actionable message', () => {
  const a = describeBracketGap('guard_no_target: x', { symbol: 'EURUSD', side: 'BUY' })
  assert.equal(a.suggestion, null)
  assert.match(a.message, /EURUSD BUY has no take profit/)
  // entry === sl would divide the trade into a zero-distance stop; no suggestion.
  const b = describeBracketGap('guard_no_target: x', { symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.2 })
  assert.equal(b.suggestion, null)
})

// ---------------------------------------------------------------------------
// HVN-targeted take profit (instr/hvn-targeted-tp-spec.md §3, owner-approved
// 01-08-2026). Additive fields only: hvnSuggestion / hvnSuggestionBasis.
// Owner's extra constraints: never compress below the strategy's own R:R
// floor (suppress, not round), never inflate to a far node (max-RR-multiple
// cap), and the profile is computed on the caller's own-timeframe bars.
// ---------------------------------------------------------------------------

// Bars whose composite 24-bucket profile puts a heavy shelf where each test
// needs it. Range [1.1900, 1.2140] → step 0.001; bucket i spans
// 1.19+i*0.001 .. 1.19+(i+1)*0.001.
function hvnBars(pocBucket, { buckets = 24, lo = 1.19, step = 0.001, pocVol = 1000, baseVol = 100 } = {}) {
  const out = []
  for (let i = 0; i < buckets; i++) {
    const l = lo + i * step + step * 0.1
    const h = lo + (i + 1) * step - step * 0.1
    out.push({ t: 1700000000000 + i * 60_000, o: l, h, l, c: h, v: i === pocBucket ? pocVol : baseVol })
  }
  // ≥30 bars total (fail-open threshold) — pad with more base-volume bars
  // inside existing buckets so the profile shape is unchanged.
  for (let i = 0; out.length < 32; i++) {
    const l = lo + (i % buckets) * step + step * 0.1
    out.push({ t: 1700000000000 + (buckets + i) * 60_000, o: l, h: l, l, c: l, v: 1 })
  }
  return out
}

test('T5: long trade — both suggestions present, HVN basis names node % and R multiple', () => {
  // Entry 1.2000, SL 1.1990 (10 pips). rrFloor manual default 1.5 → floor TP 1.2015.
  // POC shelf in bucket 20 → node 1.2100..1.2110, near edge 1.2100 = 10.0R… too far
  // under the inflation cap — use bucket 13: 1.2030..1.2040, near edge 1.2030 = 3.0R.
  const a = describeBracketGap('guard_no_target: x', {
    symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.199, minRR: 1.5, digits: 5,
    bars: hvnBars(13),
  })
  assert.equal(a.suggestion, 1.2015)                      // primary unchanged
  assert.equal(a.hvnSuggestion, 1.203)                    // near edge of the node
  assert.match(a.hvnSuggestionBasis, /HVN/i)
  assert.match(a.hvnSuggestionBasis, /% of POC/i)
  assert.match(a.hvnSuggestionBasis, /R\b/)
  assert.match(a.message, /high-volume node/)
})

test('T6: HVN candidate below the R:R floor → suppressed, primary untouched (never compress)', () => {
  // Node at bucket 11 → near edge 1.2010 = 1.0R < floor 1.5R.
  const a = describeBracketGap('guard_no_target: x', {
    symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.199, minRR: 1.5, digits: 5,
    bars: hvnBars(11),
  })
  assert.equal(a.hvnSuggestion, null)
  assert.equal(a.suggestion, 1.2015)
})

test('T7: no ctx.bars → output byte-identical to current behaviour (regression pin)', () => {
  const base = describeBracketGap('guard_no_target: x',
    { symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.19, minRR: 1.5, digits: 5 })
  assert.equal(base.hvnSuggestion, null)
  assert.equal(base.hvnSuggestionBasis, null)
  assert.equal(base.suggestion, 1.215)
  assert.doesNotMatch(base.message, /high-volume node/)
  // Under 30 bars behaves exactly the same (fail-open).
  const few = describeBracketGap('guard_no_target: x',
    { symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.19, minRR: 1.5, digits: 5, bars: hvnBars(13).slice(0, 20) })
  assert.equal(few.hvnSuggestion, null)
  assert.equal(few.suggestion, base.suggestion)
})

test('T8: short trade — direction from the stop, HVN node selected BELOW entry', () => {
  // Entry 1.2100, SL 1.2110 (10 pips above → short). Node bucket 7 →
  // 1.1970..1.1980, near edge (closest to entry) 1.1980 = 12R — too far; use
  // bucket 17 → 1.2070..1.2080, near edge 1.2080 = 2.0R.
  const a = describeBracketGap('guard_no_target: x', {
    symbol: 'EURUSD', side: 'SELL', entry: 1.21, sl: 1.211, minRR: 1.5, digits: 5,
    bars: hvnBars(17),
  })
  assert.equal(a.hvnSuggestion, 1.208)
  assert.ok(a.hvnSuggestion < 1.21)
})

test('T9: HVN suggestion respects broker digits', () => {
  const a = describeBracketGap('guard_no_target: x', {
    symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.199, minRR: 1.5, digits: 3,
    bars: hvnBars(13),
  })
  if (a.hvnSuggestion != null) {
    const frac = String(a.hvnSuggestion).split('.')[1] || ''
    assert.ok(frac.length <= 3, `got ${a.hvnSuggestion}`)
  }
})

test('T10 (owner constraint): a far node beyond the max-RR multiple is suppressed — never inflate', () => {
  // Node bucket 22 → near edge 1.2120 = 12R against a 1.5R floor: statistically
  // outside the strategy's timeframe/duration envelope. Must be null, and the
  // primary floor suggestion must stand alone.
  const a = describeBracketGap('guard_no_target: x', {
    symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.199, minRR: 1.5, digits: 5,
    bars: hvnBars(22),
  })
  assert.equal(a.hvnSuggestion, null)
  assert.equal(a.suggestion, 1.2015)
})

test('T11 (owner constraint): per-strategy floor binds the HVN candidate too — no cross-strategy compression', () => {
  // rsi2_reversion's floor is 1.0R. A node at 1.2R clears ITS floor even though
  // the config default 1.5 would have suppressed it — the strategy's own floor
  // is the binding one, exactly as for the primary suggestion.
  const a = describeBracketGap('guard_no_target: x', {
    symbol: 'EURUSD', side: 'BUY', entry: 1.2, sl: 1.199, strategy: 'rsi2_reversion', minRR: 1.5, digits: 5,
    bars: hvnBars(12), // near edge 1.2020 = 2.0R ≥ 1.0R floor
  })
  assert.equal(a.hvnSuggestion, 1.202)
  assert.equal(a.suggestion, 1.201) // 1.0R floor primary
})
