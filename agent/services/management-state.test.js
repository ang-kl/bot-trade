// node --test agent/services/management-state.test.js
//
// §40's state machine and §41's authority hierarchy.
//
// The module is pure on purpose, so these tests can be exhaustive rather than
// representative: every transition pair is checked, not a sample. That matters
// because the machine's whole job is to be the one place two writers can agree
// about what is true, and a machine with an untested edge is a machine that
// will be trusted exactly until it is wrong.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STATES, EXCEPTIONS, AUTHORITIES, WRITER_AUTHORITY, EVENT_SOURCE_AUTHORITY,
  canTransition, arbitrate, deriveState, isException,
  authorityForSource, isOwnerSource, isCapitalSafetySource,
} from './management-state.js'

test('the vocabularies are disjoint — a state is either happy-path or exception', () => {
  for (const s of STATES) assert.equal(isException(s), false, s)
  for (const e of EXCEPTIONS) assert.equal(STATES.includes(e), false, e)
})

test('the happy path only moves forward', () => {
  for (let i = 0; i < STATES.length; i++) {
    for (let j = 0; j < STATES.length; j++) {
      const from = STATES[i], to = STATES[j]
      const expected = i === j ? true : (from !== 'reconciled' && j > i)
      assert.equal(canTransition(from, to), expected, `${from} → ${to}`)
    }
  }
})

test('reconciled is terminal — nothing reopens a settled position', () => {
  for (const s of [...STATES, ...EXCEPTIONS]) {
    if (s === 'reconciled') continue
    assert.equal(canTransition('reconciled', s), false, `reconciled → ${s}`)
  }
})

test('any state may enter an exception — that is what exceptions are for', () => {
  for (const s of STATES) {
    for (const e of EXCEPTIONS) {
      if (s === 'reconciled') continue
      assert.equal(canTransition(s, e), true, `${s} → ${e}`)
    }
  }
})

test('leaving an exception requires a CHECKED state, never a dismissed alarm', () => {
  // The rule that matters most in this file. A naked position becomes
  // protected by having a stop read back from the broker — not by someone
  // deciding the alert was noise. So the only exits are states that
  // correspond to a real verification.
  const allowed = new Set(['protected', 'actively_managed', 'broker_closed', 'reconciled'])
  for (const e of EXCEPTIONS) {
    for (const s of STATES) {
      assert.equal(canTransition(e, s), allowed.has(s), `${e} → ${s}`)
    }
    // Notably NOT allowed: sliding back to 'filled' or 'protection_pending',
    // which would let a position claim progress it has not made.
    assert.equal(canTransition(e, 'filled'), false, `${e} → filled`)
    assert.equal(canTransition(e, 'protection_pending'), false)
  }
})

test('an unknown state transitions nowhere', () => {
  assert.equal(canTransition('invented', 'protected'), false)
  assert.equal(canTransition('protected', 'invented'), false)
})

// ---------------------------------------------------------------------------
// §41 authority
// ---------------------------------------------------------------------------

test('every registered writer maps to a real authority level', () => {
  for (const [writer, auth] of Object.entries(WRITER_AUTHORITY)) {
    assert.ok(AUTHORITIES.includes(auth), `${writer} → ${auth}`)
  }
})

test('capital safety outranks everything, including the owner', () => {
  // §41.2 says owner actions are "normally respected rather than automatically
  // reversed, UNLESS they violate a non-negotiable capital-safety rule". Levels
  // 1 and 2 are that carve-out.
  assert.equal(arbitrate('loss-cap', 'position-protect').winner, 'loss-cap')
  assert.equal(arbitrate('profit-ratchet', 'position-protect').winner, 'profit-ratchet')
})

test('§41.1 AS WRITTEN: the automated managers outrank the owner', () => {
  // This is the literal hierarchy — human owner instruction is level 7, below
  // fast position manager (4) and bar-close strategy (6). So a profit keeper
  // MAY move a stop the owner set by hand.
  //
  // §41.2 says the opposite in prose: "Human owner actions should normally be
  // respected and audited rather than automatically reversed, unless they
  // violate a non-negotiable capital-safety rule." A fast manager is not a
  // capital-safety rule, so under §41.2 it should not reverse the owner.
  //
  // THE PLAN CONTRADICTS ITSELF HERE, and the contradiction is material: it
  // decides whether the bot may undo a stop the operator placed by hand. The
  // code follows the numbered list because a list is unambiguous and prose is
  // not — and this test exists to make the choice visible rather than
  // accidental. It is an OPEN DECISION for the owner, recorded in
  // docs/position-write-authority.md.
  for (const w of ['profit-keeper', 'trade-guard', 'loss-guardian', 'restrategize']) {
    assert.equal(arbitrate('position-protect', w).winner, w, w)
  }
  // What is NOT in tension: capital safety still overrides the owner, which is
  // the one thing §41.1 and §41.2 agree on.
  assert.equal(arbitrate('position-protect', 'loss-cap').winner, 'loss-cap')
})

test('tick safety outranks the fast managers, and order does not matter', () => {
  assert.equal(arbitrate('cpp-trail-engine', 'profit-keeper').winner, 'cpp-trail-engine')
  assert.equal(arbitrate('profit-keeper', 'cpp-trail-engine').winner, 'cpp-trail-engine')
})

test('equal authority is reported as a conflict, not resolved by luck', () => {
  // profit-keeper, trade-guard and loss-guardian are all level 4 and all now
  // share one 60s tick. Today they do not collide because each filters to a
  // disjoint set of positions — that is convention, not construction, and the
  // arbiter must say so rather than invent a winner.
  const r = arbitrate('profit-keeper', 'trade-guard')
  assert.equal(r.winner, null)
  assert.match(r.reason, /equal authority/)
})

test('an unknown writer never wins, and two unknowns are a conflict', () => {
  assert.equal(arbitrate('some-new-service', 'loss-cap').winner, 'loss-cap')
  assert.equal(arbitrate('loss-cap', 'some-new-service').winner, 'loss-cap')
  assert.equal(arbitrate('mystery-a', 'mystery-b').winner, null)
})

// ---------------------------------------------------------------------------
// §41 by event source — the vocabulary position_events actually uses
// ---------------------------------------------------------------------------

test('every event source maps to a real authority level', () => {
  for (const [src, auth] of Object.entries(EVENT_SOURCE_AUTHORITY)) {
    assert.ok(AUTHORITIES.includes(auth), `${src} → ${auth}`)
  }
})

test('the two tables agree wherever they name the same component', () => {
  // WRITER_AUTHORITY is keyed by module, EVENT_SOURCE_AUTHORITY by the
  // journal's snake_case source. Where both describe the same thing they must
  // not drift — a component that is level 4 in the doc and level 6 in the
  // journal would make every report about it wrong.
  for (const [writer, auth] of Object.entries(WRITER_AUTHORITY)) {
    const snake = writer.replace(/-/g, '_')
    if (!(snake in EVENT_SOURCE_AUTHORITY)) continue
    assert.equal(EVENT_SOURCE_AUTHORITY[snake], auth, snake)
  }
})

test('the owner acts through exactly two sources — a route and a button', () => {
  assert.equal(isOwnerSource('manual'), true)
  assert.equal(isOwnerSource('telegram'), true)
  const owners = Object.entries(EVENT_SOURCE_AUTHORITY)
    .filter(([, a]) => a === 'human_owner').map(([s]) => s)
  assert.deepEqual(owners.sort(), ['manual', 'telegram'])
})

test('capital safety is levels 1-2 and nothing else', () => {
  // The one point §41.1's numbered list and §41.2's prose agree on, and the
  // distinction the minute review reports.
  for (const src of ['loss_cap', 'profit_ratchet', 'equity_stop']) {
    assert.equal(isCapitalSafetySource(src), true, src)
  }
  for (const src of ['cpp_trail_engine', 'profit_keeper', 'fast_monitor', 'position_manager', 'manual']) {
    assert.equal(isCapitalSafetySource(src), false, src)
  }
})

test('an unknown source has no authority and is not mistaken for the owner', () => {
  assert.equal(authorityForSource('brand_new_thing'), null)
  assert.equal(authorityForSource(undefined), null)
  assert.equal(isOwnerSource('brand_new_thing'), false)
  assert.equal(isCapitalSafetySource(null), false)
})

// ---------------------------------------------------------------------------
// deriveState — every existing row predates this module
// ---------------------------------------------------------------------------

test('a position with no broker stop derives as naked, whatever else is true', () => {
  assert.equal(deriveState({ brokerOpen: true, localOpen: true, hasBrokerStop: false }), 'naked')
  assert.equal(deriveState({ brokerOpen: true, localOpen: true, hasBrokerStop: false, beMoved: true }), 'naked')
})

test('the two disagreement states are distinguished by direction', () => {
  assert.equal(deriveState({ brokerOpen: false, localOpen: true }), 'broker_closed_locally_open')
  assert.equal(deriveState({ brokerOpen: true, localOpen: false }), 'locally_closed_broker_open')
})

test('management progress is read from what the row already records', () => {
  const base = { brokerOpen: true, localOpen: true, hasBrokerStop: true }
  assert.equal(deriveState(base), 'protected')
  assert.equal(deriveState({ ...base, beMoved: true }), 'risk_reduced')
  assert.equal(deriveState({ ...base, beMoved: true, scaledOut: true }), 'runner_managed')
})

test('an empty argument derives a state rather than throwing', () => {
  // Twelve live positions predate this module. A migration that errored on an
  // unknown row would be worse than one that starts them at `filled`.
  assert.equal(deriveState(), 'filled')
  assert.equal(deriveState({}), 'filled')
})
