// Freeze decisions from the existing JavaScript owner; no native output is used.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { computeRsiMeanrev } from '../agent/services/rsi-meanrev.js'
import { nativeOptionsFor, nativeProfileHash } from '../agent/services/scanner-profiles.js'
const base = JSON.parse(readFileSync('cpp-scan-timeframe/src/tests/fixtures/reference-parity.json', 'utf8'))
const fixtures = []
let recovered = 0
for (const { name, request: original } of base.filter(f => f.request.strategy === 'rsi_meanrev')) {
  const permissive = computeRsiMeanrev(original.bars, original.timeframe, { minRr: 0 })
  const values = new Set([0, 0.1, 1.2, 3, Number.MAX_SAFE_INTEGER])
  if (permissive) {
    values.add(permissive.rr)
    values.add(permissive.rr + 0.001)
    if (!computeRsiMeanrev(original.bars, original.timeframe)) recovered++
  }
  for (const minRr of values) {
    const referenceOptions = { minRr }, options = nativeOptionsFor('rsi_meanrev', referenceOptions)
    const request = { ...original, options, profileHash: nativeProfileHash('rsi_meanrev', options) }
    const expected = computeRsiMeanrev(request.bars, request.timeframe, referenceOptions)
    if (permissive) assert.equal(expected?.bias ?? null, minRr <= permissive.rr ? permissive.bias : null)
    else assert.equal(expected, null)
    fixtures.push({ name: `${name}-floor-${minRr}`, request, referenceOptions, expected })
  }
}
assert.ok(recovered >= 2, 'fixtures exercise lower-floor recovery in both directions')
writeFileSync('cpp-scan-timeframe/src/tests/fixtures/rsi-options-parity.json', JSON.stringify(fixtures) + '\n')
console.log(`${fixtures.length} RSI option fixtures; ${recovered} reference cases recovered by a lower observation floor`)
