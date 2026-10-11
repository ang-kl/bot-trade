// node --test agent/services/exit-counterfactual-extended.test.js
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder)
//
// The theory-gap exit measurements (plan B1–B4) against a real database.
// Load-bearing: the stop basis, the design target read from the risk event
// (never recomputed), the "current management" rule built from the LIVE
// loaders, the follow-through bracket, and the sweeps coming from the
// research config or the request — recorded either way.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { exitCounterfactualExtended, buildRules, managedApproxRule, hybridTriggerR, gateTagsFor, scenarioOf, COST_MODEL, EXTENDED_OPTIONS, PRESETS, GROUP_KEYS } from './exit-counterfactual-extended.js'
import { loadManagedExit } from './managed-exit.js'
import { setState } from '../db.js'
import { loadResearchConfig } from '../lib/research-config.js'
import { DEFAULT_ATR_MULT, DEFAULT_ATR_PERIOD } from './mae-chandelier-observe.js'

const MIN = 60_000
const t0 = Date.now() - 3 * 3_600_000
const bar = (m, o, h, l, c) => [t0 + m * MIN, o, h, l, c, 0]
// Long from 100. Recorded (trailed) stop 99.5, the broker's initial stop 99
// (risk 1), the as-traded take-profit 103 (the 3R stretch), the strategy's
// own target 101 (in the risk event). Price reaches 102.4 then falls to 99.3:
// the RECORDED stop is hit on bar 3, the INITIAL stop never is.
const BARS = [bar(0, 100, 100.6, 99.8, 100.5), bar(1, 100.5, 101.3, 100.4, 101.2), bar(2, 101.2, 102.4, 101.0, 102.3), bar(3, 102.3, 102.4, 99.3, 99.4), bar(4, 99.4, 99.6, 99.2, 99.5)]

function seed(db, { n, strategy = 'rsi_meanrev', riskEvent = 'tp1', timeframe = '15m', regime = 'RANGING', origin = 'bot_market_dispatch' } = {}) {
  for (let i = 0; i < n; i++) {
    let reId = null
    if (riskEvent && riskEvent !== 'none') {
      const proposal = riskEvent === 'tp1' ? { entry: 100, sl: 99, tp1: 101 } : { entry: 100, sl: 99 }
      reId = db.prepare(`INSERT INTO risk_events(symbol, side, approved, proposal_json) VALUES ('JPN225','BUY',1,?)`).run(JSON.stringify(proposal)).lastInsertRowid
    }
    const info = db.prepare(`INSERT INTO trades (symbol, side, status, strategy, entry_price, sl_price, tp_price, broker_sl_initial, realised_rr, exit_price_suspect,
        opened_at, closed_at, net_pnl, origin, account_id, risk_event_id, label_timeframe, label_regime)
      VALUES ('JPN225','long','closed',?,100,99.5,103,99,-0.5,0,?,?,-50,?,'43097342',?,?,?)`)
      .run(strategy, new Date(t0).toISOString(), new Date(t0 + 4 * MIN).toISOString(), origin, reId, timeframe, regime)
    db.prepare(`INSERT INTO trade_postmortems (trade_id, symbol, side, entry_price, sl_price, r_multiple, classification, bars_json)
      VALUES (?, 'JPN225', 'long', 100, 99.5, -1, 'stop_hunt', ?)`).run(info.lastInsertRowid, JSON.stringify(BARS))
  }
  return db
}
const fresh = () => initDB(':memory:')
const rule = (r, name) => r.rules.find(x => x.rule === name)

test('exports: the route reads its option names, presets and group keys from here', () => {
  assert.ok(EXTENDED_OPTIONS.includes('stop') && EXTENDED_OPTIONS.includes('trailR'))
  assert.deepEqual([...PRESETS], ['meanrev', 'breakout', 'momentum', 'all'])
  assert.deepEqual([...GROUP_KEYS], ['strategy', 'timeframe', 'regime', 'family', 'gateTag'])
})

test('stop=recorded replays against sl_price, stop=initial against broker_sl_initial — the same bars give different R and a different actual source', () => {
  const db = fresh(); seed(db, { n: 3 })
  const rec = exitCounterfactualExtended(db, { stop: 'recorded', minSample: 1 })
  const ini = exitCounterfactualExtended(db, { stop: 'initial', minSample: 1 })
  assert.equal(rec.extended, true); assert.equal(rec.stop.basis, 'sl_price (as recorded)')
  assert.match(ini.stop.basis, /broker_sl_initial/)
  // Recorded stop 99.5 is hit on bar 3: −1R under risk 0.5.
  assert.equal(rule(rec, 'as_traded').usable, 3); assert.equal(rule(rec, 'as_traded').expectancyR, -1)
  // Initial stop 99 is never hit and the 3R target 103 never reached: truncated, counted, not scored.
  assert.equal(rule(ini, 'as_traded').usable, 0); assert.equal(rule(ini, 'as_traded').truncated, 3)
  assert.equal(rec.actualSource, 'trade_postmortems.r_multiple'); assert.equal(rec.actual.expectancyR, -1)
  assert.match(ini.actualSource, /realised_rr/); assert.equal(ini.actual.expectancyR, -0.5)
  assert.equal(ini.verdict, 'OK', 'another rule reached the floor')
})

test('stop=initial: a suspect exit is excluded from the actual, never scored', () => {
  const db = fresh(); seed(db, { n: 2 })
  db.prepare('UPDATE trades SET exit_price_suspect = 1 WHERE id = 1').run()
  const ini = exitCounterfactualExtended(db, { stop: 'initial', minSample: 1 })
  assert.equal(ini.actual.n, 1)
})

test('design=1 reads the strategy\'s own pre-stretch target from the risk event and reports the coverage; a pruned or targetless event is counted, not recomputed', () => {
  const db = fresh()
  seed(db, { n: 2, riskEvent: 'tp1' })
  seed(db, { n: 1, riskEvent: 'none' })
  seed(db, { n: 1, riskEvent: 'no-tp1' })
  const r = exitCounterfactualExtended(db, { stop: 'initial', design: true, minSample: 1 })
  assert.deepEqual(r.design, { withDesign: 2, noRiskEvent: 1, noTp1: 1 })
  const d = rule(r, 'design_target')
  // 101 is reached on bar 1 → +1R under risk 1 for the two with a design target; the other two fail, not score.
  assert.equal(d.usable, 2); assert.equal(d.expectancyR, 1); assert.equal(d.failed, 2)
  assert.ok(rule(r, 'design_target_trail') && rule(r, 'stretched_target'))
  // The as-traded target (103) is the stretched one: truncated here, never reached.
  assert.equal(rule(r, 'stretched_target').truncated, 4)
  // The recorded stop basis makes the same design target +2R (risk 0.5).
  assert.equal(rule(exitCounterfactualExtended(db, { stop: 'recorded', design: true, minSample: 1 }), 'design_target').expectancyR, 2)
})

test('design=1 shifts the target by the fill offset when the proposal carries its entry', () => {
  const db = fresh(); seed(db, { n: 1 })
  db.prepare('UPDATE trades SET entry_price = 100.2 WHERE id = 1').run() // filled 0.2 above the proposal's entry 100
  const r = exitCounterfactualExtended(db, { stop: 'initial', design: true, minSample: 1 })
  // Target 101 + 0.2 = 101.2, reached on bar 1 (high 101.3); risk 100.2 − 99 = 1.2 → R = 1/1.2.
  assert.equal(rule(r, 'design_target').expectancyR, 0.833)
})

test('tpR sweep: from the research config by default, from the request when given — and recorded either way', () => {
  const db = fresh(); seed(db, { n: 2 })
  const cfg = loadResearchConfig()
  assert.equal(cfg.source, 'file')
  const fromFile = exitCounterfactualExtended(db, { stop: 'initial', tpR: cfg.exitReplay.tpR, minSample: 1 })
  assert.deepEqual(fromFile.sweeps.tpR, cfg.exitReplay.tpR)
  for (const v of cfg.exitReplay.tpR) assert.ok(rule(fromFile, `tp_${v}R`) && rule(fromFile, `tp_${v}R_trail`), `tp_${v}R and its trailed twin`)
  const fromReq = exitCounterfactualExtended(db, { stop: 'initial', tpR: ['2', 'junk', '2'], minSample: 1 })
  assert.deepEqual(fromReq.sweeps.tpR, [2]); assert.deepEqual(fromReq.sweeps.overridden, ['tpR'])
  assert.equal(fromReq.sweeps.source, 'file')
  // 2R under risk 1 = 102, reached on bar 2.
  assert.equal(rule(fromReq, 'tp_2R').expectancyR, 2)
  // tp_2R_trail carries the LIVE trail distance, not a typed one.
  assert.equal(rule(fromReq, 'tp_2R_trail').spec.trailR, loadManagedExit(db).trailR)
})

test('the managed approximation is built from the live loaders: trail, take-at-R (its families), the Chandelier constants and the hybrid trigger', () => {
  const db = fresh()
  const policy = loadManagedExit(db)
  const hybridR = hybridTriggerR()
  assert.equal(hybridR, 2, 'planCappedHybrid on a unit position: the trigger is 2R')
  const mr = managedApproxRule(policy, 'mean_reversion', { hybridR })
  assert.deepEqual(mr, { name: 'managed_approx', trailR: policy.trailR, chandelier: { mult: DEFAULT_ATR_MULT, period: DEFAULT_ATR_PERIOD }, partialAtR: policy.takeAtR, partialFraction: policy.takeFractionAtR })
  const bo = managedApproxRule(policy, 'breakout', { hybridR })
  assert.equal(bo.partialAtR, hybridR); assert.equal(bo.partialFraction, 0.5)
  // A stored managed_exit_json changes the approximation without a code change.
  setState(db, 'managed_exit_json', JSON.stringify({ trailR: 0.8, takeAtR: 1.5 }))
  const changed = managedApproxRule(loadManagedExit(db), 'mean_reversion', { hybridR })
  assert.equal(changed.trailR, 0.8); assert.equal(changed.partialAtR, 1.5)
})

test('presets add the named rules once each; names stay unique', () => {
  const db = fresh(); seed(db, { n: 2, strategy: 'donchian_breakout' })
  const cfg = { ...loadResearchConfig().exitReplay }
  const all = buildRules({ cfg, policy: loadManagedExit(db), preset: 'all', tpR: [], trailR: [1, 0.75], design: true, family: null })
  const names = all.map(r => r.name)
  assert.equal(new Set(names).size, names.length, 'no duplicate rule names')
  for (const must of ['managed_approx', `exit_at_mean_${cfg.exitAtMeanPeriod}`, 'managed_approx_breakout', `chandelier_${DEFAULT_ATR_MULT}x${DEFAULT_ATR_PERIOD}`, 'hybrid_half_2R_trail', 'tp1_partial_3R_half', 'trail_0.75R', 'design_target']) {
    assert.ok(names.includes(must), `${must} present`)
  }
  assert.equal(names.filter(n => n === 'trail_1R').length, 1, 'the legacy set already has a 1R trail; a requested 1 is not added twice')
  assert.ok(all.every(r => !('name_' in r)))
  const r = exitCounterfactualExtended(db, { stop: 'initial', preset: 'breakout', minSample: 1 })
  assert.equal(r.management.hybridTriggerR, 2)
  assert.equal(rule(r, 'managed_approx_breakout').spec.partialAtR, 2)
})

test('family= filters on the registry family; groupBy buckets the same rules per value', () => {
  const db = fresh()
  seed(db, { n: 3, strategy: 'rsi_meanrev', timeframe: '15m', regime: 'RANGING' })
  seed(db, { n: 2, strategy: 'donchian_breakout', timeframe: '1h', regime: 'TRENDING' })
  const mr = exitCounterfactualExtended(db, { stop: 'initial', family: 'mean_reversion', minSample: 1 })
  assert.equal(mr.eligible, 3); assert.equal(mr.family, 'mean_reversion')
  const byS = exitCounterfactualExtended(db, { stop: 'initial', groupBy: 'strategy', minSample: 1 })
  assert.equal(byS.groups.by, 'strategy'); assert.equal(byS.groups.values.rsi_meanrev.n, 3); assert.equal(byS.groups.values.donchian_breakout.n, 2)
  assert.equal(byS.groups.values.rsi_meanrev.rules.as_traded.truncated, 3)
  assert.equal(byS.groups.omitted, 0)
  assert.deepEqual(Object.keys(exitCounterfactualExtended(db, { stop: 'initial', groupBy: 'timeframe', minSample: 1 }).groups.values).sort(), ['15m', '1h'])
  assert.deepEqual(Object.keys(exitCounterfactualExtended(db, { stop: 'initial', groupBy: 'regime', minSample: 1 }).groups.values).sort(), ['RANGING', 'TRENDING'])
  assert.deepEqual(Object.keys(exitCounterfactualExtended(db, { stop: 'initial', groupBy: 'family', minSample: 1 }).groups.values).sort(), ['breakout', 'mean_reversion'])
})

test('follow-through is a bracket: under the recorded stop the peak before the stop bar is known; under the initial stop the window is truncated and the level is reported as a range', () => {
  const db = fresh(); seed(db, { n: 2 })
  const rec = exitCounterfactualExtended(db, { stop: 'recorded', followThrough: true, followThroughR: [1, 2, 3], minSample: 1 })
  // Peak before the stop bar: 102.4 → 4.8R under risk 0.5. Every level reached, low = high.
  assert.equal(rec.followThrough.measurable, 2); assert.equal(rec.followThrough.truncated, 0)
  assert.deepEqual(rec.followThrough.levels['+3R'], { reachedLow: 2, reachedHigh: 2, shareLowPct: 100, shareHighPct: 100 })
  const ini = exitCounterfactualExtended(db, { stop: 'initial', followThrough: true, followThroughR: [1, 2, 3], minSample: 1 })
  // Initial stop never hit → truncated. The peak before the end (102.4 → 2.4R under risk 1) is a CERTAIN reach of +1R and +2R
  // (it came before any stop); +3R is only "possibly later", so its low bound is 0 and its high bound is all.
  assert.equal(ini.followThrough.truncated, 2)
  assert.deepEqual(ini.followThrough.levels['+1R'], { reachedLow: 2, reachedHigh: 2, shareLowPct: 100, shareHighPct: 100 })
  assert.deepEqual(ini.followThrough.levels['+2R'], { reachedLow: 2, reachedHigh: 2, shareLowPct: 100, shareHighPct: 100 })
  assert.deepEqual(ini.followThrough.levels['+3R'], { reachedLow: 0, reachedHigh: 2, shareLowPct: 0, shareHighPct: 100 })
  assert.deepEqual(ini.sweeps.followThroughR, [1, 2, 3])
})

test('below the sample floor the verdict is INSUFFICIENT, with the same population counts as the legacy report', () => {
  const db = fresh(); seed(db, { n: 2 }); seed(db, { n: 3, origin: 'reconciler_adopted' })
  const r = exitCounterfactualExtended(db, { stop: 'initial' })
  assert.equal(r.verdict, 'INSUFFICIENT'); assert.equal(r.considered, 5); assert.equal(r.eligible, 2); assert.equal(r.skipped.not_clean_origin, 3)
  assert.match(r.note, /Not replayable exactly/)
})

test('B5c gateTag: the gate\'s pure verdict on the regime reading nearest before entry; unknown without a reading; groupBy=gateTag splits the rules', () => {
  const db = fresh()
  seed(db, { n: 2, strategy: 'rsi_meanrev' })          // long fades
  seed(db, { n: 1, strategy: 'donchian_breakout' })     // long breakout
  // A trending-short reading 10 minutes before entry: a long fade is blocked (fade-vs-trend), a long breakout against the trend too (trend-vs-trend).
  db.prepare("INSERT INTO regimes(symbol, regime, trend_direction, computed_at) VALUES ('JPN225', 'trending', 'short', datetime(?, 'unixepoch'))").run(Math.floor((t0 - 10 * MIN) / 1000))
  const tags = gateTagsFor(db, db.prepare('SELECT id, symbol, side, opened_at, strategy AS strategy_attr FROM trades').all())
  assert.deepEqual([...tags.values()].map(t => t.tag), ['would_block', 'would_block', 'would_block'])
  assert.match(tags.get(1).reason, /fade-vs-trend/); assert.match(tags.get(3).reason, /trend-vs-trend/)
  const r = exitCounterfactualExtended(db, { stop: 'initial', groupBy: 'gateTag', minSample: 1 })
  assert.deepEqual({ would_block: r.gateTag.would_block, would_pass: r.gateTag.would_pass, unknown: r.gateTag.unknown }, { would_block: 3, would_pass: 0, unknown: 0 })
  assert.deepEqual(Object.keys(r.groups.values), ['would_block'])
  // A SHORT fade in the same short trend fades WITH the trend: the gate passes it (the bias is read from the side).
  db.prepare("UPDATE trades SET side = 'SELL' WHERE id = 2").run()
  assert.equal(gateTagsFor(db, db.prepare('SELECT id, symbol, side, opened_at, strategy AS strategy_attr FROM trades WHERE id = 2').all()).get(2).tag, 'would_pass')
  db.prepare("UPDATE trades SET side = 'long' WHERE id = 2").run()
  // A ranging reading instead: the fade passes, the breakout is QUIET-free too → would_pass; a reading older than 4h is no reading.
  db.prepare("UPDATE regimes SET regime = 'ranging', trend_direction = NULL").run()
  assert.ok([...gateTagsFor(db, db.prepare('SELECT id, symbol, side, opened_at, strategy AS strategy_attr FROM trades').all()).values()].every(t => t.tag === 'would_pass'))
  db.prepare("UPDATE regimes SET computed_at = datetime(?, 'unixepoch')").run(Math.floor((t0 - 5 * 3_600_000) / 1000))
  const stale = exitCounterfactualExtended(db, { stop: 'initial', minSample: 1 })
  assert.equal(stale.gateTag.unknown, 3)
})

test('amendment area 4: rules are compared on a common cohort (rows every rule resolves), each rule names its scenario and cost; groups carry the same', () => {
  const db = fresh(); seed(db, { n: 3 })
  // Under the INITIAL stop the as-traded rule resolves nothing (truncated) while tp_2R resolves every row: the common cohort is empty, and the report says which rule dropped what.
  const ini = exitCounterfactualExtended(db, { stop: 'initial', tpR: [2], minSample: 1 })
  assert.equal(ini.cohort.n, 0); assert.equal(ini.cohort.of, 3); assert.equal(ini.cohort.notResolvedByVariant.as_traded, 3); assert.equal(ini.cohort.notResolvedByVariant.tp_2R, 0)
  assert.equal(rule(ini, 'tp_2R').usable, 3, 'the headline figure still describes the rule'); assert.equal(rule(ini, 'tp_2R').common.usable, 0); assert.equal(rule(ini, 'tp_2R').droppedFromCommon, 3)
  assert.match(ini.note, /common cohort/)
  // Under the RECORDED stop every rule resolves every row: common cohort = all, common figures = headline figures.
  const rec = exitCounterfactualExtended(db, { stop: 'recorded', tpR: [2], minSample: 1 })
  assert.equal(rec.cohort.n, 3); assert.equal(rule(rec, 'as_traded').common.expectancyR, rule(rec, 'as_traded').expectancyR)
  // Scenario and cost labels.
  assert.equal(scenarioOf({ name: 'managed_approx' }), 'current_policy'); assert.equal(scenarioOf({ name: 'hybrid_half_2R_trail' }), 'current_policy'); assert.equal(scenarioOf({ name: 'tp_2R' }), 'fixed_rule')
  const pre = exitCounterfactualExtended(db, { stop: 'recorded', preset: 'meanrev', minSample: 1 })
  assert.equal(rule(pre, 'managed_approx').scenario, 'current_policy'); assert.equal(rule(pre, 'as_traded').scenario, 'fixed_rule'); assert.equal(rule(pre, 'as_traded').cost, 'none')
  assert.deepEqual(pre.costs, COST_MODEL)
  // Groups: the common cohort is per group.
  const g = exitCounterfactualExtended(db, { stop: 'initial', tpR: [2], groupBy: 'strategy', minSample: 1 })
  assert.equal(g.groups.values.rsi_meanrev.commonN, 0); assert.equal(g.groups.values.rsi_meanrev.rules.tp_2R.common.usable, 0); assert.equal(g.groups.values.rsi_meanrev.rules.tp_2R.usable, 3)
})
