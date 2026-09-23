// Frozen expected outputs are computed only by the existing JS owner.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { computeEmaPullback } from '../agent/services/ema-pullback.js'
import { nativeOptionsFor, nativeProfileHash } from '../agent/services/scanner-profiles.js'

const base = JSON.parse(readFileSync('cpp-scan-timeframe/src/tests/fixtures/reference-parity.json', 'utf8'))
const fixtures = []
for (const side of ['long', 'short']) {
  const original = base.find(f => f.request.strategy === 'ema_pullback' && f.name === side).request
  const cases = [
    ['pending', { pendingSetup: true }],
    ['unstacked', { requireStack: false }],
    ['pending-unstacked', { pendingSetup: true, requireStack: false }],
    ['widened-floor', { minSlAtr: 1.25 }],
    ['ceiling-veto', { maxSlAtr: 0.1 }],
    ['pending-ceiling-veto', { pendingSetup: true, maxSlAtr: 0.1 }],
    ['zero-floor', { minSlAtr: 0 }],
    ['zero-ceiling', { maxSlAtr: 0 }],
    ['time-cap', { timeCapBars: 4, timeframeMinutes: 60 }],
    ['fractional-time-cap', { timeCapBars: 1.1, timeframeMinutes: 1.3 }],
    ['pending-time-cap', { pendingSetup: true, timeCapBars: 6, timeframeMinutes: 60 }],
    ['zero-time-cap', { timeCapBars: 0, timeframeMinutes: 60 }],
    ['floor-above-ceiling', { minSlAtr: 4, maxSlAtr: 3 }],
    ['fractional-floor', { minSlAtr: 0.81, maxSlAtr: 3.1 }],
  ]
  for (const [name, referenceOptions] of cases) {
    const options = nativeOptionsFor('ema_pullback', referenceOptions)
    assert.ok(options && Object.keys(options).length)
    const request = { ...original, options, profileHash: nativeProfileHash('ema_pullback', options) }
    const expected = computeEmaPullback(request.bars, request.timeframe, referenceOptions)
    if (name.includes('veto') || name === 'zero-ceiling') assert.equal(expected, null)
    else assert.equal(expected?.bias, side, `${side}/${name}`)
    fixtures.push({ name: `${side}-${name}`, request, referenceOptions, expected })
  }
  // A non-stacked recovery trend makes requireStack observable, not just a label.
  const bars = original.bars.map((b, i) => i < 250 ? { ...b, o: side === 'long' ? 130 : 270,
    c: side === 'long' ? 130 : 270, h: side === 'long' ? 130.4 : 270.4, l: side === 'long' ? 129.6 : 269.6 } : b)
  assert.equal(computeEmaPullback(bars, original.timeframe), null)
  for (const pendingSetup of [false, true]) {
    const referenceOptions = { requireStack: false, pendingSetup }
    const options = nativeOptionsFor('ema_pullback', referenceOptions)
    const request = { ...original, bars, options, profileHash: nativeProfileHash('ema_pullback', options) }
    const expected = computeEmaPullback(bars, request.timeframe, referenceOptions)
    assert.equal(expected?.bias, side)
    fixtures.push({ name: `${side}-broken-stack-${pendingSetup}`, request, referenceOptions, expected })
  }
}
writeFileSync('cpp-scan-timeframe/src/tests/fixtures/ema-options-parity.json', JSON.stringify(fixtures) + '\n')
console.log(`${fixtures.length} EMA option fixtures from the JavaScript owner`)
