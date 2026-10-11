// node --test agent/lib/bar-crosscheck.test.js
// Claude · № 13,096 11-Oct (ordered № 13,093; claude-builder), plan step 9.
import test from 'node:test'
import assert from 'node:assert/strict'
import { crossCheckBars, donchianVolumeAgreement } from './bar-crosscheck.js'
import { DONCHIAN_VOL_X, DONCHIAN_CHANNEL } from '../services/donchian-breakout.js'

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

test('donchianVolumeAgreement: the rule\'s numbers come from the strategy; ratios on both series over contiguous windows; decision agreement and tolerance share; a constant multiplier cancels, a dropped-event minute does not', () => {
  assert.equal(DONCHIAN_VOL_X, 1.2); assert.equal(DONCHIAN_CHANNEL, 20)
  const ours = [], broker = []
  for (let i = 0; i < 30; i++) { const v = i === 25 ? 100 : 40; ours.push(bar(i, 100, 101, 99, 100, v)); broker.push(bar(i, 100, 101, 99, 100, v * 2)) } // broker counts twice as many: the ratio cancels
  const r = donchianVolumeAgreement(ours, broker, { ratioTolerance: 0.15 })
  assert.deepEqual(r.rule, { channel: 20, volX: 1.2, source: 'agent/services/donchian-breakout.js' })
  assert.equal(r.comparable, 10, 'minutes 20..29 have a full contiguous prior window'); assert.equal(r.decisionAgreePct, 100); assert.equal(r.ratioAbsDiff.max, 0)
  assert.equal(r.oursPass, 1); assert.equal(r.brokerPass, 1); assert.equal(r.ratioWithinTolerance.sharePct, 100)
  // Our side dropped events in minute 25 (a recorder gap): the broker's gate fires, ours does not.
  const dropped = ours.map(b => (b.t === T + 25 * M ? { ...b, v: 40 } : b))
  const d = donchianVolumeAgreement(dropped, broker, { ratioTolerance: 0.15 })
  assert.equal(d.decisionAgree, 9); assert.equal(d.disagreements.length, 1); assert.equal(d.disagreements[0].t, T + 25 * M); assert.equal(d.disagreements[0].brokerPass, true); assert.equal(d.disagreements[0].oursPass, false)
  assert.ok(d.ratioWithinTolerance.sharePct < 100)
  // A missing minute breaks the contiguous window: fewer comparable minutes, never a guessed one.
  const gappy = ours.filter(b => b.t !== T + 3 * M)
  assert.equal(donchianVolumeAgreement(gappy, broker).comparable, 6, 'only minutes 24–29 have twenty contiguous prior minutes once minute 3 is missing')
  assert.equal(donchianVolumeAgreement([], []).comparable, 0)
})
