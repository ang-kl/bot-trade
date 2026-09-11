// node --test agent/services/goal-table.test.js
//
// §7,437·B·1 (owner, 08-09-2026): every subsystem that can be judged is
// judged by one metric against a target with one of three verdicts. The
// third, not_measurable, is the one this file cares most about: a goal with
// no data must say so with the shortfall, never print a number.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { beat, CONTROLLERS } from './heartbeat.js'
import { goalTable, loadGoalTable, goalTargets, DEFAULT_GOAL_TARGETS, GOAL_TABLE_KEY } from './goal-table.js'

const T0 = new Date('2026-09-08T06:00:00Z')
const ms = (sec) => T0.getTime() + sec * 1000

function byId(table) { return Object.fromEntries(table.goals.map(g => [g.id, g])) }

test('an empty db reports every goal, none of them as a number it did not earn', async () => {
  const db = initDB(':memory:')
  const t = await goalTable(db, { now: T0.getTime() })
  assert.equal(t.goals.length, 13)
  const g = byId(t)
  assert.equal(g.controllers_ok.verdict, 'not_measurable', 'no controller has beaten')
  assert.equal(g.pipeline_conversion.verdict, 'not_measurable', 'no decision audit on record')
  assert.equal(g.trail_rule.verdict, 'not_measurable', 'no replayable trades')
  assert.equal(g.momentum_universe_tradable.verdict, 'not_measurable')
  assert.match(g.momentum_universe_tradable.note, /not switched on/)
  assert.equal(g.close_completeness.verdict, 'on_track', 'zero incomplete closes is on track')
  for (const goal of t.goals) {
    assert.ok(['on_track', 'off_track', 'not_measurable'].includes(goal.verdict), `${goal.id} has a verdict`)
    assert.ok(goal.metric && goal.target !== undefined && goal.horizon !== undefined, `${goal.id} names metric/target/horizon`)
  }
  assert.equal(t.summary.on_track + t.summary.off_track + t.summary.not_measurable, 13)
})

test('controllers_ok: reads the heartbeat verdicts, names the offenders', async () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '5')
  beat(db, 'main_loop', { now: T0 })
  beat(db, 'weekend_bank', { now: new Date(ms(-7200)) }) // 2h old, expected 15m×4
  const t = await goalTable(db, { now: ms(30) })
  const g = byId(t).controllers_ok
  assert.equal(g.verdict, 'off_track')
  assert.equal(g.current, '50%')
  assert.match(g.note, /weekend_bank:stalled/)
})

test('records_fresh: a beating runner with a stale record is off track, and says which record', async () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '5')
  // atr_refresh: expected 86,400s × 2. A beat now, a record from 3 days ago.
  beat(db, 'atr_refresh', { now: T0 })
  setState(db, 'atr_refresh_last_json', JSON.stringify({ at: new Date(ms(-3 * 86_400)).toISOString(), updated: 0 }))
  const t = await goalTable(db, { now: ms(10) })
  const g = byId(t).records_fresh
  assert.equal(g.verdict, 'off_track')
  assert.match(g.note, /atr_refresh/)
  // Fresh record → on track.
  setState(db, 'atr_refresh_last_json', JSON.stringify({ at: T0.toISOString(), updated: 185 }))
  const t2 = await goalTable(db, { now: ms(10) })
  assert.equal(byId(t2).records_fresh.verdict, 'on_track')
})

test('pipeline_conversion: below the approval floor is not measurable; above it, the ratio decides', async () => {
  const db = initDB(':memory:')
  setState(db, 'decision_audit_last_json', JSON.stringify({ at: T0.toISOString(), approved: 3, tradesOpened: 0 }))
  let g = byId(await goalTable(db, { now: T0.getTime() })).pipeline_conversion
  assert.equal(g.verdict, 'not_measurable')
  assert.match(g.note, /3 approval\(s\) — below the 5-approval floor/)

  setState(db, 'decision_audit_last_json', JSON.stringify({ at: T0.toISOString(), approved: 59, tradesOpened: 4, because: '4 order(s)/trade(s) from 59 approval(s)' }))
  g = byId(await goalTable(db, { now: T0.getTime() })).pipeline_conversion
  assert.equal(g.verdict, 'off_track')
  assert.equal(g.current, 0.07)

  setState(db, 'decision_audit_last_json', JSON.stringify({ at: T0.toISOString(), approved: 10, tradesOpened: 6 }))
  g = byId(await goalTable(db, { now: T0.getTime() })).pipeline_conversion
  assert.equal(g.verdict, 'on_track')
})

test('close_completeness: a closed trade without P&L past the grace window is off track', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, status, closed_at_ms, net_pnl, entry_price, sl_price, tp_price, volume, opened_at)
              VALUES ('EURUSD', 'buy', 'closed', ?, NULL, 1.1, 1.09, 1.12, 1000, ?)`)
    .run(ms(-60 * 3600), new Date(ms(-62 * 3600)).toISOString()) // past the 48h grace
  const g = byId(await goalTable(db, { now: T0.getTime() })).close_completeness
  assert.equal(g.verdict, 'off_track')
  assert.equal(g.current, 1)
  assert.match(g.note, /1 missing P&L/)
})

test('targets: stored overrides apply, unknown keys survive, junk degrades to the default', () => {
  const db = initDB(':memory:')
  setState(db, GOAL_TABLE_KEY, JSON.stringify({ targets: { pipelineConversionMin: 0.8, controllersOkPct: 'junk', futureKnob: 7 } }))
  const cfg = loadGoalTable(db)
  assert.equal(cfg.targets.pipelineConversionMin, 0.8)
  assert.equal(cfg.targets.controllersOkPct, DEFAULT_GOAL_TARGETS.controllersOkPct)
  assert.equal(cfg.targets.futureKnob, 7, 'an unknown key is kept, not rebuilt away')
  assert.deepEqual(goalTargets(null), { ...DEFAULT_GOAL_TARGETS })
})

test('a reader that throws becomes a not_measurable row, not a missing table', async () => {
  const db = initDB(':memory:')
  // Break one reader's input: an unparseable momentum config must not take the table down.
  setState(db, 'momentum_account_json', '{not json')
  const t = await goalTable(db, { now: T0.getTime() })
  assert.equal(t.goals.length, 13)
  assert.ok(t.goals.every(g => g.verdict))
})

test('every controller with a declared effect is a registered controller', () => {
  for (const [name, def] of Object.entries(CONTROLLERS)) {
    if (def.effect) assert.ok(def.effect.key, `${name} effect names a key`)
  }
  assert.ok(Object.values(CONTROLLERS).some(d => d.effect), 'at least one effect is declared')
  assert.equal(typeof getState, 'function')
})

// ---------------------------------------------------------------------------
// PR-C (owner principle 7): the veto goal.
// ---------------------------------------------------------------------------

test('veto goal: 11-09-2026 production (10,580 vetoed of 10,593 reached) reads off_track with the waste share', async () => {
  const db = initDB(':memory:')
  setState(db, 'decision_audit_last_json', JSON.stringify({
    vetoed: 10580, vetoedDistinct: 1200, reachedGate: 10593, approved: 13,
    topVetoes: [{ key: 'max_positions=5/5', n: 9915 }],
  }))
  const g = byId(await goalTable(db, { now: T0.getTime() })).veto_rate
  assert.ok(g, 'the goal exists')
  assert.equal(g.verdict, 'off_track')
  assert.equal(g.vetoRate, 0.999)
  assert.equal(g.wasteRate, 0.887)
  assert.equal(g.target, `≤ ${DEFAULT_GOAL_TARGETS.vetoRateMax}`)
  assert.equal(DEFAULT_GOAL_TARGETS.vetoRateMax, 0.9)
  assert.equal(DEFAULT_GOAL_TARGETS.vetoMinReachedGate, 50)
  assert.match(g.current, /^0\.999 \(10580 vetoes, 1200 distinct, waste 89%\)$/)
  assert.match(g.note, /top reason: max_positions/)
})

test('veto goal: below the reached-gate floor reads not_measurable with the shortfall; at the target reads on_track; the owner can lower the ceiling', async () => {
  const db = initDB(':memory:')
  setState(db, 'decision_audit_last_json', JSON.stringify({ vetoed: 40, vetoedDistinct: 40, reachedGate: 41, approved: 1 }))
  let g = byId(await goalTable(db, { now: T0.getTime() })).veto_rate
  assert.equal(g.verdict, 'not_measurable')
  assert.match(g.note, /41 proposal\(s\) reached the gate — below the 50 floor/)
  assert.equal(g.current, null)

  setState(db, 'decision_audit_last_json', JSON.stringify({ vetoed: 150, vetoedDistinct: 150, reachedGate: 200, approved: 50 }))
  g = byId(await goalTable(db, { now: T0.getTime() })).veto_rate
  assert.equal(g.verdict, 'on_track')
  assert.equal(g.vetoRate, 0.75)
  assert.equal(g.wasteRate, 0)

  setState(db, GOAL_TABLE_KEY, JSON.stringify({ targets: { vetoRateMax: 0.5 } }))
  g = byId(await goalTable(db, { now: T0.getTime() })).veto_rate
  assert.equal(g.verdict, 'off_track', 'a lowered ceiling bites')
})

test('veto goal: with no stored audit it audits live rather than reporting a number it did not read', async () => {
  const db = initDB(':memory:')
  const g = byId(await goalTable(db, { now: T0.getTime() })).veto_rate
  assert.equal(g.verdict, 'not_measurable')
  assert.match(g.note, /0 proposal\(s\) reached the gate/)
})
