import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { acctKey } from './account-registry.js'
import {
  settingFor, setOverride, clearOverride, overrideView, isOverridable,
  OVERRIDABLE_KEYS, NOT_OVERRIDABLE,
} from './setting-resolver.js'

function freshDb() {
  return initDB(':memory:')
}

const KEY = 'risk_config_json'

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('with no override the account INHERITS the shared value', () => {
  const db = freshDb()
  setState(db, KEY, '{"perTradeRiskPct":1.5}')
  const r = settingFor(db, 'A', KEY)
  assert.equal(r.source, 'shared')
  assert.equal(r.value, '{"perTradeRiskPct":1.5}')
})

test('inheritance FOLLOWS a later change to the shared value', () => {
  // The property that makes this maintainable, and the one that surprises
  // people — so it is pinned rather than assumed.
  const db = freshDb()
  setState(db, KEY, 'one')
  assert.equal(settingFor(db, 'A', KEY).value, 'one')
  setState(db, KEY, 'two')
  assert.equal(settingFor(db, 'A', KEY).value, 'two')
})

test('an override wins, and the shared value is still reported alongside', () => {
  const db = freshDb()
  setState(db, KEY, 'shared')
  setOverride(db, 'A', KEY, 'mine')
  const r = settingFor(db, 'A', KEY)
  assert.equal(r.value, 'mine')
  assert.equal(r.source, 'account')
  assert.equal(r.sharedValue, 'shared', 'the UI needs both to say what a revert would do')
})

test('an override does NOT follow a later shared change', () => {
  const db = freshDb()
  setState(db, KEY, 'one')
  setOverride(db, 'A', KEY, 'pinned')
  setState(db, KEY, 'two')
  assert.equal(settingFor(db, 'A', KEY).value, 'pinned')
})

test('one account override does not leak to another', () => {
  const db = freshDb()
  setState(db, KEY, 'shared')
  setOverride(db, 'A', KEY, 'mine')
  assert.equal(settingFor(db, 'B', KEY).value, 'shared')
  assert.equal(settingFor(db, 'B', KEY).source, 'shared')
})

test('an EMPTY override is still an override, not an absence', () => {
  // "this account deliberately has nothing here" is a real state; treating it
  // as absent would silently re-inherit the shared value.
  const db = freshDb()
  setState(db, KEY, 'shared')
  setOverride(db, 'A', KEY, '')
  const r = settingFor(db, 'A', KEY)
  assert.equal(r.source, 'account')
  assert.equal(r.value, '')
})

test('no account, or "all", resolves to the shared value', () => {
  const db = freshDb()
  setState(db, KEY, 'shared')
  assert.equal(settingFor(db, null, KEY).source, 'shared')
  assert.equal(settingFor(db, 'all', KEY).source, 'shared')
})

test('a key set nowhere reports unset rather than a fabricated default', () => {
  const db = freshDb()
  const r = settingFor(db, 'A', 'ratchet_json')
  assert.equal(r.source, 'unset')
  assert.equal(r.value, null)
})

test('the resolver returns the RAW string, so adopting it changes no parsing', () => {
  const db = freshDb()
  setState(db, KEY, '{"a":1}')
  assert.equal(typeof settingFor(db, 'A', KEY).value, 'string')
})

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

test('the allowlist covers risk sizing, the protection layers and the universe', () => {
  for (const k of ['risk_config_json', 'profit_keeper_json', 'loss_guard_json', 'loss_cap_json', 'ratchet_json', 'autopilot_symbols_json']) {
    assert.equal(isOverridable(k), true, `${k} should be overridable`)
  }
})

test('a portfolio safety limit is REFUSED, with the reason', () => {
  const db = freshDb()
  const r = setOverride(db, 'A', 'global_guards_json', '{"halt":false}')
  assert.equal(r.ok, false)
  assert.match(r.error, /5A exists so it cannot be evaded/)
  assert.equal(getState(db, acctKey('A', 'global_guards_json')) ?? null, null, 'nothing was written')
})

test('process-level settings are refused, because a per-account copy could not take effect', () => {
  const db = freshDb()
  for (const k of ['llm_provider', 'loop_interval_min', 'daily_token_budget']) {
    const r = setOverride(db, 'A', k, 'x')
    assert.equal(r.ok, false, `${k} must be refused`)
    assert.ok(NOT_OVERRIDABLE[k])
  }
})

test('an UNKNOWN key is refused too — the list is an allowlist, not a denylist', () => {
  // The direction matters: a setting added next month is not silently
  // overridable. A denylist would grow the surface by default.
  const db = freshDb()
  const r = setOverride(db, 'A', 'some_new_setting_json', 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /by decision, not by default/)
})

test('setOverride needs an account', () => {
  const db = freshDb()
  assert.equal(setOverride(db, null, KEY, 'x').ok, false)
})

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

test('reverting restores INHERITANCE, not a copy of today shared value', () => {
  // A copy would freeze the current shared value and stop following later
  // changes — the exact drift this design exists to avoid.
  const db = freshDb()
  setState(db, KEY, 'one')
  setOverride(db, 'A', KEY, 'pinned')
  assert.equal(clearOverride(db, 'A', KEY).ok, true)
  assert.equal(settingFor(db, 'A', KEY).source, 'shared')
  setState(db, KEY, 'two')
  assert.equal(settingFor(db, 'A', KEY).value, 'two', 'it follows again after the revert')
})

test('reverting a key that was never overridden is harmless', () => {
  const db = freshDb()
  setState(db, KEY, 'shared')
  assert.equal(clearOverride(db, 'A', KEY).ok, true)
  assert.equal(settingFor(db, 'A', KEY).value, 'shared')
})

test('reverting one key leaves the account other overrides alone', () => {
  const db = freshDb()
  setOverride(db, 'A', KEY, 'r')
  setOverride(db, 'A', 'ratchet_json', 'k')
  clearOverride(db, 'A', KEY)
  assert.equal(settingFor(db, 'A', 'ratchet_json').source, 'account')
})

// ---------------------------------------------------------------------------
// The view the UI renders
// ---------------------------------------------------------------------------

test('the view lists every overridable setting, grouped, with its source', () => {
  const db = freshDb()
  const v = overrideView(db, 'A')
  const keys = v.groups.flatMap(g => g.settings.map(s => s.key))
  assert.deepEqual(new Set(keys), new Set(Object.keys(OVERRIDABLE_KEYS)))
  assert.equal(v.overriddenCount, 0)
  for (const g of v.groups) assert.ok(g.label, 'each group needs a human label')
})

test('the view counts overrides and marks the right rows', () => {
  const db = freshDb()
  setOverride(db, 'A', KEY, 'mine')
  const v = overrideView(db, 'A')
  assert.equal(v.overriddenCount, 1)
  const row = v.groups.flatMap(g => g.settings).find(s => s.key === KEY)
  assert.equal(row.overridden, true)
  assert.equal(row.source, 'account')
})

test('an override EQUAL to the shared value is still an override, and differs says so', () => {
  const db = freshDb()
  setState(db, KEY, 'same')
  setOverride(db, 'A', KEY, 'same')
  const row = overrideView(db, 'A').groups.flatMap(g => g.settings).find(s => s.key === KEY)
  assert.equal(row.overridden, true, 'it will not follow a later shared change, so it is not inherited')
  assert.equal(row.differs, false)
})

test('the view carries the NOT-overridable list, so a refusal is discoverable in advance', () => {
  const db = freshDb()
  const v = overrideView(db, 'A')
  assert.ok(v.notOverridable.length > 0)
  for (const n of v.notOverridable) assert.ok(n.why, `${n.key} needs a stated reason`)
})

test('the view for no account shows everything as shared', () => {
  const db = freshDb()
  setOverride(db, 'A', KEY, 'mine')
  const v = overrideView(db, null)
  assert.equal(v.overriddenCount, 0)
  assert.equal(v.accountId, null)
})

test('the resolver uses the SAME acct:<id>:<key> convention the registry already had', () => {
  const db = freshDb()
  setOverride(db, 'A', KEY, 'mine')
  assert.equal(getState(db, acctKey('A', KEY)), 'mine')
})

test('the existing watchlist fork is visible through the resolver', () => {
  // watchlists.js has written acct:<id>:autopilot_symbols_json since the
  // per-account watchlist work; the resolver must SEE those, not shadow them.
  const db = freshDb()
  setState(db, 'autopilot_symbols_json', '["EURUSD"]')
  setState(db, acctKey('A', 'autopilot_symbols_json'), '["BTCUSD"]')
  const r = settingFor(db, 'A', 'autopilot_symbols_json')
  assert.equal(r.source, 'account')
  assert.equal(r.value, '["BTCUSD"]')
})
