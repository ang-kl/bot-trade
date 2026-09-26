import { test, expect } from 'vitest'
import { sortRows } from './use-sort.jsx'

// use-sort.jsx already shipped (Trade.jsx, Desk.jsx) before this change,
// which only EXTRACTED its comparator into `sortRows` so common/DataTable.jsx
// can reuse it for a per-group sort without forking the logic. These pin the
// extracted function's behaviour, unchanged from what useSort always did:
// null/undefined last in either direction, string vs numeric compare, and
// direction flip.

test('null and undefined values always sort last, in either direction', () => {
  const rows = [{ k: 2 }, { k: null }, { k: 1 }, { k: undefined }]
  expect(sortRows(rows, { key: 'k', dir: 'asc' }).map(r => r.k)).toEqual([1, 2, null, undefined])
  expect(sortRows(rows, { key: 'k', dir: 'desc' }).map(r => r.k)).toEqual([2, 1, null, undefined])
})

test('string values sort with localeCompare; numeric values sort numerically', () => {
  const strs = [{ k: 'b' }, { k: 'a' }, { k: 'c' }]
  expect(sortRows(strs, { key: 'k', dir: 'asc' }).map(r => r.k)).toEqual(['a', 'b', 'c'])
  const nums = [{ k: 10 }, { k: 2 }, { k: -5 }]
  expect(sortRows(nums, { key: 'k', dir: 'asc' }).map(r => r.k)).toEqual([-5, 2, 10])
})

test('an accessor overrides the bare column read', () => {
  const rows = [{ raw: '3' }, { raw: '1' }, { raw: '2' }]
  const sorted = sortRows(rows, { key: 'n', dir: 'asc' }, { n: r => Number(r.raw) })
  expect(sorted.map(r => r.raw)).toEqual(['1', '2', '3'])
})

test('the input array is not mutated', () => {
  const rows = [{ k: 2 }, { k: 1 }]
  const copy = [...rows]
  sortRows(rows, { key: 'k', dir: 'asc' })
  expect(rows).toEqual(copy)
})
