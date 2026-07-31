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
