// ---------------------------------------------------------------------------
// agent/services/exit-counterfactual-extended.js — the theory-gap exit
// measurements (plan B1–B4), on the same replayable population as
// exit-counterfactual.js and the same measuring instrument (lib/exit-replay).
//
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder).
//
// READ-ONLY, REPORT WORKER. Legacy GET /state/exit-counterfactual is left
// byte-identical; this runs only when the request names one of the new
// options (stop=initial, tpR=, design=1, family=, preset=, groupBy=,
// followThrough=1). Nothing here is read by a gate or a management path.
//
// WHERE THE VALUES COME FROM (owner principle 9 — nothing hardcoded):
//   · sweeps (trail R, target R, follow-through R, the mean period) from
//     agent/config/research.json, overridable per request and recorded;
//   · the CURRENT management approximation from the live loaders and
//     modules: managed-exit.js loadManagedExit (trailR, takeAtR, its
//     families, takeFractionAtR), mae-chandelier-observe.js
//     (DEFAULT_ATR_MULT/PERIOD), capped-hybrid-policy.js planCappedHybrid
//     (the hybrid trigger, read by planning a unit position, never retyped);
//   · the strategy's OWN target from risk_events.proposal_json.tp1 (written
//     BEFORE the earned-floor stretch, loop.js persistRiskEvent precedes the
//     target override), shifted by the fill offset the stored levels carry.
//
// WHAT A BAR REPLAY CANNOT SEE, said beside every figure: the tick-level
// Chandelier on the native TrailEngine, broker-side trailing, the hybrid's
// tick trigger and partial fill prices. The 'managed_approx' preset is an
// approximation of the live stack at bar close, and the report says how
// well it reproduces the actual outcomes on the same trades.
// ---------------------------------------------------------------------------
import { replayablePopulation, MIN_SAMPLE } from './exit-counterfactual.js'
import { replayExit, summariseReplay, favourableExcursion, DEFAULT_RULES, entryBarCoverage, barIntervalMs, normaliseBars, T as BAR_T } from '../lib/exit-replay.js'
// Claude · № 15,258 17-Oct (research plan step 2 prerequisites, owner: "Build it, initial stop as the default,
// merge when green"; claude-builder): the broker's asset class per symbol. This report runs on an isolated
// worker whose module state is not primed at boot, so the cached tree is read here (read-only).
import { classOfSymbol, initAssetClasses, assetClassStatus } from '../lib/asset-class.js'
import { getState } from '../db.js'
import { loadResearchConfig, withOverrides } from '../lib/research-config.js'
import { loadManagedExit } from './managed-exit.js'
import { familyOf } from './strategies.js'
import { DEFAULT_ATR_MULT, DEFAULT_ATR_PERIOD } from './mae-chandelier-observe.js'
import { planCappedHybrid, loadCappedHybridSettings, CAPPED_HYBRID_DEFAULTS } from './capped-hybrid-policy.js'
// Claude · № 13,096 11-Oct (plan step 9, B5c): the regime gate's PURE verdict,
// applied to the regime recorded nearest BEFORE each entry. Read-only reach
// into a protected module (agent/research-isolation.test.js names it).
import { regimeBlocks, loadRegimeGateConfig, DEFAULT_MAX_REGIME_AGE_MIN } from './regime-gate.js'

export const EXTENDED_OPTIONS = Object.freeze(['stop', 'tpR', 'design', 'family', 'preset', 'groupBy', 'followThrough', 'trailR'])
export const PRESETS = Object.freeze(['meanrev', 'breakout', 'momentum', 'all'])
export const GROUP_KEYS = Object.freeze(['strategy', 'timeframe', 'regime', 'family', 'gateTag', 'class', 'side', 'source'])
/** The gate's configured age bound (regime_gate_json.maxRegimeAgeMin over the gate's default) in ms: the tag describes the CONFIGURED gate (Codex P2 on #1311). */
export function gateTagMaxAgeMs(db) { const cfg = loadRegimeGateConfig(db); const min = Number(cfg?.maxRegimeAgeMin); return (Number.isFinite(min) && min > 0 ? min : DEFAULT_MAX_REGIME_AGE_MIN) * 60_000 }
export const MAX_GROUP_VALUES = 24

const ms = s => { if (s == null) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null }
const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
const round = (n, d = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

/** The hybrid's trigger in R, read from the live policy by planning a unit
 * position — under the stored setting (capped_hybrid_json) when a database is
 * given, the defaults otherwise. Codex P1 on #1327 — Claude · № 13,488 12-Oct
 * (claude-builder): the "current policy" replay must be the policy in force. */
export function hybridTriggerR(db = null) {
  const { triggerR } = db ? loadCappedHybridSettings(db) : CAPPED_HYBRID_DEFAULTS
  const plan = planCappedHybrid({ side: 'BUY', entry: 100, initialRisk: 1, brokerTarget: 1000, volume: 200, minVolume: 100, stepVolume: 100, digits: 2, openingDealIds: ['1'], triggerR })
  return plan.ok ? round((plan.trigger - plan.entry) / plan.initialRisk) : null
}

/** The live management, as a bar-close approximation, per family. */
export function managedApproxRule(policy, family, { hybridR, hybridFraction = CAPPED_HYBRID_DEFAULTS.closeFraction }) {
  const take = policy.takeAtR > 0 && policy.takeAtRFamilies.includes(family)
  const rule = { name: 'managed_approx', trailR: policy.trailR, chandelier: { mult: DEFAULT_ATR_MULT, period: DEFAULT_ATR_PERIOD } }
  if (take) { rule.partialAtR = policy.takeAtR; rule.partialFraction = policy.takeFractionAtR }
  else if (hybridR != null && ['trend', 'breakout', 'momentum'].includes(family)) { rule.partialAtR = hybridR; rule.partialFraction = hybridFraction }
  return rule
}

/** Build the rule set for a request. Rules with `tpSource` are resolved per trade. */
export function buildRules({ cfg, policy, preset, tpR, trailR, design, family, hybrid = null }) {
  const hybridR = hybrid?.triggerR ?? hybridTriggerR()
  const hybridFraction = hybrid?.closeFraction ?? CAPPED_HYBRID_DEFAULTS.closeFraction
  const base = [...DEFAULT_RULES]
  const rules = [...base]
  for (const v of trailR) if (!rules.some(r => r.trailR === v)) rules.push({ name: `trail_${v}R`, trailR: v })
  for (const v of tpR) {
    rules.push({ name: `tp_${v}R`, tpR: v })
    rules.push({ name: `tp_${v}R_trail`, tpR: v, trailR: policy.trailR })
  }
  if (design) {
    rules.push({ name: 'design_target', tpSource: 'design' })
    rules.push({ name: 'design_target_trail', tpSource: 'design', trailR: policy.trailR })
    rules.push({ name: 'stretched_target', tpSource: 'stretched' }) // = the as-traded take-profit
  }
  const fam = family || null
  const presets = preset === 'all' ? ['meanrev', 'breakout', 'momentum'] : (preset ? [preset] : [])
  for (const p of presets) {
    if (p === 'meanrev') {
      rules.push({ ...managedApproxRule(policy, 'mean_reversion', { hybridR, hybridFraction }), name: 'managed_approx' })
      rules.push({ name: `exit_at_mean_${cfg.exitAtMeanPeriod}`, exitAtMean: { period: cfg.exitAtMeanPeriod } })
      rules.push({ name: `exit_at_mean_${cfg.exitAtMeanPeriod}_be`, exitAtMean: { period: cfg.exitAtMeanPeriod }, breakevenAtR: 1 })
    }
    if (p === 'breakout') {
      rules.push({ ...managedApproxRule(policy, fam && fam !== 'mean_reversion' ? fam : 'breakout', { hybridR, hybridFraction }), name: 'managed_approx_breakout' })
      rules.push({ name: `chandelier_${DEFAULT_ATR_MULT}x${DEFAULT_ATR_PERIOD}`, chandelier: { mult: DEFAULT_ATR_MULT, period: DEFAULT_ATR_PERIOD } })
      // The live hybrid plus the trail: the stored share, named by it (Codex P1
      // on #1328; Claude · № 13,496 12-Oct; claude-builder). At the default
      // the name is unchanged.
      if (hybridR != null) rules.push({ name: hybridFraction === 0.5 ? `hybrid_half_${hybridR}R_trail` : `hybrid_${round(hybridFraction * 100, 1)}pct_${hybridR}R_trail`, partialAtR: hybridR, partialFraction: hybridFraction, trailR: policy.trailR })
    }
    if (p === 'momentum') {
      rules.push({ name: `chandelier_${DEFAULT_ATR_MULT}x${DEFAULT_ATR_PERIOD}_only`, chandelier: { mult: DEFAULT_ATR_MULT, period: DEFAULT_ATR_PERIOD } })
      rules.push({ name: 'tp1_partial_3R_half', partialAtR: 3, partialFraction: 0.5 })
    }
  }
  // Names stay unique: a later duplicate is dropped, never silently merged.
  const seen = new Set(); return rules.filter(r => (seen.has(r.name) ? false : (seen.add(r.name), true)))
}

/** Which rules read today's live policy (a current-policy scenario) rather than a fixed rule. */
export function scenarioOf(rule) {
  return /^managed_approx|^hybrid_(half|[0-9.]+pct)_/.test(String(rule?.name || '')) ? 'current_policy' : 'fixed_rule'
}
/** The cost model every replay figure carries: declared, not modelled. */
export const COST_MODEL = Object.freeze({ model: 'none', status: 'gross_only_prerequisite_open', prerequisite: 'a historical spread/slippage source for counterfactual exit prices (Codex P2 on #1391); commission and swap from the broker terms then price each exit net. Until then every figure is gross and no rule is confirmed beyond confirmed_gross_only.', note: 'exits fill at the level on the bar that touches it; no spread, slippage, commission or swap; R is price-based against the chosen stop. The stored windows carry no bid/ask, so a spread model cannot be fitted from them.' })

/** The strategy's own pre-stretch target for a row, from its risk event, shifted by the fill offset. */
function designTargets(db, rows) {
  const ids = rows.map(r => r.risk_event_id).filter(v => v != null)
  const out = new Map(), coverage = { withDesign: 0, noRiskEvent: 0, noTp1: 0 }
  const byRe = new Map()
  if (ids.length) {
    for (const re of db.prepare(`SELECT id, proposal_json FROM risk_events WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      let p = null; try { p = JSON.parse(re.proposal_json || 'null') } catch { p = null }
      byRe.set(re.id, p)
    }
  }
  for (const r of rows) {
    if (r.risk_event_id == null) { coverage.noRiskEvent++; continue }
    const p = byRe.get(r.risk_event_id)
    const tp1 = num(p?.tp1 ?? p?.tp), pe = num(p?.entry ?? p?.entry_price)
    if (tp1 == null) { coverage.noTp1++; continue }
    const shift = pe != null && num(r.entry_price) != null ? num(r.entry_price) - pe : 0
    out.set(r.id, round(tp1 + shift, 8)); coverage.withDesign++
  }
  return { targets: out, coverage }
}

/**
 * B5c: for every eligible row, what the regime gate WOULD have said at entry,
 * from the regimes table reading nearest before the entry (within the gate's
 * own age bound). 'unknown' when no reading is near enough or the strategy
 * has no gate kind. Pure verdict (regimeBlocks), no gate state touched.
 */
export function gateTagsFor(db, rows) {
  const symbols = [...new Set(rows.map(r => r.symbol).filter(Boolean))]
  const out = new Map()
  if (!symbols.length) return out
  const maxAgeMs = gateTagMaxAgeMs(db)
  const sel = db.prepare(`SELECT regime, trend_direction, computed_at FROM regimes WHERE symbol = ? AND computed_at <= datetime(?, 'unixepoch') AND computed_at >= datetime(?, 'unixepoch') ORDER BY computed_at DESC LIMIT 1`)
  for (const r of rows) {
    const at = ms(r.opened_at)
    if (at == null || !r.symbol) { out.set(r.id, { tag: 'unknown', reason: 'no entry time or symbol' }); continue }
    const row = sel.get(r.symbol, Math.floor(at / 1000), Math.floor((at - maxAgeMs) / 1000))
    if (!row) { out.set(r.id, { tag: 'unknown', reason: `no regime reading within the gate's age bound (${maxAgeMs / 60_000} min) before entry` }); continue }
    const bias = /^(sell|short)$/i.test(String(r.side || '')) ? 'short' : 'long'
    const v = regimeBlocks(r.strategy_attr, bias, row)
    out.set(r.id, { tag: v.block ? 'would_block' : 'would_pass', reason: v.reason ?? null, regime: row.regime, trendDirection: row.trend_direction ?? null })
  }
  return out
}

/**
 * The extended report. Options are the route's validated values; `now` only
 * for tests. Returns a shape that EXTENDS the legacy report's keys.
 */
export function exitCounterfactualExtended(db, {
  days = 30, cleanOnly = true, accountId = null, strategy = null, excludeStrategy = null, family = null,
  stop = 'initial', tpR = null, trailR = null, design = false, preset = null, groupBy = null, followThrough = false,
  followThroughR = null, minSample = MIN_SAMPLE,
} = {}) {
  const research = loadResearchConfig()
  const sweeps = withOverrides(research.exitReplay, { tpR, trailR, followThroughR }, { tpR: { list: true, max: 10 }, trailR: { list: true, max: 10 }, followThroughR: { list: true, max: 10 } })
  const cfg = { ...sweeps.value, exitAtMeanPeriod: sweeps.value.exitAtMeanPeriod ?? 20 }
  const policy = loadManagedExit(db)
  const pop = replayablePopulation(db, { days, cleanOnly, accountId, strategy, excludeStrategy })
  // Family filter on the attributed strategy, with the registry's own map.
  let eligible = pop.eligible
  if (family) eligible = eligible.filter(({ row }) => familyOf(row.strategy_attr) === family)
  // Claude · № 15,258 17-Oct: under stop=initial a row without the broker's
  // first stop is EXCLUDED and counted — never silently replayed against the
  // plan stop (research plan step 2). A window that does not span the fill
  // (clipped at capture) is excluded and counted for every rule.
  const coverage = { no_initial_stop: 0, clipped: 0 }
  // Codex round 1 on #1394: 0 or a stop on the wrong side of the entry is no
  // initial stop at all (realisedRR treats zero the same way) — count it.
  const validInitial = row => { const sl = num(row.broker_sl_initial), e = num(row.entry_price); if (!(sl > 0) || e == null) return false; const s = String(row.side || '').toLowerCase(); return s === 'buy' || s === 'long' ? sl < e : s === 'sell' || s === 'short' ? sl > e : false }
  if (stop === 'initial') eligible = eligible.filter(({ row }) => (validInitial(row) ? true : (coverage.no_initial_stop++, false)))
  eligible = eligible.filter(({ row, bars }) => (entryBarCoverage(bars, { side: row.side, entry: row.entry_price, sl: stop === 'initial' ? num(row.broker_sl_initial) : num(row.sl_price), openedAtMs: ms(row.opened_at) }).status === 'clipped' ? (coverage.clipped++, false) : true))
  const rows = eligible.map(e => e.row)
  const dz = design ? designTargets(db, rows) : null
  const tags = gateTagsFor(db, rows)
  const gateTag = { would_block: 0, would_pass: 0, unknown: 0 }
  for (const r of rows) gateTag[tags.get(r.id)?.tag ?? 'unknown']++
  const hybridSetting = loadCappedHybridSettings(db)
  const hybrid = { triggerR: hybridTriggerR(db), closeFraction: hybridSetting.closeFraction }
  const rules = buildRules({ cfg, policy, preset, tpR: tpR ? cfg.tpR : [], trailR: trailR ? cfg.trailR : [], design, family, hybrid })

  const stopOf = row => (stop === 'initial' ? num(row.broker_sl_initial) : num(row.sl_price))
  const tradeFor = (row, rule) => {
    let tp = num(row.tp_price)
    if (rule.tpSource === 'design') tp = dz?.targets.get(row.id) ?? null
    return { side: row.side, entry: row.entry_price, sl: stopOf(row), tp, openedAtMs: ms(row.opened_at), _noTp: rule.tpSource === 'design' && tp == null }
  }
  const replayOne = (e, rule) => {
    const t = tradeFor(e.row, rule)
    if (t._noTp) return { ok: false, reason: 'no design target on record (risk event pruned or absent)' }
    if (entryBarCoverage(e.bars, t, rule).status === 'entry_bar_unresolved') return { ok: false, reason: 'entry_bar_unresolved', entryBarUnresolved: true }
    return replayExit(e.bars, t, rule)
  }
  const specOf = rule => Object.fromEntries(Object.entries(rule).filter(([k]) => k !== 'name'))
  // Amendment area 4 (Claude · № 13,101): every rule is replayed over the same
  // eligible rows; its headline figures are over the rows IT resolves
  // (descriptive), and `common` is over the COMMON COHORT — the rows every
  // compared rule resolves — so a comparison between rules never drops
  // censored trades differently by variant. `scenario` says whether a rule
  // is today's policy (read from the live loaders at request time) or a
  // fixed rule; `cost` is declared, not modelled.
  const results = rules.map(rule => ({ rule, out: eligible.map(e => replayOne(e, rule)) }))
  const cohortIdx = eligible.map((_, i) => i).filter(i => results.every(r => r.out[i]?.ok))
  const perRule = results.map(({ rule, out }) => ({
    rule: rule.name, spec: specOf(rule), scenario: scenarioOf(rule), cost: COST_MODEL.model,
    ...summariseReplay(out),
    common: summariseReplay(cohortIdx.map(i => out[i])),
    droppedFromCommon: out.length - cohortIdx.length,
    entryBarUnresolved: out.filter(o => o?.entryBarUnresolved).length,
  }))
  const cohort = { n: cohortIdx.length, of: eligible.length, rule: 'a trade is in the common cohort only when EVERY compared rule resolves it (no truncation, no ambiguity, no missing level); read `common` to compare rules, the headline figures to describe one', notResolvedByVariant: Object.fromEntries(results.map(({ rule, out }) => [rule.name, out.filter(o => !o?.ok).length])) }

  // Actual, over the same population: the ledger's realised_rr when the
  // initial stop is the basis (the postmortem's r_multiple divides by a
  // possibly trailed sl_price — the r-audit finding), else the legacy field.
  const actualSource = stop === 'initial' ? 'trades.realised_rr (suspect exits excluded)' : 'trade_postmortems.r_multiple'
  const actualRs = rows.map(r => (stop === 'initial' ? (Number(r.exit_price_suspect) === 1 ? null : num(r.realised_rr)) : num(r.actual_r))).filter(v => v != null)
  const actual = actualRs.length ? summariseReplay(actualRs.map(r => ({ ok: true, rMultiple: r, reason: 'as_recorded' }))) : null

  // Follow-through: the share of entries reaching +kR before the stop, bracketed.
  let follow = null
  if (followThrough) {
    const ks = cfg.followThroughR
    const ex = eligible.map(e => favourableExcursion(e.bars, { side: e.row.side, entry: e.row.entry_price, sl: stopOf(e.row), openedAtMs: ms(e.row.opened_at) }))
    const ok = ex.filter(x => x.ok)
    follow = { n: eligible.length, measurable: ok.length, truncated: ok.filter(x => x.truncated).length, levels: {} }
    for (const k of ks) {
      // Codex P1 on #1309 (Claude · № 13,098): a window that ends before the
      // stop but already touched +kR reached it for certain — the touch came
      // before any stop. So `low` counts every bar-before-stop peak at or
      // past k, truncated or not; `high` adds the stop bar's own extreme and
      // counts a truncated window as possibly reaching later.
      const low = ok.filter(x => x.peakRBeforeStopBar >= k).length
      const high = ok.filter(x => x.peakRInclStopBar >= k || x.truncated).length
      follow.levels[`+${k}R`] = { reachedLow: low, reachedHigh: high, shareLowPct: ok.length ? round(low / ok.length * 100, 1) : null, shareHighPct: ok.length ? round(high / ok.length * 100, 1) : null }
    }
  }

  // Groups: the same rules per group value, bounded.
  let groups = null
  if (groupBy) {
    if (groupBy === 'class' && !assetClassStatus().primed) initAssetClasses(db, getState)
    const sideOf = row => { const s = String(row.side || '').toLowerCase(); return s === 'buy' || s === 'long' ? 'long' : s === 'sell' || s === 'short' ? 'short' : '(none)' }
    const keyOf = row => groupBy === 'strategy' ? (row.strategy_attr || '(none)') : groupBy === 'timeframe' ? (row.label_timeframe || '(none)') : groupBy === 'regime' ? (row.label_regime || '(none)') : groupBy === 'gateTag' ? (tags.get(row.id)?.tag ?? 'unknown')
      : groupBy === 'class' ? classOfSymbol(row.symbol).cls : groupBy === 'side' ? sideOf(row) : groupBy === 'source' ? (row.origin || '(none)') : (familyOf(row.strategy_attr) || '(none)')
    const buckets = new Map()
    for (const e of eligible) { const k = keyOf(e.row); (buckets.get(k) || buckets.set(k, []).get(k)).push(e) }
    const ordered = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)
    groups = { by: groupBy, values: {}, omitted: Math.max(0, ordered.length - MAX_GROUP_VALUES) }
    for (const [k, list] of ordered.slice(0, MAX_GROUP_VALUES)) {
      const outs = rules.map(rule => list.map(e => replayOne(e, rule)))
      const idx = list.map((_, i) => i).filter(i => outs.every(o => o[i]?.ok))
      groups.values[k] = { n: list.length, commonN: idx.length, rules: Object.fromEntries(rules.map((rule, r) => [rule.name, { ...summariseReplay(outs[r]), common: summariseReplay(idx.map(i => outs[r][i])) }])) }
    }
  }

  // Claude · № 15,258 17-Oct: the chronological holdout (research plan step 2,
  // the same rule as barForm.validation). Rows are placed by time: TRAIN closed
  // at or before the cutoff, CONFIRM opened at or after it, a trade spanning
  // it in neither (counted). A rule is chosen on TRAIN (best common
  // expectancy among rules with minSample usable) and judged on CONFIRM,
  // which played no part in the choice. Costs are not modelled, so the best a
  // verdict can read is confirmed_gross_only.
  const validation = (() => {
    const frac = research.exitReplay?.validation?.trainFraction ?? null
    if (!(frac > 0 && frac < 1)) return { status: 'not_split', reason: 'research.json exitReplay.validation.trainFraction missing or outside (0, 1)' }
    const opens = eligible.map(e => ms(e.row.opened_at)), closes = eligible.map(e => ms(e.row.closed_at))
    const known = opens.filter(v => v != null).concat(closes.filter(v => v != null))
    if (known.length < 2) return { status: 'insufficient', reason: 'no dated rows', trainFraction: frac }
    const start = Math.min(...known), end = Math.max(...known), cutoff = start + frac * (end - start)
    const train = [], confirm = []; let straddling = 0
    eligible.forEach((_, i) => { if (closes[i] != null && closes[i] <= cutoff) train.push(i); else if (opens[i] != null && opens[i] >= cutoff) confirm.push(i); else straddling++ })
    // Codex round 3 on #1394 (P1): a TRAIN row's window holds aftermath bars
    // that can run past the cutoff, so its full-window outcome may be decided
    // by prices CONFIRM is meant to own. TRAIN is replayed on the bars that
    // closed by the cutoff; a rule still holding there is truncated (not
    // usable), never scored on later prices. CONFIRM keeps the full window.
    const cutBars = bars => {
      const tuples = normaliseBars(bars), tf = barIntervalMs(tuples) ?? 0
      return tuples.filter(b => b[BAR_T] + tf <= cutoff)
    }
    const trainOut = new Map(train.map(i => [i, results.map(({ rule }) => replayOne({ ...eligible[i], bars: cutBars(eligible[i].bars) }, rule))]))
    const outAt = (r, i, own) => (own ? trainOut.get(i)[r] : results[r].out[i])
    const block = (idx, own) => {
      const common = idx.filter(i => results.every((_, r) => outAt(r, i, own)?.ok))
      return Object.fromEntries(results.map(({ rule }, r) => [rule.name, summariseReplay(common.map(i => outAt(r, i, own)))]))
    }
    const tr = block(train, true), cf = block(confirm, false)
    const ranked = Object.entries(tr).filter(([, s]) => s.usable >= minSample && s.expectancyR != null).sort((a, b) => b[1].expectancyR - a[1].expectancyR)
    const selected = ranked.length ? ranked[0][0] : null
    const conf = selected ? cf[selected] : null
    let verdict = 'insufficient'
    if (selected && conf && conf.usable >= minSample) verdict = conf.expectancyR > 0 && tr[selected].expectancyR > 0 ? (COST_MODEL.status === 'modelled' ? 'confirmed' : 'confirmed_gross_only') : 'not_confirmed'
    return {
      status: 'split', trainFraction: frac, cutoff: new Date(cutoff).toISOString(),
      rows: { train: train.length, confirm: confirm.length, straddling },
      selectedOnTrain: selected, verdict, costs: COST_MODEL.status,
      train: tr, confirm: cf,
      rule: 'selection on TRAIN common-cohort expectancy (rules with minSample usable); CONFIRM untouched by the choice; a verdict is gross while costs.status is not modelled',
    }
  })()

  const best = perRule.filter(r => r.usable >= minSample).length
  return {
    verdict: best > 0 ? 'OK' : 'INSUFFICIENT',
    extended: true,
    accountId: accountId == null ? null : String(accountId), days, cleanOnly, strategy, excludeStrategy, family, minSample,
    stop: { basis: stop === 'initial' ? 'broker_sl_initial (rows without it excluded, counted in coverage.no_initial_stop)' : 'sl_price (as recorded)' },
    coverage: { ...coverage, entryBarUnresolvedByRule: Object.fromEntries(perRule.map(r => [r.rule, r.entryBarUnresolved])), rule: 'clipped: no stored bar spans the fill; entry_bar_unresolved: the fill is inside a bar whose range reaches a level the rule acts on (stop, target, partial, break-even or trail level, or a close past the mean). Both excluded from every figure. Trail rules start their peak from the next bar: a known late (never false) bias.' },
    validation,
    actualSource,
    sweeps: { ...cfg, source: research.source, overridden: sweeps.overridden },
    management: { source: 'loadManagedExit (managed_exit_json over defaults) + mae-chandelier-observe + capped-hybrid-policy', trailR: policy.trailR, takeAtR: policy.takeAtR, takeAtRFamilies: policy.takeAtRFamilies, takeFractionAtR: policy.takeFractionAtR, chandelier: { mult: DEFAULT_ATR_MULT, period: DEFAULT_ATR_PERIOD }, hybridTriggerR: hybrid.triggerR, hybridCloseFraction: hybrid.closeFraction, hybridSource: hybridSetting.source },
    design: dz ? dz.coverage : null,
    gateTag: { ...gateTag, maxAgeMin: gateTagMaxAgeMs(db) / 60_000, basis: 'regimeBlocks(strategy, bias, regime reading nearest before entry within the configured regime-gate age bound); groupBy=gateTag splits every rule by it' },
    considered: pop.considered, eligible: eligible.length, skipped: pop.skipped,
    actual, rules: perRule, cohort, costs: COST_MODEL, followThrough: follow, groups,
    note: 'Bar replay only. Compare rules on `common` (the common cohort), never on the headline figures, whose denominators differ by rule. Costs: none modelled (see costs). Not replayable exactly: the tick-level Chandelier on the native TrailEngine, broker-side trailing once a stop locks profit, the hybrid tick trigger, partial fill prices. managed_approx approximates the live stack at bar close; compare its figures with `actual` on the same trades before reading any other rule against it. Ambiguous and truncated trades are excluded from every figure and counted beside it; follow-through is a bracket because a bar that hits the stop may also have set the high.',
  }
}
