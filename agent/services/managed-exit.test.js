// node --test agent/services/managed-exit.test.js
//
// The policy's load-bearing properties (owner "c1", 25-08-2026): it reaches
// DEMO accounts only, it fails CLOSED for accounts it cannot identify, its
// cap scales with the SIGNAL's timeframe rather than the wall clock, and the
// trail it switches on is peak-based and tighten-only — plus the wiring pins,
// because a policy nothing calls is failure mode #4.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { loadManagedExit, managedExitApplies, managedCapAt, MANAGED_EXIT_DEFAULTS } from './managed-exit.js'
import { evaluatePosition, DEFAULT_RULES } from './position-manager.js'

function withAccounts(db) {
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('43097342','5203012',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('42993489','1251247',1,1,'active')`).run()
  return db
}

test('defaults: on, demo-only, 8 bars, 1R — and junk state degrades to them', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadManagedExit(db), { ...MANAGED_EXIT_DEFAULTS })
  setState(db, 'managed_exit_json', '{"capBars":"-3","trailR":"junk"')  // malformed on purpose
  assert.deepEqual(loadManagedExit(db), { ...MANAGED_EXIT_DEFAULTS })
})

test('demo yes, live no, unknown NO — the policy fails closed away from live money', () => {
  const db = withAccounts(initDB(':memory:'))
  assert.equal(managedExitApplies(db, '43097342'), true, 'demo account governed')
  assert.equal(managedExitApplies(db, '42993489'), false, 'live account untouched')
  assert.equal(managedExitApplies(db, '99999999'), false, 'unregistered account treated as not-demo')
  assert.equal(managedExitApplies(db, null), false)
  setState(db, 'managed_exit_json', JSON.stringify({ on: false }))
  assert.equal(managedExitApplies(db, '43097342'), false, 'off means off, even for demo')
})

test('the cap is 8 bars of the SIGNAL timeframe, not a wall-clock constant', () => {
  const t0 = Date.parse('2026-08-25T00:00:00Z')
  assert.equal(managedCapAt(t0, '15m', 8), new Date(t0 + 8 * 15 * 60_000).toISOString(), '2h on a 15m chart')
  assert.equal(managedCapAt(t0, '1h', 8), new Date(t0 + 8 * 3_600_000).toISOString(), '8h on a 1h chart')
  assert.equal(managedCapAt(t0, 'nonsense', 8), new Date(t0 + 8 * 3_600_000).toISOString(), 'unknown timeframe falls back to 1h bars')
})

// ---------------------------------------------------------------------------
// The trail rule itself (position-manager's alwaysTrailR).
// ---------------------------------------------------------------------------

const basePos = {
  id: 1, symbol: 'EURUSD', side: 'long',
  entry_price: 100, current_sl: 99, current_tp: 106,
  initial_risk: 1, mfe_r: 0, mae_r: 0,
  be_moved: 0, scaled_out: 0,
  invalidation_trigger: null, time_cap_at: null,
}

test('the managed trail ratchets behind the PEAK and never loosens; off by default', () => {
  // Peak 2R (mfe_r=2), price pulled back to 1.2R: behind-price would loosen
  // to 0.2R — behind-peak holds 1.0R. The stop follows the high-water mark.
  const rules = { ...DEFAULT_RULES, beTriggerR: 99, partialTriggerR: 99, bankTriggerR: 0, alwaysTrailR: 1.0 }
  const out = evaluatePosition({ ...basePos, mfe_r: 2 }, { currentPrice: 101.2, rules })
  assert.equal(out.action, 'MOVE_SL')
  assert.equal(out.newSL, 101, 'peak 2R − 1R = +1R = 101')

  // Already at the trail level → tighten-only guard holds.
  const held = evaluatePosition({ ...basePos, mfe_r: 2, current_sl: 101 }, { currentPrice: 101.2, rules })
  assert.notEqual(held.action, 'MOVE_SL')

  // At entry (no favorable excursion) the trail equals the original stop — no-op.
  const flat = evaluatePosition({ ...basePos }, { currentPrice: 100, rules })
  assert.notEqual(flat.action, 'MOVE_SL')

  // And absent the knob, nothing new fires: DEFAULT_RULES leaves it null.
  assert.equal(DEFAULT_RULES.alwaysTrailR, null)
})

// ---------------------------------------------------------------------------
// Wiring pins — a policy nothing calls is failure mode #4. loop.js cannot be
// imported here (it drags in the broker client), so the call sites are
// asserted from source, same justification as vercel-decomm.test.js.
// ---------------------------------------------------------------------------

test('loop.js actually consults the policy at BOTH wiring points', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.match(src, /managedExitApplies\(db, accountId\)/, 'fill-time cap gate missing')
  assert.match(src, /managedCapAt\(Date\.now\(\)/, 'fill-time cap stamp missing')
  assert.match(src, /managedExitApplies\(db, pos\.account_id\)/, 'monitor-time trail gate missing')
  assert.match(src, /alwaysTrailR: loadManagedExit\(db\)\.trailR/, 'trail knob not passed to the evaluator')
})
