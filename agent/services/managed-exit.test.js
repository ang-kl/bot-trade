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
import { loadManagedExit, managedExitApplies, managedCapAt, applyManagedRules, takeAtRFor, MANAGED_EXIT_DEFAULTS } from './managed-exit.js'
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

test('every REGISTERED account is governed; unknown still fails closed', () => {
  // Owner 28-08-2026: "regardless of account" — demoOnly defaults false, so
  // live is governed too. The registry check is unconditional: an account
  // the policy cannot identify is never governed, whichever scope is on.
  const db = withAccounts(initDB(':memory:'))
  assert.equal(managedExitApplies(db, '43097342'), true, 'demo account governed')
  assert.equal(managedExitApplies(db, '42993489'), true, 'live account governed (owner order)')
  assert.equal(managedExitApplies(db, '99999999'), false, 'unregistered account fails closed')
  assert.equal(managedExitApplies(db, null), false, 'unattributable rows fail closed')
  setState(db, 'managed_exit_json', JSON.stringify({ demoOnly: true }))
  assert.equal(managedExitApplies(db, '42993489'), false, 'demoOnly:true stored restores the demo fence')
  assert.equal(managedExitApplies(db, '99999999'), false, 'unknown fails closed under demoOnly too')
  setState(db, 'managed_exit_json', JSON.stringify({ on: false }))
  assert.equal(managedExitApplies(db, '43097342'), false, 'off means off, even for demo')
})

test('the cap is WALL-CLOCK minutes — a timeframe never becomes a hold deadline', () => {
  // Reversal of the 25-08 timeframe-scaled cap (owner, 01-09-2026: a
  // timeframe is the bar size a signal looked BACK on, not a future
  // interval). One number, minutes from fill, timeframe-blind.
  const t0 = Date.parse('2026-08-25T00:00:00Z')
  assert.equal(managedCapAt(t0, 120), new Date(t0 + 120 * 60_000).toISOString())
  assert.equal(managedCapAt(t0, 480), new Date(t0 + 480 * 60_000).toISOString())
  assert.equal(MANAGED_EXIT_DEFAULTS.capMinutes, 0, 'no policy cap by default')
})

test('legacy stored capBars is ignored; capMinutes is the only cap knob', () => {
  const db = initDB(':memory:')
  setState(db, 'managed_exit_json', JSON.stringify({ capBars: 8 }))
  assert.equal(loadManagedExit(db).capMinutes, 0, 'capBars must not resurrect a cap')
  assert.equal(loadManagedExit(db).capBars, undefined, 'capBars is gone from the config shape')
  setState(db, 'managed_exit_json', JSON.stringify({ capMinutes: 90 }))
  assert.equal(loadManagedExit(db).capMinutes, 90)
  setState(db, 'managed_exit_json', JSON.stringify({ capMinutes: 0 }))
  assert.equal(loadManagedExit(db).capMinutes, 0, '0 is a VALUE (cap off), not junk')
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

test('the policy is wired at the fill-time cap and at EVERY position evaluator', () => {
  // 2026-08-31, 0016.HK: the managed merge lived only in loop.js's monitor,
  // so fast-monitor (30s cadence) ran the raw ladder and bank_target_4R took
  // the exit one minute after HK open. Every evaluator pins here now — the
  // next one added without the merge fails this test by name.
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.match(loop, /managedExitApplies\(db, accountId\)/, 'fill-time cap gate missing')
  assert.match(loop, /managedCapAt\(Date\.now\(\)/, 'fill-time cap stamp missing')
  assert.match(loop, /applyManagedRules\(db, pos\.account_id, rulesForSymbol\(db, pos\.symbol\), \{ strategy: pos\.strategy \}\)/, 'loop monitor must evaluate through applyManagedRules WITH the position strategy')
  const fast = readFileSync(new URL('./fast-monitor.js', import.meta.url), 'utf8')
  assert.match(fast, /applyManagedRules\(db, pos\.account_id, rulesForSymbol\(db, pos\.symbol\), \{ strategy: pos\.strategy \}\)/, 'fast-monitor must evaluate through applyManagedRules WITH the position strategy')
})

// ---------------------------------------------------------------------------
// One Simple System (owner 28-08-2026, win-rate goal > 69%): trail 0.5R is
// the sole exit-timing rule on managed accounts; the policy cap defaults OFF
// and 0 is a VALUE, not junk to be "repaired" back to a cap.
// ---------------------------------------------------------------------------

test('defaults are the swept values: trailR 0.5, capMinutes 0', () => {
  assert.equal(MANAGED_EXIT_DEFAULTS.trailR, 0.5)
  assert.equal(MANAGED_EXIT_DEFAULTS.capMinutes, 0)
})

test('capMinutes 0 stored is honoured as NO CAP, not repaired to a default', () => {
  const db = initDB(':memory:')
  setState(db, 'managed_exit_json', JSON.stringify({ capMinutes: 0, trailR: 0.5 }))
  const cfg = loadManagedExit(db)
  assert.equal(cfg.capMinutes, 0, 'a cap you can configure but never turn off is the guard-out-of-reach shape')
  // Junk still degrades to the default, and an explicit positive cap still works.
  setState(db, 'managed_exit_json', JSON.stringify({ capMinutes: 'junk' }))
  assert.equal(loadManagedExit(db).capMinutes, MANAGED_EXIT_DEFAULTS.capMinutes)
  setState(db, 'managed_exit_json', JSON.stringify({ capMinutes: 480 }))
  assert.equal(loadManagedExit(db).capMinutes, 480)
})

test('the managed ruleset silences the legacy ladder and the trail alone fires', () => {
  // The exact rule values loop.js merges for managed accounts.
  const managedRules = {
    ...DEFAULT_RULES,
    alwaysTrailR: 0.5,
    bankTriggerR: 0,
    partialTriggerR: Infinity,
    runnerTriggerR: Infinity,
    beTriggerR: Infinity,
  }
  const pos = {
    id: 1, symbol: 'TEST', side: 'long', entry_price: 100, current_sl: 99,
    current_tp: null, initial_risk: 1, mfe_r: 0, mae_r: 0, be_moved: 0,
    scaled_out: 0, invalidation_trigger: null, time_cap_at: null,
    created_at: new Date().toISOString(),
  }
  // +6R would have hit bank_target_5R, the partial window and breakeven under
  // the legacy ladder. Under the managed ruleset only the trail may answer.
  const r = evaluatePosition(pos, { currentPrice: 106, rules: managedRules })
  assert.equal(r.action, 'MOVE_SL')
  assert.match(r.reason, /managed_trail/, 'the trail must be the rule that fires, not bank/partial/breakeven')
  assert.equal(r.newSL, 105.5, 'peak 6R − 0.5R = +5.5R = 105.5')
  // And below +0.5R the ruleset does nothing at all: stop stands, no exits.
  const hold = evaluatePosition(pos, { currentPrice: 100.4, rules: managedRules })
  assert.equal(hold.action, 'HOLD')
})

test('applyManagedRules sets the silencing values for governed accounts and passes others through', () => {
  const db = withAccounts(initDB(':memory:'))
  const base = { ...DEFAULT_RULES, bankTriggerR: 4 }
  const managed = applyManagedRules(db, '43097342', base, { strategy: 'rsi2_reversion' })
  assert.equal(managed.alwaysTrailR, MANAGED_EXIT_DEFAULTS.trailR)
  assert.equal(managed.bankTriggerR, MANAGED_EXIT_DEFAULTS.takeAtR, 'takeAtR rides the bank-target rule (reversion family)')
  assert.equal(managed.partialTriggerR, Infinity)
  assert.equal(managed.runnerTriggerR, Infinity)
  assert.equal(managed.beTriggerR, Infinity)
  // Ungoverned scopes get the base rules BY REFERENCE-EQUAL VALUES: the
  // ladder survives untouched for unknown accounts and with the policy off.
  assert.deepEqual(applyManagedRules(db, '99999999', base), base)
  setState(db, 'managed_exit_json', JSON.stringify({ on: false }))
  assert.deepEqual(applyManagedRules(db, '43097342', base), base)
})

test('loop wiring pin: the fill-path cap stamp is gated on capMinutes > 0 and takes NO timeframe', () => {
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(loop, /if \(mePolicy\.capMinutes > 0\) \{/,
    'the fill-path cap stamp must be gated on capMinutes > 0')
  assert.match(loop, /managedCapAt\(Date\.now\(\), mePolicy\.capMinutes\)/,
    'the cap stamp must be wall-clock only — no timeframe argument')
})

test('every source whitelist that names ours includes preopen', () => {
  // 2026-08-31: #787 upgraded misfiled preopen rows out of 'external' — and
  // straight out of the monitor's whitelist, freezing their checks for two
  // days. The 09-08 label split touched every consumer that names sources;
  // this pin makes the NEXT new source fail loudly in four places at once.
  const files = [
    '../loop.js', './profit-keeper.js', './loss-guardian.js', './cockpit-intention.js',
  ]
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const lists = src.match(/\(?['"[]autopilot['"].{0,80}/g) || []
    const withList = lists.filter(s => s.includes('external'))
    assert.ok(withList.length > 0, `${f}: source whitelist not found — re-anchor this pin`)
    for (const s of withList) {
      assert.ok(s.includes('preopen'), `${f}: a source whitelist omits 'preopen': ${s}`)
    }
  }
})

// ---------------------------------------------------------------------------
// takeAtR (owner "do the different exit", 03-09-2026): the whole position is
// taken at +1R; the trail answers below it; 0 restores trail-only.
// ---------------------------------------------------------------------------

test('takeAtR: default 1.0, stored value honoured, 0 is a value (trail only), junk degrades to the default', () => {
  const db = initDB(':memory:')
  assert.equal(MANAGED_EXIT_DEFAULTS.takeAtR, 1.0)
  assert.equal(loadManagedExit(db).takeAtR, 1.0)
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtR: 1.5 }))
  assert.equal(loadManagedExit(db).takeAtR, 1.5)
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtR: 0 }))
  assert.equal(loadManagedExit(db).takeAtR, 0)
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtR: 'junk' }))
  assert.equal(loadManagedExit(db).takeAtR, 1.0)
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtR: -2 }))
  assert.equal(loadManagedExit(db).takeAtR, 1.0)
})

test('under the managed ruleset +1R is a FULL_EXIT (bank_target_1R); +0.8R is still the trail; takeAtR 0 leaves the trail alone', () => {
  const db = withAccounts(initDB(':memory:'))
  const pos = {
    id: 1, symbol: 'TEST', side: 'long', entry_price: 100, current_sl: 99,
    current_tp: null, initial_risk: 1, mfe_r: 0, mae_r: 0, be_moved: 0,
    scaled_out: 0, invalidation_trigger: null, time_cap_at: null,
    created_at: new Date().toISOString(),
  }
  const managed = applyManagedRules(db, '43097342', { ...DEFAULT_RULES }, { strategy: 'rsi2_reversion' })
  assert.equal(managed.bankTriggerR, 1.0)
  const take = evaluatePosition(pos, { currentPrice: 101, rules: managed })
  assert.equal(take.action, 'FULL_EXIT')
  assert.match(take.reason, /bank_target_1R/)
  assert.equal(take.exitFraction, 1)
  const below = evaluatePosition(pos, { currentPrice: 100.8, rules: managed })
  assert.equal(below.action, 'MOVE_SL', 'below +1R the 0.5R trail is the rule that answers')
  assert.match(below.reason, /managed_trail/)
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtR: 0 }))
  const trailOnly = applyManagedRules(db, '43097342', { ...DEFAULT_RULES }, { strategy: 'rsi2_reversion' })
  assert.equal(trailOnly.bankTriggerR, 0)
  const r = evaluatePosition(pos, { currentPrice: 106, rules: trailOnly })
  assert.equal(r.action, 'MOVE_SL', 'with takeAtR 0 a +6R print is still only trailed')
})

// ---------------------------------------------------------------------------
// takeAtR scoped by family (owner 07-09-2026: "scope takeAtR to mean
// reversion"). The +1R whole-position take was measured on reversion closes
// (~40% touch +1R, nothing reaches +1.5R); on a trend or breakout entry it
// cuts the momentum tail at the root. Only the listed families get the take.
// ---------------------------------------------------------------------------

test('takeAtR reaches ONLY the mean_reversion family by default; trend, breakout, momentum and unknown keep the trail alone', () => {
  const db = withAccounts(initDB(':memory:'))
  assert.deepEqual(MANAGED_EXIT_DEFAULTS.takeAtRFamilies, ['mean_reversion'])
  const base = { ...DEFAULT_RULES }
  assert.equal(applyManagedRules(db, '43097342', base, { strategy: 'rsi2_reversion' }).bankTriggerR, 1.0)
  assert.equal(applyManagedRules(db, '43097342', base, { strategy: 'vp_value' }).bankTriggerR, 1.0)
  assert.equal(applyManagedRules(db, '43097342', base, { strategy: 'ema_pullback' }).bankTriggerR, 0, 'trend: trail only')
  assert.equal(applyManagedRules(db, '43097342', base, { strategy: 'donchian_breakout' }).bankTriggerR, 0, 'breakout: trail only')
  assert.equal(applyManagedRules(db, '43097342', base, { strategy: 'tsmom_long' }).bankTriggerR, 0, 'momentum: trail only')
  assert.equal(applyManagedRules(db, '43097342', base, { strategy: null }).bankTriggerR, 0, 'no strategy on record: trail only')
  assert.equal(applyManagedRules(db, '43097342', base).bankTriggerR, 0, 'caller that passes no strategy gets trail only, never a silent take')
  // Ungoverned accounts still get the base ladder untouched, family or not.
  assert.deepEqual(applyManagedRules(db, '99999999', base, { strategy: 'rsi2_reversion' }), base)
})

test('a trend position at +1R is TRAILED, not taken; the same print on a reversion position is taken whole', () => {
  const db = withAccounts(initDB(':memory:'))
  const pos = {
    id: 1, symbol: 'TEST', side: 'long', entry_price: 100, current_sl: 99,
    current_tp: null, initial_risk: 1, mfe_r: 0, mae_r: 0, be_moved: 0,
    scaled_out: 0, invalidation_trigger: null, time_cap_at: null,
    created_at: new Date().toISOString(),
  }
  const trend = evaluatePosition(pos, { currentPrice: 101, rules: applyManagedRules(db, '43097342', { ...DEFAULT_RULES }, { strategy: 'ema_pullback' }) })
  assert.equal(trend.action, 'MOVE_SL', 'trend at +1R: the 0.5R trail answers')
  assert.match(trend.reason, /managed_trail/)
  const rev = evaluatePosition(pos, { currentPrice: 101, rules: applyManagedRules(db, '43097342', { ...DEFAULT_RULES }, { strategy: 'rsi2_reversion' }) })
  assert.equal(rev.action, 'FULL_EXIT')
  assert.match(rev.reason, /bank_target_1R/)
})

test('takeAtRFamilies: an explicit list REPLACES the default, an empty list reaches no family, junk degrades', () => {
  const db = initDB(':memory:')
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtRFamilies: ['trend'] }))
  let p = loadManagedExit(db)
  assert.deepEqual(p.takeAtRFamilies, ['trend'])
  assert.equal(takeAtRFor(p, 'ema_pullback'), 1.0)
  assert.equal(takeAtRFor(p, 'rsi2_reversion'), 0, 'an explicit list replaces the default, it does not extend it')
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtRFamilies: [] }))
  p = loadManagedExit(db)
  assert.equal(takeAtRFor(p, 'rsi2_reversion'), 0, 'empty list is a value: the take reaches nobody')
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtRFamilies: 'mean_reversion' }))
  p = loadManagedExit(db)
  assert.deepEqual(p.takeAtRFamilies, ['mean_reversion'], 'a bare string is junk → default')
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtR: 0 }))
  assert.equal(takeAtRFor(loadManagedExit(db), 'rsi2_reversion'), 0, 'takeAtR 0 is off for every family')
})
