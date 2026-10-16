// Claude · № 15,144 16-Oct (owner: "B priorities class that are profitable as
// first to trade" after § 15,128; the 8-of-15 share chosen after № 15,144;
// claude-builder). node --test agent/services/scan-tiers.test.js
//
// The two-tier rotation in selectScanBatch. Expected batches are
// self-derived fixtures (the arithmetic of the tiers), the share itself is
// the owner's choice; the share-off cases pin that the legacy path is
// unchanged for every caller that passes no class rank.
import test from 'node:test'
import assert from 'node:assert/strict'
import { selectScanBatch, tieredScanBatch, TIER_CURSOR_STRIDE } from './fib-strategy.js'

const mk = (prefix, n, rank) => Array.from({ length: n }, (_, i) => ({ symbol: `${prefix}${i}`, rank }))
const rankOf = (w) => w.rank
const names = (r) => r.batch.map(b => b.symbol)
const SHARE = { classRank: rankOf, prioritySlots: 8, priorityMaxRank: 3 }

test('8 of 15 slots go to tier A (rank ≤ 3), the remaining 7 to tier B, each tier on its own window', () => {
  const s = [...mk('B', 30, 5), ...mk('A', 20, 1)] // list order does not decide the tiers
  const r0 = selectScanBatch(s, { batchSize: 15, cursor: 0, ...SHARE })
  assert.deepEqual(names(r0), ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6'])
  assert.equal(r0.nextCursor, 8 + 7 * TIER_CURSOR_STRIDE, 'the cursor encodes both tier offsets, each advanced by what it took')
  assert.deepEqual([r0.tiers.aStart, r0.tiers.bStart], [0, 0])
  assert.deepEqual({ tierA: r0.tiers.tierA, tierB: r0.tiers.tierB, prioritySlots: r0.tiers.prioritySlots, runsPerPassA: r0.tiers.runsPerPassA, runsPerPassB: r0.tiers.runsPerPassB },
    { tierA: 20, tierB: 30, prioritySlots: 8, runsPerPassA: 3, runsPerPassB: 5 })
  const r1 = selectScanBatch(s, { batchSize: 15, cursor: r0.nextCursor, ...SHARE })
  assert.deepEqual(names(r1), ['A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13'])
  const r2 = selectScanBatch(s, { batchSize: 15, cursor: r1.nextCursor, ...SHARE })
  assert.deepEqual(names(r2).slice(0, 8), ['A16', 'A17', 'A18', 'A19', 'A0', 'A1', 'A2', 'A3'], 'tier A wraps on its own')
  assert.deepEqual(names(r2).slice(8), ['B14', 'B15', 'B16', 'B17', 'B18', 'B19', 'B20'])
})

test('coverage: every tier-A symbol is scanned within ceil(|A|/8) runs and every tier-B symbol within ceil(|B|/7) runs', () => {
  const s = [...mk('A', 161, 2), ...mk('B', 252, 5)] // the 16-10 watchlist's shape
  const seenA = new Set(), seenB = new Set()
  let cursor = 0
  for (let run = 0; run < 36; run++) {
    const r = selectScanBatch(s, { batchSize: 15, cursor, ...SHARE })
    assert.equal(r.batch.length, 15)
    for (const b of r.batch) (b.rank <= 3 ? seenA : seenB).add(b.symbol)
    if (run === 20) assert.equal(seenA.size, 161, 'tier A fully covered after 21 runs')
    cursor = r.nextCursor
  }
  assert.equal(seenB.size, 252, 'tier B fully covered after 36 runs')
})

test('a short tier hands its spare slots to the other; an empty tier gives the whole batch to the other', () => {
  const r = selectScanBatch([...mk('A', 3, 1), ...mk('B', 30, 5)], { batchSize: 15, cursor: 0, ...SHARE })
  assert.deepEqual(names(r).slice(0, 3), ['A0', 'A1', 'A2'])
  assert.equal(r.batch.length, 15, 'B filled the 12 spare slots')
  const onlyA = selectScanBatch(mk('A', 40, 1), { batchSize: 15, cursor: 0, ...SHARE })
  assert.equal(onlyA.batch.length, 15)
  assert.deepEqual(names(onlyA), Array.from({ length: 15 }, (_, i) => `A${i}`))
  const onlyB = selectScanBatch(mk('B', 40, 5), { batchSize: 15, cursor: 0, ...SHARE })
  assert.equal(onlyB.batch.length, 15)
  const tiny = selectScanBatch([...mk('A', 2, 1), ...mk('B', 3, 5)], { batchSize: 15, cursor: 0, ...SHARE })
  assert.equal(tiny.batch.length, 5, 'never more than the pool holds')
})

test('spike boost still rides first and counts against the batch; held symbols never enter either tier', () => {
  const s = [...mk('A', 20, 1), ...mk('B', 30, 5)]
  const r = selectScanBatch(s, { batchSize: 15, cursor: 0, heldSymbols: ['A0', 'B0'], prioritySpikeSymbols: ['B9', 'A0'], ...SHARE })
  assert.equal(r.batch[0].symbol, 'B9', 'the non-held spike first')
  assert.equal(r.batch.length, 15)
  assert.ok(!names(r).includes('A0') && !names(r).includes('B0'), 'held excluded')
  assert.equal(names(r).filter(n => n.startsWith('A')).length, 8, 'tier A keeps its 8')
  assert.equal(names(r).filter(n => n.startsWith('B')).length, 7, 'the spike took one of tier B\'s 7')
  assert.equal(r.restCount, 47, 'pool = 50 − 2 held − 1 boosted')
  assert.equal(r.nextCursor, 8 + 6 * TIER_CURSOR_STRIDE, 'tier B advanced by the 6 it took, not its nominal 7')
})

test('a symbol boosted on EVERY run never hides a tail row (Codex round 3 on #1390): tiers advance by actual consumption', () => {
  const s = [...mk('A', 20, 1), ...mk('B', 29, 5)]
  const seenB = new Set(); let cursor = 0
  for (let run = 0; run < 12; run++) {
    const r = selectScanBatch(s, { batchSize: 15, cursor, prioritySpikeSymbols: ['B5'], ...SHARE })
    assert.equal(r.batch[0].symbol, 'B5')
    for (const b of r.batch) if (b.symbol.startsWith('B')) seenB.add(b.symbol)
    cursor = r.nextCursor
  }
  assert.equal(seenB.size, 29, 'every tier-B symbol scanned within 12 boosted runs (28-row pool at 6 rows a run)')
})

test('a rank the policy cannot read (NaN/undefined) is tier B, never tier A', () => {
  const s = [{ symbol: 'X' }, { symbol: 'Y', rank: 'nope' }, ...mk('A', 2, 1)]
  const r = selectScanBatch(s, { batchSize: 4, cursor: 0, ...SHARE })
  assert.deepEqual(names(r), ['A0', 'A1', 'X', 'Y'])
  assert.equal(r.tiers.tierA, 2); assert.equal(r.tiers.tierB, 2)
})

test('share off (no classRank, zero slots, or a non-numeric rank cap) → the legacy rotation, byte for byte', () => {
  const s = [...mk('A', 20, 1), ...mk('B', 30, 5)]
  const legacy = selectScanBatch(s, { batchSize: 15, cursor: 7, prioritySpikeSymbols: ['B3'] })
  assert.deepEqual(selectScanBatch(s, { batchSize: 15, cursor: 7, prioritySpikeSymbols: ['B3'], classRank: null, prioritySlots: 8, priorityMaxRank: 3 }), legacy)
  assert.deepEqual(selectScanBatch(s, { batchSize: 15, cursor: 7, prioritySpikeSymbols: ['B3'], classRank: rankOf, prioritySlots: 0, priorityMaxRank: 3 }), legacy)
  assert.deepEqual(selectScanBatch(s, { batchSize: 15, cursor: 7, prioritySpikeSymbols: ['B3'], classRank: rankOf, prioritySlots: 8, priorityMaxRank: null }), legacy)
  assert.equal('tiers' in legacy, false, 'the legacy result carries no tiers field')
  assert.equal(legacy.nextCursor, 7 + 14, 'legacy cursor = symbol index')
})

test('tieredScanBatch: a cursor left by the legacy rotation decodes as a tier-A offset; the next cursor carries both offsets', () => {
  const rest = [...mk('A', 4, 1), ...mk('B', 5, 5)]
  const r = tieredScanBatch(rest, [], 3, 19, { classRank: rankOf, prioritySlots: 2, priorityMaxRank: 3 })
  assert.deepEqual(names(r), ['A3', 'A0', 'B0'], 'A starts at 19 % 4 = 3 and wraps, B at 0')
  assert.equal(r.nextCursor, 1 + 1 * TIER_CURSOR_STRIDE, 'A: (3 + 2) % 4 = 1; B: (0 + 1) % 5 = 1')
  const r2 = tieredScanBatch(rest, [], 3, r.nextCursor, { classRank: rankOf, prioritySlots: 2, priorityMaxRank: 3 })
  assert.deepEqual(names(r2), ['A1', 'A2', 'B1'])
  const empty = tieredScanBatch([], [], 15, 3, { classRank: rankOf, prioritySlots: 8, priorityMaxRank: 3 })
  assert.deepEqual(empty.batch, []); assert.equal(empty.nextCursor, 0); assert.equal(empty.restCount, 0)
})
