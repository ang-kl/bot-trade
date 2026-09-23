// ---------------------------------------------------------------------------
// agent/services/exit-counterfactual.js — Phase 7, wired to the real ledger.
//
// Reads closed trades that have a stored bar window, replays each under every
// candidate exit rule, and reports the comparison. It is READ-ONLY: no row is
// written, no threshold read or changed, no order touched.
//
// THE RULE THAT GOVERNS WHAT MAY BE COUNTED. The repair prompt forbids using
// adopted, manual or unattributed trades as evidence of strategy edge, so this
// admits only CLEAN BOT ORIGINS by default — the trades this system actually
// decided to open. That is `cleanBotOrigin()` from #673, applied here rather
// than re-implemented.
//
// AND IT REFUSES TO ANSWER ON TOO LITTLE. `minSample` is not decoration: on
// 2026-08-06 the whole book had 37 clean rows, all from a single day, and a
// profit factor computed over those would have looked exactly as authoritative
// as one computed over a year. The report says `verdict: 'INSUFFICIENT'` and
// names the shortfall instead of printing a number nobody should act on.
// ---------------------------------------------------------------------------

import { cleanBotOrigin } from '../lib/trade-origin.js'
import { strategyAttrSql } from '../lib/strategy-attribution.js'
import { parseBars, replayExit, summariseReplay, DEFAULT_RULES } from '../lib/exit-replay.js'
import { lastStateBeforeExit } from './position-events.js'

/**
 * Below this many usable trades PER RULE, no comparison is reported.
 *
 * 30 is the smallest sample at which a win-rate difference of the size this is
 * looking for (60% of exits being time_cap) is distinguishable from noise at
 * all. It is a floor on being misleading, NOT a claim of significance — a real
 * significance test needs the walk-forward work this phase does not do.
 */
export const MIN_SAMPLE = 30

const ms = (s) => {
  if (s == null) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * Parse a `?trailR=0.5,0.75,1.5,2` sweep request into extra trail rules.
 *
 * Owner question 2026-08-28: "is 1R the best way" — 1R was only the best
 * AMONG THE RULES TESTED, and nothing had ever swept the trail distance
 * itself. This turns a comma list into `{ name: 'trail_<v>R', trailR: v }`
 * rules so the sweep runs over the same replay population as everything
 * else, instead of being estimated.
 *
 * Strict on garbage rather than forgiving: a value that is not a finite
 * number in (0, 10] is dropped, duplicates (including of the built-in 1.0)
 * are dropped, and at most 8 survive — a sweep request is a bounded read,
 * not a way to make the endpoint replay hundreds of rule variants.
 */
export function parseTrailSweep(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const seen = new Set([1]) // trail_1R is already in DEFAULT_RULES
  const out = []
  for (const part of raw.split(',')) {
    const v = Number(part.trim())
    if (!Number.isFinite(v) || v <= 0 || v > 10) continue
    const r = Math.round(v * 100) / 100
    if (seen.has(r)) continue
    seen.add(r)
    out.push({ name: `trail_${r}R`, trailR: r })
    if (out.length >= 8) break
  }
  return out
}

/**
 * Load the replayable population.
 *
 * A trade qualifies only with: a stored bar window, an entry, a stop, and —
 * unless `cleanOnly` is off — a clean bot origin.
 */
export function replayablePopulation(db, { days = 30, cleanOnly = true, accountId = null, strategy = null, excludeStrategy = null } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  // Strategy filtering (owner, 25-08-2026, choosing option A): the 30d
  // population is majority burn-in probes — entries taken ON PACE to generate
  // exit data, so a verdict over the unfiltered sample answers "do random
  // entries have edge" (no, by construction) rather than "do the GATED
  // strategies' entries have edge under a better exit", which is the question
  // the owner is paying for. Attribution goes through strategyAttrSql — the
  // repo's one true reading — so a probe stamped only in the legacy column
  // cannot leak back in.
  const attr = strategyAttrSql('t.label_strategy', 't.strategy')
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.side, t.entry_price, t.sl_price, t.tp_price,
           t.opened_at, t.closed_at, t.net_pnl, t.origin, t.account_id,
           ${attr} AS strategy_attr,
           pm.bars_json, pm.r_multiple AS actual_r, pm.classification
      FROM trades t
      JOIN trade_postmortems pm ON pm.trade_id = t.id
     WHERE t.status = 'closed' AND t.closed_at IS NOT NULL AND t.closed_at >= ?
       AND (? IS NULL OR t.account_id = ?)
       AND (? IS NULL OR ${attr} = ?)
       AND (? IS NULL OR COALESCE(${attr}, '') != ?)
     ORDER BY t.closed_at DESC
  `).all(since, accountId, accountId, strategy, strategy, excludeStrategy, excludeStrategy)

  const skipped = { not_clean_origin: 0, no_bars: 0, no_levels: 0 }
  const eligible = []
  for (const r of rows) {
    if (cleanOnly && !cleanBotOrigin(r.origin)) { skipped.not_clean_origin++; continue }
    if (r.entry_price == null || r.sl_price == null) { skipped.no_levels++; continue }
    const { bars } = parseBars(r.bars_json)
    if (!bars.length) { skipped.no_bars++; continue }
    eligible.push({ row: r, bars })
  }
  return { considered: rows.length, eligible, skipped }
}

/**
 * The counterfactual comparison.
 *
 * @returns {{verdict: 'OK'|'INSUFFICIENT', days, considered, eligible,
 *   skipped, minSample, rules: Array, actual: object|null, note: string}}
 *
 * Each rule row carries its own `usable`, `ambiguous` and `truncated` counts —
 * a rule can be under-sampled while another is fine, and one aggregate figure
 * would hide that.
 */
export function exitCounterfactual(db, {
  days = 30, rules = DEFAULT_RULES, cleanOnly = true, accountId = null, minSample = MIN_SAMPLE,
  strategy = null, excludeStrategy = null,
} = {}) {
  const pop = replayablePopulation(db, { days, cleanOnly, accountId, strategy, excludeStrategy })

  const perRule = (Array.isArray(rules) ? rules : []).map((rule) => {
    const results = pop.eligible.map(({ row, bars }) => replayExit(bars, {
      side: row.side,
      entry: row.entry_price,
      sl: row.sl_price,
      tp: row.tp_price,
      openedAtMs: ms(row.opened_at),
    }, rule))
    return { rule: rule.name, spec: rule, ...summariseReplay(results) }
  })

  // What the system actually returned over the SAME population, so the
  // comparison is like-for-like. Comparing a replayed rule against a
  // book-wide historical figure would compare two different trade sets — the
  // error this repo has already made three times with multi-day aggregates.
  const actualRs = pop.eligible
    .map(({ row }) => Number(row.actual_r))
    .filter(n => Number.isFinite(n))
  const actual = actualRs.length
    ? summariseReplay(actualRs.map(r => ({ ok: true, rMultiple: r, reason: 'as_recorded' })))
    : null

  // BY MANAGEMENT STATE (owner plan, 02-09-2026). The as-traded outcome split
  // by the last state the journal recorded before the exit, with the mean R
  // at that transition — the raw material of a state-conditioned exit model,
  // reported here beside the replay so the two can be compared on the same
  // population when there are enough closes to compare. Report only.
  const byState = {}
  for (const { row } of pop.eligible) {
    const r = Number(row.actual_r)
    if (!Number.isFinite(r)) continue
    const { state, rAtTransition } = lastStateBeforeExit(db, row.id)
    const b = byState[state] || (byState[state] = { n: 0, wins: 0, totalR: 0, rAtTransitionSum: 0, rAtTransitionN: 0 })
    b.n++; if (r > 0) b.wins++; b.totalR += r
    // Number(null) is 0 — an unstamped R must not average in as zero.
    if (rAtTransition != null && Number.isFinite(Number(rAtTransition))) { b.rAtTransitionSum += Number(rAtTransition); b.rAtTransitionN++ }
  }
  for (const b of Object.values(byState)) {
    b.expectancyR = Math.round((b.totalR / b.n) * 1000) / 1000
    b.winRate = Math.round((b.wins / b.n) * 1000) / 10
    b.meanRAtTransition = b.rAtTransitionN ? Math.round((b.rAtTransitionSum / b.rAtTransitionN) * 1000) / 1000 : null
    delete b.rAtTransitionSum; delete b.rAtTransitionN
    b.totalR = Math.round(b.totalR * 1000) / 1000
  }

  const best = perRule.filter(r => r.usable >= minSample).length
  const verdict = best > 0 ? 'OK' : 'INSUFFICIENT'
  return {
    verdict,
    accountId: accountId == null ? null : String(accountId),
    days,
    cleanOnly,
    strategy,
    excludeStrategy,
    minSample,
    considered: pop.considered,
    eligible: pop.eligible.length,
    skipped: pop.skipped,
    actual,
    byState,
    rules: perRule,
    note: verdict === 'OK'
      ? `${pop.eligible.length} replayable trade(s) over ${days}d; ${best} of ${perRule.length} rule(s) reached the ${minSample}-trade floor. Ambiguous and truncated trades are excluded from every figure and counted beside it.`
      : `INSUFFICIENT — ${pop.eligible.length} replayable trade(s) over ${days}d, none of the ${perRule.length} rules reached the ${minSample}-trade floor. `
        + `Skipped: ${pop.skipped.not_clean_origin} not clean origin, ${pop.skipped.no_bars} without a stored bar window, ${pop.skipped.no_levels} without entry/stop. `
        + 'No comparison is reported, because a figure computed over this many trades would read exactly as authoritative as one that had earned it.',
  }
}
