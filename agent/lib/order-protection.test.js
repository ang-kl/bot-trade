// node --test agent/lib/order-protection.test.js
//
// Spike protection: the stop trigger method is config-gated — unset means NO
// field is sent (broker behaviour byte-identical), and only real cTrader
// enum values ever reach the wire.

import test from 'node:test'
import assert from 'node:assert/strict'
import { stopTriggerField, STOP_TRIGGER_METHODS } from './order-protection.js'
import { buildLimitPayload } from '../services/closed-market-limits.js'

test('unset/null/unknown → empty fragment (no wire field)', () => {
  assert.deepEqual(stopTriggerField(null), {})
  assert.deepEqual(stopTriggerField({}), {})
  assert.deepEqual(stopTriggerField({ stopTriggerMethod: null }), {})
  assert.deepEqual(stopTriggerField({ stopTriggerMethod: '' }), {})
  assert.deepEqual(stopTriggerField({ stopTriggerMethod: 'bogus' }), {})
  assert.deepEqual(stopTriggerField({ stopTriggerMethod: 99 }), {})
})

test('names (case-insensitive) and numeric values map to the wire enum', () => {
  assert.deepEqual(stopTriggerField({ stopTriggerMethod: 'OPPOSITE' }), { stopTriggerMethod: 2 })
  assert.deepEqual(stopTriggerField({ stopTriggerMethod: 'opposite' }), { stopTriggerMethod: 2 })
  assert.deepEqual(stopTriggerField({ stopTriggerMethod: 'DOUBLE_TRADE' }), { stopTriggerMethod: 3 })
  assert.deepEqual(stopTriggerField({ stopTriggerMethod: 4 }), { stopTriggerMethod: 4 })
  assert.equal(STOP_TRIGGER_METHODS.TRADE, 1)
})

test('closed-market limit payload carries the method only when configured', () => {
  const base = {
    accountId: '1', symbolId: 2, side: 'BUY', volume: 1000, entry: 1.1, sl: 1.09,
    tp: 1.12, digits: 5, expiresAtMs: 123, label: 'l', relativePoints: (d) => Math.round(d * 100000),
  }
  assert.equal(buildLimitPayload(base).stopTriggerMethod, undefined)
  assert.equal(buildLimitPayload({ ...base, riskCfg: { stopTriggerMethod: 'OPPOSITE' } }).stopTriggerMethod, 2)
})
