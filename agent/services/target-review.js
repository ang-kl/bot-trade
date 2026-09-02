// ---------------------------------------------------------------------------
// agent/services/target-review.js — strategy target review (02-09-2026 plan,
// part 3). Each strategy's FIXED take-profit target, as it is actually
// constructed, read against three things the repo already measures:
//
//   (a) what the strategy PROPOSED — the gate's own rounded R:R from
//       risk_events.checks_json.rr, per distinct opportunity;
//   (b) what the shrunk PRIOR says that ratio is worth — W′ from
//       earnedFloorPriorReport, so E(rr) = W′·rr − (1 − W′) at the declared
//       target, at the median proposed ratio, and at HARD_MIN_RR;
//   (c) what the trades actually RETURNED — the replay population and the
//       same summariser exit-counterfactual.js uses, so the two agree on the
//       same trades.
//
// READ-ONLY AND RECOMMENDATION-ONLY. Nothing here is read by the gate, by any
// strategy or by the position manager, and nothing here changes a constant:
// HARD_MIN_RR, STRATEGY_MIN_RR, every tp rule and every manager trigger are
// untouched. The module imports the gate's constants so the review reads the
// floors the gate really enforces, and it imports NO strategy module and NOT
// the position manager (target-review.test.js pins both), so it cannot drift
// into being one.
//
// IT REFUSES TO ANSWER ON TOO LITTLE, the same way the counterfactual does:
// proposal figures need TARGET_REVIEW_GATES.minProposals distinct
// opportunities with a measured rr, realised figures need MIN_SAMPLE usable
// closes. Below either gate the row says `insufficient` with the count it
// has, never a number that would read as authoritative.
// ---------------------------------------------------------------------------

import { HARD_MIN_RR } from './risk.js'
import { STRATEGY_REGISTRY, minRrFor, STRATEGY_PREFILTER_RR } from './strategies.js'
import { earnedFloorPriorReport, loadEarnedFloor } from './earned-floor.js'
import { replayablePopulation, MIN_SAMPLE } from './exit-counterfactual.js'
import { replayExit, summariseReplay } from '../lib/exit-replay.js'

/**
 * Each strategy's tp1 as its own module builds it, transcribed for the report.
 * `rr` is the fixed multiple of the stop distance when the target IS a fixed
 * multiple; null when the target is a price level whose R depends on the
 * setup (range height, swing origin, POC, mean). A null here is not "unknown"
 * — it is "measured, not declared", and the proposal median is the reading.
 *
 * Report-only table. Changing a number here changes what the review SAYS a
 * strategy declares, not what the strategy does — the strategy module is the
 * authority and the test cross-checks the two fixed ones it can.
 */
export const DECLARED_TARGETS = Object.freeze({
  rsi2_reversion:    { rr: 1.2,  basis: 'fixed: TP_RR × stop distance (tp2 at 2.2)' },
  ema_pullback:      { rr: 2,    basis: 'fixed: 2R (tp2 at 3R)' },
  vwap_trend:        { rr: 2,    basis: 'fixed: 2R' },
  fib_confluence:    { rr: 2,    basis: 'fixed: 2R' },
  donchian_breakout: { rr: null, basis: 'range height (measured move)' },
  va_breakout:       { rr: null, basis: 'value-area height beyond the level' },
  fib_618_fade:      { rr: null, basis: 'swing origin (≈1.2–2.0R by geometry)' },
  vp_value:          { rr: null, basis: 'point of control (rotation to value)' },
  rsi_meanrev:       { rr: null, basis: 'SMA20 (the mean itself)' },
  fvg_retrace:       { rr: null, basis: 'impulse extreme, ≥1.5R by filter' },
  cup_handle:        { rr: null, basis: 'measured move (cup depth)' },
  inv_cup_handle:    { rr: null, basis: 'measured move (cup depth)' },
})

/** Below these the corresponding block reports `insufficient`. */
export const TARGET_REVIEW_GATES = Object.freeze({ minProposals: 20, minCloses: MIN_SAMPLE })

/** Replay rules the realised block runs beside the as-recorded outcome. */
export const TARGET_REVIEW_RULES = Object.freeze([
  { name: 'trail_0.5R', trailR: 0.5 },
  { name: 'trail_1R', trailR: 1.0 },
  { name: 'tp_1R', tpR: 1.0 },
])

const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null)
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null)

/** Linear-interpolated quantile over a sorted numeric array; null when empty. */
export function quantile(sorted, q) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * The prior arithmetic for one strategy at one W′ (0–1).
 *
 *   E(rr)       = W′·rr − (1 − W′)
 *   breakEvenRr = (1 − W′) / W′            (E = 0)
 *   rrForMinE   = (minE + 1 − W′) / W′     (E = minE)
 *
 * Pure so the test can pin it: W′ 0.6 → break-even 0.667, rrForMinE(0.1)
 * 0.833, E(1.2) 0.32.
 */
export function priorArithmetic(W, { declared = null, median = null, minE = 0.1, hard = HARD_MIN_RR } = {}) {
  if (!(Number.isFinite(W) && W > 0 && W < 1)) return null
  const E = (rr) => (Number.isFinite(rr) ? r3(W * rr - (1 - W)) : null)
  const eDeclared = E(declared), eMedian = E(median)
  return {
    shrunkWinRatePct: r3(W * 100),
    expectancyR: { declared: eDeclared, median: eMedian, hard: E(hard) },
    breakEvenRr: r3((1 - W) / W),
    rrForMinE: r3((minE + 1 - W) / W),
    wouldAdmit: {
      declared: eDeclared == null ? null : eDeclared > minE,
      median: eMedian == null ? null : eMedian > minE,
    },
  }
}

/**
 * (a) Proposals per strategy over `days`, ONE ROW PER DISTINCT OPPORTUNITY
 * (latest gate decision wins — the earnedFloorReport unit, because the
 * scanner re-evaluates the same setup every cycle). Post-approval refusals
 * are not gate decisions and are excluded before the dedupe, so a refused
 * approval still counts as the approval the gate made.
 */
export function proposalsByStrategy(db, { days = 30, accountId = null } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  let rows = []
  try {
    rows = db.prepare(`
      SELECT id, approved, veto_reason, opportunity_key,
             json_extract(proposal_json, '$.strategy') AS strategy,
             json_extract(checks_json, '$.rr') AS rr,
             (json_extract(checks_json, '$.earned_floor') IS NOT NULL) AS via_floor,
             (json_extract(checks_json, '$.earned_floor.via') = 'prior') AS via_prior
        FROM risk_events
       WHERE created_at >= ?
         AND (? IS NULL OR account_id = ?)
         AND COALESCE(json_extract(checks_json, '$.post_approval'), 0) != 1
       ORDER BY id ASC
    `).all(since, accountId, accountId)
  } catch { rows = [] }
  // Latest row per opportunity wins: rows arrive id-ascending, so a plain
  // overwrite keeps the newest decision. Unkeyed rows count one-per-row.
  const latest = new Map()
  for (const r of rows) latest.set(r.opportunity_key || `row:${r.id}`, r)
  const out = {}
  for (const r of latest.values()) {
    const key = r.strategy ? String(r.strategy) : 'unattributed'
    const s = out[key] || (out[key] = { n: 0, rrs: [], approved: 0, earnedFloorAdmits: 0, priorAdmits: 0, badRrVetoes: 0 })
    s.n++
    const rr = r.rr == null ? NaN : Number(r.rr)
    if (Number.isFinite(rr)) s.rrs.push(rr)
    if (Number(r.approved) === 1) s.approved++
    if (Number(r.approved) === 1 && r.via_floor) s.earnedFloorAdmits++
    if (Number(r.approved) === 1 && r.via_prior) s.priorAdmits++
    if (typeof r.veto_reason === 'string' && r.veto_reason.startsWith('bad_rr')) s.badRrVetoes++
  }
  return out
}

/**
 * The review.
 *
 * @returns {{ reportOnly: true, recommendationsOnly: true, days, accountId,
 *   hardMinRr, prefilterRr, minE, k, priorSource, gates, strategies: object,
 *   note: string }}
 */
export function targetReview(db, { days = 30, accountId = null } = {}) {
  const cfg = loadEarnedFloor(db)
  const minE = Number.isFinite(Number(cfg.minE)) ? Number(cfg.minE) : 0.1
  const proposals = proposalsByStrategy(db, { days, accountId })

  let prior = null
  try { prior = earnedFloorPriorReport(db) } catch { prior = null }
  const priorFor = (strategy) => {
    const row = prior?.strategies?.[strategy]
    if (!row) return null
    const scope = accountId != null && row.byAccount?.[String(accountId)] ? row.byAccount[String(accountId)] : row.pooled
    const pct = scope?.shrunkWinRatePct
    return Number.isFinite(Number(pct)) ? Number(pct) / 100 : null
  }

  // (c) One population read, grouped by attribution; the SAME rows and the
  // SAME summariser as exit-counterfactual.js so `actual.expectancyR` here
  // equals `exitCounterfactual(db, { strategy }).actual.expectancyR` there.
  let pop = { eligible: [], considered: 0, skipped: {} }
  try { pop = replayablePopulation(db, { days, cleanOnly: true, accountId }) } catch { /* zeros stand */ }
  const byStrategy = {}
  for (const e of pop.eligible) {
    const key = e.row.strategy_attr ? String(e.row.strategy_attr) : 'unattributed'
    ;(byStrategy[key] || (byStrategy[key] = [])).push(e)
  }

  const keys = [...new Set([
    ...STRATEGY_REGISTRY.map(s => s.key),
    ...Object.keys(proposals),
    ...Object.keys(byStrategy),
  ])].sort()

  const strategies = {}
  for (const key of keys) {
    const declared = DECLARED_TARGETS[key] || { rr: null, basis: 'not in the declared table' }
    const ownFloor = minRrFor(key, STRATEGY_PREFILTER_RR)
    const p = proposals[key] || { n: 0, rrs: [], approved: 0, earnedFloorAdmits: 0, priorAdmits: 0, badRrVetoes: 0 }
    const sorted = [...p.rrs].sort((a, b) => a - b)
    const withRr = sorted.length
    const W = priorFor(key)
    const median = quantile(sorted, 0.5)
    const enoughProposals = withRr >= TARGET_REVIEW_GATES.minProposals

    // (d) What the 3.0 floor removes, and what the prior would have let through.
    const belowHard = sorted.filter(rr => rr < HARD_MIN_RR).length
    const belowOwn = sorted.filter(rr => rr < ownFloor).length
    const admissibleOnPrior = W != null
      ? sorted.filter(rr => rr >= ownFloor && rr < HARD_MIN_RR && (W * rr - (1 - W)) > minE).length
      : null

    const proposalBlock = {
      n: p.n, withRr, approved: p.approved, earnedFloorAdmits: p.earnedFloorAdmits, priorAdmits: p.priorAdmits,
      badRrVetoes: p.badRrVetoes,
      ...(enoughProposals ? {
        medianRr: r2(median), p25Rr: r2(quantile(sorted, 0.25)), p75Rr: r2(quantile(sorted, 0.75)),
        shareBelowHard: r3(belowHard / withRr),
        shareBelowOwnFloor: r3(belowOwn / withRr),
        badRrVetoShare: r3(p.badRrVetoes / withRr),
        admissibleOnPrior: admissibleOnPrior == null ? null : { count: admissibleOnPrior, share: r3(admissibleOnPrior / withRr) },
      } : { insufficient: true, need: TARGET_REVIEW_GATES.minProposals }),
    }

    const arith = W != null ? priorArithmetic(W, { declared: declared.rr, median: enoughProposals ? median : null, minE }) : null

    const trades = byStrategy[key] || []
    const actualRs = trades.map(({ row }) => Number(row.actual_r)).filter(n => Number.isFinite(n))
    let realised
    if (actualRs.length >= TARGET_REVIEW_GATES.minCloses) {
      const actual = summariseReplay(actualRs.map(r => ({ ok: true, rMultiple: r, reason: 'as_recorded' })))
      const sortedR = [...actualRs].sort((a, b) => a - b)
      const rules = {}
      for (const rule of TARGET_REVIEW_RULES) {
        const results = trades.map(({ row, bars }) => replayExit(bars, {
          side: row.side, entry: row.entry_price, sl: row.sl_price, tp: row.tp_price,
          openedAtMs: row.opened_at ? Date.parse(row.opened_at) : null,
        }, rule))
        const s = summariseReplay(results)
        rules[rule.name] = { usable: s.usable, winRate: s.winRate, profitFactor: s.profitFactor, expectancyR: s.expectancyR }
      }
      realised = {
        closes: actualRs.length,
        actual: { usable: actual.usable, winRate: actual.winRate, profitFactor: actual.profitFactor, expectancyR: actual.expectancyR, totalR: actual.totalR },
        rQuantiles: { p25: r3(quantile(sortedR, 0.25)), median: r3(quantile(sortedR, 0.5)), p75: r3(quantile(sortedR, 0.75)) },
        shareReachedDeclared: declared.rr != null ? r3(actualRs.filter(r => r >= declared.rr).length / actualRs.length) : null,
        rules,
      }
    } else {
      realised = { closes: actualRs.length, insufficient: true, need: TARGET_REVIEW_GATES.minCloses }
    }

    strategies[key] = {
      declaredTarget: { ...declared },
      ownFloor,
      proposals: proposalBlock,
      prior: arith,
      realised,
    }
  }

  return {
    reportOnly: true,
    recommendationsOnly: true,
    days,
    accountId: accountId == null ? null : String(accountId),
    hardMinRr: HARD_MIN_RR,
    prefilterRr: STRATEGY_PREFILTER_RR,
    minE,
    k: prior?.k ?? null,
    priorSource: prior?.source ?? null,
    gates: { ...TARGET_REVIEW_GATES },
    population: { considered: pop.considered, eligible: pop.eligible.length, skipped: pop.skipped },
    strategies,
    note: 'Read-only. Declared targets are transcribed from each strategy module; the prior is the shrunk W′ the earned floor already reports; '
      + 'realised figures use the exit-counterfactual population and summariser. No floor, target or manager trigger is changed by this report.',
  }
}
