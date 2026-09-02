// node --test agent/services/management-state.test.js
//
// §40's state machine and §41's authority hierarchy.
//
// The module is pure on purpose, so these tests can be exhaustive rather than
// representative: every writer, source and rule in the tables is checked, not a
// sample. The transition and arbitration functions that once lived beside these
// vocabularies were deleted on 02-09-2026 (owner: wire it or delete it) — no
// writer ever consulted them; what remains is what minute-review and
// workstream-ws05 actually read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  STATES, EXCEPTIONS, AUTHORITIES, WRITER_AUTHORITY, EVENT_SOURCE_AUTHORITY,
  TRIGGERS, RULE_TRIGGER,
  isException,
  authorityForSource, isOwnerSource, isCapitalSafetySource,
  triggerForRule, rulesForWriter,
} from './management-state.js'

test('the vocabularies are disjoint — a state is either happy-path or exception', () => {
  for (const s of STATES) assert.equal(isException(s), false, s)
  for (const e of EXCEPTIONS) assert.equal(STATES.includes(e), false, e)
})

// ---------------------------------------------------------------------------
// §41 authority
// ---------------------------------------------------------------------------

test('every registered writer maps to a real authority level', () => {
  for (const [writer, auth] of Object.entries(WRITER_AUTHORITY)) {
    assert.ok(AUTHORITIES.includes(auth), `${writer} → ${auth}`)
  }
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
// §70.6 RULE_TRIGGER — the trigger is a property of the RULE, not the module
// ---------------------------------------------------------------------------

test('every rule carries a trigger from the allowed set', () => {
  for (const [rule, trig] of Object.entries(RULE_TRIGGER)) {
    assert.ok(TRIGGERS.includes(trig), `${rule} → ${trig} is not a known trigger`)
  }
})

test('every classified rule belongs to a writer that HAS authority', () => {
  // A rule whose writer is not in §41's registry is a rule nobody is
  // accountable for. The two tables must name the same components.
  for (const key of Object.keys(RULE_TRIGGER)) {
    const [writer, rule] = key.split(':')
    assert.ok(rule, `${key} must be <writer>:<rule>`)
    assert.ok(WRITER_AUTHORITY[writer], `${key}: '${writer}' is not in WRITER_AUTHORITY`)
  }
})

test('every ACTING writer has at least one classified rule', () => {
  // The failure this catches: a new rule shipped inside an existing module and
  // silently inheriting whatever cadence its host happens to run on.
  for (const w of ['trade-guard', 'profit-keeper', 'loss-cap', 'loss-guardian', 'profit-ratchet']) {
    assert.ok(rulesForWriter(w).length > 0, `${w} has no classified rules`)
  }
})

test('an unclassified rule reads as null rather than as a default', () => {
  assert.equal(triggerForRule('trade-guard:break_even'), 'tick')
  assert.equal(triggerForRule('profit-keeper:invented_rule'), null)
  assert.equal(triggerForRule(undefined), null)
})

test('THE RULES THAT MUST NOT BE TICKED', () => {
  // Each of these has a specific reason, and each reason is a real incident or
  // a real property — not a preference.
  //
  //  · profit-ratchet reads ACCOUNT EQUITY, a sum over positions. On
  //    2026-08-01 06:39 UTC it flattened an account off ONE 60-second equity
  //    read; the fix was hysteresis (`confirmReads`), which exists precisely
  //    to SUPPRESS fast reactions. Ticking it makes that incident worse.
  //  · naked_stop fires on a STATE — "this position has no stop" — which no
  //    price crossing announces.
  //  · time_cap is elapsed hours. A 60s poll is already 3600× finer.
  //  · spike_tighten reads COMPLETED bars; on a tick it would read a partial
  //    candle and produce a verdict the rule did not earn.
  for (const rule of Object.keys(RULE_TRIGGER)) {
    if (rule.startsWith('profit-ratchet:')) assert.equal(RULE_TRIGGER[rule], 'poll', rule)
  }
  assert.equal(RULE_TRIGGER['loss-guardian:naked_stop'], 'poll')
  assert.equal(RULE_TRIGGER['loss-guardian:time_cap'], 'poll')
  assert.equal(RULE_TRIGGER['profit-keeper:spike_tighten'], 'bar')
})

test('the C++ tick ratchet is classified as a tick rule', () => {
  // profit-keeper:chandelier_ratchet is the ONE rule already executing on
  // ticks in the sidecar. If this ever reads 'poll', the table has drifted
  // from what the system actually does.
  assert.equal(RULE_TRIGGER['profit-keeper:chandelier_ratchet'], 'tick')
})

test('a rule RENAMED or REMOVED in the code fails this table', () => {
  // The rot-guard. loss-guardian stamps `rule: '<name>'` on every decision it
  // returns, and those names are what land in position_events. Renaming one
  // without updating RULE_TRIGGER would leave the journal describing a rule
  // the classification does not know about — so the two directions are both
  // checked here.
  const src = readFileSync(new URL('./loss-guardian.js', import.meta.url), 'utf8')
  const inCode = new Set([...src.matchAll(/\brule:\s*'([a-z_]+)'/g)].map(m => m[1]))
  assert.ok(inCode.size >= 3, 'expected loss-guardian to stamp a rule on each decision')

  for (const name of inCode) {
    assert.ok(RULE_TRIGGER[`loss-guardian:${name}`],
      `loss-guardian returns rule '${name}' but RULE_TRIGGER does not classify it`)
  }
  for (const name of rulesForWriter('loss-guardian')) {
    assert.ok(inCode.has(name),
      `RULE_TRIGGER classifies loss-guardian:${name} but no such rule exists in the code`)
  }
})

test('loss-guardian journals BOTH of its writes', () => {
  // It amended stops and closed positions with no timeline entry at all until
  // 2026-08-04 — so §70.4's owner-override notice and the P10 journal were
  // blind to the one layer whose job is putting a stop on a position that has
  // NONE. Two recordPositionEvent calls, one per write site.
  const src = readFileSync(new URL('./loss-guardian.js', import.meta.url), 'utf8')
  assert.equal((src.match(/recordPositionEvent\(db, \{/g) || []).length, 2)
  assert.match(src, /kind: 'sl_moved', fromValue: null/, 'a naked position had NO prior stop — record that')
  assert.match(src, /kind: 'close'/)
})

