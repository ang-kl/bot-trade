// agent/services/entry-mode-auto.test.js — PR-G (owner principle 2): the
// bot's half of the entry-mode switch. Promotion after AUTO_PROMOTE_CYCLES
// ready evaluations with the opportunity rule, demotion within one, a manual
// account never touched, hysteresis on alternating cycles, the loop wiring —
// and the independent checker's counterexamples (C-1, A-1, A-2, B-1, B-2,
// R-1, C-2) ported as regressions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { engineStatusFor, requestEntryMode, requestEntryModePolicy, requestAdmittedBases, writeEngineStatus, markEntryModeBlocked, admitEntry, basesFor, writeAutoState, _resetRefusalDedupe } from './entry-mode.js'
import { tickEntryAccountsFor } from './tick-permits.js'
import { evaluateAutoEntryModes, opportunityCounts, readAutoState, sideHealth, AUTO_PROMOTE_CYCLES, OPPORTUNITY_WINDOW_H, MIN_TICK_SHADOW, HUMAN_OVERRIDE_COOLDOWN_H, STREAK_MAX_GAP_MS, AUTO_BLOCKED_CYCLES, AUTO_ACTOR } from './entry-mode-auto.js'

const A = '46130058', B = '42993489'
const SIDE = 'cpp_exec'
const T0 = Date.parse('2026-09-11T06:00:00Z')
const H = 1_800_000 // one quant cadence
function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: A, isLive: false })
  upsertAccount(db, { accountId: B, isLive: false })
  db.prepare(`UPDATE accounts SET enabled = 1, mode = 'active'`).run() // the autopilot roster: enabled, entering
  return db
}
function stage(db, id, validationStage = 'SHADOW_PASSED') {
  const cur = engineStatusFor(db, id)
  writeEngineStatus(db, { ...cur, validationStage, profileHash: 'a'.repeat(64), profileId: 'tick_momentum_breakout@v1', configRevision: cur.configRevision + 1 })
}
function settle(db, id) { // the sidecar's echo
  const cur = engineStatusFor(db, id)
  writeEngineStatus(db, { ...cur, transitionState: 'STABLE', effectiveEntryMode: cur.requestedEntryMode, fenceAckEpoch: cur.modeEpoch })
}
const readyFn = (verdicts) => (db, id) => {
  const v = typeof verdicts === 'function' ? verdicts(id) : verdicts
  return v ? { ready: true, blockedReasons: [], side: SIDE } : { ready: false, blockedReasons: ['recorder_status_fresh', 'feed_continuity'], side: SIDE }
}
const gatewayStub = (calls = []) => async (db, id, mode, { epoch }) => { calls.push({ id, mode, epoch }); return { gateway: { pushed: true }, status: engineStatusFor(db, id) } }
const opp = (tickShadow, timeApprovals) => () => ({ tickShadow, timeApprovals })
const base = (over = {}) => ({ readiness: readyFn(true), opportunity: opp(3, 1), gateway: gatewayStub(), sideOf: async () => ({ name: SIDE }), health: () => ({ ok: true }), ...over })
const actions = (db, id) => db.prepare(`SELECT body FROM action_log WHERE path = '/actions/entry-mode' AND account_id = ? ORDER BY id`).all(id).map(r => JSON.parse(r.body))
// WP-A (25-09-2026): a promotion ADDS tick next to bar — the record stays
// TIME_BASED and its admitted set becomes [bar, tick]. Every "promoted" /
// "not promoted" assertion below therefore reads the SET, never the mode
// string alone (which is TIME_BASED either way and could not go red).
const DUAL = ['bar', 'tick']
const requestedBases = (db, id) => { const st = engineStatusFor(db, id); return basesFor({ ...st, effectiveEntryMode: st.requestedEntryMode }) }
function assertTimeOnly(db, id, msg) {
  const st = engineStatusFor(db, id)
  assert.equal(st.requestedEntryMode, 'TIME_BASED', msg); assert.equal(st.admittedBases, null, msg); assert.deepEqual(requestedBases(db, id), ['bar'], msg)
}
function assertDual(db, id, msg) {
  const st = engineStatusFor(db, id)
  assert.equal(st.requestedEntryMode, 'TIME_BASED', msg); assert.deepEqual(st.admittedBases, DUAL, msg)
}
async function promote(db, opts, from = 1) {
  for (let i = from; i < from + AUTO_PROMOTE_CYCLES; i++) await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
  assertDual(db, A, 'precondition: promoted (tick added next to bar)')
  settle(db, A)
}

test('promotion: after AUTO_PROMOTE_CYCLES ready evaluations with SHADOW_PASSED and tick ≥ max(min, time), the switch is thrown as auto:readiness with both counts on the action row and the gateway bound', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const calls = []
  const opts = base({ opportunity: opp(12, 9), gateway: gatewayStub(calls) })
  for (let i = 1; i < AUTO_PROMOTE_CYCLES; i++) {
    const r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
    assert.equal(r.promoted.length, 0); assert.equal(r.held.length, 1); assert.match(r.lines[0], new RegExp(`held \\(ready ${i}/${AUTO_PROMOTE_CYCLES}\\)`))
    assertTimeOnly(db, A, `cycle ${i}: not yet promoted`)
    assert.equal(readAutoState(db, A).readyStreak, i)
  }
  const r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + AUTO_PROMOTE_CYCLES * H) })
  assert.equal(r.promoted.length, 1); assert.deepEqual(r.demoted, [])
  assert.match(r.lines[0], /^…0058 promoted \(ready 3\/3, tick 12 ≥ max\(min 1, time 9\) over 24 h\)$/)
  const st = engineStatusFor(db, A)
  assert.equal(st.requestedEntryMode, 'TIME_BASED'); assert.deepEqual(st.admittedBases, DUAL, 'RED if the promotion still lands on TICK_MOMENTUM (bar replaced by tick)')
  assert.equal(st.transitionState, 'WARMING'); assert.equal(st.effectiveEntryMode, 'STOPPED', 'the ack protocol applies unchanged: effective waits for the echo')
  const rows = actions(db, A)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].actor, AUTO_ACTOR); assert.equal(rows[0].to, 'TIME_BASED'); assert.deepEqual(rows[0].bases, { from: ['bar'], to: DUAL })
  assert.deepEqual(rows[0].detail, { readyStreak: 3, tickShadow: 12, timeApprovals: 9, windowH: OPPORTUNITY_WINDOW_H, minTickShadow: MIN_TICK_SHADOW, side: SIDE })
  assert.deepEqual(calls, [{ id: A, mode: 'TIME_BASED', epoch: st.modeEpoch }], 'the gateway is bound with the new epoch')
  assert.deepEqual(r.promoted[0].bases, DUAL)
  assert.equal(readAutoState(db, A).lastAction.action, 'promoted')
  assert.equal(readAutoState(db, A).humanOverride, null, 'the bot\'s own switch records no human override')
  // mid-transition (WARMING): held, nothing stacked
  const again = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + 4 * H) })
  assert.match(again.lines[0], /held \(transition WARMING\)/)
  assert.equal(actions(db, A).length, 1)
  // after the echo: time entries KEEP running and the account is on the tick roster
  settle(db, A)
  _resetRefusalDedupe()
  assert.equal(admitEntry(db, { accountId: A, producerId: 'daily_momentum_account' }).ok, true, 'bar still admitted after promotion — RED if promotion replaced bar with tick')
  assert.equal(admitEntry(db, { accountId: A, producerId: 'tick_momentum' }).ok, true)
  assert.ok(tickEntryAccountsFor(db, { isLive: null }).includes(A), 'the sidecar lists it for tick entries')
  const held = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + 5 * H) })
  assert.match(held.lines[0], /held \(already admits tick \(bar\+tick, ready \d+\)\)/)
})

test('demotion: one failing evaluation on an account admitting tick (promoted to Time + tick) takes it back to TIME_BASED bar only at once and resets the streak', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const calls = []
  const opts = base({ opportunity: opp(5, 1), gateway: gatewayStub(calls) })
  await promote(db, opts)
  const r = await evaluateAutoEntryModes(db, { ...opts, readiness: readyFn(false), now: new Date(T0 + 5 * H) })
  assert.equal(r.demoted.length, 1)
  assert.match(r.lines[0], /^…0058 demoted \(not ready: recorder_status_fresh, feed_continuity\)$/)
  const st = engineStatusFor(db, A)
  assertTimeOnly(db, A, 'tick removed'); assert.equal(st.transitionState, 'WARMING')
  assert.equal(readAutoState(db, A).readyStreak, 0, 'a demotion resets the streak')
  const rows = actions(db, A)
  assert.equal(rows.at(-1).actor, AUTO_ACTOR); assert.equal(rows.at(-1).to, 'TIME_BASED'); assert.deepEqual(rows.at(-1).bases, { from: DUAL, to: ['bar'] }); assert.deepEqual(rows.at(-1).detail.blockedReasons, ['recorder_status_fresh', 'feed_continuity'])
  assert.equal(calls.at(-1).mode, 'TIME_BASED')
})

test('C-1 (checker): a HUMAN demotes a promoted auto account to TIME_BASED — the bot does not re-promote it; ten ready cycles later it is still TIME_BASED; after the cooldown and a fresh streak it may', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const opts = base()
  await promote(db, opts)
  for (let i = 4; i <= 6; i++) await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) }) // held "already", streak keeps counting
  assert.ok(readAutoState(db, A).readyStreak >= AUTO_PROMOTE_CYCLES)
  const h = requestEntryMode(db, A, 'TIME_BASED', { actor: 'owner', now: new Date(T0 + 6 * H + 60_000) })
  assert.equal(h.ok, true)
  const mem = readAutoState(db, A)
  assert.equal(mem.readyStreak, 0, 'the human switch zeroes the streak')
  assert.equal(mem.humanOverride.mode, 'TIME_BASED'); assert.deepEqual(mem.humanOverride.bases, ['bar']); assert.equal(mem.humanOverride.epoch, h.status.modeEpoch); assert.equal(mem.humanOverride.actor, 'owner')
  settle(db, A)
  for (let i = 7; i <= 16; i++) {
    const r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
    assert.equal(r.promoted.length, 0, `cycle ${i}`)
    if (i >= 9) assert.match(r.lines[0], /held \(human set TIME_BASED \d+ min ago; the bot does not promote past it for 24 h/)
  }
  assertTimeOnly(db, A, 'the bot never undid the human')
  assert.equal(actions(db, A).at(-1).actor, 'owner')
  // after HUMAN_OVERRIDE_COOLDOWN_H the override lapses — but the streak is
  // by time, so three fresh consecutive ready cycles are still needed
  const later = T0 + 6 * H + HUMAN_OVERRIDE_COOLDOWN_H * 3_600_000 + H
  let r = null
  for (let i = 0; i < AUTO_PROMOTE_CYCLES; i++) r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(later + i * H) })
  assert.equal(r.promoted.length, 1, 'the cooldown lapsed and a fresh streak promoted')
  assertDual(db, A)
  // and a policy change is the human acting: memory starts clean under the new policy
  requestEntryModePolicy(db, A, 'manual'); requestEntryModePolicy(db, A, 'auto')
  assert.deepEqual(readAutoState(db, A), { readyStreak: 0, lastEval: null, lastAction: null, humanOverride: null, blockedCycles: 0 })
})

test('A-1 (checker): the streak does not advance while STOPPED, and a human STOPPED → TIME_BASED is not promoted on the first evaluation; the bot never lifts a stop', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const opts = base()
  await promote(db, opts)
  requestEntryMode(db, A, 'STOPPED', { actor: 'owner', now: new Date(T0 + 3 * H + 60_000) })
  settle(db, A)
  for (let i = 4; i <= 8; i++) {
    const r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
    assert.match(r.lines[0], /held \(stopped by a human; the bot never lifts a stop \(streak held at 0\)/, `cycle ${i}`)
  }
  assert.equal(readAutoState(db, A).readyStreak, 0, 'no streak advance while STOPPED')
  assert.equal(engineStatusFor(db, A).requestedEntryMode, 'STOPPED')
  requestEntryMode(db, A, 'TIME_BASED', { actor: 'owner', now: new Date(T0 + 8 * H + 60_000) }); settle(db, A)
  const r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + 9 * H) })
  assert.equal(r.promoted.length, 0)
  assertTimeOnly(db, A, 'not promoted on the first evaluation after the human chose TIME_BASED')
  assert.equal(actions(db, A).filter(a => a.actor === AUTO_ACTOR).length, 1, 'only the original promotion is the bot\'s')
})

test('A-2 (checker): a streak is consecutive by TIME — two ready evaluations a week ago and one now do not promote, and the held reason says the streak was reset', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const opts = base()
  await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0) })
  await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + H) })
  assert.equal(readAutoState(db, A).readyStreak, 2)
  const r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + 7 * 24 * 3_600_000) })
  assert.equal(r.promoted.length, 0)
  assert.match(r.lines[0], /held \(ready 1\/3; streak reset: previous evaluation \d+ min ago\)/)
  assert.equal(readAutoState(db, A).readyStreak, 1)
  assertTimeOnly(db, A)
  // just inside the gap keeps counting
  const db2 = fresh(); requestEntryModePolicy(db2, A, 'auto'); stage(db2, A)
  await evaluateAutoEntryModes(db2, { ...opts, now: new Date(T0) })
  await evaluateAutoEntryModes(db2, { ...opts, now: new Date(T0 + STREAK_MAX_GAP_MS - 1) })
  assert.equal(readAutoState(db2, A).readyStreak, 2)
})

test('a manual account is never touched — not evaluated, no streak, no action row — even when ready with opportunity', async () => {
  const db = fresh()
  stage(db, A)
  requestEntryModePolicy(db, B, 'auto'); stage(db, B)
  const calls = []
  const opts = base({ opportunity: opp(9, 0), gateway: gatewayStub(calls) })
  for (let i = 1; i <= AUTO_PROMOTE_CYCLES + 1; i++) await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
  assertTimeOnly(db, A); assert.equal(engineStatusFor(db, A).configRevision, 1, 'only the stage write touched the manual account')
  assert.deepEqual(readAutoState(db, A), { readyStreak: 0, lastEval: null, lastAction: null, humanOverride: null, blockedCycles: 0 })
  assert.deepEqual(actions(db, A), [])
  assertDual(db, B, 'the auto account on the same pass was promoted')
  assert.deepEqual(calls.map(c => c.id), [B])
})

test('hysteresis: alternating ready / not-ready evaluations never promote', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const opts = base({ opportunity: opp(9, 0) })
  for (let i = 1; i <= 12; i++) {
    const r = await evaluateAutoEntryModes(db, { ...opts, readiness: readyFn(i % 2 === 1), now: new Date(T0 + i * H) })
    assert.equal(r.promoted.length, 0, `cycle ${i}`)
    assert.ok(readAutoState(db, A).readyStreak <= 1)
  }
  assertTimeOnly(db, A)
  assert.deepEqual(actions(db, A), [])
  let t = T0 + 13 * H
  for (const v of [true, true, false, true, true]) await evaluateAutoEntryModes(db, { ...opts, readiness: readyFn(v), now: new Date(t += H) })
  assertTimeOnly(db, A)
})

test('B-1 (checker) + opportunity: 0 ≥ 0 does NOT promote (the minimum is named); tick below time holds with both counts; equal-and-above-minimum promotes', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const opts = base()
  let r = null
  for (let i = 1; i <= AUTO_PROMOTE_CYCLES; i++) r = await evaluateAutoEntryModes(db, { ...opts, opportunity: opp(0, 0), now: new Date(T0 + i * H) })
  assert.equal(r.promoted.length, 0)
  assert.match(r.lines[0], /held \(ready 3\/3 but opportunity tick 0 < max\(min 1, time 0\) over 24 h\)/)
  assertTimeOnly(db, A, 'a quiet account is not promoted')
  const held = await evaluateAutoEntryModes(db, { ...opts, opportunity: opp(4, 5), now: new Date(T0 + 4 * H) })
  assert.equal(held.promoted.length, 0)
  assert.match(held.lines[0], /held \(ready 4\/3 but opportunity tick 4 < max\(min 1, time 5\) over 24 h\)/)
  assert.equal(held.held[0].tickShadow, 4); assert.equal(held.held[0].timeApprovals, 5)
  const equal = await evaluateAutoEntryModes(db, { ...opts, opportunity: opp(5, 5), now: new Date(T0 + 5 * H) })
  assert.equal(equal.promoted.length, 1, 'at least the time path\'s count, and at least the minimum, promotes')
  // one taken shadow signal with no time approvals is enough
  const db2 = fresh(); requestEntryModePolicy(db2, A, 'auto'); stage(db2, A)
  for (let i = 1; i <= AUTO_PROMOTE_CYCLES; i++) r = await evaluateAutoEntryModes(db2, { ...opts, opportunity: opp(1, 0), now: new Date(T0 + i * H) })
  assert.equal(r.promoted.length, 1)
})

test('B-2 (checker) + the real counter: risk_events.created_at is ISO text and cpp_decisions is windowed on ts_ms — approvals at 25 h and 29.5 h ago are NOT counted; taken shadow signals on the side within the window are', () => {
  const db = fresh()
  const now = new Date('2026-09-11T06:00:00Z')
  const iso = (hAgo) => new Date(now.getTime() - hAgo * 3_600_000).toISOString() // production format (risk.js)
  const ms = (hAgo) => now.getTime() - hAgo * 3_600_000
  const re = db.prepare(`INSERT INTO risk_events (symbol, side, approved, account_id, opportunity_key, created_at) VALUES (?, 'BUY', ?, ?, ?, ?)`)
  re.run('EURUSD', 1, A, 'k1', iso(1)); re.run('EURUSD', 1, A, 'k1', iso(1))   // one opportunity re-scored → 1
  re.run('GBPUSD', 1, A, 'k2', iso(3))                                        // → 2
  re.run('GBPUSD', 1, A, null, iso(3))                                        // no key: counts as its own row → 3
  re.run('XAUUSD', 0, A, 'k3', iso(1))                                        // vetoed → no
  re.run('XAUUSD', 1, B, 'k4', iso(1))                                        // other account → no
  re.run('USDJPY', 1, A, 'k5', iso(25))                                       // 2026-09-10T05:00Z: outside 24 h → no (B-2)
  re.run('USDCAD', 1, A, 'k6', iso(29.5))                                     // 2026-09-10T00:30Z: outside → no (B-2)
  re.run('AUDUSD', 1, A, 'k7', '2026-09-11 05:30:00')                         // sqlite-format text (older rows) still counts → 4
  re.run('NZDUSD', 1, A, 'k8', '2026-09-10 07:00:00')                         // sqlite-format, 23 h ago, on the since-day: counts → 5 (a raw text compare against an ISO bound drops it: ' ' < 'T')
  const cd = db.prepare(`INSERT INTO cpp_decisions (at, side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail) VALUES (?, ?, 'b1', ?, ?, ?, ?, NULL, 1, 'BUY', ?)`)
  let seq = 0
  const ingest = '2026-09-11 05:59:00' // `at` is the INGEST time — every row pulled in one probe shares it
  cd.run(ingest, SIDE, ++seq, ms(1), 'tick', 'signal', 'shadow seq=1 profile=x')           // taken → counts
  cd.run(ingest, SIDE, ++seq, ms(2), 'tick', 'signal', 'shadow seq=2 profile=x')           // taken → counts
  cd.run(ingest, SIDE, ++seq, ms(2), 'tick', 'signal', 'shadow_cost seq=3 profile=x')      // refused offer → no
  cd.run(ingest, SIDE, ++seq, ms(2), 'tick', 'signal', 'shadow_busy seq=4 profile=x')      // refused offer → no
  cd.run(ingest, SIDE, ++seq, ms(30), 'tick', 'signal', 'shadow seq=5 profile=x')          // sidecar clock outside the window → no, although ingested now
  cd.run(ingest, 'cpp_exec_demo', ++seq, ms(1), 'tick', 'signal', 'shadow seq=6 profile=x') // other side → no
  cd.run(ingest, SIDE, ++seq, ms(1), 'tick', 'gap', 'shadow')                              // not a signal → no
  cd.run(ingest, SIDE, ++seq, null, 'tick', 'signal', 'shadow seq=8 profile=x')            // no sidecar clock → not counted
  const c = opportunityCounts(db, A, { now, side: SIDE })
  assert.equal(c.timeApprovals, 5, `since=${c.since}`)
  assert.equal(c.tickShadow, 2); assert.equal(c.windowH, OPPORTUNITY_WINDOW_H)
  assert.equal(opportunityCounts(db, A, { now, side: SIDE, windowH: 48 }).tickShadow, 3)
  assert.equal(opportunityCounts(db, A, { now, side: SIDE, windowH: 48 }).timeApprovals, 7)
})

test('R-1 (checker): an auto account that left the autopilot roster is still evaluated — demoted when readiness fails — while promotion needs the roster', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const opts = base()
  await promote(db, opts)
  db.prepare(`UPDATE accounts SET params = ? WHERE account_id = ?`).run(JSON.stringify({ autopilot: false }), A)
  assert.deepEqual(tickEntryAccountsFor(db, { isLive: null }), [A], 'the sidecar still lists it for tick entries')
  const r = await evaluateAutoEntryModes(db, { ...opts, readiness: readyFn(false), now: new Date(T0 + 9 * H) })
  assert.equal(r.evaluated.length, 1); assert.equal(r.demoted.length, 1)
  assertTimeOnly(db, A, 'demoted although off the autopilot roster')
  settle(db, A)
  // back to ready off the roster: held, never promoted
  let last = null
  const later = T0 + HUMAN_OVERRIDE_COOLDOWN_H * 3_600_000 // no human override stands here anyway (the demotion was the bot's)
  for (let i = 1; i <= AUTO_PROMOTE_CYCLES + 1; i++) last = await evaluateAutoEntryModes(db, { ...opts, now: new Date(later + i * H) })
  assert.equal(last.promoted.length, 0)
  assert.match(last.lines[0], /but not on the autopilot roster/)
  assertTimeOnly(db, A)
})

test('C-2 (checker): a promotion whose push fails is taken back by the bot after AUTO_BLOCKED_CYCLES passes; a side whose last push or probe failed is not promoted at all', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const failing = async (db, id) => { markEntryModeBlocked(db, id, 'sidecar 502'); return { gateway: { pushed: false, error: 'sidecar 502' }, status: engineStatusFor(db, id) } }
  const opts = base({ gateway: failing })
  for (let i = 1; i <= AUTO_PROMOTE_CYCLES; i++) await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
  let st = engineStatusFor(db, A)
  assert.equal(st.effectiveEntryMode, 'STOPPED'); assert.equal(st.transitionState, 'BLOCKED'); assertDual(db, A)
  const promotedEpoch = st.modeEpoch
  const lines = []
  for (let i = 1; i <= AUTO_BLOCKED_CYCLES; i++) lines.push((await evaluateAutoEntryModes(db, { ...opts, gateway: gatewayStub(), now: new Date(T0 + (3 + i) * H) })).lines[0])
  assert.match(lines[0], /held \(transition BLOCKED under the bot's promotion \(1\/2\)\)/)
  assert.match(lines.at(-1), /demoted \(BLOCKED for 2 passes after the bot's promotion — taken back\)/)
  st = engineStatusFor(db, A)
  assertTimeOnly(db, A, 'the take-back clears the set (review: switchTo with no bases)'); assert.equal(st.modeEpoch, promotedEpoch + 1)
  const row = actions(db, A).at(-1)
  assert.equal(row.actor, AUTO_ACTOR); assert.equal(row.to, 'TIME_BASED'); assert.deepEqual(row.bases.to, ['bar']); assert.equal(row.detail.why, 'blocked_after_auto_promotion')
  assert.equal(readAutoState(db, A).blockedCycles, 0); assert.equal(readAutoState(db, A).readyStreak, 0)
  // BLOCKED under a HUMAN's epoch is not the bot's to take back
  const db2 = fresh(); requestEntryModePolicy(db2, A, 'auto'); stage(db2, A)
  requestEntryMode(db2, A, 'TIME_BASED', { actor: 'owner' }); markEntryModeBlocked(db2, A, 'sidecar 502')
  for (let i = 1; i <= AUTO_BLOCKED_CYCLES + 1; i++) {
    const r = await evaluateAutoEntryModes(db2, { ...opts, now: new Date(T0 + i * H) })
    assert.match(r.lines[0], /held \(transition BLOCKED \(not the bot's epoch\)\)/)
  }
  assert.equal(actions(db2, A).length, 1)
  // an unhealthy side refuses the promotion before any switch is written
  const db3 = fresh(); requestEntryModePolicy(db3, A, 'auto'); stage(db3, A)
  setState(db3, 'exec_guard_sync_last_error_json', JSON.stringify({ at: new Date(T0).toISOString(), side: SIDE, error: 'HTTP 502' }))
  assert.equal(sideHealth(db3, SIDE).ok, false)
  assert.equal(sideHealth(db3, 'cpp_exec_demo').ok, true, 'the stamp names its side')
  let r3 = null
  for (let i = 1; i <= AUTO_PROMOTE_CYCLES; i++) r3 = await evaluateAutoEntryModes(db3, { ...opts, gateway: gatewayStub(), health: sideHealth, now: new Date(T0 + i * H) })
  assert.match(r3.lines[0], /held \(ready 3\/3 but side cpp_exec unhealthy: last guard push failed: HTTP 502\)/)
  assert.deepEqual(actions(db3, A), [])
  setState(db3, 'exec_guard_sync_last_error_json', null)
  setState(db3, 'cpp_exec_health_json', JSON.stringify({ ok: false, error: 'ECONNREFUSED', at: new Date(T0).toISOString() }))
  r3 = await evaluateAutoEntryModes(db3, { ...opts, gateway: gatewayStub(), health: sideHealth, now: new Date(T0 + 4 * H) })
  assert.match(r3.lines[0], /unhealthy: last probe failed: ECONNREFUSED/)
  setState(db3, 'cpp_exec_health_json', JSON.stringify({ ok: true, at: new Date(T0).toISOString() }))
  r3 = await evaluateAutoEntryModes(db3, { ...opts, gateway: gatewayStub(), health: sideHealth, now: new Date(T0 + 5 * H) })
  assert.equal(r3.promoted.length, 1)
  assertDual(db3, A)
})

test('the switch it throws is the same requestEntryMode the human uses: a readiness function that says no at the request refuses the promotion and the pass reports it', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const twoFaced = (db, id, opts) => opts ? { ready: true, blockedReasons: [], side: SIDE } : { ready: false, blockedReasons: ['disk_reserve_clear'], side: SIDE }
  const opts = base({ readiness: twoFaced, opportunity: opp(1, 0) })
  let last = null
  for (let i = 1; i <= AUTO_PROMOTE_CYCLES; i++) last = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
  assert.equal(last.promoted.length, 0)
  assert.match(last.lines[0], /held \(promotion refused: tick_not_ready: disk_reserve_clear\)/)
  assertTimeOnly(db, A)
  assert.deepEqual(actions(db, A), [], 'nothing written')
  assert.equal(requestEntryMode(db, A, 'TICK_MOMENTUM', { actor: 'auto:readiness' }).reason.startsWith('tick_readiness_unavailable'), true, 'no unchecked path into tick trading')
})

test('pin: loop.js runs evaluateAutoEntryModes inside the quant-cadence block and prints its lines under [entry-mode] auto:', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const quant = src.indexOf('if (loopCount % 6 === 0) {')
  const call = src.indexOf("await import('./services/entry-mode-auto.js')")
  const run = src.indexOf('await evaluateAutoEntryModes(db)')
  const line = src.indexOf('log(`[entry-mode] auto: ${line}`)')
  assert.ok(quant > 0 && call > quant && run > call && line > run, `quant ${quant} import ${call} run ${run} log ${line}`)
  const quantPhase = src.indexOf("phase('quant')", quant)
  const nextPhase = src.indexOf("phase('", quantPhase + 5)
  assert.ok(nextPhase === -1 || run < nextPhase, 'the call sits inside the quant phase, not a later one')
})

// ---------------------------------------------------------------------------
// WP-A: the pass works on bases — demotion reaches a dual account, a human's
// dual choice is honoured, and a human's time-only choice still blocks.
// ---------------------------------------------------------------------------
const humanReady = () => ({ ready: true, blockedReasons: [] })

test('WP-A: demotion reaches a DUAL account — a human-set Time + tick on an auto account loses tick on one failing pass', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const h = requestEntryMode(db, A, 'TIME_BASED', { actor: 'owner', readiness: humanReady, admittedBases: DUAL, now: new Date(T0) })
  assert.equal(h.ok, true, h.reason)
  settle(db, A)
  const calls = []
  const r = await evaluateAutoEntryModes(db, { ...base({ gateway: gatewayStub(calls) }), readiness: readyFn(false), now: new Date(T0 + H) })
  assert.equal(r.demoted.length, 1, `RED if demotion keys on requestedEntryMode === TICK_MOMENTUM: ${r.lines[0]}`)
  assert.match(r.lines[0], /^…0058 demoted \(not ready: recorder_status_fresh, feed_continuity\)$/)
  assertTimeOnly(db, A)
  assert.deepEqual(calls, [{ id: A, mode: 'TIME_BASED', epoch: h.status.modeEpoch + 1 }])
  settle(db, A)
  assert.deepEqual(basesFor(engineStatusFor(db, A)), ['bar'], 'after the echo the fence admits bar only')
  assert.ok(!tickEntryAccountsFor(db, { isLive: null }).includes(A), 'off the tick roster')
})

test('WP-A: a HUMAN dual choice is honoured — held as already admitting tick, demoted on a failure, re-promoted to [bar, tick] inside the cooldown; a human time-only choice (mode or set) still blocks; an old override with no bases does not block', async () => {
  const db = fresh()
  requestEntryModePolicy(db, A, 'auto'); stage(db, A)
  const opts = base()
  const h = requestEntryMode(db, A, 'TIME_BASED', { actor: 'owner', readiness: humanReady, admittedBases: DUAL, now: new Date(T0) })
  assert.equal(h.ok, true, h.reason); settle(db, A)
  let r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + H) })
  assert.match(r.lines[0], /held \(already admits tick \(bar\+tick, ready 1\)\)/)
  r = await evaluateAutoEntryModes(db, { ...opts, readiness: readyFn(false), now: new Date(T0 + 2 * H) })
  assert.equal(r.demoted.length, 1); settle(db, A)
  for (let i = 3; i < 3 + AUTO_PROMOTE_CYCLES; i++) r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
  assert.equal(r.promoted.length, 1, `the human's own dual choice does not block the bot re-adding tick inside the cooldown — RED if the override is read by mode string: ${r.lines[0]}`)
  assertDual(db, A)
  // the converse: a human's time-only choice through the SET binds the pass
  settle(db, A)
  const n = requestAdmittedBases(db, A, ['bar'], { actor: 'owner', now: new Date(T0 + 7 * H) })
  assert.equal(n.ok, true, n.reason)
  for (let i = 8; i < 8 + AUTO_PROMOTE_CYCLES + 2; i++) r = await evaluateAutoEntryModes(db, { ...opts, now: new Date(T0 + i * H) })
  assert.equal(r.promoted.length, 0); assert.match(r.lines[0], /held \(human set TIME_BASED \d+ min ago; the bot does not promote past it for 24 h/)
  assert.deepEqual(engineStatusFor(db, A).admittedBases, ['bar'], 'the human\'s [bar] stands'); assert.deepEqual(requestedBases(db, A), ['bar'])
  // an override stored before WP-A (no bases) whose mode admitted tick does not block
  const db2 = fresh(); requestEntryModePolicy(db2, A, 'auto'); stage(db2, A)
  writeAutoState(db2, A, { humanOverride: { mode: 'TICK_MOMENTUM', at: new Date(T0).toISOString(), epoch: 0, actor: 'owner' } })
  for (let i = 1; i <= AUTO_PROMOTE_CYCLES; i++) r = await evaluateAutoEntryModes(db2, { ...opts, now: new Date(T0 + i * H) })
  assert.equal(r.promoted.length, 1, r.lines[0])
  assertDual(db2, A)
})
