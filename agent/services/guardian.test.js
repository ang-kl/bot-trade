// node --test agent/services/guardian.test.js
//
// Tick guardian: the pure wake decision and the watched-symbol resolution.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { significantMove, watchedSymbolIds } from './guardian.js'

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
