// agent/services/tick-validation.test.js — P5: the validation-stage importer.
//
// The stage moves one step at a time on evidence naming its profile, judged
// against owner-held thresholds; a refusal writes NOTHING. Each test here
// pins one refusal or one pass, and the last pins that the importer never
// reads a bar-strategy record (TM-20: promotion cannot borrow time-strategy
// evidence) by reading its own source with comments stripped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB, setState, getState } from '../db.js'
import { loadRepoSchedule, scheduleHash, TICK_COST_MAP_KEY } from '../lib/tick-cost-schedule.js'
import { upsertAccount, getAccountState, setAccountState } from './account-registry.js'
import { engineStatusFor, requestTickObservation, ENGINE_STATUS_KEY } from './entry-mode.js'
import { importTickTrial } from './tick-research.js'
import { DEFAULT_PARAMS, profileHash, profileHashFull, normalizeParams } from '../lib/tick-strategy.js'
import { importTickValidation, loadThresholds, validationHistory, shadowSignalEvidence, tradedTickEvidence, replayChecks, shadowWindow, TICK_VALIDATION_KEY } from './tick-validation.js'
import { simulate } from '../lib/tick-replay-sim.js'
import { buildFixture } from '../lib/tick-strategy.test.js'

const DEMO = '46979908', LIVE = '42993489'
// PR-L: the cost model a charged trial records — the replay rung refuses a
// trial that was replayed at zero cost.
const CHARGED = { latencyMs: 250, costSource: 'class', costClass: 'fx', commissionWirePerSide: 0, commissionBpsPerSide: 0.35, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 }
const TH = { replay: { minTrades: 30, minProfitFactor: 1.3, maxDrawdownR: 10, minExpectancyLowerR: 0, minTestTrades: 10 }, shadow: { minSignals: 20, minHours: 24, minTrades: 5, minLosses: 2, minProfitFactor: 1.2, minExpectancyLowerR: -1, maxDrawdownR: 6, maxResetSharePct: 20 }, traded: { minTrades: 3, minProfitFactor: 1.2, maxDrawdownR: 10 } }

function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  upsertAccount(db, { accountId: LIVE, isLive: true })
  return db
}
function trial(db, { params = DEFAULT_PARAMS, trades = 40, profitFactor = 1.6, testNetR = 3, testLowerR = 0.2, testWithheld = false, maxDrawdownR = 4, trialId = null, uncharged = false } = {}) {
  const testBlock = testWithheld ? { name: 'test', withheld: true, trades: null } : { name: 'test', trades: 10, netR: testNetR, expectancyLowerR: testLowerR }
  const t = {
    trialId, strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: profileHash(params), params: normalizeParams(params),
    // PR-L: a trial must record the cost model it was replayed at — the
    // replay rung refuses a zero-cost trial. `uncharged` builds the old shape.
    sim: uncharged ? { latencyMs: 250 } : { latencyMs: 250, costSource: 'class', costClass: 'fx', commissionWirePerSide: 0, commissionBpsPerSide: 0.35, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    manifest: { segments: 1 }, summary: { trades, profitFactor, maxDrawdownR, netR: testNetR + 2 },
    blocks: [{ name: 'train', trades: 20, netR: 1 }, { name: 'validation', trades: 10, netR: 1 }, testBlock],
  }
  const r = importTickTrial(db, t)
  assert.equal(r.ok, true)
  return r.trialId
}
// PR-L: a shadow row counts toward SHADOW_PASSED only when the sidecar's book
// PRICED it — `cost_class` is the marker. `costClass: null` builds a pre-PR-L
// row, the shape of the 236 already on record.
function shadowTrade(db, { side = 'cpp_exec_demo', seq, profile, netR, exitMs, reason = 'target', symbolId = 1, costClass = 'fx' }) {
  db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, reason, net_r, gross_r, exit_ms, cost_class, commission_wire, commission_bps, slippage_wire, slippage_bps)
              VALUES (?, 'b1', ?, ?, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(side, seq, symbolId, profile, reason, netR, netR, exitMs, costClass,
         costClass ? 0 : null, costClass ? 0.35 : null, costClass ? 0 : null, costClass ? 0.5 : null)
}

// PR-L: the sidecar's reported sim — what the evidence gate reads to prove the
// verdict rests on a charged cost model. Defaults to the repo's own schedule
// and a symbol map matching the one the keeper pushed.
function sidecarCosts(db, { side = 'cpp_exec_demo', symbolClass = { 1: 'fx' }, schedule = null } = {}) {
  const sch = schedule || loadRepoSchedule()
  setState(db, `${side}_tick_json`, JSON.stringify({ at: 'x', status: { shadowPortfolio: { sim: { latencyMs: 250, slippage: 0, commissionPerSide: 0, costs: { ...sch, symbolClass } } } } }))
  const map = {}
  try { Object.assign(map, JSON.parse(getState(db, TICK_COST_MAP_KEY) || '{}')) } catch { /* fresh */ }
  map[side] = { at: new Date().toISOString(), hash: scheduleHash(sch), ...sch, symbolClass, unclassified: [] }
  setState(db, TICK_COST_MAP_KEY, JSON.stringify(map))
}
function signal(db, { side = 'cpp_exec_demo', at, profile, symbolId = 1, seq }) {
  db.prepare(`INSERT INTO cpp_decisions (at, side, boot_id, seq, ts_ms, component, kind, symbol_id, code, detail) VALUES (?, ?, 'b1', ?, ?, 'tick', 'signal', ?, 'BUY', ?)`)
    .run(at, side, seq, Date.parse(at + 'Z'), symbolId, `shadow trigger2=1.1 stop=0.002 V=0.5 E=0.7 setup=${seq} profile=${profile}`)
}

// PR-H (11-09-2026): the owner's decision of 11-09-2026 (CLAUDE.md "Owner
// principles", decision on thresholds; plan §4 PR-H). These are THE numbers,
// pinned here so a silent edit of the file is red. replay.minTestNetR is
// gone: replay.minExpectancyLowerR is judged on the same TEST block.
export const OWNER_THRESHOLDS = Object.freeze({
  replay: { minTrades: 40, minProfitFactor: 1.3, maxDrawdownR: 8, minExpectancyLowerR: 0, minTestTrades: 10 },
  shadow: { minSignals: 200, minHours: 48, minTrades: 30, minLosses: 8, minProfitFactor: 1.3, minExpectancyLowerR: 0, maxDrawdownR: 8, maxResetSharePct: 20 },
  traded: { minTrades: 30, minProfitFactor: 1.3, maxDrawdownR: 8 },
})

test('PR-H: the checked-in thresholds file carries the owner\'s exact numbers (a silent edit is red), no stage is thresholds_unset any more, and an injected null still refuses with nothing written', () => {
  const raw = JSON.parse(readFileSync(new URL('../config/tick-validation.json', import.meta.url), 'utf8'))
  for (const g of ['replay', 'shadow', 'traded']) {
    assert.deepEqual(raw[g], OWNER_THRESHOLDS[g], `${g}: the file must carry exactly the owner's thresholds`)
    for (const [k, v] of Object.entries(raw[g])) assert.ok(typeof v === 'number' && Number.isFinite(v), `${g}.${k} is a finite number, not ${v}`)
  }
  assert.equal('minTestNetR' in raw.replay, false, 'the old key is gone (mapped to minExpectancyLowerR on the test block)')
  assert.equal(raw.replay.minTestTrades, 10, 'checker M-3: the test block needs a sample floor (a quarter of minTrades)')
  assert.match(raw._note, /11-09-2026/); assert.match(raw._note, /minExpectancyLowerR REPLACES the former replay\.minTestNetR/)
  const th = loadThresholds()
  assert.deepEqual(th, OWNER_THRESHOLDS, 'the loader reads every value as set (no key silently dropped)')
  assert.deepEqual(Object.keys(th.shadow), ['minSignals', 'minHours', 'minTrades', 'minLosses', 'minProfitFactor', 'minExpectancyLowerR', 'maxDrawdownR', 'maxResetSharePct'], 'P6a: the shadow stage judges the portfolio')
  // no stage answers thresholds_unset with the checked-in file
  const db = fresh()
  const id = trial(db)
  const r = importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: id } })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED' }).reason, 'observation_not_shadow', 'past the threshold gate: refused on evidence, not on thresholds_unset')
  engineModule.writeEngineStatus(db, { ...engineStatusFor(db, DEMO), validationStage: 'SHADOW_PASSED' })
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'TRADED_PASSED' }).reason, 'traded_below_threshold')
  // a null anywhere still refuses that stage and writes nothing (the ask-first rule is intact)
  const db2 = fresh()
  const id2 = trial(db2)
  const un = importTickValidation(db2, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: id2 }, thresholds: { ...OWNER_THRESHOLDS, replay: { ...OWNER_THRESHOLDS.replay, minExpectancyLowerR: null } } })
  assert.equal(un.ok, false); assert.equal(un.reason, 'thresholds_unset'); assert.deepEqual(un.unset, ['replay.minExpectancyLowerR'])
  assert.equal(engineStatusFor(db2, DEMO).configRevision, 0, 'nothing written on a refusal')
  assert.equal(getAccountState(db2, DEMO, ENGINE_STATUS_KEY), null)
  assert.equal(getAccountState(db2, DEMO, TICK_VALIDATION_KEY), null)
})

test('PR-H replay stage against the file\'s exact numbers: 40 trades / PF 1.3 / DD 8R / test-block expectancy lower bound 0 pass at the boundary; one short on each fails; a withheld test block or a pre-PR-H trial with no lower bound cannot pass', () => {
  const th = loadThresholds()
  const db = fresh()
  const pass = trial(db, { trades: 40, profitFactor: 1.3, maxDrawdownR: 8, testLowerR: 0, trialId: 'pass' })
  assert.deepEqual(replayChecks({ sim: CHARGED, summary: { trades: 40, profitFactor: 1.3, maxDrawdownR: 8 }, blocks: [{ name: 'test', trades: 10, expectancyLowerR: 0 }] }, th.replay).failed, [])
  for (const [name, over] of Object.entries({ trades: { trades: 39 }, profitFactor: { profitFactor: 1.29 }, maxDrawdownR: { maxDrawdownR: 8.01 }, expectancyLowerR: { testLowerR: -0.01 } })) {
    const dbx = fresh()
    const id = trial(dbx, { trades: 40, profitFactor: 1.3, maxDrawdownR: 8, testLowerR: 0, ...over, trialId: `fail-${name}` })
    const r = importTickValidation(dbx, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: id } })
    assert.equal(r.ok, false, name); assert.equal(r.reason, 'replay_below_threshold'); assert.deepEqual(r.failed, [name], `${name} alone fails`)
    assert.equal(engineStatusFor(dbx, DEMO).validationStage, 'UNVALIDATED')
  }
  // a research trial (test block withheld) has no out-of-sample figure
  const dbw = fresh()
  const w = trial(dbw, { trades: 40, profitFactor: 1.3, maxDrawdownR: 8, testWithheld: true, trialId: 'withheld' })
  const rw = importTickValidation(dbw, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: w } })
  assert.equal(rw.ok, false); assert.equal(rw.reason, 'test_block_too_small'); assert.deepEqual(rw.failed, ['testTrades', 'expectancyLowerR']); assert.equal(rw.checks.expectancyLowerR.withheld, true); assert.equal(rw.checks.expectancyLowerR.observed, null)
  // a trial written before the replayer carried the figure (test block with netR only) cannot pass on netR
  const dbo = fresh()
  const o = trial(dbo, { trades: 40, profitFactor: 1.3, maxDrawdownR: 8, testNetR: 5, testLowerR: undefined, trialId: 'old' })
  dbo.prepare(`UPDATE tick_trials SET blocks_json = ? WHERE trial_id = ?`).run(JSON.stringify([{ name: 'train', trades: 20, netR: 1 }, { name: 'validation', trades: 10, netR: 1 }, { name: 'test', trades: 10, netR: 5 }]), o)
  const ro = importTickValidation(dbo, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: o } })
  assert.equal(ro.ok, false); assert.deepEqual(ro.failed, ['expectancyLowerR'], 'net R on the test block is not the bar any more')
  // an Infinity / null profit factor (no losing trade) cannot pass a floor
  assert.deepEqual(replayChecks({ sim: CHARGED, summary: { trades: 40, profitFactor: null, maxDrawdownR: 0 }, blocks: [{ name: 'test', trades: 10, expectancyLowerR: 1 }] }, th.replay).failed, ['profitFactor'])
  // a block marked withheld that nonetheless carries a figure (a hand-edited import) is still withheld: the flag wins over the number
  assert.deepEqual(replayChecks({ sim: CHARGED, summary: { trades: 40, profitFactor: 2, maxDrawdownR: 0 }, blocks: [{ name: 'test', trades: 10, withheld: true, expectancyLowerR: 1 }] }, th.replay).failed, ['testTrades', 'expectancyLowerR'])
  // checker M-3: the test block's SAMPLE — blocks are cut by event index, so a two-trade block (bootstrap over two numbers) and a zero-trade block with a pasted figure must not pass; a block with no trade count is refused too
  for (const [name, block] of Object.entries({ twoTrades: { name: 'test', trades: 2, netR: 0.2, expectancyLowerR: 0.1 }, zeroWithFigure: { name: 'test', trades: 0, expectancyLowerR: 0.5 }, nineTrades: { name: 'test', trades: 9, expectancyLowerR: 0.5 }, noCount: { name: 'test', expectancyLowerR: 0.5 }, stringCount: { name: 'test', trades: '12', expectancyLowerR: 0.5 } })) {
    const dbs = fresh()
    const id = trial(dbs, { trialId: `small-${name}` })
    dbs.prepare('UPDATE tick_trials SET blocks_json = ? WHERE trial_id = ?').run(JSON.stringify([{ name: 'train', trades: 30, netR: 1 }, { name: 'validation', trades: 8, netR: 1 }, block]), id)
    const rs = importTickValidation(dbs, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: id } })
    assert.equal(rs.ok, false, name); assert.equal(rs.reason, 'test_block_too_small', name); assert.ok(rs.failed.includes('testTrades'), name)
    assert.equal(engineStatusFor(dbs, DEMO).validationStage, 'UNVALIDATED', name)
  }
  const db10 = fresh()
  const ten = trial(db10, { trialId: 'ten' })
  db10.prepare('UPDATE tick_trials SET blocks_json = ? WHERE trial_id = ?').run(JSON.stringify([{ name: 'train', trades: 20, netR: 1 }, { name: 'validation', trades: 10, netR: 1 }, { name: 'test', trades: 10, netR: 1, expectancyLowerR: 0 }]), ten)
  assert.equal(importTickValidation(db10, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: ten } }).ok, true, 'ten trades at the boundary pass')
  // the boundary trial passes and pins
  const rp = importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: pass } })
  assert.equal(rp.ok, true, JSON.stringify(rp)); assert.equal(engineStatusFor(db, DEMO).validationStage, 'REPLAY_PASSED')
  assert.equal(rp.record.evidence.checks.expectancyLowerR.block, 'test')
  // and the replayer writes the figure the check reads, on every block and the summary
  const sim = simulate(buildFixture(), { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, { latencyMs: 60, minTargetToCost: 1, includeTest: true })
  assert.ok('expectancyLowerR' in sim.summary, 'summary carries expectancyLowerR')
  assert.ok(sim.blocks.every(b => 'expectancyLowerR' in b), 'each unsealed block carries expectancyLowerR')
  assert.equal(simulate(buildFixture(), { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, { latencyMs: 60, minTargetToCost: 1 }).blocks.find(b => b.name === 'test').expectancyLowerR, undefined, 'a withheld test block carries no figure')
})

test('stages move one step at a time, in order; a skip is refused', () => {
  const db = fresh()
  const r = importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(r.ok, false); assert.match(r.reason, /^stage_order/)
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'TRADED_PASSED', thresholds: TH }).ok, false)
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'NOPE', thresholds: TH }).reason, 'unknown_stage: NOPE')
  // PR-B: the environment-tiered stages are gone from the ladder
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'LIVE_APPROVED', evidence: { approval: 'LIVE_APPROVED' }, thresholds: TH }).reason, 'unknown_stage: LIVE_APPROVED')
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'DEMO_PASSED', thresholds: TH }).reason, 'unknown_stage: DEMO_PASSED')
  assert.equal(importTickValidation(db, { accountId: '', stage: 'REPLAY_PASSED', thresholds: TH }).reason, 'no_account')
  assert.equal(engineStatusFor(db, DEMO).configRevision, 0)
})

test('REPLAY_PASSED needs a ledger trial over every threshold; the first pass PINS the full profile hash and records the evidence', () => {
  const db = fresh()
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: 'missing' }, thresholds: TH }).reason, 'trial_not_found')
  const weak = trial(db, { trades: 10, trialId: 'weak' })
  const r1 = importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: weak }, thresholds: TH })
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'replay_below_threshold'); assert.deepEqual(r1.failed, ['trades'])
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'UNVALIDATED')
  const good = trial(db, { trialId: 'good' })
  const r2 = importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: good }, thresholds: TH, now: new Date('2026-09-11T06:00:00Z') })
  assert.equal(r2.ok, true, JSON.stringify(r2))
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.validationStage, 'REPLAY_PASSED')
  assert.equal(st.profileHash, profileHashFull(DEFAULT_PARAMS)); assert.match(st.profileHash, /^[0-9a-f]{64}$/)
  assert.equal(st.profileId, 'tick_momentum_breakout@v1')
  assert.equal(st.configRevision, 1)
  const h = validationHistory(db, DEMO)
  assert.equal(h.length, 1); assert.equal(h[0].stage, 'REPLAY_PASSED'); assert.equal(h[0].from, 'UNVALIDATED'); assert.equal(h[0].evidence.trialId, good); assert.equal(h[0].revision, 1)
  const log = db.prepare(`SELECT body FROM action_log WHERE path = '/actions/tick-validation'`).all()
  assert.equal(log.length, 1); assert.equal(JSON.parse(log[0].body).to, 'REPLAY_PASSED')
})

test('evidence for another profile cannot promote a pinned one (TM-20), and a trial whose stored hash disagrees with its own parameters is refused', () => {
  const db = fresh()
  const good = trial(db, { trialId: 'good' })
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: good }, thresholds: TH }).ok, true)
  // reset, then try to re-pass with a different profile: refused as a mismatch
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'UNVALIDATED', evidence: { reason: 'test' }, thresholds: TH }).ok, true)
  const other = trial(db, { params: { ...DEFAULT_PARAMS, N: 512 }, trialId: 'other' })
  const r = importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: other }, thresholds: TH })
  assert.equal(r.ok, false); assert.equal(r.reason, 'profile_mismatch')
  // a trial lying about its hash
  db.prepare(`UPDATE tick_trials SET profile_hash = 'deadbeefdeadbeef' WHERE trial_id = ?`).run(good)
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: good }, thresholds: TH }).reason, 'trial_hash_mismatch')
})

test('a reset needs a reason and keeps the pin so a re-import must match; UNVALIDATED twice is refused', () => {
  const db = fresh()
  const good = trial(db)
  importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: good }, thresholds: TH })
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'UNVALIDATED', thresholds: TH }).reason, 'reset_needs_reason')
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'UNVALIDATED', evidence: { reason: 'profile changed' }, thresholds: TH }).ok, true)
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'UNVALIDATED')
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'UNVALIDATED', evidence: { reason: 'again' }, thresholds: TH }).reason, 'already_unvalidated')
})

test('SHADOW_PASSED counts only signals rung under the pinned profile on the account\'s side since its SHADOW switch, over the owner\'s minimums', () => {
  const db = fresh()
  const good = trial(db)
  importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: good }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH }).reason, 'observation_not_shadow')
  // signals BEFORE the switch must not count
  const prefix = profileHash(DEFAULT_PARAMS)
  signal(db, { at: '2026-09-10 00:00:00', profile: prefix, seq: 1 })
  requestTickObservation(db, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
  db.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db)
  const r0 = importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(r0.ok, false); assert.equal(r0.reason, 'shadow_below_threshold'); assert.equal(r0.evidence.signals.signals, 0)
  // 25 signals under the profile across 30 h, plus 5 under another profile and 3 on the live side
  for (let i = 0; i < 25; i++) signal(db, { at: `2026-09-11 ${String(Math.floor(i * 1.25)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i, symbolId: 1 + (i % 3) })
  signal(db, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
  for (let i = 0; i < 5; i++) signal(db, { at: '2026-09-11 05:00:00', profile: 'ffffffffffffffff', seq: 50 + i })
  for (let i = 0; i < 3; i++) signal(db, { side: 'cpp_exec', at: '2026-09-11 05:00:00', profile: prefix, seq: 60 + i })
  const ev = shadowSignalEvidence(db, { side: 'cpp_exec_demo', profilePrefix: prefix, sinceIso: '2026-09-11 00:00:00' })
  assert.equal(ev.signals, 26); assert.equal(ev.otherProfile, 5); assert.equal(ev.symbols, 3); assert.ok(ev.hours >= 24, `hours ${ev.hours}`)
  // P6a: signals alone do not pass — the shadow's own portfolio must clear
  // the owner's trade count, profit factor and drawdown
  const rs = importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(rs.ok, false); assert.equal(rs.reason, 'shadow_below_threshold'); assert.deepEqual(rs.failed, ['trades', 'losses', 'profitFactor', 'expectancyLowerR', 'resetSharePct'])
  const T0 = Date.parse('2026-09-11T00:00:00Z')
  // a trade closed BEFORE the switch and one under another profile must not count
  shadowTrade(db, { seq: 1, profile: prefix, netR: 5, exitMs: T0 - 1000 })
  shadowTrade(db, { seq: 2, profile: 'ffffffffffffffff', netR: 5, exitMs: T0 + 1000 })
  for (const [i, r] of [2, -1, 3, -1, 1.5, -1].entries()) shadowTrade(db, { seq: 10 + i, profile: prefix, netR: r, exitMs: T0 + (i + 1) * 3_600_000, reason: r > 0 ? 'target' : 'stop' })
  const r = importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'SHADOW_PASSED')
  assert.equal(r.record.evidence.signals.signals, 26)
  assert.equal(r.record.evidence.portfolio.trades, 6); assert.equal(r.record.evidence.portfolio.netR, 3.5); assert.equal(r.record.evidence.portfolio.losses, 3)
  assert.equal(r.record.evidence.portfolio.profitFactor, +(6.5 / 3).toFixed(3))
  assert.ok(r.record.evidence.provenance && Array.isArray(r.record.evidence.provenance.window.switches), 'the window and its switches are on the record')
  assert.match(r.record.evidence.provenance.costsNote, /per-symbol-class cost schedule [0-9a-f]{16}/)
  // PR-L: the schedule this verdict was earned under is on the record, AND
  // the four cost checks that let it get there are in `checks`.
  assert.match(r.record.evidence.provenance.costSchedule.hash, /^[0-9a-f]{16}$/)
  assert.equal(r.record.evidence.provenance.costSchedule.matchesRepo, true)
  assert.ok(r.record.evidence.provenance.costSensitivity, 'the sensitivity line rides the evidence record')
  for (const k of ['costScheduleKnown', 'costScheduleCharged', 'costScheduleMatchesRepo', 'costSymbolMap', 'costRowsCharged']) {
    assert.equal(r.record.evidence.checks[k].ok, true, `${k} must be a check that PASSED, not a note`)
  }
  assert.equal(r.record.evidence.portfolio.costAudit.charged, 6, 'the verdict rests on six rows the book demonstrably charged')
  assert.equal(r.record.evidence.portfolio.costAudit.preCostModel, 0)
  assert.equal(r.record.evidence.checks.costRowsCharged.ok, true)
  // a book with no losing trade has an UNDEFINED profit factor and cannot pass any floor
  const db3 = fresh(); const g3 = trial(db3)
  importTickValidation(db3, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g3 }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
  requestTickObservation(db3, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
  db3.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db3)
  for (let i = 0; i < 26; i++) signal(db3, { at: `2026-09-11 ${String(Math.floor(i * 0.95)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i })
  signal(db3, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
  for (let i = 0; i < 6; i++) shadowTrade(db3, { seq: 10 + i, profile: prefix, netR: 0.01, exitMs: T0 + (i + 1) * 3_600_000 })
  const nl = importTickValidation(db3, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: { ...TH, shadow: { ...TH.shadow, minProfitFactor: 0.0001, minLosses: 0 } } })
  assert.equal(nl.ok, false); assert.ok(nl.failed.includes('profitFactor')); assert.equal(nl.checks.profitFactor.observed, null)
  // cycling SHADOW → OFF → SHADOW after a losing stretch does NOT re-open the window
  const db4 = fresh(); const g4 = trial(db4)
  importTickValidation(db4, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g4 }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
  requestTickObservation(db4, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
  requestTickObservation(db4, DEMO, 'OFF', { now: new Date('2026-09-11T06:00:00Z') })
  requestTickObservation(db4, DEMO, 'SHADOW', { now: new Date('2026-09-11T07:00:00Z') })
  const rows4 = db4.prepare(`SELECT id FROM action_log WHERE path = '/actions/tick-observation' ORDER BY id`).all()
  for (const [i, at] of ['2026-09-11 00:00:00', '2026-09-11 06:00:00', '2026-09-11 07:00:00'].entries()) db4.prepare('UPDATE action_log SET at = ? WHERE id = ?').run(at, rows4[i].id)
  const wb = importTickValidation(db4, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(wb.ok, false); assert.equal(wb.reason, 'shadow_window_broken'); assert.equal(wb.brokenBy.to, 'OFF'); assert.equal(wb.switches.length, 3)
  // a deep drawdown under the same profile refuses even with enough trades
  const db2 = fresh(); const g2 = trial(db2)
  importTickValidation(db2, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g2 }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
  requestTickObservation(db2, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
  db2.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db2)
  for (let i = 0; i < 26; i++) signal(db2, { at: `2026-09-11 ${String(Math.floor(i * 0.95)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i })
  signal(db2, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
  for (const [i, r] of [4, 4, -1, -1, -1, -1, -1, -1, -1, 6].entries()) shadowTrade(db2, { seq: 10 + i, profile: prefix, netR: r, exitMs: T0 + (i + 1) * 3_600_000 })
  const dd = importTickValidation(db2, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(dd.ok, false); assert.ok(dd.failed.includes('maxDrawdownR')); assert.equal(dd.checks.maxDrawdownR.observed, 7)
})

test('PR-H shadow and traded stages against the file\'s exact numbers: a boundary book passes, one short on the loss count / signal count / trade count fails', () => {
  const prefix = profileHash(DEFAULT_PARAMS)
  const T0 = Date.parse('2026-09-11T00:00:00Z')
  const at = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
  const setup = () => {
    const db = fresh()
    const g = trial(db)
    assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g }, now: new Date('2026-09-10T00:00:00Z') }).ok, true)
    requestTickObservation(db, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
    db.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db)
    return db
  }
  // 200 signals over 50 h (one per 15 min); 30 trades = 7 × [+1, +1, +1, −1] + [+1, +1]: 8 losses, PF 22/8, DD 1R, lower bound > 0, no resets
  const fill = (db, { signals = 200, losses = 8 }) => {
    for (let i = 0; i < signals; i++) signal(db, { at: at(T0 + i * 15 * 60_000), profile: prefix, seq: 1000 + i, symbolId: 1 + (i % 4) })
    const rs = []
    for (let i = 0; i < 30; i++) rs.push(rs.filter(r => r < 0).length < losses && i % 4 === 3 ? -1 : 1)
    while (rs.filter(r => r < 0).length < losses) rs[rs.lastIndexOf(1)] = -1
    for (const [i, r] of rs.entries()) shadowTrade(db, { seq: 10 + i, profile: prefix, netR: r, exitMs: T0 + (i + 1) * 3_600_000, reason: r > 0 ? 'target' : 'stop' })
    return rs
  }
  const db = setup()
  const rs = fill(db, {})
  assert.equal(rs.filter(r => r < 0).length, 8)
  const r = importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED' })
  assert.equal(r.ok, true, JSON.stringify(r))
  const ev = r.record.evidence
  assert.equal(ev.signals.signals, 200); assert.ok(ev.signals.hours >= 48, `hours ${ev.signals.hours}`)
  assert.equal(ev.portfolio.trades, 30); assert.equal(ev.portfolio.losses, 8); assert.equal(ev.portfolio.profitFactor, 2.75); assert.ok(ev.portfolio.expectancyLowerR >= 0); assert.ok(ev.portfolio.maxDrawdownR <= 8); assert.equal(ev.portfolio.resetSharePct, 0)
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'SHADOW_PASSED')
  // one short on the loss count
  const db7 = setup(); fill(db7, { losses: 7 })
  const r7 = importTickValidation(db7, { accountId: DEMO, stage: 'SHADOW_PASSED' })
  assert.equal(r7.ok, false); assert.equal(r7.reason, 'shadow_below_threshold'); assert.deepEqual(r7.failed, ['losses'])
  // one short on the signal count (199 over 49.75 h: hours still pass)
  const db199 = setup(); fill(db199, { signals: 199 })
  const r199 = importTickValidation(db199, { accountId: DEMO, stage: 'SHADOW_PASSED' })
  assert.equal(r199.ok, false); assert.deepEqual(r199.failed, ['signals'])
  assert.equal(engineStatusFor(db199, DEMO).validationStage, 'REPLAY_PASSED', 'nothing written on a refusal')
  // TRADED: 30 own tick closes (20 × +2R, 10 × −1R → PF 4, DD ≤ 2R) pass; 29 fail on the count alone
  const traded = (n) => {
    const dbt = fresh()
    const g = trial(dbt)
    importTickValidation(dbt, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g } })
    engineModule.writeEngineStatus(dbt, { ...engineStatusFor(dbt, DEMO), validationStage: 'SHADOW_PASSED' })
    for (let i = 0; i < n; i++) tickClose(dbt, DEMO, { id: `t${i}`, positionId: 9500 + i, entry: 1.1000, exit: i % 3 === 2 ? 1.0990 : 1.1020, sl: 1.0990, at: `2026-09-11 ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00` })
    return dbt
  }
  const db30 = traded(30)
  const t30 = importTickValidation(db30, { accountId: DEMO, stage: 'TRADED_PASSED' })
  assert.equal(t30.ok, true, JSON.stringify(t30)); assert.equal(t30.record.evidence.traded.trades, 30); assert.equal(t30.record.evidence.traded.profitFactor, 4)
  const db29 = traded(29)
  const t29 = importTickValidation(db29, { accountId: DEMO, stage: 'TRADED_PASSED' })
  assert.equal(t29.ok, false); assert.equal(t29.reason, 'traded_below_threshold'); assert.deepEqual(t29.failed, ['trades'])
  assert.equal(engineStatusFor(db29, DEMO).validationStage, 'SHADOW_PASSED')
})

test('PR-H: an account already in SHADOW when the profile is pinned (the seeded case) has its window opened BY THE PIN — no re-posted switch — at the pin\'s own time; a switch away after it still breaks the window; a refused pin records nothing', () => {
  const prefix = profileHash(DEFAULT_PARAMS)
  const db = fresh()
  // boot seeds SHADOW before any evidence exists
  requestTickObservation(db, DEMO, 'SHADOW', { actor: 'config/tick-observation.json', now: new Date('2026-09-10T00:00:00Z') })
  db.prepare(`UPDATE action_log SET at = '2026-09-10 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db)
  // a refused pin (weak trial) writes no window row
  const weak = trial(db, { trades: 10, trialId: 'weak' })
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: weak } }).ok, false)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE path = '/actions/tick-observation'`).get().n, 1)
  const good = trial(db, { trialId: 'good' })
  const pinAt = new Date('2026-09-11T00:00:00.700Z')
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: good }, now: pinAt }).ok, true)
  const rows = db.prepare(`SELECT at, body FROM action_log WHERE path = '/actions/tick-observation' AND account_id = ? ORDER BY id`).all(DEMO)
  assert.equal(rows.length, 2, 'RED if the pin does not record the window opening')
  const opened = JSON.parse(rows[1].body)
  assert.equal(opened.actor, 'tick-validation:pin'); assert.equal(opened.to, 'SHADOW'); assert.equal(rows[1].at, '2026-09-11 00:00:00', 'the pin\'s own time, seconds resolution')
  const win = shadowWindow(db, DEMO, pinAt.toISOString())
  assert.equal(win.since, '2026-09-11 00:00:00', 'the window opens at the pin even though the pin carries milliseconds and the row does not'); assert.equal(win.broken, false)
  // evidence since the pin passes without any operator re-post
  const T0 = Date.parse('2026-09-11T00:00:00Z')
  for (let i = 0; i < 26; i++) signal(db, { at: `2026-09-11 ${String(Math.floor(i * 0.95)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i })
  signal(db, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
  for (const [i, r] of [2, -1, 3, -1, 1.5, -1].entries()) shadowTrade(db, { seq: 10 + i, profile: prefix, netR: r, exitMs: T0 + (i + 1) * 3_600_000, reason: r > 0 ? 'target' : 'stop' })
  const r = importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.record.evidence.since, '2026-09-11 00:00:00')
  // the same seeded account, but switched OFF after the pin: the window is broken, not re-openable
  const db2 = fresh()
  requestTickObservation(db2, DEMO, 'SHADOW', { now: new Date('2026-09-10T00:00:00Z') })
  db2.prepare(`UPDATE action_log SET at = '2026-09-10 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db2)
  const g2 = trial(db2)
  importTickValidation(db2, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g2 }, now: pinAt })
  requestTickObservation(db2, DEMO, 'OFF', { now: new Date('2026-09-11T06:00:00Z') })
  db2.prepare(`UPDATE action_log SET at = '2026-09-11 06:00:00' WHERE path = '/actions/tick-observation' AND id = (SELECT MAX(id) FROM action_log WHERE path = '/actions/tick-observation')`).run()
  requestTickObservation(db2, DEMO, 'SHADOW', { now: new Date('2026-09-11T07:00:00Z') })
  db2.prepare(`UPDATE action_log SET at = '2026-09-11 07:00:00' WHERE path = '/actions/tick-observation' AND id = (SELECT MAX(id) FROM action_log WHERE path = '/actions/tick-observation')`).run()
  const wb = importTickValidation(db2, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(wb.ok, false); assert.equal(wb.reason, 'shadow_window_broken'); assert.equal(wb.brokenBy.to, 'OFF')
  // checker m-1: a switch away in the SAME SECOND as the opening row is still a break (ordered by action_log.id, not by the seconds-resolution `at`)
  const db5 = fresh()
  requestTickObservation(db5, DEMO, 'SHADOW', { now: new Date('2026-09-10T00:00:00Z') })
  db5.prepare(`UPDATE action_log SET at = '2026-09-10 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db5)
  const g5 = trial(db5)
  const pin5 = new Date('2026-09-11T00:00:00.100Z')
  assert.equal(importTickValidation(db5, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g5 }, now: pin5 }).ok, true)
  requestTickObservation(db5, DEMO, 'OFF', { now: pin5 })
  db5.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE id = (SELECT MAX(id) FROM action_log WHERE path = '/actions/tick-observation')`).run()
  const w5 = shadowWindow(db5, DEMO, pin5.toISOString())
  assert.equal(w5.since, '2026-09-11 00:00:00'); assert.equal(w5.broken, true, 'RED if the same-second OFF is invisible'); assert.equal(w5.brokenBy.to, 'OFF')
  // an account NOT in SHADOW at the pin gets no row (the window opens at its later switch, as before)
  const db3 = fresh()
  const g3 = trial(db3)
  importTickValidation(db3, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g3 }, now: pinAt })
  assert.equal(db3.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE path = '/actions/tick-observation'`).get().n, 0)
})

// PR-B (owner principle 1): the traded stage is ONE stage for every account,
// judged on the account's own closed tick trades in R. Lineage via the entry
// ledger, so a time-based close on the same account is not tick evidence.
function tickClose(db, accountId, { id, positionId, entry, exit, sl, side = 'BUY', producer = 'tick_momentum', at = '2026-09-11 01:00:00' }) {
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, order_type, volume, producer_id, basis, mode_epoch, config_revision, permit_id, permit_expires_at, state, broker_position_id, created_at, updated_at)
              VALUES (?, ?, 'demo', 'EURUSD', 1, ?, 'MARKET', 1000, ?, 'tick', 1, 1, ?, ?, 'FILLED', ?, ?, ?)`).run(id, accountId, side, producer, `p-${id}`, at, String(positionId), at, at)
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, volume, status, opened_at, closed_at, net_pnl, account_id, ctrader_position_id)
              VALUES ('EURUSD', ?, ?, ?, ?, 0.01, 'closed', ?, ?, ?, ?, ?)`).run(side, entry, exit, sl, at, at, (exit - entry) * (side === 'BUY' ? 1 : -1) * 1000, accountId, String(positionId))
}

test('TRADED_PASSED: thresholds_unset on an injected null; otherwise judged on the account\'s OWN closed tick trades in R, the same on a live account (no environment test), and non-tick closes do not count', () => {
  const db = fresh()
  const good = trial(db)
  const { writeEngineStatus } = engineModule
  for (const id of [DEMO, LIVE]) {
    importTickValidation(db, { accountId: id, stage: 'REPLAY_PASSED', evidence: { trialId: good }, thresholds: TH })
    // force the stage forward without the shadow evidence
    writeEngineStatus(db, { ...engineStatusFor(db, id), validationStage: 'SHADOW_PASSED' })
  }
  const unset = importTickValidation(db, { accountId: DEMO, stage: 'TRADED_PASSED', thresholds: { ...TH, traded: { minTrades: null, minProfitFactor: null, maxDrawdownR: null } } })
  assert.equal(unset.ok, false); assert.equal(unset.reason, 'thresholds_unset'); assert.deepEqual(unset.unset, ['traded.minTrades', 'traded.minProfitFactor', 'traded.maxDrawdownR'])
  // the checked-in file (PR-H): the traded thresholds are set; the demo key is gone
  const file = loadThresholds()
  assert.deepEqual(file.traded, { minTrades: 30, minProfitFactor: 1.3, maxDrawdownR: 8 })
  assert.equal('demo' in file, false, 'the demo key is gone from the thresholds')
  // no trades yet → below threshold, nothing written
  const none = importTickValidation(db, { accountId: DEMO, stage: 'TRADED_PASSED', thresholds: TH })
  assert.equal(none.ok, false); assert.equal(none.reason, 'traded_below_threshold'); assert.deepEqual(none.failed, ['trades', 'profitFactor'])
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'SHADOW_PASSED')
  // three tick closes on the LIVE account: +2R, +2R, −1R → PF 4, DD 1R; and a
  // time-based close on the same account that must NOT be counted
  tickClose(db, LIVE, { id: 'l1', positionId: 9001, entry: 1.1000, exit: 1.1020, sl: 1.0990 })
  tickClose(db, LIVE, { id: 'l2', positionId: 9002, entry: 1.1000, exit: 1.1020, sl: 1.0990 })
  tickClose(db, LIVE, { id: 'l3', positionId: 9003, entry: 1.1000, exit: 1.0990, sl: 1.0990 })
  tickClose(db, LIVE, { id: 'l4', positionId: 9004, entry: 1.1000, exit: 1.1100, sl: 1.0990, producer: 'scan_dispatch' })
  const ev = tradedTickEvidence(db, LIVE)
  assert.equal(ev.trades, 3); assert.equal(ev.losses, 1); assert.equal(ev.profitFactor, 4); assert.equal(ev.maxDrawdownR, 1); assert.equal(ev.netR, 3)
  const live = importTickValidation(db, { accountId: LIVE, stage: 'TRADED_PASSED', thresholds: TH })
  assert.equal(live.ok, true, JSON.stringify(live))
  assert.equal(engineStatusFor(db, LIVE).validationStage, 'TRADED_PASSED')
  assert.equal(live.record.evidence.traded.trades, 3)
  assert.doesNotMatch(JSON.stringify(live), /not_a_demo_account|LIVE_APPROVED|approval/)
  // the demo account with the same evidence reaches the same stage the same way
  tickClose(db, DEMO, { id: 'd1', positionId: 9101, entry: 1.1000, exit: 1.1020, sl: 1.0990 })
  tickClose(db, DEMO, { id: 'd2', positionId: 9102, entry: 1.1000, exit: 1.1020, sl: 1.0990 })
  tickClose(db, DEMO, { id: 'd3', positionId: 9103, entry: 1.1000, exit: 1.0990, sl: 1.0990 })
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'TRADED_PASSED', thresholds: TH }).ok, true)
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'TRADED_PASSED')
  // nothing above it
  assert.match(importTickValidation(db, { accountId: DEMO, stage: 'TRADED_PASSED', thresholds: TH }).reason, /^stage_order/)
})

test('PR-B: a record stored with the old environment-tiered stages reads as TRADED_PASSED, and the next write stores the new name', () => {
  const db = fresh()
  const { ENGINE_STATUS_KEY: key } = engineModule
  for (const legacy of ['DEMO_PASSED', 'LIVE_APPROVED']) {
    const base = { ...engineStatusFor(db, DEMO), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: legacy, configRevision: 3, updatedAt: '2026-09-10T00:00:00.000Z' }
    delete base.stored
    setAccountState(db, DEMO, key, JSON.stringify(base))
    const st = engineStatusFor(db, DEMO)
    assert.equal(st.validationStage, 'TRADED_PASSED', `${legacy} reads as TRADED_PASSED`)
    assert.equal(st.invalid, undefined, 'the normalised record is valid')
    assert.match(getAccountState(db, DEMO, key), new RegExp(legacy), 'a read never writes')
    engineModule.writeEngineStatus(db, { ...st, configRevision: 4 })
    assert.doesNotMatch(getAccountState(db, DEMO, key), new RegExp(legacy))
  }
})
import * as engineModule from './entry-mode.js'

test('the importer never reads strategy pins, the evidence gate or a bar-strategy record (TM-20), and the routes reach it', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('./tick-validation.js', import.meta.url), 'utf8'))
  for (const forbidden of ['stage-matrix', 'evidence-gate', 'strategy_stage', 'strategy-pins', 'earned-floor', 'account-analytics']) {
    assert.equal(src.includes(forbidden), false, `tick-validation.js must not touch ${forbidden}`)
  }
  const actions = strip(readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8'))
  assert.match(actions, /router\.post\('\/tick-validation'/)
  assert.match(actions, /importTickValidation\(db, \{/)
  const state = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(state, /router\.get\('\/tick-readiness'/)
  assert.match(state, /router\.get\('\/tick-signals'/)
  assert.match(state, /tickReadinessView\(db,\s*\{\s*includeRoutingIdentity:\s*true\s*\}\)/)
  assert.match(state, /tickSignalsView\(db/)
})

// PR-L (docs/plan-execution-audit-2026-09-11.md §16): every SHADOW_PASSED
// record must carry the COST SCHEDULE that produced it, so a verdict earned
// under one cost model can never be read as if it were earned under another.
test('PR-L: a SHADOW_PASSED record carries the cost schedule the sidecar ran, hashed, with the repo\'s hash beside it', () => {
  const db = fresh()
  const good = trial(db)
  const prefix = profileHash(DEFAULT_PARAMS)
  importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: good }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
  requestTickObservation(db, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
  db.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db)
  for (let i = 0; i < 26; i++) signal(db, { at: `2026-09-11 ${String(Math.floor(i * 0.95)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i })
  signal(db, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
  const T0 = Date.parse('2026-09-11T00:00:00Z')
  for (const [i, r] of [2, -1, 3, -1, 1.5, -1].entries()) shadowTrade(db, { seq: 10 + i, profile: prefix, netR: r, exitMs: T0 + (i + 1) * 3_600_000, reason: r > 0 ? 'target' : 'stop' })

  // the sidecar reports the schedule its books run at, inside the sim — and
  // the keeper's pushed map must AGREE with it (a stale map hashes identically)
  const repo = loadRepoSchedule()
  sidecarCosts(db, { symbolClass: { 1: 'fx', 2: 'stock_us' } })
  const r = importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(r.ok, true, JSON.stringify(r))
  const cs = r.record.evidence.provenance.costSchedule
  assert.equal(cs.source, 'sidecar_reported_sim')
  assert.equal(cs.hash, scheduleHash(repo))
  assert.equal(cs.repoHash, scheduleHash(repo))
  assert.equal(cs.matchesRepo, true, 'the sidecar is running the repo\'s schedule')
  assert.equal(cs.symbolsPriced, 2)
  assert.equal(cs.fallbackClass, 'stock_hk')
  assert.equal(cs.classes.stock_hk.commissionBpsPerSide, 15)
  assert.match(r.record.evidence.provenance.costsNote, /per-symbol-class cost schedule [0-9a-f]{16}/)

  // a sidecar running a DIFFERENT schedule is caught, not averaged in
  const db2 = fresh()
  const g2 = trial(db2)
  importTickValidation(db2, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g2 }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
  requestTickObservation(db2, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
  db2.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
  sidecarCosts(db2)
  for (let i = 0; i < 26; i++) signal(db2, { at: `2026-09-11 ${String(Math.floor(i * 0.95)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i })
  signal(db2, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
  for (const [i, x] of [2, -1, 3, -1, 1.5, -1].entries()) shadowTrade(db2, { seq: 10 + i, profile: prefix, netR: x, exitMs: T0 + (i + 1) * 3_600_000, reason: x > 0 ? 'target' : 'stop' })
  const drifted = { fallbackClass: 'fx', classes: { fx: { commissionBpsPerSide: 0.01, slippageBpsPerSide: 0 } } }
  sidecarCosts(db2, { schedule: drifted })
  // CHECKER BLOCKER 1: a sidecar running a schedule that is NOT the repo's
  // must not promote the account. Before this it did — the note said
  // "DIFFERS" and the very next assertion was that the stage moved anyway.
  const r2 = importTickValidation(db2, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(r2.ok, false, JSON.stringify(r2.checks))
  assert.equal(r2.reason, 'shadow_cost_model_unproven')
  assert.deepEqual(r2.costFailed, ['costScheduleMatchesRepo', 'costRowsCharged'],
    'the rows were charged the repo schedule, so a drifted one also fails the per-row check')
  assert.equal(r2.checks.costScheduleMatchesRepo.observed, false)
  assert.notEqual(r2.checks.costScheduleMatchesRepo.sidecar, scheduleHash(repo))
  assert.equal(engineStatusFor(db2, DEMO).validationStage, 'REPLAY_PASSED', 'nothing moved')
})

// CHECKER BLOCKER 1, the four refusals in full. Each is its own named check,
// so a verdict that cannot be shown to rest on charged costs cannot arm
// anything — the schedule stands BETWEEN the evidence and the stage, it is
// not merely recorded beside it.
test('PR-L: SHADOW_PASSED refuses when the cost model cannot be proved — unknown, uncharged, drifted, unmapped, or built on pre-PR-L rows', () => {
  const prefix = profileHash(DEFAULT_PARAMS)
  const T0 = Date.parse('2026-09-11T00:00:00Z')
  const build = ({ costClass = 'fx' } = {}) => {
    const db = fresh()
    const g = trial(db)
    importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
    requestTickObservation(db, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
    db.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
    for (let i = 0; i < 26; i++) signal(db, { at: `2026-09-11 ${String(Math.floor(i * 0.95)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i })
    signal(db, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
    for (const [i, x] of [2, -1, 3, -1, 1.5, -1].entries()) shadowTrade(db, { seq: 10 + i, profile: prefix, netR: x, exitMs: T0 + (i + 1) * 3_600_000, reason: x > 0 ? 'target' : 'stop', costClass })
    return db
  }
  const go = (db) => importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })

  // 1. the sidecar reports no sim at all — the repo's schedule is NEVER
  //    stamped on a verdict the sidecar may not have earned under it
  const dbA = build()
  const rA = go(dbA)
  assert.equal(rA.ok, false); assert.equal(rA.reason, 'shadow_cost_model_unproven')
  assert.deepEqual(rA.costFailed, ['costScheduleKnown', 'costScheduleCharged', 'costScheduleMatchesRepo', 'costSymbolMap', 'costRowsCharged'])
  assert.equal(rA.checks.costScheduleKnown.observed, 'sidecar_sim_unavailable')
  assert.equal(engineStatusFor(dbA, DEMO).validationStage, 'REPLAY_PASSED')

  // 2. the sidecar reports a sim with an ALL-ZERO schedule — spread-only
  const dbB = build()
  sidecarCosts(dbB, { schedule: { fallbackClass: 'fx', classes: { fx: { commissionWirePerSide: 0, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0 } } } })
  const rB = go(dbB)
  assert.equal(rB.ok, false); assert.ok(rB.costFailed.includes('costScheduleCharged'))

  // 3. the schedule is right but it PRICES NO SYMBOL (checker BLOCKER 2: an
  //    empty map makes every book charge the fallback and record nothing)
  const dbC = build()
  sidecarCosts(dbC, { symbolClass: {} })
  const rC = go(dbC)
  assert.equal(rC.ok, false); assert.deepEqual(rC.costFailed, ['costSymbolMap'])
  assert.equal(rC.checks.costSymbolMap.observed, 0)

  // 4. the sidecar's map is STALE — it does not match what the keeper pushed.
  //    The schedule hash is identical (the map is not in the hash), so only
  //    this check catches it.
  //    The map has the SAME NUMBER of symbols — only the CLASS of one of them
  //    differs — so neither the hash nor a count can see it. Charging an FX
  //    pair as a 15-bps HK stock is a 43x cost error on that symbol.
  const dbD = build()
  sidecarCosts(dbD, { symbolClass: { 1: 'fx', 2: 'index_cfd' } })
  const stale = JSON.parse(getState(dbD, TICK_COST_MAP_KEY))
  stale.cpp_exec_demo.symbolClass = { 1: 'stock_hk', 2: 'index_cfd' }
  setState(dbD, TICK_COST_MAP_KEY, JSON.stringify(stale))
  const rD = go(dbD)
  assert.equal(rD.ok, false); assert.deepEqual(rD.costFailed, ['costSymbolMap'])
  assert.equal(rD.checks.costSymbolMap.agrees, false)
  assert.equal(rD.checks.costSymbolMap.observed, 2, 'the sidecar prices two symbols…')
  assert.equal(rD.checks.costSymbolMap.pushed, 2, '…and the keeper pushed two: a count cannot see this')
  assert.equal(rD.checks.costScheduleMatchesRepo.ok, true, 'and neither can the hash — the map is not part of it')
  // the same map, in agreement, passes — so the refusal is the drift and
  // nothing else
  const dbD2 = build()
  sidecarCosts(dbD2, { symbolClass: { 1: 'fx', 2: 'index_cfd' } })
  assert.equal(go(dbD2).ok, true)

  // 5. THE SCENARIO THAT ARMED REAL MONEY: everything about the schedule is
  //    right, but the trades are pre-PR-L rows with no cost class. They were
  //    closed spread-only and must not reach the bar.
  const dbE = build({ costClass: null })
  sidecarCosts(dbE)
  const rE = go(dbE)
  assert.equal(rE.ok, false)
  assert.equal(rE.reason, 'shadow_cost_model_unproven')
  assert.deepEqual(rE.costFailed, ['costRowsCharged'], 'the schedule is proved; the ROWS were never charged it')
  assert.equal(rE.checks.trades.observed, 0, 'six pre-cost-model rows count as zero charged trades')
  assert.equal(rE.checks.costRowsCharged.observed, 0)
  assert.equal(rE.checks.costRowsCharged.preCostModel, 6)
  assert.deepEqual(rE.checks.costRowsCharged.refused, { no_cost_class: 6 })
  assert.equal(engineStatusFor(dbE, DEMO).validationStage, 'REPLAY_PASSED')

  // …and the same book WITH a cost class passes, so the refusal is the cost
  // model and nothing else
  const dbF = build()
  sidecarCosts(dbF)
  assert.equal(go(dbF).ok, true)
})

// ROUND-TWO CHECKER, BLOCKER 1 + 2, verbatim. Six rows carrying
// `cost_class: 'fx'` and FOUR ZERO COST TERMS, with the sidecar echoing the
// real repo schedule and a matching symbol map, passed all four /health
// checks and reached SHADOW_PASSED. The checks proved what the sidecar SAID;
// nothing reached back to what any book had SUBTRACTED.
//
// It is not an adversarial case: main.cpp applies a pushed sim to NEW BOOKS
// only, so for the whole window after any push /health declares the new
// schedule while books opened earlier keep closing under the old one.
test('PR-L: a row that CLAIMS a class but was charged nothing cannot pass, however honest the sidecar\'s declaration', () => {
  const prefix = profileHash(DEFAULT_PARAMS)
  const T0 = Date.parse('2026-09-11T00:00:00Z')
  const fx = loadRepoSchedule().classes.fx
  const build = (terms) => {
    const db = fresh()
    const g = trial(db)
    importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
    requestTickObservation(db, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
    db.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
    for (let i = 0; i < 26; i++) signal(db, { at: `2026-09-11 ${String(Math.floor(i * 0.95)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i })
    signal(db, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
    for (const [i, x] of [2, -1, 3, -1, 1.5, -1].entries()) {
      db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, reason, net_r, gross_r, exit_ms, cost_class, commission_wire, commission_bps, slippage_wire, slippage_bps)
                  VALUES ('cpp_exec_demo', 'b1', ?, 1, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(10 + i, prefix, x > 0 ? 'target' : 'stop', x, x, T0 + (i + 1) * 3_600_000,
             terms.cost_class, terms.commission_wire, terms.commission_bps, terms.slippage_wire, terms.slippage_bps)
    }
    sidecarCosts(db)   // the sidecar honestly declares the repo schedule
    return db
  }
  const go = (db) => importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })

  // THE CASE THE CHECKER VERIFIED: the class is real, the terms are zero.
  const zeroTerms = build({ cost_class: 'fx', commission_wire: 0, commission_bps: 0, slippage_wire: 0, slippage_bps: 0 })
  const rz = go(zeroTerms)
  assert.equal(rz.ok, false, 'a row charged nothing is not evidence for a schedule')
  assert.equal(rz.reason, 'shadow_cost_model_unproven')
  assert.deepEqual(rz.costFailed, ['costRowsCharged'])
  // the four declaration checks all still pass — which is the point: they
  // never could have caught this, and the fifth is what does
  for (const k of ['costScheduleKnown', 'costScheduleCharged', 'costScheduleMatchesRepo', 'costSymbolMap']) {
    assert.equal(rz.checks[k].ok, true, `${k} proves the sidecar's declaration, not the rows`)
  }
  assert.deepEqual(rz.checks.costRowsCharged.refused, { cost_terms_differ: 6 })
  assert.equal(engineStatusFor(zeroTerms, DEMO).validationStage, 'REPLAY_PASSED', 'nothing armed')

  // a class string that is not a class this repo prices
  const bogus = build({ cost_class: 'not_a_class', commission_wire: 0, commission_bps: 0.35, slippage_wire: 0, slippage_bps: 0.5 })
  assert.deepEqual(go(bogus).checks.costRowsCharged.refused, { unknown_cost_class: 6 })
  // …and a single space, which passed both the SQL `<> ''` and the predicate
  const blank = build({ cost_class: ' ', commission_wire: 0, commission_bps: 0.35, slippage_wire: 0, slippage_bps: 0.5 })
  assert.deepEqual(go(blank).checks.costRowsCharged.refused, { no_cost_class: 6 })

  // THE NON-ADVERSARIAL CASE: books opened under the PREVIOUS schedule keep
  // closing after a push. Their rows carry the old terms; they fall out of
  // the evidence instead of being counted under a model they never paid.
  const oldSchedule = build({ cost_class: 'fx', commission_wire: 0, commission_bps: 0.2, slippage_wire: 0, slippage_bps: 0.5 })
  const ro = go(oldSchedule)
  assert.equal(ro.ok, false)
  assert.deepEqual(ro.checks.costRowsCharged.refused, { cost_terms_differ: 6 })

  // and the SAME book with the schedule's own terms, actually spent, passes
  const real = build({ cost_class: 'fx', commission_wire: fx.commissionWirePerSide, commission_bps: fx.commissionBpsPerSide, slippage_wire: fx.slippageWirePerSide, slippage_bps: fx.slippageBpsPerSide })
  assert.equal(go(real).ok, true, 'so the refusal is the cost model and nothing else')
})

// CHECKER, on §16.7: both rungs were free. The replay rung now refuses a
// trial replayed at zero cost instead of passing it silently.
test('PR-L: REPLAY_PASSED refuses a trial replayed at ZERO cost, or one charged the fallback because its symbol was never classified', () => {
  const db = fresh()
  const zero = trial(db, { uncharged: true, trialId: 'zero-cost' })
  const r = importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: zero }, thresholds: TH })
  assert.equal(r.ok, false); assert.equal(r.reason, 'replay_below_threshold')
  assert.deepEqual(r.failed, ['costModel'])
  assert.equal(r.checks.costModel.observed, 'unrecorded')
  assert.equal(r.checks.costModel.charged, false)
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'UNVALIDATED', 'nothing pinned')
  // a trial whose symbol never classified was charged the schedule's FALLBACK,
  // not its own class — that is not evidence for the instrument it replayed
  const summary = { trades: 40, profitFactor: 1.6, maxDrawdownR: 4 }
  const blocks = [{ name: 'test', trades: 10, expectancyLowerR: 0.2 }]
  const fb = replayChecks({ sim: { ...CHARGED, costSource: 'fallback_unclassified' }, summary, blocks }, TH.replay)
  assert.deepEqual(fb.failed, ['costModel'])

  // ROUND-TWO CHECKER, MAJOR 2: the rung must pin to the REPO schedule, not
  // merely to "some cost > 0". A trial's sim arrives from outside — body.sim
  // wins over the repo default, and POST /actions/tick-trials imports JSON
  // produced off-box — so a homeopathic figure used to clear it.
  for (const bps of [1e-12, 1e-9, 0.0001, 0.34]) {
    const tiny = replayChecks({ sim: { ...CHARGED, commissionBpsPerSide: bps }, summary, blocks }, TH.replay)
    assert.deepEqual(tiny.failed, ['costModel'], `${bps} bps must not clear the rung`)
    assert.equal(tiny.checks.costModel.charged, true, 'it IS charged something — that was the whole hole')
    assert.equal(tiny.checks.costModel.schedule, 'cost_terms_differ', 'but it is not this repo\'s schedule')
  }
  // a class this repo does not price, and a class absent from the schedule
  assert.deepEqual(replayChecks({ sim: { ...CHARGED, costClass: 'not_a_class' }, summary, blocks }, TH.replay).failed, ['costModel'])
  // the repo's own fx row clears it, and the check names the hash it pinned to
  const good = replayChecks({ sim: CHARGED, summary, blocks }, TH.replay)
  assert.deepEqual(good.failed, [])
  assert.equal(good.checks.costModel.schedule, 'repo')
  assert.equal(good.checks.costModel.repoHash, scheduleHash(loadRepoSchedule()))
  // and every OTHER priced class clears it too, on its own numbers
  for (const [cls, row] of Object.entries(loadRepoSchedule().classes)) {
    const r2 = replayChecks({ sim: { latencyMs: 250, costSource: 'class', costClass: cls, ...row }, summary, blocks }, TH.replay)
    assert.deepEqual(r2.failed, [], `${cls} charged at its own schedule row must pass`)
  }
  // and a charged, classified trial passes
  const ok = trial(db, { trialId: 'charged' })
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: ok }, thresholds: TH }).ok, true)
})
