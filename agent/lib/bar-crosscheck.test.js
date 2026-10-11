// node --test agent/lib/bar-crosscheck.test.js
// Claude · № 13,096 11-Oct (ordered № 13,093; claude-builder), plan step 9.
import test from 'node:test'
import assert from 'node:assert/strict'
import { crossCheckBars } from './bar-crosscheck.js'

const M = 60_000, T = 1_760_000_040_000 - (1_760_000_040_000 % M)
const bar = (i, o, h, l, c, v) => ({ t: T + i * M, o, h, l, c, v })

test('aligned minutes are compared per field; one-sided minutes are counted and sampled; volume ratio and tolerance share reported', () => {
  const ours = [bar(0, 100, 100.5, 99.8, 100.2, 30), bar(1, 100.2, 100.6, 100.1, 100.4, 28), bar(3, 100.4, 100.9, 100.3, 100.8, 35)]
  const broker = [bar(0, 100, 100.5, 99.8, 100.2, 31), bar(1, 100.21, 100.7, 100.1, 100.45, 56), bar(2, 100.45, 100.5, 100.2, 100.3, 10)]
  const r = crossCheckBars(ours, broker, { tolerance: 0.02 })
  assert.equal(r.ours, 3); assert.equal(r.broker, 3); assert.equal(r.aligned, 2); assert.equal(r.onlyOurs, 1); assert.equal(r.onlyBroker, 1)
  assert.deepEqual(r.onlyOursSample, [T + 3 * M]); assert.deepEqual(r.onlyBrokerSample, [T + 2 * M])
  assert.equal(r.absDiff.o.max, 0.01); assert.equal(r.absDiff.h.max, 0.1); assert.equal(r.absDiff.c.median, 0.025); assert.equal(r.absDiff.l.max, 0)
  // Minute 1: worst diff 0.1 over the broker's range 0.6 → 0.1667; minute 0: 0.
  assert.equal(r.worstDiffOverBrokerRange.max, 0.166667); assert.equal(r.worstDiffOverBrokerRange.median, 0.083333)
  assert.equal(r.volumeRatioOursOverBroker.n, 2); assert.equal(r.volumeRatioOursOverBroker.median, 0.733871)
  assert.deepEqual(r.closeWithinTolerance, { tolerance: 0.02, n: 2, sharePct: 50 })
  assert.equal(r.fromMs, T); assert.equal(r.toMs, T + 3 * M); assert.match(r.note, /neither side is the reference/)
})

test('empty inputs and no tolerance', () => {
  const r = crossCheckBars([], [])
  assert.equal(r.aligned, 0); assert.equal(r.absDiff.c.median, null); assert.equal(r.closeWithinTolerance, null); assert.equal(r.fromMs, null)
  assert.equal(crossCheckBars([bar(0, 1, 1, 1, 1, 0)], [bar(0, 1, 1, 1, 1, 0)]).volumeRatioOursOverBroker.n, 0, 'a zero broker volume gives no ratio')
})
