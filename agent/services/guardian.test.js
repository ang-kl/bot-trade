// node --test agent/services/guardian.test.js
//
// Tick guardian: the pure wake decision and the watched-symbol resolution.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  significantMove, watchedSymbolIds, watchlistSymbolIds,
  flagScanPriority, takeScanPrioritySymbols,
} from './guardian.js'

test('significantMove: percentage threshold, bad inputs never wake', () => {
  assert.equal(significantMove(100, 100.06, 0.05), true)   // 0.06% ≥ 0.05%
  assert.equal(significantMove(100, 100.04, 0.05), false)  // 0.04% < 0.05%
  assert.equal(significantMove(100, 99.94, 0.05), true)    // moves down count too
  assert.equal(significantMove(null, 100, 0.05), false)
  assert.equal(significantMove(100, NaN, 0.05), false)
  assert.equal(significantMove(0, 100, 0.05), false)
})

test('watchedSymbolIds: active positions with a known id map, sorted, deduped', () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ NATGAS: 2280, EURUSD: 1, MYSTERY: null }))
  const ins = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, status) VALUES (?, 'BUY', 1, ?)`)
  ins.run('NatGas', 'active')
  ins.run('NATGAS', 'active')   // dedupe across case
  ins.run('EURUSD', 'active')
  ins.run('GBPUSD', 'closed')   // closed → not watched
  ins.run('MYSTERY', 'active')  // no symbolId → skipped, never guessed
  const w = watchedSymbolIds(db)
  assert.deepEqual(w, [
    { symbol: 'EURUSD', symbolId: 1 },
    { symbol: 'NATGAS', symbolId: 2280 },
  ])
})

// ---- watchlist-wide spike-priority (owner, 2026-07-26: "when market
// volume spike, check immediately") --------------------------------------

test('watchlistSymbolIds: enabled symbols with a known id, disabled/force_skip/string-shorthand handled', () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, XAUUSD: 3, NOMAP: undefined }))
  setState(db, 'autopilot_symbols_json', JSON.stringify([
    'EURUSD',                                   // string shorthand → enabled
    { symbol: 'GBPUSD', enabled: true },
    { symbol: 'XAUUSD', enabled: false },        // disabled → excluded
    { symbol: 'NOMAP' },                         // no symbolId → excluded
  ]))
  assert.deepEqual(watchlistSymbolIds(db), [
    { symbol: 'EURUSD', symbolId: 1 },
    { symbol: 'GBPUSD', symbolId: 2 },
  ])
})

test('watchlistSymbolIds: force_skip excluded, falls back to legacy watchlist_json when autopilot key is absent', () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, USDJPY: 2 }))
  setState(db, 'watchlist_json', JSON.stringify([
    { symbol: 'EURUSD' },
    { symbol: 'USDJPY', force_skip: true },
  ]))
  assert.deepEqual(watchlistSymbolIds(db), [{ symbol: 'EURUSD', symbolId: 1 }])
})

test('watchlistSymbolIds: missing/malformed state never throws, returns empty', () => {
  const db = initDB(':memory:')
  assert.deepEqual(watchlistSymbolIds(db), [])
  setState(db, 'autopilot_symbols_json', 'not json')
  assert.deepEqual(watchlistSymbolIds(db), [])
})

test('flagScanPriority + takeScanPrioritySymbols: round-trips, and consumption clears the flag', () => {
  const db = initDB(':memory:')
  flagScanPriority(db, 'eurusd')
  flagScanPriority(db, 'XAUUSD')
  const first = takeScanPrioritySymbols(db).sort()
  assert.deepEqual(first, ['EURUSD', 'XAUUSD'], 'case-normalized')
  assert.deepEqual(takeScanPrioritySymbols(db), [], 'consumed once — cleared after the first read')
})

test('takeScanPrioritySymbols: expires stale flags past the ttl', () => {
  const db = initDB(':memory:')
  flagScanPriority(db, 'EURUSD')
  // ttl=0 → the flag set "now" is already outside a zero-width window
  assert.deepEqual(takeScanPrioritySymbols(db, 0), [])
})

test('takeScanPrioritySymbols: never throws on a closed db handle', () => {
  const db = initDB(':memory:')
  db.close()
  assert.doesNotThrow(() => flagScanPriority(db, 'EURUSD'))
  assert.deepEqual(takeScanPrioritySymbols(db), [])
})
