// node --test agent/lib/bounded-map.test.js
//
// #123. The maps this replaces were keyed by position id, and position ids are
// never reused — so the failure mode is not "wrong answer", it is "grows until
// something else breaks, silently". These tests pin the ceiling, the eviction
// ORDER (oldest, not a flush), and the fact that eviction is visible.

import test from 'node:test'
import assert from 'node:assert/strict'
import { BoundedMap, boundedMap } from './bounded-map.js'

test('the ceiling holds no matter how many keys arrive', () => {
  const m = new BoundedMap(3, { name: 't' })
  for (let i = 0; i < 1000; i++) m.set(`k${i}`, i)
  assert.equal(m.size, 3)
  assert.equal(m.evictions, 997)
})

test('eviction is oldest-first, not a flush', () => {
  // The distinction that matters: a cache which empties itself at its ceiling
  // loses every warm entry at once and stampedes whatever refills it.
  const m = new BoundedMap(3)
  m.set('a', 1); m.set('b', 2); m.set('c', 3)
  m.set('d', 4)
  assert.equal(m.has('a'), false, 'the oldest went')
  assert.deepEqual([...m.keys()], ['b', 'c', 'd'], 'the rest survived')
})

test('updating a key makes it the newest, so a hot key is not evicted as stale', () => {
  const m = new BoundedMap(3)
  m.set('a', 1); m.set('b', 2); m.set('c', 3)
  m.set('a', 99)          // 'a' is written every tick in the real caller
  m.set('d', 4)
  assert.equal(m.get('a'), 99, 'the frequently-written key survived')
  assert.equal(m.has('b'), false, 'the genuinely oldest went instead')
})

test('a plain read does NOT refresh recency by default', () => {
  // Right for a "when did I last check this position" ledger: re-reading an
  // old entry must not keep it alive ahead of a newer one.
  const m = new BoundedMap(2)
  m.set('a', 1); m.set('b', 2)
  m.get('a')
  m.set('c', 3)
  assert.equal(m.has('a'), false)
})

test('lru:true makes a read refresh recency', () => {
  const m = new BoundedMap(2, { lru: true })
  m.set('a', 1); m.set('b', 2)
  m.get('a')
  m.set('c', 3)
  assert.equal(m.has('a'), true, 'the recently-read key survived')
  assert.equal(m.has('b'), false)
})

test('eviction is visible — a cap nobody can see is a lie about coverage', () => {
  const m = new BoundedMap(2, { name: 'fast_monitor.lastCheckAt' })
  m.set('a', 1); m.set('b', 2); m.set('c', 3)
  const s = m.stats()
  assert.equal(s.name, 'fast_monitor.lastCheckAt')
  assert.equal(s.size, 2)
  assert.equal(s.max, 2)
  assert.equal(s.evictions, 1)
  assert.equal(s.full, true)
})

test('a nonsense ceiling is refused at construction rather than silently ignored', () => {
  for (const bad of [0, -1, NaN, null, undefined, 'ten']) {
    assert.throws(() => new BoundedMap(bad), /positive integer/)
  }
  assert.equal(boundedMap(1).max, 1)
})

test('delete and clear behave like a Map', () => {
  const m = new BoundedMap(5)
  m.set('a', 1); m.set('b', 2)
  assert.equal(m.delete('a'), true)
  assert.equal(m.delete('a'), false)
  assert.equal(m.size, 1)
  m.clear()
  assert.equal(m.size, 0)
})

test('it iterates like a Map, so callers do not need to know it is bounded', () => {
  const m = new BoundedMap(5)
  m.set('a', 1); m.set('b', 2)
  assert.deepEqual([...m], [['a', 1], ['b', 2]])
  assert.deepEqual([...m.entries()], [['a', 1], ['b', 2]])
  assert.deepEqual([...m.values()], [1, 2])
})
