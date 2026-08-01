// node --test agent/lib/pos-id.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normPosId } from './pos-id.js'

test('normPosId canonicalises every spelling of a position id', () => {
  assert.equal(normPosId('234698574'), '234698574')
  assert.equal(normPosId('234698574.0'), '234698574')   // the production bug
  assert.equal(normPosId(234698574), '234698574')
  assert.equal(normPosId(234698574.0), '234698574')
  assert.equal(normPosId(' 234698574 '), '234698574')
  assert.equal(normPosId('"234698574"'), '"234698574"') // non-numeric → as-is
  assert.equal(normPosId(null), null)
  assert.equal(normPosId(undefined), null)
  assert.equal(normPosId(''), null)
  assert.equal(normPosId('   '), null)
  // Unsafely large stays untouched rather than losing precision.
  assert.equal(normPosId('92233720368547758079'), '92233720368547758079')
})
