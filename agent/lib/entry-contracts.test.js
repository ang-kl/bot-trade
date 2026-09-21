// agent/lib/entry-contracts.test.js — the P0 contracts refuse what the plan
// forbids and accept what it describes (docs/tick-momentum/plan.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENTRY_MODES, OBSERVATION_MODES, VALIDATION_STAGES, TRANSITION_STATES, PERMIT_STATES, SIGNAL_BASES,
  validateQuoteEvent, validateSignalIntent, validateExecutionPermit, validateEngineStatus,
  defaultEngineStatus,
} from './entry-contracts.js'

const HASH = 'a'.repeat(64)

function quote(over = {}) {
  return {
    environment: 'demo', feedId: 'ctrader:demo:ic-markets', symbolId: 1, symbol: 'EURUSD',
    generation: 3, seq: 100, brokerTsMs: 1_757_000_000_000, recvMonoNs: 5_000_000_000,
    bid: 110000, ask: 110002, changedMask: 1, bidUpdatedSeq: 100, askUpdatedSeq: 98,
    quality: { snapshot: false, stale: false, crossed: false, missingSide: false },
    ...over,
  }
}

function intent(over = {}) {
  return {
    intentId: 'int-1', signalId: 'sig-1', basis: 'tick', strategy: 'tick_momentum_breakout', strategyVersion: 'proposed-v1',
    profileHash: HASH, environment: 'demo', accountId: '46130058', symbolId: 1, symbol: 'EURUSD', side: 'BUY',
    entry: { type: 'MARKET', price: null }, stopPrice: 1.0990, targetPrice: 1.1030, volumeUnits: 1000,
    setupGeneration: 7, feedGeneration: 3, configEpoch: 2, emittedAtMs: 1000, expiresAtMs: 2000,
    window: { rangeEvents: 256, momentumEvents: 64, timeframe: null },
    ...over,
  }
}

function permit(over = {}) {
  return {
    permitId: 'p-1', intentId: 'int-1', accountId: '46130058', environment: 'demo', symbolId: 1, side: 'BUY',
    volumeUnits: 1000, stopPrice: 1.0990, targetPrice: 1.1030, setupGeneration: 7, modeEpoch: 2,
    issuedAtMs: 1000, expiresAtMs: 1500, state: 'RESERVED', gatewayInstance: null, brokerCorrelationId: null, brokerOrderId: null,
    ...over,
  }
}

test('enums are the plan\'s §2 table, frozen', () => {
  assert.deepEqual([...ENTRY_MODES], ['TIME_BASED', 'TICK_MOMENTUM', 'STOPPED'])
  assert.deepEqual([...OBSERVATION_MODES], ['OFF', 'RECORD', 'SHADOW'])
  // PR-B: one ladder, no environment tier — RED if a demo stage or a live approval returns.
  assert.deepEqual([...VALIDATION_STAGES], ['UNVALIDATED', 'REPLAY_PASSED', 'SHADOW_PASSED', 'TRADED_PASSED'])
  assert.deepEqual([...TRANSITION_STATES], ['STABLE', 'QUIESCING', 'RECONCILING', 'WARMING', 'BLOCKED'])
  assert.ok(Object.isFrozen(ENTRY_MODES) && Object.isFrozen(PERMIT_STATES))
  assert.throws(() => { ENTRY_MODES.push('FAKE') })
})

test('QuoteEvent: a valid change passes; a side-less, crossed, or unchanged non-snapshot event is refused with the field named', () => {
  assert.deepEqual(validateQuoteEvent(quote()), { ok: true, errors: [] })
  // null side without the flag
  let r = validateQuoteEvent(quote({ ask: null }))
  assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.startsWith('quality.missingSide')))
  // crossed without the flag
  r = validateQuoteEvent(quote({ bid: 110005, ask: 110002 }))
  assert.ok(r.errors.some(e => e.startsWith('quality.crossed')))
  // a changed bid must carry this seq
  r = validateQuoteEvent(quote({ bidUpdatedSeq: 99 }))
  assert.ok(r.errors.some(e => e.startsWith('bidUpdatedSeq')))
  // a non-snapshot must change something
  r = validateQuoteEvent(quote({ changedMask: 0 }))
  assert.ok(r.errors.some(e => e.startsWith('changedMask')))
  // a snapshot may change nothing
  assert.equal(validateQuoteEvent(quote({ changedMask: 0, quality: { snapshot: true, stale: false, crossed: false, missingSide: false } })).ok, true)
  // wire integers only, no floats
  r = validateQuoteEvent(quote({ bid: 1.1 }))
  assert.ok(r.errors.some(e => e.startsWith('bid')))
  // unknown environment, unknown field
  r = validateQuoteEvent(quote({ environment: 'paper', extra: 1 }))
  assert.ok(r.errors.some(e => e.startsWith('environment')) && r.errors.some(e => e === 'extra: not in contract'))
})

test('SignalIntent: tick signals name event windows and no timeframe; bar signals the reverse; brackets sit the right side of the stop', () => {
  assert.deepEqual(validateSignalIntent(intent()), { ok: true, errors: [] })
  let r = validateSignalIntent(intent({ window: { rangeEvents: 256, momentumEvents: 64, timeframe: '1m' } }))
  assert.ok(r.errors.some(e => e.includes('carries no timeframe')), 'no fake M1 on a tick signal')
  r = validateSignalIntent(intent({ basis: 'bar', window: { timeframe: null } }))
  assert.ok(r.errors.some(e => e.includes('names its timeframe')))
  assert.equal(validateSignalIntent(intent({ basis: 'bar', window: { timeframe: '15m' } })).ok, true)
  r = validateSignalIntent(intent({ targetPrice: 1.0900 }))
  assert.ok(r.errors.some(e => e.includes('BUY target sits above')))
  r = validateSignalIntent(intent({ side: 'SELL', stopPrice: 1.1050, targetPrice: 1.1100 }))
  assert.ok(r.errors.some(e => e.includes('SELL target sits below')))
  r = validateSignalIntent(intent({ entry: { type: 'LIMIT', price: null } }))
  assert.ok(r.errors.some(e => e.startsWith('entry.price')))
  r = validateSignalIntent(intent({ expiresAtMs: 1000 }))
  assert.ok(r.errors.some(e => e.startsWith('expiresAtMs')))
  r = validateSignalIntent(intent({ profileHash: 'abc', accountId: 'ACCT-DEMO-2', volumeUnits: 0.5 }))
  assert.equal(r.errors.length, 4, JSON.stringify(r.errors)) // hash, account id, and two on the fractional volume
})

test('ExecutionPermit: one-use lifecycle — redemption fields are null before and required after', () => {
  assert.deepEqual(validateExecutionPermit(permit()), { ok: true, errors: [] })
  let r = validateExecutionPermit(permit({ state: 'DISPATCHING' }))
  assert.ok(r.errors.some(e => e.includes('a redeemed permit names who redeemed it')))
  assert.equal(validateExecutionPermit(permit({ state: 'DISPATCHING', gatewayInstance: 'cpp-exec:boot-9', brokerCorrelationId: 'cx-77' })).ok, true)
  r = validateExecutionPermit(permit({ brokerOrderId: '123' }))
  assert.ok(r.errors.some(e => e.includes('null until redemption')))
  r = validateExecutionPermit(permit({ state: 'SENT_TWICE' }))
  assert.ok(r.errors.some(e => e.startsWith('state')))
  assert.equal(validateExecutionPermit(permit({ state: 'UNKNOWN', gatewayInstance: 'g', brokerCorrelationId: 'c' })).ok, true, 'an uncertain send is a first-class state')
})

test('EngineStatus: a new account is fully OFF and valid; TICK_MOMENTUM needs evidence; unknown entries cannot be STABLE; blocked reasons must be failing checks', () => {
  const base = defaultEngineStatus({ accountId: '46130058', environment: 'demo' })
  assert.deepEqual(validateEngineStatus(base), { ok: true, errors: [] })
  assert.equal(base.tickObservation, 'OFF'); assert.equal(base.effectiveEntryMode, 'TIME_BASED')
  // requested ≠ effective while STABLE
  let r = validateEngineStatus({ ...base, requestedEntryMode: 'STOPPED' })
  assert.ok(r.errors.some(e => e.startsWith('transitionState')))
  assert.equal(validateEngineStatus({ ...base, requestedEntryMode: 'STOPPED', transitionState: 'QUIESCING' }).ok, true)
  // tick effective without evidence
  r = validateEngineStatus({ ...base, requestedEntryMode: 'TICK_MOMENTUM', effectiveEntryMode: 'TICK_MOMENTUM' })
  assert.ok(r.errors.some(e => e.startsWith('profileHash')) && r.errors.some(e => e.startsWith('validationStage')))
  const tickDemo = { ...base, requestedEntryMode: 'TICK_MOMENTUM', effectiveEntryMode: 'TICK_MOMENTUM', profileHash: HASH, validationStage: 'SHADOW_PASSED' }
  assert.equal(validateEngineStatus(tickDemo).ok, true, 'demo may run tick after SHADOW_PASSED (runbook: no circular requirement)')
  // PR-B (owner principle 1): the same record on a live account is valid on
  // the same evidence — RED if the live → typed-approval clause comes back.
  r = validateEngineStatus({ ...tickDemo, environment: 'live', riskGroupId: 'live:1' })
  assert.deepEqual(r, { ok: true, errors: [] }, 'live runs tick after SHADOW_PASSED like any account')
  assert.equal(validateEngineStatus({ ...tickDemo, environment: 'live', riskGroupId: 'live:1', validationStage: 'TRADED_PASSED' }).ok, true)
  assert.equal(validateEngineStatus({ ...tickDemo, validationStage: 'REPLAY_PASSED' }).ok, false, 'REPLAY_PASSED is below the bar on every account')
  // unknown exposure while stable and active
  r = validateEngineStatus({ ...base, entryCounts: { unsent: 0, inFlight: 0, resting: 0, unknown: 1 } })
  assert.ok(r.errors.some(e => e.startsWith('entryCounts.unknown')))
  assert.equal(validateEngineStatus({ ...base, requestedEntryMode: 'STOPPED', effectiveEntryMode: 'STOPPED', entryCounts: { unsent: 0, inFlight: 0, resting: 0, unknown: 1 } }).ok, true, 'STOPPED may carry an unknown while it reconciles')
  // readiness rows
  const failing = { check: 'journal', ok: false, source: 'cpp /entry-status', observed: 'ENOSPC', at: '2026-09-11T00:00:00Z', blockClass: 'infrastructure', remedy: 'free the volume' }
  r = validateEngineStatus({ ...base, readiness: [{ ...failing, blockClass: null }] })
  assert.ok(r.errors.some(e => e.includes('which kind of "no"')))
  r = validateEngineStatus({ ...base, readiness: [failing], blockedReasons: ['feed'] })
  assert.ok(r.errors.some(e => e.includes("'feed' is not a failing readiness check")))
  assert.equal(validateEngineStatus({ ...base, readiness: [failing], blockedReasons: ['journal'] }).ok, true)
})

test('PR-G: entryModePolicy is manual | auto, defaults to manual, and a pre-PR-G record without it still validates', () => {
  const base = defaultEngineStatus({ accountId: '46130058', environment: 'demo' })
  assert.equal(base.entryModePolicy, 'manual', 'no account is handed to the bot by omission')
  assert.equal(validateEngineStatus(base).ok, true)
  assert.equal(validateEngineStatus({ ...base, entryModePolicy: 'auto' }).ok, true)
  const bad = validateEngineStatus({ ...base, entryModePolicy: 'sometimes' })
  assert.equal(bad.ok, false); assert.match(bad.errors.join('; '), /entryModePolicy: 'sometimes' not in \[manual, auto\]/)
  const { entryModePolicy, ...legacy } = base // eslint-disable-line no-unused-vars
  assert.equal(validateEngineStatus(legacy).ok, true, 'a record written before the field existed is not refused')
})

test('PR-3: admittedBases is null by default (the mode\'s own basis), a set of SIGNAL_BASES is valid, and [] / duplicates / an unknown basis are refused by name; a record without the field still validates', () => {
  const base = defaultEngineStatus({ accountId: '46130058', environment: 'demo' })
  assert.equal(base.admittedBases, null)
  assert.equal(validateEngineStatus({ ...base, admittedBases: ['bar', 'tick'] }).ok, true)
  assert.equal(validateEngineStatus({ ...base, admittedBases: ['tick'] }).ok, true)
  assert.match(validateEngineStatus({ ...base, admittedBases: [] }).errors.join('; '), /^admittedBases: an empty set/)
  assert.match(validateEngineStatus({ ...base, admittedBases: ['bar', 'bar'] }).errors.join('; '), /^admittedBases: duplicate basis/)
  assert.match(validateEngineStatus({ ...base, admittedBases: ['candle'] }).errors.join('; '), /admittedBases\[0\]: 'candle' not in \[bar, tick\]/)
  assert.equal(validateEngineStatus({ ...base, admittedBases: 'tick' }).ok, false, 'a bare string is not a set')
  const { admittedBases, ...legacy } = base // eslint-disable-line no-unused-vars
  assert.equal(validateEngineStatus(legacy).ok, true, 'a record written before the field existed is not refused')
  assert.deepEqual([...SIGNAL_BASES], ['bar', 'tick'])
  assert.deepEqual([...ENTRY_MODES], ['TIME_BASED', 'TICK_MOMENTUM', 'STOPPED'], 'no DUAL mode: the set is an overlay, not a fourth mode')
})
