// node --test agent/lib/trade-labels.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeLabel,
  parseLabel,
  isOurs,
  convictionBucket,
  MAX_LABEL_LEN,
} from './trade-labels.js'

// encode ------------------------------------------------------------------

test('encodeLabel — full round trip', () => {
  const label = encodeLabel({
    source: 'autopilot', version: 'v1', strategy: 'trend',
    conviction: 'high', session: 'London', timeframe: 'H1', regime: 'trending',
  })
  assert.equal(label, 'AP|v1|TREND|HI|LDN|H1|REGT')
})

test('encodeLabel — newer registry strategies round-trip (were "-" before, blanking the Strategy column)', () => {
  for (const [key, code] of [['vp_value', 'VP'], ['rsi2_reversion', 'RSI2'], ['vwap_trend', 'VWAP']]) {
    const label = encodeLabel({ source: 'autopilot', strategy: key })
    assert.equal(label.split('|')[2], code, `${key} should encode to ${code}`)
    assert.equal(parseLabel(label).strategy, key, `${code} should parse back to ${key}`)
  }
})

test('encodeLabel — missing fields collapse to "-"', () => {
  const label = encodeLabel({ source: 'autopilot' })
  assert.equal(label, 'AP|v1|-|-|-|-|-')
})

test('encodeLabel — an unrecognised strategy VALUE falls to "other", not a permanent blank', () => {
  // A free-text strategy that doesn't match the STRATEGIES vocabulary (e.g.
  // an LLM-produced label, or a registry key added to strategies.js but not
  // yet mirrored here) must still get SOME attribution rather than "-" —
  // "-" round-trips to null forever and can't be fixed after the fact once
  // it's baked into the broker's label.
  const label = encodeLabel({ source: 'autopilot', strategy: 'some_future_strategy' })
  assert.equal(label.split('|')[2], 'OTH')
  assert.equal(parseLabel(label).strategy, 'other')
})

test('encodeLabel — no strategy AT ALL still collapses to "-" (not every source, e.g. plain manual, sets one)', () => {
  const label = encodeLabel({ source: 'autopilot' })
  assert.equal(label.split('|')[2], '-')
})

test('encodeLabel — unknown source defaults to manual', () => {
  const label = encodeLabel({ source: 'something-weird' })
  assert.ok(label.startsWith('MAN|'))
})

test('encodeLabel — never exceeds MAX_LABEL_LEN', () => {
  const label = encodeLabel({
    source: 'autopilot',
    version: 'v'.padEnd(500, 'x'),
    strategy: 'trend',
    conviction: 'high',
  })
  assert.ok(label.length <= MAX_LABEL_LEN)
})

test('encodeLabel — pipes in freeform fields are stripped', () => {
  const label = encodeLabel({ source: 'autopilot', version: 'v|2|EVIL' })
  // Parsing the reassembled label must still yield 7 components.
  assert.equal(label.split('|').length, 7)
})

// parse -------------------------------------------------------------------

test('parseLabel — known components decoded', () => {
  const p = parseLabel('AP|v1|TREND|HI|LDN|H1|REGT')
  assert.equal(p.source, 'autopilot')
  assert.equal(p.version, 'v1')
  assert.equal(p.strategy, 'trend')
  assert.equal(p.conviction, 'high')
  assert.equal(p.session, 'London')
  assert.equal(p.timeframe, 'H1')
  assert.equal(p.regime, 'trending')
})

test('parseLabel — copilot label', () => {
  const p = parseLabel('CP|v1|MR|MD|NYC|H4|REGR')
  assert.equal(p.source, 'copilot')
  assert.equal(p.strategy, 'meanrev')
  assert.equal(p.conviction, 'medium')
  assert.equal(p.session, 'New York')
  assert.equal(p.regime, 'ranging')
})

test('parseLabel — legacy label "abot-auto" returns nulls (no throw)', () => {
  const p = parseLabel('abot-auto')
  assert.equal(p.source, null)
  assert.equal(p.strategy, null)
  assert.equal(p.raw, 'abot-auto')
})

test('parseLabel — empty / null input', () => {
  assert.equal(parseLabel(null).source, null)
  assert.equal(parseLabel('').source, null)
  assert.equal(parseLabel(undefined).raw, null)
})

test('parseLabel — "-" markers map to null', () => {
  const p = parseLabel('AP|v1|-|-|-|-|-')
  assert.equal(p.source, 'autopilot')
  assert.equal(p.strategy, null)
  assert.equal(p.conviction, null)
  assert.equal(p.timeframe, null)
})

test('parseLabel — case-insensitive', () => {
  const p = parseLabel('ap|v1|trend|hi|ldn|h1|regt')
  assert.equal(p.source, 'autopilot')
  assert.equal(p.strategy, 'trend')
  assert.equal(p.timeframe, 'h1')
})

// isOurs ------------------------------------------------------------------

test('isOurs — autopilot label', () => {
  assert.equal(isOurs(encodeLabel({ source: 'autopilot' })), true)
})

test('isOurs — copilot label', () => {
  assert.equal(isOurs(encodeLabel({ source: 'copilot' })), true)
})

test('isOurs — manual / unknown labels', () => {
  assert.equal(isOurs(encodeLabel({ source: 'manual' })), false)
  assert.equal(isOurs('some-random-label'), false)
  assert.equal(isOurs(null), false)
})

// convictionBucket --------------------------------------------------------

test('convictionBucket — maps 0-10 score into buckets', () => {
  assert.equal(convictionBucket(9), 'high')
  assert.equal(convictionBucket(7), 'high')
  assert.equal(convictionBucket(6), 'medium')
  assert.equal(convictionBucket(4), 'medium')
  assert.equal(convictionBucket(2), 'low')
  assert.equal(convictionBucket(null), 'medium') // safe default
  assert.equal(convictionBucket('garbage'), 'medium')
})
