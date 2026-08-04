// node --test agent/services/risk-config-history.test.js
//
// The Risk page's reassessment summary asserted "the settings below hold these
// values now" from a frozen record it never read back. These tests hold down
// the two facts that make the honest version possible: WHICH keys really
// changed, and whether an applied proposal still holds.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  noteRiskConfigChanges, loadRiskConfigChanges, pruneRiskConfigChanges,
  proposalStatus, changeKey,
} from './risk-config-history.js'

const db = () => {
  const d = new Database(':memory:')
  d.exec('CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT)')
  return d
}

test('only keys that ACTUALLY changed are stamped', () => {
  // A form re-save must not move every timestamp on the page. "Last changed"
  // has to mean changed, not submitted — otherwise the stamp answers a
  // question nobody asked.
  const d = db()
  const changed = noteRiskConfigChanges(d, { a: 1, b: 2 }, { a: 1, b: 3 })
  assert.deepEqual(changed, ['b'])
  const map = loadRiskConfigChanges(d)
  assert.equal(map.b.from, 2)
  assert.equal(map.b.to, 3)
  assert.equal(map.a, undefined)
})

test('turning a limit OFF is a change — 0, false and null are real settings', () => {
  // A truthiness comparison here would silently ignore disabling a cap, which
  // is the single most consequential edit on this page.
  const d = db()
  assert.deepEqual(noteRiskConfigChanges(d, { cap: 300 }, { cap: 0 }), ['cap'])
  assert.deepEqual(noteRiskConfigChanges(d, { on: true }, { on: false }), ['on'])
  assert.deepEqual(noteRiskConfigChanges(d, { x: 5 }, { x: null }), ['x'])
})

test('the stamp records WHO changed it, so a reassess apply is distinguishable', () => {
  const d = db()
  noteRiskConfigChanges(d, { a: 1 }, { a: 2 }, { by: 'reassess' })
  assert.equal(loadRiskConfigChanges(d).a.by, 'reassess')
})

test('per-account overlays keep their own history', () => {
  const d = db()
  noteRiskConfigChanges(d, { a: 1 }, { a: 2 })
  noteRiskConfigChanges(d, { a: 1 }, { a: 9 }, { accountId: '5203012' })
  assert.equal(loadRiskConfigChanges(d).a.to, 2)
  assert.equal(loadRiskConfigChanges(d, '5203012').a.to, 9)
  assert.equal(changeKey('5203012'), 'acct:5203012:risk_config_changed_json')
})

test('a later change overwrites the earlier one — one entry per key, bounded', () => {
  const d = db()
  noteRiskConfigChanges(d, { a: 1 }, { a: 2 }, { at: '2026-08-01T00:00:00Z' })
  noteRiskConfigChanges(d, { a: 2 }, { a: 3 }, { at: '2026-08-04T00:00:00Z' })
  const m = loadRiskConfigChanges(d)
  assert.equal(Object.keys(m).length, 1)
  assert.equal(m.a.from, 2)
  assert.equal(m.a.at, '2026-08-04T00:00:00Z')
})

test('pruning forgets keys the config no longer has', () => {
  const d = db()
  noteRiskConfigChanges(d, {}, { a: 1, gone: 2 })
  assert.equal(pruneRiskConfigChanges(d, ['a']), 1)
  assert.deepEqual(Object.keys(loadRiskConfigChanges(d)), ['a'])
})

test('a broken store reads as empty and records nothing, never throws', () => {
  const d = db()
  d.exec('DROP TABLE agent_state')
  assert.deepEqual(loadRiskConfigChanges(d), {})
  assert.deepEqual(noteRiskConfigChanges(d, { a: 1 }, { a: 2 }), [])
})

// ---------------------------------------------------------------------------
// the three-way status — the state the page could not express
// ---------------------------------------------------------------------------

test('APPLIED AND STILL HOLDING is not the same as APPLIED', () => {
  // The defect, exactly. The table had two states, so a row applied on 31 Jul
  // and changed on 3 Aug still read "APPLIED · the settings below hold these
  // values now" while the field below said something else.
  assert.equal(proposalStatus({ applied: true, proposed: 150, live: 150 }), 'holds')
  assert.equal(proposalStatus({ applied: true, proposed: 150, live: 300 }), 'superseded')
  assert.equal(proposalStatus({ applied: false, proposed: 150, live: 300 }), 'not_applied')
})

test('a proposal of 0 or false that still holds reads as holding', () => {
  assert.equal(proposalStatus({ applied: true, proposed: 0, live: 0 }), 'holds')
  assert.equal(proposalStatus({ applied: true, proposed: false, live: false }), 'holds')
  assert.equal(proposalStatus({ applied: true, proposed: 0, live: null }), 'superseded')
})
