// Claude · № 14,745 15-Oct (owner order § 14,741·A PR-1; claude-builder).
// Expected outcomes: the monitor's own parser (position-manager.js
// parsePriceTrigger accepts `price<X`/`price>X` only) and the trader's rule
// that a premise sits between the stop and the entry (§ 14,740·A).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { premiseFor, premiseTrigger, premiseTriggerForSignal, unreadablePremise, noPremise, isReadablePremise } from './premise.js'
import { _internal } from '../services/position-manager.js'

test('a premise inside the stop becomes a trigger the monitor parses; outside it is dropped with a reason', () => {
  assert.deepEqual(premiseFor({ bias: 'long', entry: 100, sl: 90, level: 95 }), { op: '<', price: 95 })
  assert.deepEqual(premiseFor({ bias: 'short', entry: 100, sl: 110, level: 104.123456 }), { op: '>', price: 104.12346 })
  assert.equal(premiseFor({ bias: 'long', entry: 100, sl: 90, level: 89 }), null, 'beyond the stop: the stop wins, not a premise')
  assert.equal(premiseFor({ bias: 'long', entry: 100, sl: 90, level: 101 }), null, 'profit side: a target, not a premise')
  assert.equal(premiseFor({ bias: 'long', entry: 100, sl: 90, level: 90 }), null, 'equal to the stop is not inside it')
  assert.equal(premiseFor({ bias: 'short', entry: 100, sl: 110, level: 99 }), null)
  assert.equal(premiseFor({ bias: 'long', entry: 100, sl: 90, level: NaN }), null)
  const t = premiseTrigger(premiseFor({ bias: 'long', entry: 1.1, sl: 1.09, level: 1.0950 }))
  assert.equal(t, 'price<1.095')
  const parsed = _internal.parsePriceTrigger(t)
  assert.ok(parsed, 'the monitor reads it')
  assert.equal(parsed.fired(1.0949), true)
  assert.equal(parsed.fired(1.0951), false)
  assert.equal(premiseTrigger(null), null)
  assert.equal(premiseTrigger({ op: '<', price: 0 }), null)
})

test('absent premises are recorded as reasons the monitor never acts on', () => {
  for (const raw of [unreadablePremise('vwap_trend'), unreadablePremise('outside stop'), noPremise('adopted'), 'Close beyond swing origin undefined', null, undefined]) {
    assert.equal(_internal.parsePriceTrigger(raw), null, `${raw} is not a trigger`)
    assert.equal(isReadablePremise(raw), false)
  }
  assert.equal(unreadablePremise('outside stop'), 'unreadable:outside_stop')
  assert.equal(noPremise('manual'), 'none_manual')
  assert.equal(isReadablePremise('price>1.2'), true)
  assert.equal(premiseTriggerForSignal({ strategy: 'vwap_trend', invalidation: { op: '<', price: 1.2 } }), 'price<1.2')
  assert.equal(premiseTriggerForSignal({ strategy: 'vwap_trend', invalidation: null, invalidation_reason: 'outside_stop' }), 'unreadable:outside_stop')
  assert.equal(premiseTriggerForSignal({ strategy: 'vwap_trend' }), 'unreadable:vwap_trend')
  assert.equal(premiseTriggerForSignal(null), 'unreadable:no_signal')
})
