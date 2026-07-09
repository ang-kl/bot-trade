// node --test agent/lib/instrument-tree.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInstrumentTree } from './instrument-tree.js'

const classes = [{ id: 1, name: 'Forex' }, { id: 2, name: 'Metals' }, { id: 3, name: 'Empty' }]
const cats = [
  { id: 10, assetClassId: 1, name: 'Majors' },
  { id: 11, assetClassId: 1, name: 'Minors' },
  { id: 20, assetClassId: 2, name: 'Spot' },
]
const syms = [
  { symbolId: 1, symbolName: 'EURUSD', symbolCategoryId: 10 },
  { symbolId: 2, symbolName: 'GBPUSD', symbolCategoryId: 10 },
  { symbolId: 3, symbolName: 'NZDCAD', symbolCategoryId: 11 },
  { symbolId: 4, symbolName: 'XAUUSD', symbolCategoryId: 20 },
  { symbolId: 5, symbolName: 'GHOST', symbolCategoryId: 99 },   // unknown category
  { symbolId: 6, symbolName: 'DEAD', symbolCategoryId: 10, enabled: false }, // archived
]

test('builds class → category → symbols with counts', () => {
  const t = buildInstrumentTree(classes, cats, syms)
  assert.equal(t.total, 5) // disabled symbol excluded
  const forex = t.classes.find(c => c.name === 'Forex')
  assert.equal(forex.count, 3)
  assert.deepEqual(forex.categories.map(c => c.name), ['Majors', 'Minors'])
  assert.deepEqual(forex.categories[0].symbols, ['EURUSD', 'GBPUSD'])
})

test('empty classes are dropped; orphan symbols land under Other', () => {
  const t = buildInstrumentTree(classes, cats, syms)
  assert.ok(!t.classes.some(c => c.name === 'Empty'))
  const other = t.classes.find(c => c.name === 'Other')
  assert.deepEqual(other.categories[0].symbols, ['GHOST'])
})

test('classes sort by size, largest first', () => {
  const t = buildInstrumentTree(classes, cats, syms)
  assert.equal(t.classes[0].name, 'Forex')
})
