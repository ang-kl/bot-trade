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

import { initDB } from '../db.js'
import { upsertAccount, getAccountState } from './account-registry.js'
import { engineStatusFor, requestTickObservation, ENGINE_STATUS_KEY } from './entry-mode.js'
import { importTickTrial } from './tick-research.js'
import { DEFAULT_PARAMS, profileHash, profileHashFull, normalizeParams } from '../lib/tick-strategy.js'
import { importTickValidation, loadThresholds, validationHistory, shadowSignalEvidence, TICK_VALIDATION_KEY } from './tick-validation.js'

const DEMO = '46979908', LIVE = '42993489'
const TH = { replay: { minTrades: 30, minProfitFactor: 1.3, minTestNetR: 0, maxDrawdownR: 10 }, shadow: { minSignals: 20, minHours: 24, minTrades: 5, minLosses: 2, minProfitFactor: 1.2, minExpectancyLowerR: -1, maxDrawdownR: 6, maxResetSharePct: 20 }, demo: { minClosedTrades: 30, minProfitFactor: 1.2, maxDrawdownR: 10 } }

function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  upsertAccount(db, { accountId: LIVE, isLive: true })
  return db
}
function trial(db, { params = DEFAULT_PARAMS, trades = 40, profitFactor = 1.6, testNetR = 3, maxDrawdownR = 4, trialId = null } = {}) {
  const t = {
    trialId, strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: profileHash(params), params: normalizeParams(params),
    sim: { latencyMs: 250 }, manifest: { segments: 1 }, summary: { trades, profitFactor, maxDrawdownR, netR: testNetR + 2 },
    blocks: [{ name: 'train', trades: 20, netR: 1 }, { name: 'validation', trades: 10, netR: 1 }, { name: 'test', trades: 10, netR: testNetR }],
  }
  const r = importTickTrial(db, t)
  assert.equal(r.ok, true)
  return r.trialId
}
function shadowTrade(db, { side = 'cpp_exec_demo', seq, profile, netR, exitMs, reason = 'target', symbolId = 1 }) {
  db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, reason, net_r, gross_r, exit_ms) VALUES (?, 'b1', ?, ?, ?, 'BUY', ?, ?, ?, ?)`)
    .run(side, seq, symbolId, profile, reason, netR, netR, exitMs)
}
function signal(db, { side = 'cpp_exec_demo', at, profile, symbolId = 1, seq }) {
  db.prepare(`INSERT INTO cpp_decisions (at, side, boot_id, seq, ts_ms, component, kind, symbol_id, code, detail) VALUES (?, ?, 'b1', ?, ?, 'tick', 'signal', ?, 'BUY', ?)`)
    .run(at, side, seq, Date.parse(at + 'Z'), symbolId, `shadow trigger2=1.1 stop=0.002 V=0.5 E=0.7 setup=${seq} profile=${profile}`)
}

test('the checked-in thresholds file leaves every threshold unset, and an unset threshold refuses the import with nothing written', () => {
  const th = loadThresholds()
  for (const g of ['replay', 'shadow', 'demo']) for (const [k, v] of Object.entries(th[g])) assert.equal(v, null, `${g}.${k} must be null in the checked-in file (owner-held risk limit)`)
  assert.deepEqual(Object.keys(th.shadow), ['minSignals', 'minHours', 'minTrades', 'minLosses', 'minProfitFactor', 'minExpectancyLowerR', 'maxDrawdownR', 'maxResetSharePct'], 'P6a: the shadow stage judges the portfolio')
  const db = fresh()
  const id = trial(db)
  const r = importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: id }, thresholds: th })
  assert.equal(r.ok, false); assert.equal(r.reason, 'thresholds_unset')
  assert.ok(r.unset.includes('replay.minTrades'))
  assert.equal(engineStatusFor(db, DEMO).configRevision, 0, 'nothing written on a refusal')
  assert.equal(getAccountState(db, DEMO, ENGINE_STATUS_KEY), null)
  assert.equal(getAccountState(db, DEMO, TICK_VALIDATION_KEY), null)
})

test('stages move one step at a time, in order; a skip is refused', () => {
  const db = fresh()
  const r = importTickValidation(db, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(r.ok, false); assert.match(r.reason, /^stage_order/)
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'LIVE_APPROVED', evidence: { approval: 'LIVE_APPROVED' }, thresholds: TH }).ok, false)
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'NOPE', thresholds: TH }).reason, 'unknown_stage: NOPE')
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
  assert.match(r.record.evidence.provenance.costsNote, /spread-only/)
  // a book with no losing trade has an UNDEFINED profit factor and cannot pass any floor
  const db3 = fresh(); const g3 = trial(db3)
  importTickValidation(db3, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: g3 }, thresholds: TH, now: new Date('2026-09-10T00:00:00Z') })
  requestTickObservation(db3, DEMO, 'SHADOW', { now: new Date('2026-09-11T00:00:00Z') })
  db3.prepare(`UPDATE action_log SET at = '2026-09-11 00:00:00' WHERE path = '/actions/tick-observation'`).run()
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
  for (let i = 0; i < 26; i++) signal(db2, { at: `2026-09-11 ${String(Math.floor(i * 0.95)).padStart(2, '0')}:00:00`, profile: prefix, seq: 10 + i })
  signal(db2, { at: '2026-09-12 07:00:00', profile: prefix, seq: 40 })
  for (const [i, r] of [4, 4, -1, -1, -1, -1, -1, -1, -1, 6].entries()) shadowTrade(db2, { seq: 10 + i, profile: prefix, netR: r, exitMs: T0 + (i + 1) * 3_600_000 })
  const dd = importTickValidation(db2, { accountId: DEMO, stage: 'SHADOW_PASSED', thresholds: TH })
  assert.equal(dd.ok, false); assert.ok(dd.failed.includes('maxDrawdownR')); assert.equal(dd.checks.maxDrawdownR.observed, 7)
})

test('DEMO_PASSED is refused honestly until P6 produces tick trades; LIVE_APPROVED needs the owner\'s typed word and a demo account cannot skip to it', () => {
  const db = fresh()
  const good = trial(db)
  importTickValidation(db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: good }, thresholds: TH })
  requestTickObservation(db, DEMO, 'SHADOW')
  // force the stage forward for the DEMO_PASSED check without the shadow evidence
  const { writeEngineStatus } = engineModule
  writeEngineStatus(db, { ...engineStatusFor(db, DEMO), validationStage: 'SHADOW_PASSED' })
  const r = importTickValidation(db, { accountId: DEMO, stage: 'DEMO_PASSED', evidence: { closedTrades: 50, profitFactor: 2, maxDrawdownR: 3 }, thresholds: TH })
  assert.equal(r.ok, false); assert.match(r.reason, /^demo_evidence_not_produced/)
  assert.equal(importTickValidation(db, { accountId: LIVE, stage: 'DEMO_PASSED', thresholds: TH }).ok, false)
  writeEngineStatus(db, { ...engineStatusFor(db, DEMO), validationStage: 'DEMO_PASSED' })
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'LIVE_APPROVED', thresholds: TH }).reason, 'approval_word_required')
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'LIVE_APPROVED', evidence: { approval: 'LIVE_APPROVED' }, actor: 'autopilot', thresholds: TH }).reason, 'owner_only')
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'LIVE_APPROVED', evidence: { approval: 'LIVE_APPROVED' }, thresholds: TH }).ok, true)
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'LIVE_APPROVED')
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
  assert.match(state, /tickReadinessView\(db\)/)
  assert.match(state, /tickSignalsView\(db/)
})
