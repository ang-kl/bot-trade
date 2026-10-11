// node --test agent/services/capped-hybrid-settings.test.js
// W10 — Claude · № 13,391 12-Oct (owner's yes naming capped-hybrid-policy.js;
// docs/instruction-2026-10-12-decisions.md W10; claude-builder). The hybrid's
// trigger (R) and closed fraction become a stored setting. With no setting
// every plan and refusal is byte-identical to the pre-W10 code (GOLDEN was
// generated from that code, af578c7d, before this change); a stored 2.5R
// makes a 2.5R trigger; a plan armed before a settings change still validates.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { planCappedHybrid, loadCappedHybridSettings, validateCappedHybridSettings, CAPPED_HYBRID_SETTINGS_KEY,
  CAPPED_HYBRID_DEFAULTS } from './capped-hybrid-policy.js'

const GOLDEN = [
 {
  "input": {
   "side": "BUY",
   "entry": 100,
   "initialRisk": 10,
   "brokerTarget": 140,
   "volume": 10000,
   "minVolume": 100,
   "stepVolume": 100,
   "digits": 2,
   "openingDealIds": [
    "901"
   ]
  },
  "output": {
   "ok": true,
   "policy": "capped_hybrid_2r_half_v1",
   "mode": "partial_runner",
   "side": "BUY",
   "entry": 100,
   "initialRisk": 10,
   "originalStop": 90,
   "trigger": 120,
   "brokerTarget": 140,
   "volume": 10000,
   "closeVolume": 5000,
   "runnerVolume": 5000,
   "closePercentage": 50,
   "minVolume": 100,
   "stepVolume": 100,
   "digits": 2,
   "openingDealIds": [
    "901"
   ],
   "rBasis": "recorded_initial_price_risk",
   "runner": "existing_broker_sl_and_tp",
   "profitability": "unverified_after_costs"
  }
 },
 {
  "input": {
   "side": "SELL",
   "entry": 1.2345,
   "initialRisk": 0.0021,
   "brokerTarget": 1.2201,
   "volume": 200000,
   "minVolume": 1000,
   "stepVolume": 1000,
   "digits": 5,
   "openingDealIds": [
    "11",
    "12"
   ]
  },
  "output": {
   "ok": true,
   "policy": "capped_hybrid_2r_half_v1",
   "mode": "partial_runner",
   "side": "SELL",
   "entry": 1.2345,
   "initialRisk": 0.0021,
   "originalStop": 1.2366,
   "trigger": 1.2303,
   "brokerTarget": 1.2201,
   "volume": 200000,
   "closeVolume": 100000,
   "runnerVolume": 100000,
   "closePercentage": 50,
   "minVolume": 1000,
   "stepVolume": 1000,
   "digits": 5,
   "openingDealIds": [
    "11",
    "12"
   ],
   "rBasis": "recorded_initial_price_risk",
   "runner": "existing_broker_sl_and_tp",
   "profitability": "unverified_after_costs"
  }
 },
 {
  "input": {
   "side": "BUY",
   "entry": 0.08577,
   "initialRisk": 0.02266,
   "brokerTarget": 0.15797,
   "volume": 10,
   "minVolume": 1,
   "stepVolume": 1,
   "digits": 5,
   "openingDealIds": [
    "901"
   ]
  },
  "output": {
   "ok": true,
   "policy": "capped_hybrid_2r_half_v1",
   "mode": "partial_runner",
   "side": "BUY",
   "entry": 0.08577,
   "initialRisk": 0.02266,
   "originalStop": 0.06311,
   "trigger": 0.13109,
   "brokerTarget": 0.15797,
   "volume": 10,
   "closeVolume": 5,
   "runnerVolume": 5,
   "closePercentage": 50,
   "minVolume": 1,
   "stepVolume": 1,
   "digits": 5,
   "openingDealIds": [
    "901"
   ],
   "rBasis": "recorded_initial_price_risk",
   "runner": "existing_broker_sl_and_tp",
   "profitability": "unverified_after_costs"
  }
 },
 {
  "input": {
   "side": "BUY",
   "entry": 100,
   "initialRisk": 10,
   "brokerTarget": 115,
   "volume": 10000,
   "minVolume": 100,
   "stepVolume": 100,
   "digits": 2,
   "openingDealIds": [
    "901"
   ]
  },
  "output": {
   "ok": false,
   "policy": "capped_hybrid_2r_half_v1",
   "reason": "existing_tp_caps_before_runner"
  }
 },
 {
  "input": {
   "side": "BUY",
   "entry": 100,
   "initialRisk": 10,
   "brokerTarget": 140,
   "volume": 300,
   "minVolume": 100,
   "stepVolume": 100,
   "digits": 2,
   "openingDealIds": [
    "901"
   ]
  },
  "output": {
   "ok": false,
   "policy": "capped_hybrid_2r_half_v1",
   "reason": "half_and_runner_not_representable"
  }
 },
 {
  "input": {
   "side": "BUY",
   "entry": 100,
   "initialRisk": 10,
   "brokerTarget": 140,
   "volume": 10000,
   "minVolume": 100,
   "stepVolume": 100,
   "digits": 2,
   "openingDealIds": []
  },
  "output": {
   "ok": false,
   "policy": "capped_hybrid_2r_half_v1",
   "reason": "opening_receipts_required"
  }
 },
 {
  "input": {
   "side": "SELL",
   "entry": 4500.5,
   "initialRisk": 12.25,
   "brokerTarget": 4400,
   "volume": 2000,
   "minVolume": 100,
   "stepVolume": 100,
   "digits": 1,
   "openingDealIds": [
    "901"
   ]
  },
  "output": {
   "ok": true,
   "policy": "capped_hybrid_2r_half_v1",
   "mode": "partial_runner",
   "side": "SELL",
   "entry": 4500.5,
   "initialRisk": 12.25,
   "originalStop": 4512.75,
   "trigger": 4476,
   "brokerTarget": 4400,
   "volume": 2000,
   "closeVolume": 1000,
   "runnerVolume": 1000,
   "closePercentage": 50,
   "minVolume": 100,
   "stepVolume": 100,
   "digits": 1,
   "openingDealIds": [
    "901"
   ],
   "rBasis": "recorded_initial_price_risk",
   "runner": "existing_broker_sl_and_tp",
   "profitability": "unverified_after_costs"
  }
 },
 {
  "input": {
   "side": "X",
   "entry": 1,
   "initialRisk": 1,
   "brokerTarget": 2,
   "volume": 100,
   "minVolume": 1,
   "stepVolume": 1,
   "digits": 2,
   "openingDealIds": [
    "901"
   ]
  },
  "output": {
   "ok": false,
   "policy": "capped_hybrid_2r_half_v1",
   "reason": "recorded_risk_required"
  }
 }
]

test('W10 byte-identical: with no setting every plan and refusal is exactly the pre-W10 output', () => {
  for (const { input, output } of GOLDEN) {
    assert.equal(JSON.stringify(planCappedHybrid(input)), JSON.stringify(output), JSON.stringify(input))
    // Passing the defaults explicitly (what enrolment does with no stored setting) is the same.
    assert.equal(JSON.stringify(planCappedHybrid({ ...input, ...CAPPED_HYBRID_DEFAULTS })), JSON.stringify(output))
  }
})

test('W10: a pre-W10 plan still re-computes to itself (the partial manager and tick controller validity check)', () => {
  for (const { output } of GOLDEN.filter(g => g.output.ok)) {
    assert.equal(JSON.stringify(planCappedHybrid(output)), JSON.stringify(output))
  }
})

test('W10: a stored 2.5R makes a 2.5R trigger, and the plan carries what it was made with', () => {
  const base = GOLDEN[0].input   // BUY 100, risk 10, TP 140, 10000 units
  const p = planCappedHybrid({ ...base, triggerR: 2.5 })
  assert.equal(p.ok, true)
  assert.equal(p.trigger, 125)
  assert.deepEqual([p.closeVolume, p.runnerVolume, p.closePercentage], [5000, 5000, 50])
  assert.deepEqual([p.triggerR, p.closeFraction], [2.5, 0.5])
  // A short mirrors it.
  const s = planCappedHybrid({ ...GOLDEN[1].input, triggerR: 3 })
  assert.equal(s.ok, true); assert.ok(s.trigger < GOLDEN[1].output.trigger, 'further below entry than 2R')
})

test('W10: a stored fraction closes that share, exactly representable or refused (never rounded to a token partial)', () => {
  const base = GOLDEN[0].input
  const p = planCappedHybrid({ ...base, closeFraction: 0.4 })
  assert.deepEqual([p.ok, p.closeVolume, p.runnerVolume, p.closePercentage, p.trigger], [true, 4000, 6000, 40, 120])
  // 300 units in steps of 100: 30% is 90, not a step multiple → refused, not rounded.
  assert.equal(planCappedHybrid({ ...base, volume: 300, closeFraction: 0.3 }).reason, 'half_and_runner_not_representable')
  // 7 units in steps of 1: half is 3.5 — refused, never rounded to 4 + 3.
  assert.equal(planCappedHybrid({ ...base, volume: 7, minVolume: 1, stepVolume: 1 }).reason, 'half_and_runner_not_representable')
  assert.equal(planCappedHybrid({ ...base, volume: 7, minVolume: 1, stepVolume: 1, closeFraction: 0.3 }).reason, 'half_and_runner_not_representable')
  // A runner below the broker minimum is refused too.
  assert.equal(planCappedHybrid({ ...base, volume: 1000, minVolume: 200, stepVolume: 100, closeFraction: 0.9 }).reason, 'half_and_runner_not_representable')
})

test('W10: a plan armed before a settings change still validates; its own values, not the current setting, decide', () => {
  const armed = planCappedHybrid({ ...GOLDEN[0].input, triggerR: 2.5, closeFraction: 0.4 })
  assert.equal(armed.ok, true)
  // The setting moves on; the armed plan re-computes from itself.
  assert.equal(JSON.stringify(planCappedHybrid(armed)), JSON.stringify(armed))
  // And a default plan does not silently become a 2.5R plan.
  assert.equal(JSON.stringify(planCappedHybrid(GOLDEN[0].output)), JSON.stringify(GOLDEN[0].output))
})

test('W10: ranges are validated; out of range is refused by name, never clamped', () => {
  for (const bad of [{ triggerR: 0.5 }, { triggerR: 6 }, { triggerR: '2' }, { closeFraction: 0 }, { closeFraction: 1 }, { closeFraction: 0.95 }, { triggerR: NaN }]) {
    assert.equal(planCappedHybrid({ ...GOLDEN[0].input, ...bad }).reason, 'hybrid_settings_invalid', JSON.stringify(bad))
    assert.equal(validateCappedHybridSettings(bad).ok, false, JSON.stringify(bad))
  }
  assert.deepEqual(validateCappedHybridSettings({ triggerR: 2.5 }), { ok: true, settings: { triggerR: 2.5, closeFraction: 0.5 }, errors: [] })
  assert.equal(validateCappedHybridSettings(null).ok, false)
})

test('W10: the loader reads the stored setting; missing or invalid reads the defaults and says why', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadCappedHybridSettings(db), { triggerR: 2, closeFraction: 0.5, source: 'default', error: null })
  setState(db, CAPPED_HYBRID_SETTINGS_KEY, JSON.stringify({ triggerR: 2.5, closeFraction: 0.4 }))
  assert.deepEqual(loadCappedHybridSettings(db), { triggerR: 2.5, closeFraction: 0.4, source: 'stored', error: null })
  setState(db, CAPPED_HYBRID_SETTINGS_KEY, JSON.stringify({ triggerR: 9 }))
  const bad = loadCappedHybridSettings(db)
  assert.deepEqual([bad.triggerR, bad.closeFraction, bad.source], [2, 0.5, 'default']); assert.match(bad.error, /triggerR/)
  setState(db, CAPPED_HYBRID_SETTINGS_KEY, '{nope')
  assert.equal(loadCappedHybridSettings(db).error, 'stored setting is not JSON')
})
