// node --test agent/services/signal-ranking.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { rankHotSymbols, provenEdgeSymbolsFrom } from './signal-ranking.js'

const scans = [
  { symbol: 'AUDUSD', confidence: 6 },
  { symbol: 'EURUSD', confidence: 9 },
  { symbol: 'GBPUSD', confidence: 6 },
  { symbol: 'XAUUSD', confidence: 8 },
]

test('ranks strongest conviction first (not scan order)', () => {
  const hot = ['AUDUSD', 'EURUSD', 'GBPUSD', 'XAUUSD']
  assert.deepEqual(rankHotSymbols(scans, hot), ['EURUSD', 'XAUUSD', 'AUDUSD', 'GBPUSD'])
})

test('a proven-backtest-edge symbol wins a conviction tie', () => {
  const hot = ['AUDUSD', 'GBPUSD'] // both conviction 6
  const ranked = rankHotSymbols(scans, hot, { provenEdgeSymbols: new Set(['GBPUSD']) })
  assert.deepEqual(ranked, ['GBPUSD', 'AUDUSD']) // proven edge breaks the tie
})

test('ties with no edge signal fall back to a deterministic order', () => {
  const hot = ['GBPUSD', 'AUDUSD']
  assert.deepEqual(rankHotSymbols(scans, hot), ['AUDUSD', 'GBPUSD']) // alphabetical, stable
})

test('does not mutate the input array', () => {
  const hot = ['AUDUSD', 'EURUSD']
  const copy = [...hot]
  rankHotSymbols(scans, hot)
  assert.deepEqual(hot, copy)
})

test('missing scan data treats conviction as 0, never throws', () => {
  const ranked = rankHotSymbols(scans, ['ZZZ', 'EURUSD'])
  assert.deepEqual(ranked, ['EURUSD', 'ZZZ'])
})

test('provenEdgeSymbolsFrom: only positive, traded combos count', () => {
  const baseline = { combos: [
    { symbol: 'EURUSD', profitFactor: 1.6, trades: 20 }, // in
    { symbol: 'GBPUSD', profitFactor: 0.8, trades: 12 }, // out (PF ≤ 1)
    { symbol: 'USDJPY', profitFactor: 2.0, trades: 0 },  // out (no trades)
  ] }
  const s = provenEdgeSymbolsFrom(baseline)
  assert.deepEqual([...s], ['EURUSD'])
  assert.deepEqual([...provenEdgeSymbolsFrom(null)], []) // no baseline → empty
})
