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
  assert.equal(t.goals.length, 28) // Wave 3: four family rows + the momentum checkpoint; Wave 5: monitor_cadence; V3 L1: four lifecycle rows; V3 M3: four P1/P4 rows
  const g = byId(t)
  assert.equal(g.controllers_ok.verdict, 'not_measurable', 'no controller has beaten')
  assert.equal(g.pipeline_conversion.verdict, 'not_measurable', 'no decision audit on record')
  assert.equal(g.trail_rule.verdict, 'not_measurable', 'no replayable trades')
  assert.equal(g.momentum_universe_tradable.verdict, 'not_measurable')
  assert.match(g.momentum_universe_tradable.note, /not switched on/)
  assert.equal(g.close_completeness.verdict, 'on_track', 'zero incomplete closes is on track')
  for (const goal of t.goals) {
    assert.ok(['on_track', 'off_track', 'not_measurable', 'proposed'].includes(goal.verdict), `${goal.id} has a verdict`)
    assert.ok(goal.metric && goal.target !== undefined && goal.horizon !== undefined, `${goal.id} names metric/target/horizon`)
  }
  // V3 M3: with no boot record and no account, every P1/P4 row is not measurable.
  for (const id of ['startup_window', 'event_loop_lag', 'protection_freshness', 'loop_latency']) assert.equal(g[id].verdict, 'not_measurable', id)
  assert.equal(t.summary.on_track + t.summary.off_track + t.summary.not_measurable + t.summary.proposed, 28)
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
  // V3 M3: an unparseable boot record is an absent one, not a missing row.
  setState(db, 'boot_record_json', '{not json')
  const t = await goalTable(db, { now: T0.getTime() })
  assert.equal(t.goals.length, 28) // Wave 3: four family rows + the momentum checkpoint; Wave 5: monitor_cadence; V3 L1: four lifecycle rows; V3 M3: four P1/P4 rows
  assert.ok(t.goals.every(g => g.verdict))
  assert.equal(t.goals.find(g => g.id === 'startup_window').verdict, 'not_measurable')
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

test('monitor_cadence: the note carries the quotes10m window figure when the record has one; unchanged (byte-identical) when it does not', async () => {
  const db = initDB(':memory:')
  const now = Date.parse('2026-09-20T12:00:00Z')
  const withoutWindow = { at: new Date(now - 60_000).toISOString(), tick: { everyMs: 3000, lastMs: 120, max10mMs: 900, skipped10m: 4, skipShare10m: 0.02, busyShare10m: 0.1 } }
  setState(db, 'fast_monitor_pass_json', JSON.stringify(withoutWindow))
  const baseline = byId(await goalTable(db, { now })).monitor_cadence
  assert.doesNotMatch(baseline.note, /quotes 10m/, 'no window on the record → no window text')

  setState(db, 'fast_monitor_pass_json', JSON.stringify({
    ...withoutWindow,
    tick: { ...withoutWindow.tick, quotes10m: { fromSidecar: 412, fromBroker: 18, stale: 2, passes: 96, sidecarSharePct: 95.8 } },
  }))
  const withWindow = byId(await goalTable(db, { now })).monitor_cadence
  assert.equal(withWindow.note, `${baseline.note} · quotes 10m: 412 sidecar / 18 broker (96% sidecar)`)
  // verdict/target/current are untouched by the window figure
  assert.equal(withWindow.verdict, baseline.verdict)
  assert.equal(withWindow.current, baseline.current)
  assert.equal(withWindow.target, baseline.target)

  // an empty window (passes: 0, e.g. the monitor just started) is treated
  // like "no window" — no dangling "0 sidecar / 0 broker (NaN%)" text
  setState(db, 'fast_monitor_pass_json', JSON.stringify({
    ...withoutWindow,
    tick: { ...withoutWindow.tick, quotes10m: { fromSidecar: 0, fromBroker: 0, stale: 0, passes: 0, sidecarSharePct: null } },
  }))
  const emptyWindow = byId(await goalTable(db, { now })).monitor_cadence
  assert.equal(emptyWindow.note, baseline.note)
})

// ---------------------------------------------------------------------------
// V3 M3 (P1/P4-3): the four P1/P4 rows. Their limits are PROPOSED until the
// owner stamps p1p4LimitsConfirmedAt: until then a row reads 'proposed' with
// the verdict it WOULD have, and is not counted as off track (principle 6).
// ---------------------------------------------------------------------------

const BOOT = Date.parse('2026-09-28T13:00:00Z')
const iso = (x) => new Date(x).toISOString()

function bootRecord({ persistedAt = BOOT + 16 * 60_000, listeningMs = 7_500, stallMs = 800, routes = [], complete = true, first = null, lag10m = null, mainLoop = null } = {}) {
  return {
    version: 1, bootId: 'boot-1', bootAt: iso(BOOT), commit: 'abc1234', startupWindowMs: 900_000,
    listening: { at: iso(BOOT + listeningMs), sinceBootMs: listeningMs },
    startupLag: { ms: stallMs, at: iso(BOOT + 60_000), loopPhase: 'scan' },
    startupHttp: { complete, total: {}, first5xx: null, routes },
    first: first ?? {
      loop: { sinceBootMs: 70_000, ms: 62_000, ok: true },
      band: { sinceBootMs: 20_000, ms: 3_000, overran: false, ok: true },
      cleanProtectionAudit: { sinceBootMs: 30_000, accounts: 7 },
      equityStop: { sinceBootMs: 72_000, ok: true },
    },
    latencyWindows: {
      mainLoop: mainLoop ?? { n: 360, p50: 40_000, p95: 55_000, p99: 70_000, max: 134_000 },
      eventLoopLag: { last10m: lag10m ?? { n: 6_000, maxMs: 400, p99LeMs: 250, worst: { ms: 400, at: iso(persistedAt - 1_000), loopPhase: 'idle' } } },
    },
    persistedAt: iso(persistedAt),
  }
}
const withRecord = (rec) => { const db = initDB(':memory:'); setState(db, 'boot_record_json', JSON.stringify(rec)); return db }
const confirm = (db) => setState(db, GOAL_TABLE_KEY, JSON.stringify({ targets: { p1p4LimitsConfirmedAt: '2026-09-28T12:00:00Z' } }))

test('P1/P4 rows: a clean startup reads proposed/on_track, is not counted on or off track, and names the proposal', async () => {
  const db = withRecord(bootRecord())
  const t = await goalTable(db, { now: BOOT + 17 * 60_000 })
  const g = byId(t).startup_window
  assert.equal(g.verdict, 'proposed')
  assert.equal(g.proposedVerdict, 'on_track')
  assert.equal(g.limits, 'proposed')
  assert.match(g.current, /listening 7.5 s · worst stall 800 ms · critical 5xx 0/)
  assert.match(g.note, /PROPOSED, not confirmed by the owner/)
  assert.ok(t.summary.proposed >= 1)
  assert.equal(t.goals.filter(x => x.verdict === 'proposed').length, t.summary.proposed)
})

test('P1/P4 rows: a critical-route 5xx would be off track; excluded from the count until the owner confirms, then counted', async () => {
  const db = withRecord(bootRecord({ routes: [{ route: '/state/heartbeats', '4xx': 0, '5xx': 2, aborted: 0 }, { route: '/state/decisions-daily', '4xx': 0, '5xx': 1, aborted: 0 }] }))
  const now = BOOT + 17 * 60_000
  let t = await goalTable(db, { now })
  let g = byId(t).startup_window
  assert.equal(g.verdict, 'proposed')
  assert.equal(g.proposedVerdict, 'off_track', 'the reading is not hidden — it says what it would read')
  assert.match(g.note, /2 critical-route 5xx/)
  assert.match(g.note, /1 report-route 5xx listed, tolerance is the owner's/)
  const offBefore = t.summary.off_track
  confirm(db)
  t = await goalTable(db, { now })
  g = byId(t).startup_window
  assert.equal(g.verdict, 'off_track', 'confirmed limits: the same reading is off track')
  assert.equal(g.limits, 'confirmed')
  assert.equal(t.summary.off_track, offBefore + 1)
})

test('P1/P4 rows: an open startup window is not measurable, unless a failure has already been seen', async () => {
  const open = withRecord(bootRecord({ persistedAt: BOOT + 4 * 60_000, complete: false, first: { band: { sinceBootMs: 20_000, ms: 3_000, overran: false, ok: true } } }))
  const g = byId(await goalTable(open, { now: BOOT + 4 * 60_000 })).startup_window
  assert.equal(g.verdict, 'not_measurable')
  assert.match(g.note, /still open — 11 min left/)
  const failed = withRecord(bootRecord({ persistedAt: BOOT + 4 * 60_000, complete: false, stallMs: 7_000 }))
  const f = byId(await goalTable(failed, { now: BOOT + 4 * 60_000 })).startup_window
  assert.equal(f.verdict, 'proposed')
  assert.equal(f.proposedVerdict, 'off_track', 'a failed observation stays failed')
  // After +300 s with no band on record, the absence is itself the failure.
  const noBand = withRecord(bootRecord({ persistedAt: BOOT + 6 * 60_000, complete: false, first: { cleanProtectionAudit: { sinceBootMs: 30_000 } } }))
  const nb = byId(await goalTable(noBand, { now: BOOT + 6 * 60_000 })).startup_window
  assert.equal(nb.proposedVerdict, 'off_track')
  assert.match(nb.note, /no band by \+300 s/)
})

test('P1/P4 rows: event-loop lag — boundaries, and a stale record is not measurable', async () => {
  const at = async (lag10m, persistedAt = BOOT + 60 * 60_000, now = BOOT + 61 * 60_000) =>
    byId(await goalTable(withRecord(bootRecord({ lag10m, persistedAt })), { now })).event_loop_lag
  // p99 < 1,000 ms (H-P1-1) from the histogram bound: 500 shows it; the
  // 500–1,000 bucket's bound of 1,000 cannot, so the row is not measurable
  // rather than on track (checker 25-09: a bound of 1,000 read on track).
  assert.equal((await at({ n: 6_000, maxMs: 4_999, p99LeMs: 500 })).proposedVerdict, 'on_track')
  const edge = await at({ n: 6_000, maxMs: 4_999, p99LeMs: 1_000 })
  assert.equal(edge.verdict, 'not_measurable', `a bound equal to the limit cannot show p99 < 1,000 ms (RED under <=): ${edge.verdict}/${edge.proposedVerdict}`)
  assert.match(edge.note, /cannot show p99 < 1000 ms/)
  assert.equal(edge.current, 'max 4999 ms · p99 ≤ 1000 ms', 'the reading is still shown')
  assert.match(edge.target, /p99 < 1000 ms/)
  assert.equal((await at({ n: 6_000, maxMs: 5_000, p99LeMs: 1_000 })).proposedVerdict, 'off_track', 'a failed max decides the row on its own')
  assert.equal((await at({ n: 6_000, maxMs: 5_000, p99LeMs: 100 })).proposedVerdict, 'off_track')
  assert.equal((await at({ n: 6_000, maxMs: 1_500, p99LeMs: 2_000 })).proposedVerdict, 'off_track')
  assert.equal((await at({ n: 0, maxMs: null, p99LeMs: null })).verdict, 'not_measurable')
  const stale = await at({ n: 6_000, maxMs: 100, p99LeMs: 50 }, BOOT + 60 * 60_000, BOOT + 71 * 60_000)
  assert.equal(stale.verdict, 'not_measurable')
  assert.match(stale.note, /11 min old/)
})

test('P1/P4 rows: loop latency — p95 on both sides of 60 s, under 10 loops not measurable, first loop named apart', async () => {
  const at = async (mainLoop) => byId(await goalTable(withRecord(bootRecord({ mainLoop, persistedAt: BOOT + 60 * 60_000 })), { now: BOOT + 61 * 60_000 })).loop_latency
  assert.equal((await at({ n: 360, p50: 1, p95: 60_000, p99: 1, max: 1 })).proposedVerdict, 'on_track')
  const over = await at({ n: 360, p50: 1, p95: 60_001, p99: 1, max: 1 })
  assert.equal(over.proposedVerdict, 'off_track')
  assert.match(over.note, /first loop 62 s \(no bar set — the owner sets it\)/)
  assert.equal((await at({ n: 9, p50: 1, p95: 1, p99: 1, max: 1 })).verdict, 'not_measurable')
})

test('P1/P4 rows: protection freshness ages every account from raw timestamps, limit on both sides', async () => {
  const now = BOOT + 60 * 60_000
  const db = initDB(':memory:')
  for (const id of ['43097342', '46130058']) {
    db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode, base_currency) VALUES (?, '1', 0, 1, 'active', 'USD')`).run(id)
  }
  // A disabled account is not judged (no audit, no reading, and not counted).
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode, base_currency) VALUES ('11110000', '1', 0, 0, 'paused', 'USD')`).run()
  setState(db, 'acct:43097342:protection_audit_last_json', JSON.stringify({ at: iso(now - 120_000), checked: 3 }))
  setState(db, 'acct:46130058:protection_audit_last_json', JSON.stringify({ at: iso(now - 121_000), checked: 1 }))
  setState(db, 'independent_protection_json', JSON.stringify({ accounts: [
    { accountId: '43097342', checkedAtMs: now - 120_000, openCount: 1, missingSl: 0, missingTp: 0, ok: true, source: 'broker_reconcile', host: 'demo' },
  ] }))
  const g = byId(await goalTable(db, { now })).protection_freshness
  assert.equal(g.verdict, 'proposed')
  assert.equal(g.proposedVerdict, 'off_track')
  assert.equal(g.current, '1/2 audit · 1/2 independent')
  assert.match(g.note, /…0058 audit 121 s/)
  assert.match(g.note, /…0058 independent none/)
  assert.doesNotMatch(g.note, /…7342/, 'exactly 120 s is within the limit')
  assert.doesNotMatch(g.note, /…0000/, 'the disabled account is not judged')
  // Both fresh: the would-be verdict flips to on_track (still proposed, not counted).
  setState(db, 'acct:46130058:protection_audit_last_json', JSON.stringify({ at: iso(now - 5_000), checked: 1 }))
  setState(db, 'independent_protection_json', JSON.stringify({ accounts: [
    { accountId: '43097342', checkedAtMs: now - 120_000, openCount: 1, missingSl: 0, missingTp: 0, ok: true, source: 'broker_reconcile', host: 'demo' },
    { accountId: '46130058', checkedAtMs: now - 1_000, openCount: 0, missingSl: 0, missingTp: 0, ok: true, source: 'broker_reconcile', host: 'demo' },
  ] }))
  const fresh = byId(await goalTable(db, { now })).protection_freshness
  assert.equal(fresh.proposedVerdict, 'on_track')
  assert.equal(fresh.current, '2/2 audit · 2/2 independent')
})

test('goalTargets: a null (owner-set) limit stays unset through a stored round trip; a boolean never becomes a number', () => {
  const t = goalTargets({ p1p4Report5xxMax: null, p1p4FirstLoopMaxSec: true, p1p4ListeningMaxSec: '20' })
  assert.equal(t.p1p4Report5xxMax, null, 'Number(null) is 0 — a stored null must not become a zero tolerance')
  assert.equal(t.p1p4FirstLoopMaxSec, null, 'true is not a 1-second bar')
  assert.equal(t.p1p4ListeningMaxSec, 20)
  assert.equal(goalTargets({ p1p4FirstLoopMaxSec: 90 }).p1p4FirstLoopMaxSec, 90, 'the owner can set the bar')
  assert.equal(goalTargets({ p1p4LimitsConfirmedAt: 'yes' }).p1p4LimitsConfirmedAt, '', 'only a date confirms')
  assert.equal(goalTargets(JSON.parse(JSON.stringify(goalTargets({})))).p1p4Report5xxMax, null)
  assert.equal(DEFAULT_GOAL_TARGETS.fastMonitorSkipMaxPct, 10, 'the existing skip target is unchanged')
})

test('P1/P4 rows: every measured row says load representativeness is not judged here — the harness grades a no-visible-tab window Not Verifiable', async () => {
  // Checker 25-09: once the limits are confirmed a quiet window (no visible
  // tab) reads on_track here while the harness grades it Not Verifiable. The
  // row must say which of the two judgements it is not making.
  const now = BOOT + 17 * 60_000
  const four = ['startup_window', 'event_loop_lag', 'protection_freshness', 'loop_latency']
  const db = withRecord(bootRecord())
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode, base_currency) VALUES ('46130058', '1', 0, 1, 'active', 'USD')`).run()
  setState(db, 'acct:46130058:protection_audit_last_json', JSON.stringify({ at: iso(now - 5_000), checked: 1 }))
  setState(db, 'independent_protection_json', JSON.stringify({ accounts: [
    { accountId: '46130058', checkedAtMs: now - 1_000, openCount: 0, missingSl: 0, missingTp: 0, ok: true, source: 'broker_reconcile', host: 'demo' },
  ] }))
  confirm(db)
  const g = byId(await goalTable(db, { now }))
  for (const id of four) {
    assert.equal(g[id].verdict, 'on_track', `${id}: confirmed limits, clean reading — ${g[id].note}`)
    assert.match(g[id].note, /load representativeness \(whether a Desk or Performance tab was visible\) is not judged here — the acceptance harness grades it/, id)
  }
  const empty = byId(await goalTable(initDB(':memory:'), { now }))
  for (const id of four) {
    assert.equal(empty[id].verdict, 'not_measurable', id)
    assert.doesNotMatch(empty[id].note, /load representativeness/, `${id}: no reading, nothing to qualify`)
  }
})

// --- V3 B4 (P5b-3): completeness goals name what cannot be recovered -------
// Production 26-09 00:14Z: close_completeness 17 (17 missing P&L, 17 missing
// a postmortem; 9 flat exempt), 19 written off of which 2 carry no
// closed_at_ms; trade_reasons 254 over 320 (plan_missing 147,
// adopted_ours_unreasoned 106, risk_event_missing 1). Until the owner answers
// H-P5b-3 both rows read their raw totals and verdicts; the split is beside.

const B4_NOW = Date.parse('2026-09-26T00:14:00Z')

function b4Close(db, { id, pos, net = null, writtenOff = false, closedAtMs = B4_NOW - 60 * 86_400_000 }) {
  db.prepare(`INSERT INTO trades (id, symbol, side, status, closed_at, closed_at_ms, net_pnl, entry_price, opened_at, account_id, ctrader_position_id,
                                  pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at)
              VALUES (?, 'GBPJPY', 'BUY', 'closed', '2026-08-03 21:06:24', ?, ?, 190, '2026-08-03 21:03:01', '46130058', ?, ?, ?, ?)`)
    .run(id, closedAtMs, net, pos, writtenOff ? 1 : 0, writtenOff ? `unresolved: no broker evidence: re-read: position ${pos} refused` : null, writtenOff ? '2026-09-02 11:00:30' : null)
}

test('B4: close_completeness keeps its raw count (17, off track) and names every labelled close with its reason; the rows outside its population are named, not recovered', async () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 17; i++) b4Close(db, { id: 1000 + i, pos: String(234843500 + i), writtenOff: true })
  for (let i = 0; i < 9; i++) b4Close(db, { id: 2000 + i, pos: String(235000000 + i), net: 0 }) // breakeven: exempt (L2b W16)
  b4Close(db, { id: 8, pos: '231619053', writtenOff: true, closedAtMs: null })
  b4Close(db, { id: 353, pos: '234186932', writtenOff: true, closedAtMs: null })
  const t = await goalTable(db, { now: B4_NOW })
  const g = byId(t).close_completeness
  assert.equal(g.current, 17, 'the raw count is unchanged by the split')
  assert.equal(g.verdict, 'off_track', 'labelled rows still count until the owner answers H-P5b-3')
  assert.deepEqual({ raw: g.split.raw, l: g.split.labelled_unrecoverable, p: g.split.broker_evidence_pending, m: g.split.postmortem_pending }, { raw: 17, l: 17, p: 0, m: 0 })
  assert.equal(g.items.length, 17); assert.equal(g.itemsTotal, 17)
  for (const it of g.items) {
    assert.equal(it.class, 'labelled_unrecoverable')
    assert.match(it.reason, /^written off 2026-09-02 11:00:30: unresolved: no broker evidence/)
    assert.deepEqual(it.missing, ['net_pnl', 'postmortem'])
    assert.equal(it.account, '46130058')
  }
  assert.match(g.note, /^17 incomplete — 17 labelled unrecoverable · 0 awaiting broker evidence · 0 awaiting a postmortem \(17 missing P&L, 17 missing a postmortem\)/)
  assert.match(g.note, /labelled: #1000 …0058 GBPJPY, #1001 …0058 GBPJPY, #1002 …0058 GBPJPY, #1003 …0058 GBPJPY, #1004 …0058 GBPJPY, \+12 more/)
  assert.match(g.note, /every one counted until the owner answers H-P5b-3/)
  assert.match(g.note, /9 closed exactly flat carry no postmortem — exempt/)
  assert.match(g.note, /2 more unpriced close\(s\) carry no closed_at_ms and are outside this count, not recovered: #8 \(written off\), #353 \(written off\)/)
  assert.deepEqual(g.outsidePopulation.map(o => o.id), [8, 353]); assert.equal(g.outsideTotal, 2)
  assert.equal(g.semantics.id, 'H-P5b-3')
  assert.deepEqual(g.semantics.ifOwnerExcludes, { question: 'H-P5b-3', counted: false, current: 0, verdict: 'on_track' })
  assert.equal(t.summary.proposed, 0, 'no summary count moves: the would-read is not a verdict')
})

test('B4: close_completeness split is a partition — pending first in the items, each class counted once', async () => {
  const db = initDB(':memory:')
  b4Close(db, { id: 1, pos: '1', writtenOff: true })
  b4Close(db, { id: 2, pos: '2' })
  b4Close(db, { id: 3, pos: '3', net: -4.5 })
  const g = byId(await goalTable(db, { now: B4_NOW })).close_completeness
  assert.equal(g.current, 3)
  assert.equal(g.split.labelled_unrecoverable + g.split.broker_evidence_pending + g.split.postmortem_pending, g.split.raw)
  assert.deepEqual(g.items.map(i => [i.tradeId, i.class]), [[2, 'broker_evidence_pending'], [3, 'postmortem_pending'], [1, 'labelled_unrecoverable']])
  assert.deepEqual(g.semantics.ifOwnerExcludes, { question: 'H-P5b-3', counted: false, current: 2, verdict: 'off_track' })
})

test('B4: trade_reasons keeps its raw count (254, off track); pre-contract plan gaps are split beside it and the first 50 items are the post-contract ones', async () => {
  const db = initDB(':memory:')
  const { recordTradePlan } = await import('./trade-plans.js')
  const bot = db.prepare(`INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at, status, origin, strategy, risk_event_id, account_id)
                          VALUES ('EURUSD', 'BUY', 1.1, 1.095, 1.11, 1000, ?, 'open', 'bot_market_dispatch', 'donchian_breakout', ?, '46130058')`)
  for (let i = 0; i < 140; i++) bot.run('2026-09-01 10:00:00', 5) // plan_missing, opened before #857
  for (let i = 0; i < 7; i++) bot.run('2026-09-20 10:00:00', 5) // plan_missing, opened after #857
  const noRisk = bot.run('2026-09-20 10:00:00', null).lastInsertRowid // risk_event_missing (it has a plan)
  recordTradePlan(db, noRisk, { accountId: '46130058', symbol: 'EURUSD', side: 'BUY', strategy: 'donchian_breakout', entry: 1.1, sl: 1.095, tp: 1.11, now: B4_NOW })
  const adopted = db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin, origin_source, label_raw, account_id)
                              VALUES ('EURUSD', 'BUY', 1.1, '2026-09-01 10:00:00', 'open', 'reconciler_adopted', 'write', 'ap|v1|FIB|H|LN|4h|RG', '46130058')`)
  for (let i = 0; i < 106; i++) adopted.run()
  const g = byId(await goalTable(db, { now: B4_NOW })).trade_reasons
  assert.equal(g.current, 254, 'the raw count is unchanged by the split')
  assert.equal(g.verdict, 'off_track')
  assert.deepEqual({ raw: g.split.raw, pre: g.split.pre_contract, post: g.split.post_contract }, { raw: 254, pre: 140, post: 114 })
  assert.deepEqual(g.split.byContractKind, { pre_contract: { plan_missing: 140 }, post_contract: { adopted_ours_unreasoned: 106, plan_missing: 7, risk_event_missing: 1 } })
  assert.match(g.note, /^254 violation\(s\) over 148 trade\(s\): plan_missing 147, adopted_ours_unreasoned 106, risk_event_missing 1 — 140 pre-contract \(plan_missing 140: opened before the plan writer, #857 2026-09-08T07:48:28Z\) · 114 post-contract \(adopted_ours_unreasoned 106, plan_missing 7, risk_event_missing 1\); every one counted until the owner answers H-P5b-3$/)
  assert.equal(g.items.length, 50); assert.equal(g.itemsTotal, 254)
  assert.ok(g.items.every(i => i.contract === 'post_contract'), 'the actionable ones first')
  assert.deepEqual(g.semantics.ifOwnerExcludes, { question: 'H-P5b-3', counted: false, current: 114, verdict: 'off_track' })
})
