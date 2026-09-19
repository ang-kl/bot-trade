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
import { goalTable, loadGoalTable, goalTargets, DEFAULT_GOAL_TARGETS, GOAL_TABLE_KEY, MOMENTUM_CHECKPOINT_KEY } from './goal-table.js'

const T0 = new Date('2026-09-08T06:00:00Z')
const ms = (sec) => T0.getTime() + sec * 1000

function byId(table) { return Object.fromEntries(table.goals.map(g => [g.id, g])) }

test('an empty db reports every goal, none of them as a number it did not earn', async () => {
  const db = initDB(':memory:')
  const t = await goalTable(db, { now: T0.getTime() })
  assert.equal(t.goals.length, 20) // Wave 3: four family rows + the momentum checkpoint; Wave 5: monitor_cadence
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
  assert.equal(t.summary.on_track + t.summary.off_track + t.summary.not_measurable, 20)
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
  // Wave 3: the date-valued target takes a parseable date and refuses junk
  assert.equal(goalTargets({ momentumTrialSince: '2026-10-01T00:00:00Z' }).momentumTrialSince, '2026-10-01T00:00:00Z')
  assert.equal(goalTargets({ momentumTrialSince: 'soon' }).momentumTrialSince, DEFAULT_GOAL_TARGETS.momentumTrialSince)
  assert.equal(goalTargets({ momentumTrialSince: 42 }).momentumTrialSince, DEFAULT_GOAL_TARGETS.momentumTrialSince)
})

test('a reader that throws becomes a not_measurable row, not a missing table', async () => {
  const db = initDB(':memory:')
  // Break one reader's input: an unparseable momentum config must not take the table down.
  setState(db, 'momentum_account_json', '{not json')
  const t = await goalTable(db, { now: T0.getTime() })
  assert.equal(t.goals.length, 20) // Wave 3: four family rows + the momentum checkpoint; Wave 5: monitor_cadence
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

test('trade_reasons (PR-E): not_measurable with no bot trade since the cutoff, on_track when every trade has a reason, off_track naming the kinds when one does not', async () => {
  const db = initDB(':memory:')
  let g = byId(await goalTable(db, { now: T0.getTime() })).trade_reasons
  assert.equal(g.verdict, 'not_measurable'); assert.match(g.note, /no bot trade since 2026-08-17/)
  const { recordTradePlan } = await import('./trade-plans.js')
  const ok = db.prepare(`INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at, status, origin, strategy, risk_event_id)
                         VALUES ('EURUSD','BUY',1.1,1.095,1.11,1000,'2026-09-07 08:00:00','open','bot_market_dispatch','donchian_breakout',5)`).run().lastInsertRowid
  recordTradePlan(db, ok, { symbol: 'EURUSD', side: 'BUY', strategy: 'donchian_breakout', entry: 1.1, sl: 1.095, tp: 1.11, now: T0.getTime() })
  g = byId(await goalTable(db, { now: T0.getTime() })).trade_reasons
  assert.equal(g.verdict, 'on_track'); assert.equal(g.current, 0); assert.match(g.note, /1 bot trade\(s\) since the cutoff, every one with a reason/)
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin) VALUES ('GBPUSD','SELL',1.3,'2026-09-07 09:00:00','open','bot_pending_fill')`).run()
  g = byId(await goalTable(db, { now: T0.getTime() })).trade_reasons
  assert.equal(g.verdict, 'off_track'); assert.equal(g.current, 3)
  assert.match(g.note, /strategy_missing 1/); assert.match(g.note, /plan_missing 1/); assert.match(g.note, /risk_event_missing 1/)
})

// --- Wave 3 (first-principles audit 19-09-2026 §K items 10 and 12) ---------

test('Wave 3: the trail rule has no win-rate target; win rate is shown as measured only', async () => {
  assert.equal('trailWinRatePct' in DEFAULT_GOAL_TARGETS, false, 'the 69% bar is gone')
  const db = initDB(':memory:')
  const g = byId(await goalTable(db, { now: T0.getTime() }))
  assert.doesNotMatch(String(g.trail_rule.target), /WR/)
  assert.match(String(g.trail_rule.target), /PF ≥ 1/)
})

test('Wave 3: one family row per strategy family, not_measurable below the close floor, on/off track by PF, tail share and drawdown', async () => {
  const db = initDB(':memory:')
  let g = byId(await goalTable(db, { now: T0.getTime() }))
  for (const fam of ['mean_reversion', 'breakout', 'trend', 'momentum']) {
    const row = g[`family_edge_${fam}`]
    assert.ok(row, `row for ${fam}`)
    assert.equal(row.verdict, 'not_measurable')
    assert.match(row.note, /30 needed/)
    assert.match(row.target, /PF ≥ 1.5 · tail ≥ 20% · maxDD ≤ 8R/)
  }
  assert.match(g.family_edge_momentum.horizon, /judged at the checkpoint/)
  // 30 trend closes: 12 winners at +3R, 18 losers at -1R → PF 2.0, tail 40%, maxDD ≤ 8R → on_track
  const ins = db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, net_pnl, status, closed_at, closed_at_ms, strategy, account_id)
                          VALUES (?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?)`)
  let t = T0.getTime() - 20 * 86400_000
  for (let i = 0; i < 30; i++) {
    const win = i % 5 < 2
    t += 3600_000
    ins.run('EURUSD', 'BUY', 1.1, win ? 1.13 : 1.09, 1.09, win ? 300 : -100, new Date(t).toISOString().replace('T', ' ').slice(0, 19), t, 'vwap_trend', '47790949')
  }
  g = byId(await goalTable(db, { now: T0.getTime() }))
  assert.equal(g.family_edge_trend.verdict, 'on_track', g.family_edge_trend.note)
  assert.match(g.family_edge_trend.current, /PF 2 · tail 40% · maxDD 3R · n=30\/30/)
  assert.equal(g.family_edge_breakout.verdict, 'not_measurable', 'other families untouched')
  // widen the drawdown target down to 2R → the same record is off_track
  setState(db, GOAL_TABLE_KEY, JSON.stringify({ targets: { familyMaxDdR: 2 } }))
  g = byId(await goalTable(db, { now: T0.getTime() }))
  assert.equal(g.family_edge_trend.verdict, 'off_track')
  // raise the PF target above the record's 2.0 (tail and drawdown still pass) → off_track on PF alone
  setState(db, GOAL_TABLE_KEY, JSON.stringify({ targets: { familyMinPf: 2.5 } }))
  g = byId(await goalTable(db, { now: T0.getTime() }))
  assert.equal(g.family_edge_trend.verdict, 'off_track', 'PF 2 < 2.5')
})

test('Wave 3: the momentum checkpoint is one row, judged on its date and not before, on the trial account only', async () => {
  const db = initDB(':memory:')
  const before = byId(await goalTable(db, { now: Date.parse('2026-10-01T00:00:00Z') }))
  const row = before.momentum_checkpoint
  assert.ok(row)
  assert.equal(row.checkpointDate, '2026-12-19', 'the date is read from strategy-pins.json _trial_note')
  assert.equal(row.verdict, 'not_measurable')
  assert.match(row.note, /pre-registered; judged on 2026-12-19, not before/)
  assert.match(row.trialAccount, /…\d{4}/)
  // On the date with no closes: judged, and the trial did not earn a number
  const on = byId(await goalTable(db, { now: Date.parse('2026-12-19T00:00:00Z') }))
  assert.equal(on.momentum_checkpoint.verdict, 'off_track')
  assert.match(on.momentum_checkpoint.note, /did not earn a number/)
})

test('Wave 3 (checker F5): the checkpoint verdict is FROZEN on the date — later closes do not re-judge it; clearing the key does', async () => {
  const db = initDB(':memory:')
  const ins = db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, net_pnl, status, closed_at, closed_at_ms, strategy, account_id)
                          VALUES ('AAPL.US', 'BUY', 100, ?, 99, ?, 'closed', ?, ?, 'tsmom_long', '46130058')`)
  const day = 86400_000
  let t = Date.parse('2026-10-01T00:00:00Z')
  for (let i = 0; i < 29; i++) { t += day; ins.run(103, 300, new Date(t).toISOString().replace('T', ' ').slice(0, 19), t) }
  const onDate = Date.parse('2026-12-19T00:00:00Z')
  const judged = byId(await goalTable(db, { now: onDate })).momentum_checkpoint
  assert.equal(judged.verdict, 'off_track', '29 closes: did not earn a number')
  assert.equal(judged.judgedAt, new Date(onDate).toISOString())
  assert.ok(getState(db, MOMENTUM_CHECKPOINT_KEY), 'the verdict is stored')
  // a 30th close a month later changes nothing
  t = onDate + 30 * day; ins.run(103, 300, new Date(t).toISOString().replace('T', ' ').slice(0, 19), t)
  const later = byId(await goalTable(db, { now: onDate + 60 * day })).momentum_checkpoint
  assert.equal(later.verdict, 'off_track')
  assert.equal(later.judgedAt, new Date(onDate).toISOString())
  assert.match(later.current, /n=29\/29/)
  // clearing the key re-judges on the live record
  setState(db, MOMENTUM_CHECKPOINT_KEY, '')
  const rejudged = byId(await goalTable(db, { now: onDate + 60 * day })).momentum_checkpoint
  assert.equal(rejudged.verdict, 'on_track', rejudged.note)
  assert.match(rejudged.current, /n=30\/30/)
})

test('Wave 3 (checker F2): a lossless family with enough closes is on_track, not "PF —"', async () => {
  const db = initDB(':memory:')
  const ins = db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, net_pnl, status, closed_at, closed_at_ms, strategy, account_id)
                          VALUES ('EURUSD', 'BUY', 100, 103, 99, 300, 'closed', ?, ?, 'vwap_trend', '47790949')`)
  let t = T0.getTime() - 40 * 86400_000
  for (let i = 0; i < 30; i++) { t += 3600_000; ins.run(new Date(t).toISOString().replace('T', ' ').slice(0, 19), t) }
  const g = byId(await goalTable(db, { now: T0.getTime() }))
  assert.equal(g.family_edge_trend.verdict, 'on_track')
  assert.match(g.family_edge_trend.current, /PF ∞ \(no losses\)/)
})

// --- Wave 5 (first-principles audit 19-09-2026 §K item 15): monitor_cadence -
test('monitor_cadence: not_measurable without a record or with a stale one; on/off track from tick.skipShare10m against fastMonitorSkipMaxPct', async () => {
  const db = initDB(':memory:')
  const now = Date.parse('2026-09-19T12:00:00Z')
  assert.equal(DEFAULT_GOAL_TARGETS.fastMonitorSkipMaxPct, 10)
  let row = byId(await goalTable(db, { now })).monitor_cadence
  assert.equal(row.subsystem, 'fast monitor')
  assert.equal(row.verdict, 'not_measurable'); assert.match(row.note, /absent/)
  assert.equal(row.target, '≤ 10%')

  setState(db, 'fast_monitor_pass_json', JSON.stringify({ at: new Date(now - 6 * 60_000).toISOString(), tick: { everyMs: 3000, skipShare10m: 0.02 } }))
  row = byId(await goalTable(db, { now })).monitor_cadence
  assert.equal(row.verdict, 'not_measurable'); assert.match(row.note, /6 min old/)

  setState(db, 'fast_monitor_pass_json', JSON.stringify({ at: new Date(now - 60_000).toISOString(), tick: { everyMs: 3000, lastMs: 120, max10mMs: 900, skipped10m: 4, skipShare10m: 0.02, busyShare10m: 0.1 } }))
  row = byId(await goalTable(db, { now })).monitor_cadence
  assert.equal(row.verdict, 'on_track'); assert.equal(row.current, '2%'); assert.match(row.note, /4 skipped of ~200 expected/)

  setState(db, 'fast_monitor_pass_json', JSON.stringify({ at: new Date(now - 60_000).toISOString(), tick: { everyMs: 3000, skipShare10m: 0.25 } }))
  row = byId(await goalTable(db, { now })).monitor_cadence
  assert.equal(row.verdict, 'off_track'); assert.equal(row.current, '25%')

  // A record from before the share existed is not a number.
  setState(db, 'fast_monitor_pass_json', JSON.stringify({ at: new Date(now).toISOString(), tick: { everyMs: 3000 } }))
  row = byId(await goalTable(db, { now })).monitor_cadence
  assert.equal(row.verdict, 'not_measurable'); assert.match(row.note, /predates/)
})
